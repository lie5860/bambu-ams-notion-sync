import { Client } from "@notionhq/client";
import {
  checkboxFilter,
  filterForExactValue,
  getPlainText,
  propertyPayload
} from "./notion-properties.js";

function compactObject(entries) {
  return Object.fromEntries(entries.filter(Boolean));
}

function uniqueByUid(trays) {
  const byUid = new Map();
  for (const tray of trays) byUid.set(tray.uid, tray);
  return [...byUid.values()];
}

function publicPageId(id) {
  return id.replace(/-/g, "").slice(0, 12);
}

function swatchIcon(hexColor) {
  if (!hexColor) return undefined;
  const hex = hexColor.replace("#", "").slice(0, 6).toUpperCase();
  if (!/^[0-9A-F]{6}$/.test(hex)) return undefined;

  return {
    type: "external",
    external: {
      url: `https://dummyimage.com/64x64/${hex}/${hex}.png`
    }
  };
}

export class NotionAmsSync {
  constructor(config, logger) {
    this.config = config;
    this.logger = logger;
    this.client = new Client({
      auth: config.token,
      notionVersion: "2025-09-03"
    });
    this.schema = null;
    this.warnedMissingProperties = new Set();
    this.lastSignatures = new Map();
  }

  async init() {
    if (!this.client.dataSources?.retrieve || !this.client.dataSources?.query) {
      throw new Error("Installed @notionhq/client does not support dataSources. Run npm install with the bundled package.json.");
    }

    const dataSource = await this.resolveDataSource(this.config.dataSourceId);

    this.schema = dataSource.properties || {};
    this.assertProperty(this.config.properties.amsUid, "RFID Tag UID lookup");
    this.logger.info(
      `Loaded Notion data source ${this.config.dataSourceId} schema with ${Object.keys(this.schema).length} properties`
    );
  }

  async resolveDataSource(id) {
    try {
      return await this.client.dataSources.retrieve({ data_source_id: id });
    } catch (error) {
      if (!this.looksLikeObjectNotFound(error)) throw error;
    }

    try {
      const database = await this.client.databases.retrieve({ database_id: id });
      const dataSourceId = database.data_sources?.[0]?.id;
      if (!dataSourceId) {
        throw new Error(`Notion database ${id} has no data sources`);
      }

      this.config.dataSourceId = dataSourceId;
      this.logger.info(`Resolved Notion database ${id} to data source ${dataSourceId}`);
      return this.client.dataSources.retrieve({ data_source_id: dataSourceId });
    } catch (error) {
      if (!this.looksLikePageInsteadOfDatabase(error) && !this.looksLikeObjectNotFound(error)) throw error;
    }

    try {
      await this.client.pages.retrieve({ page_id: id });
    } catch {
      throw new Error(
        `Cannot find Notion target ${id}. Share the page/database with your Notion integration, then restart the sync service.`
      );
    }

    return this.ensureAmsDataSourceOnPage(id);
  }

  async ensureAmsDataSourceOnPage(pageId) {
    const databaseName = this.config.amsDatabaseName || "AMS 耗材";
    const existingDatabaseId = await this.findChildDatabase(pageId, databaseName);
    const database = existingDatabaseId
      ? await this.client.databases.retrieve({ database_id: existingDatabaseId })
      : await this.createAmsDatabase(pageId, databaseName);
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(`AMS database "${databaseName}" has no data source`);

    this.config.dataSourceId = dataSourceId;
    this.logger.info(`Using Notion AMS database "${databaseName}" data source ${dataSourceId}`);
    return this.client.dataSources.retrieve({ data_source_id: dataSourceId });
  }

  async findChildDatabase(pageId, title) {
    let startCursor;

    do {
      const response = await this.client.blocks.children.list({
        block_id: pageId,
        page_size: 100,
        start_cursor: startCursor
      });

      const database = response.results.find(
        (block) => block.type === "child_database" && block.child_database?.title === title
      );
      if (database) return database.id;

      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    return null;
  }

  async createAmsDatabase(pageId, title) {
    const properties = this.buildAmsDatabaseProperties();
    this.logger.info(`Creating Notion database "${title}" under page ${pageId}`);
    return this.client.databases.create({
      parent: { type: "page_id", page_id: pageId },
      title: [{ type: "text", text: { content: title } }],
      is_inline: false,
      initial_data_source: { properties }
    });
  }

  buildAmsDatabaseProperties() {
    const props = this.config.properties;
    const properties = {
      [props.title]: { type: "title", title: {} }
    };

    const add = (name, schema) => {
      if (name && name !== props.title) properties[name] = schema;
    };

    add(props.amsUid, { type: "rich_text", rich_text: {} });
    add(props.remainPercent, { type: "number", number: { format: "number" } });
    add(props.remainGrams, { type: "number", number: { format: "number" } });
    add(props.amsSlot, { type: "rich_text", rich_text: {} });
    add(props.loaded, { type: "checkbox", checkbox: {} });
    add(props.lastSync, { type: "date", date: {} });
    add(props.printer, { type: "rich_text", rich_text: {} });
    add(props.material, { type: "rich_text", rich_text: {} });
    add(props.color, { type: "rich_text", rich_text: {} });
    add(props.tagUid, { type: "rich_text", rich_text: {} });
    add(props.trayUuid, { type: "rich_text", rich_text: {} });
    add(props.trayWeight, { type: "number", number: { format: "number" } });

    return properties;
  }

  looksLikeObjectNotFound(error) {
    return error?.code === "object_not_found" || error?.status === 404;
  }

  looksLikePageInsteadOfDatabase(error) {
    return (
      error?.code === "validation_error" &&
      typeof error?.message === "string" &&
      error.message.includes("is a page, not a database")
    );
  }

  async syncTrays(trays) {
    const seenAt = new Date();
    const uniqueTrays = uniqueByUid(trays);
    const activeUids = new Set(uniqueTrays.map((tray) => tray.uid));

    for (const tray of uniqueTrays) {
      await this.syncTray(tray, seenAt);
    }

    if (this.config.clearAbsentLoaded) {
      await this.clearAbsentLoaded(activeUids, seenAt);
    }
  }

  async syncTray(tray, seenAt) {
    const page = await this.findPageByUid(tray.uid);
    const properties = this.buildTrayProperties(tray, seenAt);
    const icon = swatchIcon(tray.color);
    const signature = JSON.stringify({ pageId: page?.id || null, properties, icon });

    if (this.lastSignatures.get(tray.uid) === signature) {
      this.logger.debug(`No Notion changes for ${tray.uid} (${tray.slotLabel})`);
      return;
    }

    if (page) {
      await this.updatePage(page.id, properties, tray, icon);
      this.lastSignatures.set(tray.uid, signature);
      return;
    }

    if (!this.config.createMissingPages) {
      this.logger.warn(`No Notion row bound to RFID Tag UID ${tray.uid}; skipping`);
      return;
    }

    await this.createMissingPage(tray, properties, icon);
    this.lastSignatures.set(tray.uid, signature);
  }

  async findPageByUid(uid) {
    const propName = this.config.properties.amsUid;
    const propSchema = this.assertProperty(propName, "RFID Tag UID lookup");
    const response = await this.client.dataSources.query({
      data_source_id: this.config.dataSourceId,
      filter: filterForExactValue(propName, propSchema, uid),
      page_size: 2
    });

    if (response.results.length > 1) {
      this.logger.warn(`Multiple Notion rows use RFID Tag UID ${uid}; updating the first one`);
    }

    return response.results[0] || null;
  }

  buildTrayProperties(tray, seenAt) {
    const props = this.config.properties;
    const entries = [
      this.valueFor(props.title, this.displayTitle(tray)),
      this.valueFor(props.amsUid, tray.uid),
      this.valueFor(props.remainPercent, tray.remainPercent),
      this.valueFor(props.remainGrams, tray.remainGrams),
      this.valueFor(props.amsSlot, tray.slotLabel),
      this.valueFor(props.loaded, true),
      this.valueFor(props.lastSync, seenAt),
      this.valueFor(props.printer, this.config.printerName),
      this.valueFor(props.material, tray.material),
      this.valueFor(props.color, tray.color),
      this.valueFor(props.tagUid, tray.tagUid),
      this.valueFor(props.trayUuid, tray.trayUuid),
      this.valueFor(props.trayWeight, tray.trayWeight)
    ];

    return compactObject(entries);
  }

  displayTitle(tray) {
    const material = tray.material || "Unknown";
    return `${material} · ${tray.uid.slice(0, 8)}`;
  }

  valueFor(propertyName, value) {
    if (!propertyName) return null;
    const schema = this.schema[propertyName];
    if (!schema) {
      if (!this.warnedMissingProperties.has(propertyName)) {
        this.warnedMissingProperties.add(propertyName);
        this.logger.warn(`Notion property "${propertyName}" does not exist; ignoring it`);
      }
      return null;
    }

    const payload = propertyPayload(propertyName, schema, value);
    if (!payload && !this.warnedMissingProperties.has(`${propertyName}:${schema.type}`)) {
      this.warnedMissingProperties.add(`${propertyName}:${schema.type}`);
      this.logger.warn(`Notion property "${propertyName}" type "${schema.type}" is not writable by this syncer`);
    }
    return payload;
  }

  async updatePage(pageId, properties, tray, icon) {
    if (Object.keys(properties).length === 0) {
      this.logger.warn(`No writable Notion properties configured for RFID Tag UID ${tray.uid}`);
      return;
    }

    if (this.config.dryRun) {
      this.logger.info(
        `[dry-run] Would update Notion page ${publicPageId(pageId)} for ${tray.uid} (${tray.slotLabel})`
      );
      return;
    }

    await this.client.pages.update({ page_id: pageId, properties, ...(icon ? { icon } : {}) });
    this.logger.info(
      `Updated Notion page ${publicPageId(pageId)}: ${tray.uid} ${tray.slotLabel} ${tray.remainPercent ?? "?"}%`
    );
  }

  async createMissingPage(tray, properties, icon) {
    const titleProp = this.findTitleProperty();
    if (!titleProp) {
      this.logger.warn(`Cannot create missing row for ${tray.uid}: no title property found`);
      return;
    }

    const title = this.displayTitle(tray);
    const titleValue = titleProp.name === this.config.properties.amsUid ? tray.uid : title;
    const createProperties = {
      ...properties,
      [titleProp.name]: { title: [{ type: "text", text: { content: titleValue } }] }
    };

    if (this.config.dryRun) {
      this.logger.info(`[dry-run] Would create missing Notion row "${title}" for RFID Tag UID ${tray.uid}`);
      return;
    }

    await this.client.pages.create({
      parent: { data_source_id: this.config.dataSourceId },
      properties: createProperties,
      ...(icon ? { icon } : {})
    });
    this.logger.info(`Created missing Notion row "${title}" for RFID Tag UID ${tray.uid}`);
  }

  async clearAbsentLoaded(activeUids, seenAt) {
    const props = this.config.properties;
    if (!props.loaded) return;

    const loadedSchema = this.schema[props.loaded];
    if (!loadedSchema || loadedSchema.type !== "checkbox") {
      this.logger.warn("CLEAR_ABSENT_LOADED requires 当前在机/loaded property to be a checkbox");
      return;
    }

    const pages = await this.queryAll(checkboxFilter(props.loaded, true));

    for (const page of pages) {
      const uid = getPlainText(page.properties?.[props.amsUid]);
      if (!uid || activeUids.has(uid)) continue;

      const properties = compactObject([
        this.valueFor(props.loaded, false),
        this.valueFor(props.lastSync, seenAt)
      ]);

      if (this.config.dryRun) {
        this.logger.info(`[dry-run] Would mark Notion page ${publicPageId(page.id)} as not loaded (${uid})`);
      } else {
        await this.client.pages.update({ page_id: page.id, properties });
        this.logger.info(`Marked Notion page ${publicPageId(page.id)} as not loaded (${uid})`);
      }
    }
  }

  async queryAll(filter) {
    const results = [];
    let startCursor;

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.config.dataSourceId,
        filter,
        page_size: 100,
        start_cursor: startCursor
      });
      results.push(...response.results);
      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    return results;
  }

  assertProperty(propertyName, label) {
    const schema = this.schema?.[propertyName];
    if (!schema) throw new Error(`Notion property "${propertyName}" is required for ${label}`);
    return schema;
  }

  findTitleProperty() {
    const configured = this.config.properties.title;
    if (configured && this.schema[configured]?.type === "title") {
      return { name: configured, schema: this.schema[configured] };
    }

    const [name, schema] =
      Object.entries(this.schema).find(([, propertySchema]) => propertySchema.type === "title") || [];
    return name ? { name, schema } : null;
  }
}
