import { createHash } from "node:crypto";
import { Client } from "@notionhq/client";
import {
  checkboxFilter,
  filterForExactValue,
  getPlainText,
  propertyPayload
} from "./notion-properties.js";

const NOTION_MIN_REQUEST_INTERVAL_MS = 400;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

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

function textContent(value) {
  return [{ type: "text", text: { content: value == null ? "" : String(value).slice(0, 2000) } }];
}

function propId(propertyName, schema) {
  return schema?.id || propertyName;
}

function toFiniteNumber(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function toIsoDate(value) {
  if (!value || value === "0") return null;
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value.toISOString();

  const stringValue = String(value);
  const numeric = Number(stringValue);
  if (Number.isFinite(numeric) && numeric > 0) {
    const millis = numeric < 10_000_000_000 ? numeric * 1000 : numeric;
    return new Date(millis).toISOString();
  }

  const parsed = new Date(stringValue);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function hashString(value) {
  return createHash("sha1").update(String(value)).digest("hex").slice(0, 16);
}

function uniq(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function getSelectName(propertyValue) {
  return propertyValue?.select?.name || propertyValue?.status?.name || "";
}

function getNumberValue(propertyValue) {
  return propertyValue?.number == null ? null : Number(propertyValue.number);
}

function getDateValue(propertyValue) {
  return propertyValue?.date?.start || "";
}

function stableMediaSource(value) {
  const source = String(value || "");
  if (!source) return "";

  try {
    const url = new URL(source);
    return `${url.origin}${url.pathname}`;
  } catch {
    return source;
  }
}

function roundNumber(value, digits = 2) {
  const number = Number(value);
  if (!Number.isFinite(number)) return null;
  const factor = 10 ** digits;
  return Math.round(number * factor) / factor;
}

function normalizeColor(value) {
  const hex = String(value || "").replace("#", "").slice(0, 6).toUpperCase();
  return /^[0-9A-F]{6}$/.test(hex) ? `#${hex}` : "";
}

function getFileValues(propertyValue) {
  return Array.isArray(propertyValue?.files) ? propertyValue.files : [];
}

function getRelationIds(propertyValue) {
  return Array.isArray(propertyValue?.relation) ? propertyValue.relation.map((item) => item.id).filter(Boolean) : [];
}

function slotLabel(amsId, slotId) {
  const amsIndex = Number.parseInt(amsId, 10);
  const slotIndex = Number.parseInt(slotId, 10);
  const prefix = Number.isFinite(amsIndex) ? String.fromCharCode(65 + amsIndex) : String(amsId);
  return `${prefix}${Number.isFinite(slotIndex) ? slotIndex : slotId}`;
}

function slotLabelFromTrayIndex(value) {
  const trayIndex = Number.parseInt(value, 10);
  if (!Number.isFinite(trayIndex) || trayIndex < 0 || trayIndex >= 254) return "";
  return slotLabel(Math.floor(trayIndex / 4), trayIndex % 4);
}

function isZeroish(value) {
  return value == null || value === "" || /^0+$/.test(String(value));
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
    this.notionRequestQueue = Promise.resolve();
    this.lastNotionRequestAt = 0;
    this.installNotionRequestLimiter();
    this.schema = null;
    this.parentPageId = null;
    this.taskDatabaseId = null;
    this.taskDataSourceId = null;
    this.taskSchema = null;
    this.taskFilamentDataSourceId = null;
    this.taskFilamentSchema = null;
    this.warnedMissingProperties = new Set();
    this.warnedMissingTaskProperties = new Set();
    this.warnedMissingTaskFilamentProperties = new Set();
    this.lastSignatures = new Map();
    this.lastTaskSignatures = new Map();
    this.activeTasks = new Map();
  }

  installNotionRequestLimiter() {
    const originalRequest = this.client.request.bind(this.client);
    this.client.request = async (args) => {
      const run = async () => {
        const elapsed = Date.now() - this.lastNotionRequestAt;
        const waitMs = Math.max(0, NOTION_MIN_REQUEST_INTERVAL_MS - elapsed);
        if (waitMs > 0) await sleep(waitMs);
        this.lastNotionRequestAt = Date.now();
        return originalRequest(args);
      };

      const request = this.notionRequestQueue.then(run, run);
      this.notionRequestQueue = request.catch(() => {});
      return request;
    };
  }

  async init() {
    if (!this.client.dataSources?.retrieve || !this.client.dataSources?.query || !this.client.dataSources?.update) {
      throw new Error("Installed @notionhq/client does not support dataSources. Run npm install with the bundled package.json.");
    }

    const dataSource = await this.resolveDataSource(this.config.dataSourceId);

    this.schema = dataSource.properties || {};
    await this.ensureAmsSchema();
    await this.ensureTaskDataSource();
    await this.ensureTaskFilamentDataSource();
    await this.ensureTaskSchema({ refresh: true });
    await this.ensureTaskDefaultView();
    this.logger.info(
      `Loaded Notion data source ${this.config.dataSourceId} schema with ${Object.keys(this.schema).length} properties`
    );
  }

  async resolveDataSource(id) {
    try {
      const dataSource = await this.client.dataSources.retrieve({ data_source_id: id });
      await this.rememberParentPageFromDataSource(dataSource);
      return dataSource;
    } catch (error) {
      if (!this.looksLikeObjectNotFound(error)) throw error;
    }

    try {
      const database = await this.client.databases.retrieve({ database_id: id });
      this.rememberParentPageFromDatabase(database);
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
      this.parentPageId = id;
    } catch {
      throw new Error(
        `Cannot find Notion target ${id}. Share the page/database with your Notion integration, then restart the sync service.`
      );
    }

    return this.ensureAmsDataSourceOnPage(id);
  }

  rememberParentPageFromDatabase(database) {
    if (database?.parent?.type === "page_id" && database.parent.page_id) {
      this.parentPageId = database.parent.page_id;
    }
  }

  async rememberParentPageFromDataSource(dataSource) {
    if (dataSource?.parent?.type === "page_id" && dataSource.parent.page_id) {
      this.parentPageId = dataSource.parent.page_id;
      return;
    }

    const databaseId = dataSource?.database_parent?.id;
    if (!databaseId) return;

    try {
      const database = await this.client.databases.retrieve({ database_id: databaseId });
      this.rememberParentPageFromDatabase(database);
    } catch {
      // The AMS sync can still work with a direct data source even if sibling tables cannot be inferred.
    }
  }

  async ensureAmsDataSourceOnPage(pageId) {
    this.parentPageId = pageId;
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

  async ensureTaskDataSource() {
    if (!this.parentPageId) {
      this.logger.warn("Cannot infer Notion parent page for print task database; print task sync is disabled");
      return;
    }

    const databaseName = this.config.taskDatabaseName || "打印任务";
    const existingDatabaseId = await this.findChildDatabase(this.parentPageId, databaseName);
    const database = existingDatabaseId
      ? await this.client.databases.retrieve({ database_id: existingDatabaseId })
      : await this.createTaskDatabase(this.parentPageId, databaseName);
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(`Print task database "${databaseName}" has no data source`);

    this.taskDatabaseId = database.id;
    this.taskDataSourceId = dataSourceId;
    this.logger.info(`Using Notion print task database "${databaseName}" data source ${dataSourceId}`);
    await this.refreshTaskSchema();
    await this.ensureTaskSchema();
  }

  async createTaskDatabase(pageId, title) {
    const properties = this.buildTaskDatabaseProperties();
    this.logger.info(`Creating Notion database "${title}" under page ${pageId}`);
    return this.client.databases.create({
      parent: { type: "page_id", page_id: pageId },
      title: [{ type: "text", text: { content: title } }],
      is_inline: false,
      initial_data_source: { properties }
    });
  }

  async ensureTaskFilamentDataSource() {
    if (!this.parentPageId || !this.taskDataSourceId) {
      this.logger.warn("Cannot infer Notion parent page for print task filament database; filament usage sync is disabled");
      return;
    }

    const databaseName = this.config.taskFilamentDatabaseName || "打印任务耗材";
    const existingDatabaseId = await this.findChildDatabase(this.parentPageId, databaseName);
    const database = existingDatabaseId
      ? await this.client.databases.retrieve({ database_id: existingDatabaseId })
      : await this.createTaskFilamentDatabase(this.parentPageId, databaseName);
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(`Print task filament database "${databaseName}" has no data source`);

    this.taskFilamentDataSourceId = dataSourceId;
    this.logger.info(`Using Notion print task filament database "${databaseName}" data source ${dataSourceId}`);
    await this.refreshTaskFilamentSchema();
    await this.ensureTaskFilamentSchema();
  }

  async createTaskFilamentDatabase(pageId, title) {
    const properties = this.buildTaskFilamentDatabaseProperties();
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

  buildTaskDatabaseProperties() {
    const props = this.config.taskProperties;
    const properties = {
      [props.title]: { type: "title", title: {} }
    };

    const add = (name, schema) => {
      if (name && name !== props.title) properties[name] = schema;
    };

    add(props.taskKey, { type: "rich_text", rich_text: {} });
    add(props.taskId, { type: "rich_text", rich_text: {} });
    add(props.printer, { type: "rich_text", rich_text: {} });
    add(props.printerSerial, { type: "rich_text", rich_text: {} });
    add(props.status, {
      type: "select",
      select: {
        options: [
          { name: "运行中", color: "blue" },
          { name: "暂停", color: "yellow" },
          { name: "已完成", color: "green" },
          { name: "失败", color: "red" },
          { name: "已取消", color: "gray" },
          { name: "未知", color: "default" }
        ]
      }
    });
    add(props.statusCode, { type: "number", number: { format: "number" } });
    add(props.syncStatus, {
      type: "select",
      select: {
        options: [
          { name: "正常", color: "green" },
          { name: "重复", color: "red" },
          { name: "已合并", color: "gray" }
        ]
      }
    });
    add(props.mergedTo, { type: "rich_text", rich_text: {} });
    add(props.printConfig, { type: "rich_text", rich_text: {} });
    add(props.startTime, { type: "date", date: {} });
    add(props.endTime, { type: "date", date: {} });
    add(props.durationMinutes, { type: "number", number: { format: "number" } });
    add(props.progress, { type: "number", number: { format: "number" } });
    add(props.layers, { type: "rich_text", rich_text: {} });
    add(props.filamentWeight, { type: "number", number: { format: "number" } });
    add(props.filamentLength, { type: "number", number: { format: "number" } });
    add(props.usedSlots, { type: "rich_text", rich_text: {} });
    add(props.filamentDetails, { type: "rich_text", rich_text: {} });
    if (props.usedFilaments && this.config.dataSourceId) {
      add(props.usedFilaments, {
        type: "relation",
        relation: {
          data_source_id: this.config.dataSourceId,
          type: "single_property",
          single_property: {}
        }
      });
    }
    if (props.filamentUsages && this.taskFilamentDataSourceId) {
      add(props.filamentUsages, {
        type: "relation",
        relation: {
          data_source_id: this.taskFilamentDataSourceId,
          type: "single_property",
          single_property: {}
        }
      });
    }
    add(props.thumbnail, { type: "files", files: {} });
    add(props.snapshot, { type: "files", files: {} });
    add(props.rawCoverUrl, { type: "url", url: {} });
    add(props.rawSnapshotUrl, { type: "url", url: {} });
    add(props.lastSync, { type: "date", date: {} });

    return properties;
  }

  buildTaskFilamentDatabaseProperties() {
    const props = this.config.taskFilamentProperties;
    const properties = {
      [props.title]: { type: "title", title: {} }
    };

    const add = (name, schema) => {
      if (name && name !== props.title) properties[name] = schema;
    };

    add(props.detailKey, { type: "rich_text", rich_text: {} });
    if (props.task && this.taskDataSourceId) {
      add(props.task, {
        type: "relation",
        relation: {
          data_source_id: this.taskDataSourceId,
          type: "single_property",
          single_property: {}
        }
      });
    }
    add(props.taskKey, { type: "rich_text", rich_text: {} });
    add(props.taskId, { type: "rich_text", rich_text: {} });
    add(props.slot, { type: "rich_text", rich_text: {} });
    add(props.material, { type: "rich_text", rich_text: {} });
    add(props.color, { type: "rich_text", rich_text: {} });
    add(props.weight, { type: "number", number: { format: "number" } });
    add(props.percent, { type: "number", number: { format: "number" } });
    add(props.lastSync, { type: "date", date: {} });

    return properties;
  }

  async refreshSchema() {
    const dataSource = await this.client.dataSources.retrieve({ data_source_id: this.config.dataSourceId });
    this.schema = dataSource.properties || {};
    return this.schema;
  }

  async ensureAmsSchema({ refresh = false } = {}) {
    if (refresh) await this.refreshSchema();

    let changed = await this.ensureTitleProperty();
    const expectedProperties = this.buildAmsDatabaseProperties();

    for (const [name, expectedSchema] of Object.entries(expectedProperties)) {
      if (name === this.config.properties.title || expectedSchema.type === "title") continue;
      if (await this.ensureProperty(name, expectedSchema)) changed = true;
    }

    if (changed) {
      await this.refreshSchema();
      this.warnedMissingProperties.clear();
    }

    this.assertProperty(this.config.properties.amsUid, "RFID Tag UID lookup");
  }

  async ensureTitleProperty() {
    const titleName = this.config.properties.title;
    if (!titleName) return false;

    const existing = this.schema[titleName];
    if (existing?.type === "title") return false;

    let changed = false;
    if (existing) {
      const tempName = this.availableTempPropertyName(titleName);
      await this.renameProperty(titleName, tempName);
      this.logger.warn(
        `Notion property "${titleName}" has type "${existing.type}", expected "title"; renamed it to "${tempName}"`
      );
      await this.refreshSchema();
      changed = true;
    }

    const titleProperty = this.findTitleProperty();
    if (!titleProperty) throw new Error("Notion AMS database has no title property");

    if (titleProperty.name !== titleName) {
      await this.renameProperty(titleProperty.name, titleName);
      this.logger.info(`Renamed Notion title property "${titleProperty.name}" to "${titleName}"`);
      changed = true;
    }

    return changed;
  }

  async ensureProperty(name, expectedSchema) {
    if (!name) return false;

    const existing = this.schema[name];
    if (!existing) {
      await this.createProperty(name, expectedSchema);
      this.logger.info(`Created missing Notion property "${name}" (${expectedSchema.type})`);
      await this.refreshSchema();
      return true;
    }

    if (existing.type === expectedSchema.type) return false;

    const tempName = this.availableTempPropertyName(name);
    await this.renameProperty(name, tempName);
    this.logger.warn(
      `Notion property "${name}" has type "${existing.type}", expected "${expectedSchema.type}"; renamed it to "${tempName}"`
    );
    await this.refreshSchema();

    await this.createProperty(name, expectedSchema);
    this.logger.info(`Created replacement Notion property "${name}" (${expectedSchema.type})`);
    await this.refreshSchema();
    return true;
  }

  availableTempPropertyName(name) {
    const names = new Set(Object.keys(this.schema || {}));
    const base = `${name}-temp`;
    if (!names.has(base)) return base;

    let index = 1;
    while (names.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  async renameProperty(name, nextName) {
    await this.client.dataSources.update({
      data_source_id: this.config.dataSourceId,
      properties: {
        [name]: { name: nextName }
      }
    });
  }

  async createProperty(name, schema) {
    await this.client.dataSources.update({
      data_source_id: this.config.dataSourceId,
      properties: {
        [name]: schema
      }
    });
  }

  async refreshTaskSchema() {
    if (!this.taskDataSourceId) return null;
    const dataSource = await this.client.dataSources.retrieve({ data_source_id: this.taskDataSourceId });
    this.taskSchema = dataSource.properties || {};
    return this.taskSchema;
  }

  async ensureTaskSchema({ refresh = false } = {}) {
    if (!this.taskDataSourceId) return;
    if (refresh) await this.refreshTaskSchema();

    let changed = await this.ensureTaskTitleProperty();
    const expectedProperties = this.buildTaskDatabaseProperties();

    for (const [name, expectedSchema] of Object.entries(expectedProperties)) {
      if (name === this.config.taskProperties.title || expectedSchema.type === "title") continue;
      if (await this.ensureTaskProperty(name, expectedSchema)) changed = true;
    }

    if (changed) {
      await this.refreshTaskSchema();
      this.warnedMissingTaskProperties.clear();
    }

    this.assertTaskProperty(this.config.taskProperties.taskKey, "print task lookup");
  }

  async ensureTaskDefaultView() {
    if (!this.taskDatabaseId || !this.taskDataSourceId || !this.client.views?.list || !this.client.views?.create || !this.client.views?.update) {
      return;
    }

    const viewName = "Default view";
    const request = {
      name: viewName,
      type: "gallery",
      sorts: this.taskGalleryViewSorts(),
      configuration: this.taskGalleryViewConfiguration()
    };
    if (!request.configuration) return;

    const views = await this.client.views.list({ data_source_id: this.taskDataSourceId, page_size: 100 });
    const existing = await this.findTaskViewByName(views.results || [], viewName);

    if (existing?.type === "gallery") {
      await this.client.views.update({ view_id: existing.id, ...request });
      this.logger.info(`Updated Notion print task default gallery view "${viewName}"`);
      return;
    }

    const created = await this.client.views.create({
      data_source_id: this.taskDataSourceId,
      database_id: this.taskDatabaseId,
      ...request,
      position: { type: "start" }
    });
    this.logger.info(`Created Notion print task default gallery view "${viewName}"`);

    if (existing && this.client.views?.delete) {
      await this.client.views.delete({ view_id: existing.id });
      this.logger.info(`Deleted old Notion print task default view ${existing.id}`);
    }

    return created;
  }

  async findTaskViewByName(viewRefs, name) {
    for (const ref of viewRefs) {
      try {
        const view = await this.client.views.retrieve({ view_id: ref.id });
        if (view.name === name) return view;
      } catch (error) {
        this.logger.warn(`Cannot inspect Notion print task view ${ref.id}: ${error.message}`);
      }
    }
    return null;
  }

  taskGalleryViewSorts() {
    const startTime = this.taskSchema?.[this.config.taskProperties.startTime];
    if (!startTime) return [];
    return [{ property: startTime.id || this.config.taskProperties.startTime, direction: "descending" }];
  }

  taskGalleryViewConfiguration() {
    const props = this.config.taskProperties;
    const snapshot = this.taskSchema?.[props.snapshot];
    const visiblePropertyNames = [props.title, props.status, props.filamentUsages].filter(Boolean);
    const propertyNames = uniq([
      ...visiblePropertyNames,
      ...Object.keys(this.taskSchema || {})
    ]);
    const visibleNames = new Set(visiblePropertyNames);
    const properties = propertyNames.map((name) => {
      const schema = this.taskSchema[name];
      if (!schema) return null;
      const visible = visibleNames.has(name);
      return {
        property_id: propId(name, schema),
        visible,
        wrap: true,
        ...(visible && schema.type !== "title" ? { card_property_width_mode: "full_line" } : {})
      };
    }).filter(Boolean);

    return {
      type: "gallery",
      properties,
      cover: snapshot ? { type: "property", property_id: propId(props.snapshot, snapshot) } : { type: "page_cover" },
      cover_size: "small",
      cover_aspect: "cover",
      card_layout: "list"
    };
  }

  async ensureTaskTitleProperty() {
    const titleName = this.config.taskProperties.title;
    if (!titleName) return false;

    const existing = this.taskSchema[titleName];
    if (existing?.type === "title") return false;

    let changed = false;
    if (existing) {
      const tempName = this.availableTaskTempPropertyName(titleName);
      await this.renameTaskProperty(titleName, tempName);
      this.logger.warn(
        `Notion print task property "${titleName}" has type "${existing.type}", expected "title"; renamed it to "${tempName}"`
      );
      await this.refreshTaskSchema();
      changed = true;
    }

    const titleProperty = this.findTaskTitleProperty();
    if (!titleProperty) throw new Error("Notion print task database has no title property");

    if (titleProperty.name !== titleName) {
      await this.renameTaskProperty(titleProperty.name, titleName);
      this.logger.info(`Renamed Notion print task title property "${titleProperty.name}" to "${titleName}"`);
      changed = true;
    }

    return changed;
  }

  async ensureTaskProperty(name, expectedSchema) {
    if (!name) return false;

    const existing = this.taskSchema[name];
    if (!existing) {
      await this.createTaskProperty(name, expectedSchema);
      this.logger.info(`Created missing Notion print task property "${name}" (${expectedSchema.type})`);
      await this.refreshTaskSchema();
      return true;
    }

    if (existing.type === expectedSchema.type) return false;

    const tempName = this.availableTaskTempPropertyName(name);
    await this.renameTaskProperty(name, tempName);
    this.logger.warn(
      `Notion print task property "${name}" has type "${existing.type}", expected "${expectedSchema.type}"; renamed it to "${tempName}"`
    );
    await this.refreshTaskSchema();

    await this.createTaskProperty(name, expectedSchema);
    this.logger.info(`Created replacement Notion print task property "${name}" (${expectedSchema.type})`);
    await this.refreshTaskSchema();
    return true;
  }

  availableTaskTempPropertyName(name) {
    const names = new Set(Object.keys(this.taskSchema || {}));
    const base = `${name}-temp`;
    if (!names.has(base)) return base;

    let index = 1;
    while (names.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  async renameTaskProperty(name, nextName) {
    await this.client.dataSources.update({
      data_source_id: this.taskDataSourceId,
      properties: {
        [name]: { name: nextName }
      }
    });
  }

  async createTaskProperty(name, schema) {
    await this.client.dataSources.update({
      data_source_id: this.taskDataSourceId,
      properties: {
        [name]: schema
      }
    });
  }

  async refreshTaskFilamentSchema() {
    if (!this.taskFilamentDataSourceId) return null;
    const dataSource = await this.client.dataSources.retrieve({ data_source_id: this.taskFilamentDataSourceId });
    this.taskFilamentSchema = dataSource.properties || {};
    return this.taskFilamentSchema;
  }

  async ensureTaskFilamentSchema({ refresh = false } = {}) {
    if (!this.taskFilamentDataSourceId) return;
    if (refresh) await this.refreshTaskFilamentSchema();

    let changed = await this.ensureTaskFilamentTitleProperty();
    const expectedProperties = this.buildTaskFilamentDatabaseProperties();

    for (const [name, expectedSchema] of Object.entries(expectedProperties)) {
      if (name === this.config.taskFilamentProperties.title || expectedSchema.type === "title") continue;
      if (await this.ensureTaskFilamentProperty(name, expectedSchema)) changed = true;
    }

    if (changed) {
      await this.refreshTaskFilamentSchema();
      this.warnedMissingTaskFilamentProperties.clear();
    }

    this.assertTaskFilamentProperty(this.config.taskFilamentProperties.detailKey, "print task filament lookup");
  }

  async ensureTaskFilamentTitleProperty() {
    const titleName = this.config.taskFilamentProperties.title;
    if (!titleName) return false;

    const existing = this.taskFilamentSchema[titleName];
    if (existing?.type === "title") return false;

    let changed = false;
    if (existing) {
      const tempName = this.availableTaskFilamentTempPropertyName(titleName);
      await this.renameTaskFilamentProperty(titleName, tempName);
      this.logger.warn(
        `Notion print task filament property "${titleName}" has type "${existing.type}", expected "title"; renamed it to "${tempName}"`
      );
      await this.refreshTaskFilamentSchema();
      changed = true;
    }

    const titleProperty = this.findTaskFilamentTitleProperty();
    if (!titleProperty) throw new Error("Notion print task filament database has no title property");

    if (titleProperty.name !== titleName) {
      await this.renameTaskFilamentProperty(titleProperty.name, titleName);
      this.logger.info(`Renamed Notion print task filament title property "${titleProperty.name}" to "${titleName}"`);
      changed = true;
    }

    return changed;
  }

  async ensureTaskFilamentProperty(name, expectedSchema) {
    if (!name) return false;

    const existing = this.taskFilamentSchema[name];
    if (!existing) {
      await this.createTaskFilamentProperty(name, expectedSchema);
      this.logger.info(`Created missing Notion print task filament property "${name}" (${expectedSchema.type})`);
      await this.refreshTaskFilamentSchema();
      return true;
    }

    if (existing.type === expectedSchema.type) return false;

    const tempName = this.availableTaskFilamentTempPropertyName(name);
    await this.renameTaskFilamentProperty(name, tempName);
    this.logger.warn(
      `Notion print task filament property "${name}" has type "${existing.type}", expected "${expectedSchema.type}"; renamed it to "${tempName}"`
    );
    await this.refreshTaskFilamentSchema();

    await this.createTaskFilamentProperty(name, expectedSchema);
    this.logger.info(`Created replacement Notion print task filament property "${name}" (${expectedSchema.type})`);
    await this.refreshTaskFilamentSchema();
    return true;
  }

  availableTaskFilamentTempPropertyName(name) {
    const names = new Set(Object.keys(this.taskFilamentSchema || {}));
    const base = `${name}-temp`;
    if (!names.has(base)) return base;

    let index = 1;
    while (names.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  async renameTaskFilamentProperty(name, nextName) {
    await this.client.dataSources.update({
      data_source_id: this.taskFilamentDataSourceId,
      properties: {
        [name]: { name: nextName }
      }
    });
  }

  async createTaskFilamentProperty(name, schema) {
    await this.client.dataSources.update({
      data_source_id: this.taskFilamentDataSourceId,
      properties: {
        [name]: schema
      }
    });
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
    await this.ensureAmsSchema({ refresh: true });

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
    const titleKey = titleProp.schema.id || titleProp.name;
    const createProperties = {
      ...properties,
      [titleKey]: { title: [{ type: "text", text: { content: titleValue } }] }
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

    const pages = await this.queryAll(checkboxFilter(props.loaded, true, loadedSchema));

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

  async syncPrinterStatus(printState) {
    if (!this.taskDataSourceId) return;

    const record = this.printTaskRecordFromPrinterState(printState);
    if (!record) return;

    const previous = this.activeTasks.get(record.taskKey);
    const merged = this.mergeTaskRecords(previous?.record, record);
    const shouldWrite = this.shouldWritePrintTask(previous, merged);
    this.activeTasks.set(record.taskKey, {
      record: merged,
      lastProgress: previous?.lastProgress ?? null,
      lastWriteAt: previous?.lastWriteAt || 0,
      lastStatus: previous?.lastStatus || ""
    });

    if (!shouldWrite) return;

    await this.upsertPrintTask(merged);
    this.activeTasks.set(record.taskKey, {
      record: merged,
      lastProgress: merged.progress,
      lastWriteAt: Date.now(),
      lastStatus: merged.status
    });
  }

  async syncCloudPrintTasks(tasks) {
    if (!this.taskDataSourceId || !Array.isArray(tasks) || tasks.length === 0) return;

    await this.ensureTaskSchema({ refresh: true });
    this.logger.info(`Syncing ${tasks.length} Bambu cloud print task(s) into Notion`);

    for (const task of tasks) {
      const record = this.printTaskRecordFromCloudTask(task);
      if (!record) continue;
      await this.upsertPrintTask(record);
    }
  }

  printTaskRecordFromCloudTask(task) {
    const taskId = task?.id == null ? "" : String(task.id);
    const taskKey = this.taskKey({ taskId });
    if (!taskKey) return null;

    const startTime = toIsoDate(task.startTime);
    const endTime = toIsoDate(task.endTime);
    const durationMinutes = this.durationMinutes(startTime, endTime, task.costTime);
    const usedSlots = this.slotLabelsFromCloudTask(task);
    const status = this.statusFromCloudTask(task.status);
    const snapshotUrl = task.snapShot || (status === "失败" ? task.cover || "" : "");
    const filamentUsages = this.filamentUsagesFromCloudTask(task, usedSlots);

    return {
      source: "cloud",
      taskKey,
      taskId,
      title: task.designTitle || task.title || `打印任务 ${taskId}`,
      printConfig: task.title || "",
      printer: task.deviceName || this.config.printerName,
      printerSerial: task.deviceId || this.config.printerSerial,
      status,
      statusCode: toFiniteNumber(task.status),
      startTime,
      endTime,
      durationMinutes,
      progress: null,
      layers: "",
      filamentWeight: toFiniteNumber(task.weight),
      filamentLength: this.filamentLengthMeters(task.length),
      usedSlots,
      usedFilamentUids: [],
      filamentDetails: this.filamentDetailsFromUsages(filamentUsages),
      filamentUsages,
      coverUrl: task.cover || "",
      snapshotUrl
    };
  }

  printTaskRecordFromPrinterState(printState) {
    const taskId = printState?.task_id || printState?.subtask_id || "";
    const taskKey = this.taskKey({
      taskId,
      subtaskId: printState?.subtask_id,
      projectId: printState?.project_id,
      profileId: printState?.profile_id,
      gcodeFile: printState?.gcode_file,
      gcodeStartTime: printState?.gcode_start_time
    });
    if (!taskKey) return null;

    const progress = toFiniteNumber(printState.mc_percent);
    const tray = this.currentTrayFromPrinterState(printState);
    const usedSlots = tray.slotLabel ? [tray.slotLabel] : [];
    const usedFilamentUids = tray.uid ? [tray.uid] : [];

    return {
      source: "mqtt",
      taskKey,
      taskId: taskId ? String(taskId) : "",
      title: printState.subtask_name || printState.gcode_file || `打印任务 ${taskId || taskKey.slice(-8)}`,
      printConfig: printState.subtask_name || "",
      printer: this.config.printerName,
      printerSerial: this.config.printerSerial,
      status: this.statusFromGcodeState(printState.gcode_state),
      statusCode: toFiniteNumber(printState.print_error),
      startTime: toIsoDate(printState.gcode_start_time),
      endTime: this.isTerminalTaskStatus(this.statusFromGcodeState(printState.gcode_state))
        ? new Date().toISOString()
        : null,
      durationMinutes: null,
      progress,
      layers: this.layersText(printState.layer_num, printState.total_layer_num),
      filamentWeight: null,
      filamentLength: null,
      usedSlots,
      usedFilamentUids,
      filamentDetails: "",
      filamentUsages: [],
      coverUrl: "",
      snapshotUrl: ""
    };
  }

  taskKey({ taskId, subtaskId, projectId, profileId, gcodeFile, gcodeStartTime }) {
    const printerSerial = this.config.printerSerial;
    if (!printerSerial) return "";
    if (taskId) return `bambu:${printerSerial}:task:${taskId}`;
    if (subtaskId) return `bambu:${printerSerial}:subtask:${subtaskId}`;
    if (projectId && profileId) return `bambu:${printerSerial}:project:${projectId}:profile:${profileId}`;
    if (gcodeFile && gcodeStartTime && gcodeStartTime !== "0") {
      return `bambu:${printerSerial}:gcode:${hashString(`${gcodeFile}:${gcodeStartTime}`)}`;
    }
    return "";
  }

  statusFromCloudTask(status) {
    const value = Number(status);
    if (value === 1) return "运行中";
    if (value === 2) return "已完成";
    if (value === 3) return "失败";
    if (value === 4) return "已取消";
    return "未知";
  }

  statusFromGcodeState(state) {
    const value = String(state || "").toUpperCase();
    if (["RUNNING", "PREPARE", "PREPARING", "SLICING", "PRINTING"].includes(value)) return "运行中";
    if (["PAUSE", "PAUSED"].includes(value)) return "暂停";
    if (["FINISH", "FINISHED", "COMPLETED"].includes(value)) return "已完成";
    if (["FAILED", "FAIL"].includes(value)) return "失败";
    if (["CANCEL", "CANCELLED", "CANCELED"].includes(value)) return "已取消";
    return "未知";
  }

  isTerminalTaskStatus(status) {
    return ["已完成", "失败", "已取消"].includes(status);
  }

  shouldWritePrintTask(previous, record) {
    if (!previous) return true;
    if (this.isTerminalTaskStatus(record.status) && previous.lastStatus !== record.status) return true;
    if (record.status && record.status !== previous.lastStatus) return true;

    const progress = record.progress;
    if (
      progress != null &&
      (previous.lastProgress == null || progress - previous.lastProgress >= this.config.printTaskProgressStep)
    ) {
      return true;
    }

    const oldSlots = previous.record?.usedSlots || [];
    const newSlots = record.usedSlots || [];
    if (newSlots.some((slot) => !oldSlots.includes(slot))) return true;

    return Date.now() - previous.lastWriteAt >= this.config.printTaskUpdateIntervalMs;
  }

  mergeTaskRecords(previous, next) {
    if (!previous) return next;

    const status = this.isTerminalTaskStatus(previous.status) && !this.isTerminalTaskStatus(next.status)
      ? previous.status
      : next.status || previous.status;

    return {
      ...previous,
      ...next,
      status,
      title: next.title || previous.title,
      printConfig: next.printConfig || previous.printConfig,
      startTime: next.startTime || previous.startTime,
      endTime: next.endTime || previous.endTime,
      durationMinutes: next.durationMinutes ?? previous.durationMinutes,
      progress: Math.max(previous.progress ?? 0, next.progress ?? 0),
      layers: next.layers || previous.layers,
      filamentWeight: next.filamentWeight ?? previous.filamentWeight,
      filamentLength: next.filamentLength ?? previous.filamentLength,
      usedSlots: uniq([...(previous.usedSlots || []), ...(next.usedSlots || [])]),
      usedFilamentUids: uniq([...(previous.usedFilamentUids || []), ...(next.usedFilamentUids || [])]),
      filamentDetails: next.filamentDetails || previous.filamentDetails,
      filamentUsages: next.filamentUsages?.length ? next.filamentUsages : previous.filamentUsages,
      coverUrl: next.coverUrl || previous.coverUrl,
      snapshotUrl: next.snapshotUrl || previous.snapshotUrl
    };
  }

  currentTrayFromPrinterState(printState) {
    const trayNow = printState?.ams?.tray_now;
    const label = slotLabelFromTrayIndex(trayNow);
    const trayIndex = Number.parseInt(trayNow, 10);
    if (!label || !Array.isArray(printState?.ams?.ams)) return { slotLabel: label, uid: "" };

    const amsId = String(Math.floor(trayIndex / 4));
    const slotId = String(trayIndex % 4);
    const ams = printState.ams.ams.find((item) => String(item.id) === amsId);
    const tray = ams?.tray?.find((item) => String(item.id) === slotId);
    const uid = tray && !isZeroish(tray.tag_uid) ? String(tray.tag_uid) : "";
    return { slotLabel: label, uid };
  }

  slotLabelsFromCloudTask(task) {
    const mappings = Array.isArray(task?.amsMapping2) ? task.amsMapping2 : [];
    const fromMapping2 = mappings
      .filter((item) => Number(item.amsId) !== 255 && Number(item.slotId) !== 255)
      .map((item) => slotLabel(item.amsId, item.slotId));
    if (fromMapping2.length > 0) return uniq(fromMapping2);

    const mapping = Array.isArray(task?.amsMapping) ? task.amsMapping : [];
    return uniq(mapping.filter((value) => Number(value) >= 0).map((value) => slotLabelFromTrayIndex(value)));
  }

  filamentDetailsFromCloudTask(task, usedSlots) {
    return this.filamentDetailsFromUsages(this.filamentUsagesFromCloudTask(task, usedSlots));
  }

  filamentUsagesFromCloudTask(task, usedSlots) {
    const details = Array.isArray(task?.amsDetailMapping) ? task.amsDetailMapping : [];
    if (details.length === 0) return [];

    const totalWeight = toFiniteNumber(task.weight);
    return details
      .map((detail, index) => {
        const weight = toFiniteNumber(detail.weight);
        const slot = usedSlots[index] ||
          (Number(detail.amsId) !== 255 && Number(detail.slotId) !== 255
            ? slotLabel(detail.amsId, detail.slotId)
            : slotLabelFromTrayIndex(detail.ams));
        return {
          index,
          slot,
          material: detail.targetFilamentType || detail.filamentType || "",
          color: normalizeColor(detail.targetColor || detail.sourceColor),
          weight: roundNumber(weight, 2),
          percent: totalWeight && weight != null ? roundNumber((weight / totalWeight) * 100, 2) : null
        };
      })
      .filter((usage) => usage.slot || usage.material || usage.color || usage.weight != null);
  }

  filamentDetailsFromUsages(usages) {
    return (usages || [])
      .map((usage) => [
        usage.material,
        usage.weight == null ? "" : `${usage.weight}g`,
        usage.color
      ].filter(Boolean).join(" "))
      .filter(Boolean)
      .join("; ");
  }

  durationMinutes(startTime, endTime, costTime) {
    if (startTime && endTime) {
      const start = new Date(startTime).getTime();
      const end = new Date(endTime).getTime();
      if (Number.isFinite(start) && Number.isFinite(end) && end >= start) {
        return Math.round((end - start) / 60000);
      }
    }

    const seconds = toFiniteNumber(costTime);
    return seconds == null ? null : Math.round(seconds / 60);
  }

  filamentLengthMeters(length) {
    const value = toFiniteNumber(length);
    return value == null ? null : Math.round((value / 100) * 100) / 100;
  }

  layersText(layer, total) {
    const current = toFiniteNumber(layer);
    const count = toFiniteNumber(total);
    if (current == null && count == null) return "";
    return `${current ?? "?"}/${count ?? "?"}`;
  }

  async upsertPrintTask(record) {
    await this.ensureTaskSchema({ refresh: true });
    const pages = await this.findTaskPagesByKey(record.taskKey);
    const canonical = pages.length > 0 ? this.chooseCanonicalTaskPage(pages) : null;
    const media = await this.prepareTaskMedia(record, canonical);
    const properties = await this.buildPrintTaskProperties(record, canonical, media, pages);
    const signature = JSON.stringify({
      pageId: canonical?.id || null,
      properties,
      cover: media.coverUpload?.id || media.coverExternalUrl || ""
    });

    if (canonical && this.lastTaskSignatures.get(record.taskKey) === signature && pages.length <= 1) {
      this.logger.debug(`No Notion changes for print task ${record.taskKey}`);
      return;
    }

    if (this.config.dryRun) {
      this.logger.info(
        `[dry-run] Would ${canonical ? "update" : "create"} Notion print task "${record.title}" (${record.taskKey})`
      );
      return;
    }

    let pageId = canonical?.id;
    if (pageId) {
      await this.client.pages.update({
        page_id: pageId,
        properties,
        ...(media.pageCover ? { cover: media.pageCover } : {})
      });
      this.logger.info(`Updated Notion print task ${publicPageId(pageId)}: ${record.title}`);
    } else {
      const created = await this.client.pages.create({
        parent: { data_source_id: this.taskDataSourceId },
        properties,
        ...(media.pageCover ? { cover: media.pageCover } : {})
      });
      pageId = created.id;
      this.logger.info(`Created Notion print task "${record.title}" (${record.taskKey})`);
    }

    const freshPages = await this.findTaskPagesByKey(record.taskKey);
    if (freshPages.length > 1) {
      const freshCanonical = this.chooseCanonicalTaskPage(freshPages);
      await this.markDuplicateTaskPages(record.taskKey, freshPages, freshCanonical.id);
    }

    const usagePageIds = await this.syncTaskFilamentUsages(record, pageId);
    if (usagePageIds.length > 0) {
      await this.updateTaskFilamentUsageRelation(pageId, usagePageIds);
    }

    this.lastTaskSignatures.set(record.taskKey, signature);
  }

  async findTaskPagesByKey(taskKey) {
    const propName = this.config.taskProperties.taskKey;
    const propSchema = this.assertTaskProperty(propName, "print task lookup");
    const response = await this.client.dataSources.query({
      data_source_id: this.taskDataSourceId,
      filter: filterForExactValue(propName, propSchema, taskKey),
      page_size: 100
    });
    return response.results || [];
  }

  chooseCanonicalTaskPage(pages) {
    return [...pages].sort((a, b) => {
      const scoreDiff = this.taskPageCompletenessScore(b) - this.taskPageCompletenessScore(a);
      if (scoreDiff !== 0) return scoreDiff;
      return String(a.created_time || "").localeCompare(String(b.created_time || ""));
    })[0];
  }

  taskPageCompletenessScore(page) {
    const props = this.config.taskProperties;
    const properties = page.properties || {};
    let score = 0;
    if (getDateValue(properties[props.endTime])) score += 5;
    if (getFileValues(properties[props.snapshot]).length > 0) score += 4;
    if (getFileValues(properties[props.thumbnail]).length > 0) score += 3;
    score += getRelationIds(properties[props.usedFilaments]).length;
    if (getNumberValue(properties[props.filamentWeight]) != null) score += 2;
    return score;
  }

  async markDuplicateTaskPages(taskKey, pages, canonicalPageId) {
    const props = this.config.taskProperties;
    for (const page of pages) {
      if (page.id === canonicalPageId) continue;
      const properties = compactObject([
        this.taskValueFor(props.syncStatus, "重复"),
        this.taskValueFor(props.mergedTo, taskKey),
        this.taskValueFor(props.lastSync, new Date())
      ]);
      await this.client.pages.update({ page_id: page.id, properties });
      this.logger.warn(`Marked duplicate Notion print task ${publicPageId(page.id)} for ${taskKey}`);
    }
  }

  async syncTaskFilamentUsages(record, taskPageId) {
    const usages = record.filamentUsages || [];
    if (!this.taskFilamentDataSourceId || !taskPageId || usages.length === 0) return [];

    await this.ensureTaskFilamentSchema({ refresh: true });

    const ids = [];
    for (const usage of usages) {
      const page = await this.upsertTaskFilamentUsage(record, taskPageId, usage);
      if (page?.id) ids.push(page.id);
    }
    return ids;
  }

  async upsertTaskFilamentUsage(record, taskPageId, usage) {
    const detailKey = `${record.taskKey}:filament:${usage.index}`;
    const pages = await this.findTaskFilamentPagesByKey(detailKey);
    const page = pages[0] || null;
    const title = this.taskFilamentUsageTitle(usage);
    const properties = this.buildTaskFilamentUsageProperties(record, taskPageId, usage, detailKey, title);
    const icon = swatchIcon(usage.color);

    if (this.config.dryRun) {
      this.logger.info(`[dry-run] Would ${page ? "update" : "create"} Notion print task filament "${title}"`);
      return null;
    }

    if (page) {
      await this.client.pages.update({
        page_id: page.id,
        properties,
        ...(icon ? { icon } : {})
      });
      return page;
    }

    const created = await this.client.pages.create({
      parent: { data_source_id: this.taskFilamentDataSourceId },
      properties,
      ...(icon ? { icon } : {})
    });
    return created;
  }

  async updateTaskFilamentUsageRelation(taskPageId, usagePageIds) {
    const relationProperty = this.config.taskProperties.filamentUsages;
    if (!relationProperty || !this.taskSchema?.[relationProperty]) return;

    const value = this.taskValueFor(relationProperty, usagePageIds);
    if (!value || this.config.dryRun) return;

    await this.client.pages.update({
      page_id: taskPageId,
      properties: compactObject([value])
    });
  }

  async findTaskFilamentPagesByKey(detailKey) {
    const propName = this.config.taskFilamentProperties.detailKey;
    const propSchema = this.assertTaskFilamentProperty(propName, "print task filament lookup");
    const response = await this.client.dataSources.query({
      data_source_id: this.taskFilamentDataSourceId,
      filter: filterForExactValue(propName, propSchema, detailKey),
      page_size: 100
    });
    return response.results || [];
  }

  taskFilamentUsageTitle(usage) {
    return [
      usage.material || "耗材",
      usage.weight == null ? "" : `${usage.weight}g`
    ].filter(Boolean).join(" ");
  }

  buildTaskFilamentUsageProperties(record, taskPageId, usage, detailKey, title) {
    const props = this.config.taskFilamentProperties;
    return compactObject([
      this.taskFilamentValueFor(props.title, title),
      this.taskFilamentValueFor(props.detailKey, detailKey),
      this.taskFilamentValueFor(props.task, [taskPageId]),
      this.taskFilamentValueFor(props.taskKey, record.taskKey),
      this.taskFilamentValueFor(props.taskId, record.taskId),
      this.taskFilamentValueFor(props.slot, usage.slot),
      this.taskFilamentValueFor(props.material, usage.material),
      this.taskFilamentValueFor(props.color, usage.color),
      this.taskFilamentValueFor(props.weight, usage.weight),
      this.taskFilamentValueFor(props.percent, usage.percent),
      this.taskFilamentValueFor(props.lastSync, new Date())
    ]);
  }

  async prepareTaskMedia(record, page) {
    const props = this.config.taskProperties;
    const existingThumbnail = getFileValues(page?.properties?.[props.thumbnail]);
    const existingSnapshot = getFileValues(page?.properties?.[props.snapshot]);
    const existingSnapshotSource = getPlainText(page?.properties?.[props.rawSnapshotUrl]);
    const hasStableThumbnail = existingThumbnail.some((file) => file.type === "file");
    const hasStableSnapshot = existingSnapshot.some((file) => file.type === "file");
    const isFailedCoverFallback = record.status === "失败" && record.snapshotUrl && record.snapshotUrl === record.coverUrl;
    const shouldUploadSnapshot = Boolean(
      record.snapshotUrl &&
        (
          !hasStableSnapshot ||
          (!existingSnapshotSource && isFailedCoverFallback) ||
          (existingSnapshotSource && stableMediaSource(existingSnapshotSource) !== stableMediaSource(record.snapshotUrl))
        )
    );
    const media = {
      thumbnailFiles: null,
      snapshotFiles: null,
      pageCover: null,
      coverUpload: null,
      coverExternalUrl: "",
      snapshotUpload: null,
      snapshotExternalUrl: ""
    };

    if (this.config.dryRun) return media;

    if (record.coverUrl && !hasStableThumbnail) {
      media.coverUpload = await this.importNotionFile(record.coverUrl, `${record.taskId || "task"}-cover.png`);
      media.coverExternalUrl = record.coverUrl;
      media.thumbnailFiles = [this.fileRequest(media.coverUpload, record.coverUrl, "任务缩略图")];
    }

    if (shouldUploadSnapshot) {
      media.snapshotUpload = record.snapshotUrl === record.coverUrl && media.coverUpload
        ? media.coverUpload
        : await this.importNotionFile(record.snapshotUrl, `${record.taskId || "task"}-snapshot.jpg`);
      media.snapshotExternalUrl = record.snapshotUrl;
      media.snapshotFiles = [this.fileRequest(media.snapshotUpload, record.snapshotUrl, "完成截图")];
    }

    const coverUpload = media.snapshotUpload || media.coverUpload;
    const coverUrl = media.snapshotExternalUrl || media.coverExternalUrl;
    const shouldSetCover = page?.cover?.type !== "file" || shouldUploadSnapshot;
    if (shouldSetCover && (coverUpload || coverUrl)) {
      media.pageCover = coverUpload
        ? { type: "file_upload", file_upload: { id: coverUpload.id } }
        : { type: "external", external: { url: coverUrl } };
    }

    return media;
  }

  async importNotionFile(url, filename) {
    if (!url || !this.client.fileUploads?.create || !this.client.fileUploads?.send) return null;

    try {
      const response = await fetch(url);
      if (!response.ok) {
        throw new Error(`${response.status} ${response.statusText}`);
      }

      const bytes = await response.arrayBuffer();
      const contentType = this.contentTypeForUpload(bytes, filename, response.headers.get("content-type"));
      const upload = await this.client.fileUploads.create({
        mode: "single_part",
        filename,
        content_type: contentType
      });
      let sent = await this.client.fileUploads.send({
        file_upload_id: upload.id,
        file: {
          filename,
          data: new Blob([bytes], { type: contentType })
        }
      });

      for (let i = 0; i < 10 && sent.status === "pending"; i += 1) {
        await new Promise((resolve) => setTimeout(resolve, 1000));
        sent = await this.client.fileUploads.retrieve({ file_upload_id: upload.id });
      }

      if (sent.status !== "uploaded") {
        this.logger.warn(`Notion file upload for "${filename}" ended with status "${sent.status}"`);
        return null;
      }

      return sent;
    } catch (error) {
      this.logger.warn(`Failed to upload Notion file "${filename}": ${error.message}`);
      return null;
    }
  }

  contentTypeForFilename(filename) {
    const lower = String(filename || "").toLowerCase();
    if (lower.endsWith(".jpg") || lower.endsWith(".jpeg")) return "image/jpeg";
    if (lower.endsWith(".png")) return "image/png";
    return "application/octet-stream";
  }

  contentTypeForUpload(bytes, filename, header) {
    const typed = new Uint8Array(bytes);
    if (typed[0] === 0xff && typed[1] === 0xd8) return "image/jpeg";
    if (
      typed[0] === 0x89 &&
      typed[1] === 0x50 &&
      typed[2] === 0x4e &&
      typed[3] === 0x47
    ) {
      return "image/png";
    }

    const normalized = String(header || "").split(";")[0].trim().toLowerCase();
    if (normalized && normalized !== "application/octet-stream") return normalized;
    return this.contentTypeForFilename(filename);
  }

  fileRequest(upload, url, name) {
    if (upload?.id) return { type: "file_upload", file_upload: { id: upload.id }, name };
    return { type: "external", external: { url }, name };
  }

  async buildPrintTaskProperties(record, page, media, duplicatePages = []) {
    const props = this.config.taskProperties;
    const existing = page?.properties || {};
    const duplicateRelations = duplicatePages.flatMap((item) => getRelationIds(item.properties?.[props.usedFilaments]));
    const relationIds = uniq([
      ...getRelationIds(existing[props.usedFilaments]),
      ...duplicateRelations,
      ...(await this.filamentPageIdsForUids(record.usedFilamentUids || []))
    ]);
    const usedSlots = uniq([
      ...String(getPlainText(existing[props.usedSlots]) || "")
        .split(",")
        .map((item) => item.trim()),
      ...(record.usedSlots || [])
    ]);
    const existingStatus = getSelectName(existing[props.status]);
    const status = this.isTerminalTaskStatus(existingStatus) && !this.isTerminalTaskStatus(record.status)
      ? existingStatus
      : record.status;
    const progress = Math.max(getNumberValue(existing[props.progress]) ?? 0, record.progress ?? 0);
    const existingThumbnailFiles = getFileValues(existing[props.thumbnail]);
    const snapshotFiles = media.snapshotFiles;
    const thumbnailFiles = existingThumbnailFiles.some((file) => file.type === "file") ? null : media.thumbnailFiles;

    return compactObject([
      this.taskValueFor(props.title, record.title),
      this.taskValueFor(props.taskKey, record.taskKey),
      this.taskValueFor(props.taskId, record.taskId),
      this.taskValueFor(props.printer, record.printer),
      this.taskValueFor(props.printerSerial, record.printerSerial),
      this.taskValueFor(props.status, status),
      this.taskValueFor(props.statusCode, record.statusCode),
      this.taskValueFor(props.syncStatus, "正常"),
      this.taskValueFor(props.mergedTo, ""),
      this.taskValueFor(props.printConfig, record.printConfig),
      this.taskValueFor(props.startTime, record.startTime || getDateValue(existing[props.startTime])),
      this.taskValueFor(props.endTime, record.endTime || getDateValue(existing[props.endTime])),
      this.taskValueFor(props.durationMinutes, record.durationMinutes ?? getNumberValue(existing[props.durationMinutes])),
      this.taskValueFor(props.progress, progress),
      this.taskValueFor(props.layers, record.layers || getPlainText(existing[props.layers])),
      this.taskValueFor(props.filamentWeight, record.filamentWeight ?? getNumberValue(existing[props.filamentWeight])),
      this.taskValueFor(props.filamentLength, record.filamentLength ?? getNumberValue(existing[props.filamentLength])),
      this.taskValueFor(props.usedSlots, usedSlots.join(", ")),
      this.taskValueFor(props.filamentDetails, record.filamentDetails || getPlainText(existing[props.filamentDetails])),
      this.taskValueFor(props.usedFilaments, relationIds),
      this.taskValueFor(props.thumbnail, thumbnailFiles),
      this.taskValueFor(props.snapshot, snapshotFiles),
      this.taskValueFor(props.rawCoverUrl, stableMediaSource(record.coverUrl) || getPlainText(existing[props.rawCoverUrl])),
      this.taskValueFor(props.rawSnapshotUrl, stableMediaSource(record.snapshotUrl) || getPlainText(existing[props.rawSnapshotUrl])),
      this.taskValueFor(props.lastSync, new Date())
    ]);
  }

  async filamentPageIdsForUids(uids) {
    const ids = [];
    for (const uid of uniq(uids)) {
      try {
        const page = await this.findPageByUid(uid);
        if (page?.id) ids.push(page.id);
      } catch (error) {
        this.logger.warn(`Cannot resolve AMS filament relation for ${uid}: ${error.message}`);
      }
    }
    return ids;
  }

  taskValueFor(propertyName, value) {
    if (!propertyName || value === undefined) return null;
    const schema = this.taskSchema[propertyName];
    if (!schema) {
      if (!this.warnedMissingTaskProperties.has(propertyName)) {
        this.warnedMissingTaskProperties.add(propertyName);
        this.logger.warn(`Notion print task property "${propertyName}" does not exist; ignoring it`);
      }
      return null;
    }

    const property = propId(propertyName, schema);
    switch (schema.type) {
      case "title":
        return [property, { title: textContent(value) }];
      case "rich_text":
        return [property, { rich_text: textContent(value) }];
      case "number":
        return [property, { number: value == null || value === "" ? null : Number(value) }];
      case "date":
        return [property, { date: value ? { start: value instanceof Date ? value.toISOString() : String(value) } : null }];
      case "select":
        return [property, value ? { select: { name: String(value) } } : { select: null }];
      case "url":
        return [property, { url: value ? String(value) : null }];
      case "files":
        return Array.isArray(value) && value.length > 0 ? [property, { files: value }] : null;
      case "relation":
        return [property, { relation: uniq(value || []).map((id) => ({ id })) }];
      default:
        return null;
    }
  }

  taskFilamentValueFor(propertyName, value) {
    if (!propertyName || value === undefined) return null;
    const schema = this.taskFilamentSchema[propertyName];
    if (!schema) {
      if (!this.warnedMissingTaskFilamentProperties.has(propertyName)) {
        this.warnedMissingTaskFilamentProperties.add(propertyName);
        this.logger.warn(`Notion print task filament property "${propertyName}" does not exist; ignoring it`);
      }
      return null;
    }

    const property = propId(propertyName, schema);
    switch (schema.type) {
      case "title":
        return [property, { title: textContent(value) }];
      case "rich_text":
        return [property, { rich_text: textContent(value) }];
      case "number":
        return [property, { number: value == null || value === "" ? null : Number(value) }];
      case "date":
        return [property, { date: value ? { start: value instanceof Date ? value.toISOString() : String(value) } : null }];
      case "relation":
        return [property, { relation: uniq(value || []).map((id) => ({ id })) }];
      default:
        return null;
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

  assertTaskProperty(propertyName, label) {
    const schema = this.taskSchema?.[propertyName];
    if (!schema) throw new Error(`Notion print task property "${propertyName}" is required for ${label}`);
    return schema;
  }

  assertTaskFilamentProperty(propertyName, label) {
    const schema = this.taskFilamentSchema?.[propertyName];
    if (!schema) throw new Error(`Notion print task filament property "${propertyName}" is required for ${label}`);
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

  findTaskTitleProperty() {
    const configured = this.config.taskProperties.title;
    if (configured && this.taskSchema[configured]?.type === "title") {
      return { name: configured, schema: this.taskSchema[configured] };
    }

    const [name, schema] =
      Object.entries(this.taskSchema).find(([, propertySchema]) => propertySchema.type === "title") || [];
    return name ? { name, schema } : null;
  }

  findTaskFilamentTitleProperty() {
    const configured = this.config.taskFilamentProperties.title;
    if (configured && this.taskFilamentSchema[configured]?.type === "title") {
      return { name: configured, schema: this.taskFilamentSchema[configured] };
    }

    const [name, schema] =
      Object.entries(this.taskFilamentSchema).find(([, propertySchema]) => propertySchema.type === "title") || [];
    return name ? { name, schema } : null;
  }
}
