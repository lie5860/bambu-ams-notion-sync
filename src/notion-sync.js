import { createHash } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";
import { Client } from "@notionhq/client";
import {
  checkboxFilter,
  filterForExactValue,
  getPlainText,
  propertyPayload
} from "./notion-properties.js";
import {
  colorIconDescriptor,
  iconColorTypeLabel,
  renderColorIconPng
} from "./color-icon.js";
import { awaitWithSignal, readResponseText, withTimeout } from "./http.js";

const NOTION_MIN_REQUEST_INTERVAL_MS = 1000;
const NOTION_HTTP_TIMEOUT_MS = 30_000;
const NOTION_RESPONSE_MAX_BYTES = 8 * 1024 * 1024;
const EXTERNAL_FILE_FETCH_TIMEOUT_MS = 30_000;
const EXTERNAL_FILE_MAX_BYTES = 20 * 1024 * 1024;

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function cancelResponseBody(body, reason) {
  try {
    Promise.resolve(body?.cancel?.(reason)).catch(() => {});
  } catch {
    // Cancellation is best effort and must not replace the original media failure.
  }
}

export async function fetchNotionResponse(input, init = {}, {
  timeoutMs = NOTION_HTTP_TIMEOUT_MS,
  maxBytes = NOTION_RESPONSE_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  signal: ownerSignal
} = {}) {
  const signals = [...new Set([init.signal, ownerSignal].filter(Boolean))];
  const callerSignal = signals.length > 1 ? AbortSignal.any(signals) : signals[0];
  return withTimeout(async (signal) => {
    const response = await fetchImpl(input, { ...init, signal });
    const text = await readResponseText(response, { maxBytes, signal });
    if (response.ok && text.trim()) {
      try {
        JSON.parse(text);
      } catch (cause) {
        const error = new Error("Notion returned an invalid JSON response", { cause });
        error.code = "INVALID_HTTP_RESPONSE";
        error.status = response.status;
        throw error;
      }
    }
    return new Response(text || null, {
      status: response.status,
      statusText: response.statusText,
      headers: response.headers
    });
  }, { timeoutMs, signal: callerSignal });
}

async function responseBytesWithLimit(response, maxBytes = EXTERNAL_FILE_MAX_BYTES, signal) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    cancelResponseBody(response.body);
    throw new Error(`External file exceeds ${maxBytes} bytes`);
  }

  if (!response.body?.getReader) {
    const bytes = await awaitWithSignal(response.arrayBuffer(), signal);
    if (bytes.byteLength > maxBytes) throw new Error(`External file exceeds ${maxBytes} bytes`);
    return bytes;
  }

  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  let complete = false;
  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) {
        complete = true;
        break;
      }
      total += value.byteLength;
      if (total > maxBytes) throw new Error(`External file exceeds ${maxBytes} bytes`);
      chunks.push(value);
    }
  } finally {
    if (!complete) cancelResponseBody(reader, signal?.reason);
    try {
      reader.releaseLock?.();
    } catch {
      // Cancellation may still be releasing a pending stream read.
    }
  }

  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes.buffer;
}

export function fetchExternalFile(url, {
  timeoutMs = EXTERNAL_FILE_FETCH_TIMEOUT_MS,
  maxBytes = EXTERNAL_FILE_MAX_BYTES,
  fetchImpl = globalThis.fetch,
  signal
} = {}) {
  return withTimeout(async (signal) => {
    const response = await fetchImpl(url, { signal });
    if (!response?.ok) {
      const error = new Error(`${response?.status || "Unknown"} ${response?.statusText || "external file request failed"}`);
      error.status = response?.status;
      throw error;
    }
    const bytes = await responseBytesWithLimit(response, maxBytes, signal);
    return {
      bytes,
      contentType: response.headers?.get?.("content-type") || ""
    };
  }, { timeoutMs, signal });
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

function isoTimeMs(value) {
  const millis = Date.parse(value || "");
  return Number.isFinite(millis) ? millis : 0;
}

function printTaskRecordHistoryTimeMs(record) {
  return Math.max(isoTimeMs(record?.endTime), isoTimeMs(record?.startTime));
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

function colorLabel(value, alias = "") {
  const aliasText = String(alias || "").trim();
  if (aliasText) return aliasText;
  return normalizeColor(value);
}

function colorListLabel(colors, fallback = "") {
  const values = (Array.isArray(colors) ? colors : [])
    .map(normalizeColor)
    .filter(Boolean);
  if (values.length > 0) return values.join(" / ");
  return normalizeColor(fallback);
}

function trayColorTypeLabel(tray) {
  const descriptor = colorIconDescriptor({
    color: tray?.color,
    colors: tray?.colors,
    colorType: tray?.colorType
  });
  return iconColorTypeLabel(descriptor?.colorType || "single");
}

function getFileValues(propertyValue) {
  return Array.isArray(propertyValue?.files) ? propertyValue.files : [];
}

function getRelationIds(propertyValue) {
  return Array.isArray(propertyValue?.relation) ? propertyValue.relation.map((item) => item.id).filter(Boolean) : [];
}

function textPayloadValue(parts) {
  return (parts || []).map((part) => part.plain_text ?? part.text?.content ?? "").join("");
}

function sameStringSet(left, right) {
  const leftValues = uniq(left).sort();
  const rightValues = uniq(right).sort();
  return leftValues.length === rightValues.length && leftValues.every((value, index) => value === rightValues[index]);
}

function sameDateValue(left, right) {
  if (!left && !right) return true;
  if (!left || !right) return false;
  const leftMs = Date.parse(left);
  const rightMs = Date.parse(right);
  if (Number.isFinite(leftMs) && Number.isFinite(rightMs)) return leftMs === rightMs;
  return String(left) === String(right);
}

function fileSignature(file) {
  const name = file?.name || "";
  if (file?.type === "file_upload") return `${name}:upload:${file.file_upload?.id || ""}`;
  if (file?.type === "external") return `${name}:external:${stableMediaSource(file.external?.url || "")}`;
  if (file?.type === "file") return `${name}:file:${stableMediaSource(file.file?.url || "")}`;
  return `${name}:${file?.type || ""}`;
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

function pickSlotUid(slot, uidFields = ["tray_uuid", "tag_uid"]) {
  for (const field of uidFields) {
    const value = slot?.[field];
    if (!isZeroish(value)) return String(value);
  }
  return "";
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
    this.requestSignalContext = new AsyncLocalStorage();
    this.client = new Client({
      auth: config.token,
      notionVersion: "2025-09-03",
      fetch: (input, init) => fetchNotionResponse(input, init, {
        signal: this.currentRequestSignal()
      }),
      timeoutMs: NOTION_HTTP_TIMEOUT_MS
    });
    this.notionRequestQueue = Promise.resolve();
    this.lastNotionRequestAt = 0;
    this.installNotionRequestLimiter();
    this.schema = null;
    this.parentPageId = null;
    this.taskDatabaseId = null;
    this.taskDataSourceId = null;
    this.taskSchema = null;
    this.taskFilamentSpecDataSourceId = null;
    this.taskFilamentSpecSchema = null;
    this.taskFilamentColorDatabaseId = null;
    this.taskFilamentColorDataSourceId = null;
    this.taskFilamentColorSchema = null;
    this.taskFilamentDatabaseId = null;
    this.taskFilamentDataSourceId = null;
    this.taskFilamentSchema = null;
    this.warnedMissingProperties = new Set();
    this.warnedMissingTaskProperties = new Set();
    this.warnedMissingTaskFilamentSpecProperties = new Set();
    this.warnedMissingTaskFilamentColorProperties = new Set();
    this.warnedMissingTaskFilamentProperties = new Set();
    this.lastSignatures = new Map();
    this.lastTaskSignatures = new Map();
    this.activeTasks = new Map();
    this.traySyncRunning = false;
    this.pendingTraySync = null;
    this.traySyncPromise = null;
    this.cloudTaskBatchMode = false;
    this.taskFilamentSpecPageCache = new Map();
    this.taskFilamentColorPageCache = new Map();
    this.amsIconUploadCache = new Map();
    this.amsSyncEnabled = true;
    this.printTaskSyncEnabled = true;
  }

  currentRequestSignal() {
    return this.requestSignalContext?.getStore?.() || null;
  }

  runWithRequestSignal(signal, operation) {
    if (!signal) return operation();
    signal.throwIfAborted();
    if (!this.requestSignalContext) this.requestSignalContext = new AsyncLocalStorage();
    return this.requestSignalContext.run(signal, operation);
  }

  throwIfRequestAborted(error) {
    const signal = this.currentRequestSignal();
    if (signal?.aborted) throw signal.reason || error;
  }

  installNotionRequestLimiter() {
    const originalRequest = this.client.request.bind(this.client);
    this.client.request = async (args) => {
      const signal = this.currentRequestSignal();
      const run = async () => {
        const elapsed = Date.now() - this.lastNotionRequestAt;
        const waitMs = Math.max(0, NOTION_MIN_REQUEST_INTERVAL_MS - elapsed);
        if (waitMs > 0) await awaitWithSignal(sleep(waitMs), signal);
        signal?.throwIfAborted();
        this.lastNotionRequestAt = Date.now();
        return originalRequest(args);
      };

      const request = this.notionRequestQueue.then(run, run);
      this.notionRequestQueue = request.catch(() => {});
      return request;
    };
  }

  async init(options = {}) {
    const { signal } = options;
    if (signal && this.currentRequestSignal() !== signal) {
      return this.runWithRequestSignal(signal, () => this.init(options));
    }
    const {
      deferMaintenance = false,
      enableAmsSync = true,
      enablePrintTaskSync = true
    } = options;
    signal?.throwIfAborted();
    if (!this.client.dataSources?.retrieve || !this.client.dataSources?.query || !this.client.dataSources?.update) {
      throw new Error("Installed @notionhq/client does not support dataSources. Run npm install with the bundled package.json.");
    }

    this.amsSyncEnabled = enableAmsSync;
    this.printTaskSyncEnabled = enablePrintTaskSync;

    const dataSource = await this.resolveDataSource(this.config.dataSourceId, {
      createAmsDataSource: enableAmsSync
    });
    signal?.throwIfAborted();

    this.schema = dataSource.properties || {};
    if (enableAmsSync) await this.ensureAmsSchema();
    if (enableAmsSync || enablePrintTaskSync) await this.ensureTaskFilamentColorDataSource();
    if (enablePrintTaskSync) {
      await this.ensureTaskDataSource();
      if (!this.taskDataSourceId) {
        throw new Error("Notion print task data source could not be initialized");
      }
      await this.ensureTaskFilamentSpecDataSource();
      await this.ensureTaskFilamentDataSource();
      await this.ensureTaskSchema({ refresh: true });
    }
    if (!deferMaintenance) await this.runStartupMaintenance({ signal });
    signal?.throwIfAborted();
    this.logger.info(
      `Loaded Notion data source ${this.config.dataSourceId} schema with ${Object.keys(this.schema).length} properties`
    );
  }

  async runStartupMaintenance({ signal } = {}) {
    if (signal && this.currentRequestSignal() !== signal) {
      return this.runWithRequestSignal(signal, () => this.runStartupMaintenance({ signal }));
    }
    signal?.throwIfAborted();
    if (this.amsSyncEnabled) await this.syncAmsColorAliasesFromColorMappings();
    if (this.printTaskSyncEnabled) {
      await this.syncTaskFilamentSpecTitlesFromColorMappings();
      await this.ensureTaskFilamentCustomStatsViews();
      await this.ensureTaskDefaultView();
      await this.backfillTaskDisplayImages();
    }
    signal?.throwIfAborted();
  }

  async resolveDataSource(id, { createAmsDataSource = true } = {}) {
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
    } catch (error) {
      throw new Error(
        `Cannot find Notion target ${id}. Share the page/database with your Notion integration, then restart the sync service.`,
        { cause: error }
      );
    }

    if (!createAmsDataSource) {
      this.logger.info(`Using Notion page ${id} as parent for enabled sync databases`);
      return { id, properties: {} };
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
    } catch (error) {
      if (this.printTaskSyncEnabled) {
        throw new Error(`Cannot resolve the parent page for Notion database ${databaseId}`, { cause: error });
      }
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

    const databaseName = this.config.taskDatabaseName || "打印记录";
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

  async ensureTaskFilamentColorDataSource() {
    if (!this.parentPageId) {
      this.logger.warn("Cannot infer Notion parent page for filament color database; filament color sync is disabled");
      return;
    }

    const databaseName = this.config.taskFilamentColorDatabaseName || "颜色映射";
    const existingDatabaseId = await this.findChildDatabase(this.parentPageId, databaseName);
    const database = existingDatabaseId
      ? await this.client.databases.retrieve({ database_id: existingDatabaseId })
      : await this.createTaskFilamentColorDatabase(this.parentPageId, databaseName);
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(`Filament color database "${databaseName}" has no data source`);

    this.taskFilamentColorDatabaseId = database.id;
    this.taskFilamentColorDataSourceId = dataSourceId;
    this.logger.info(`Using Notion filament color database "${databaseName}" data source ${dataSourceId}`);
    await this.refreshTaskFilamentColorSchema();
    await this.ensureTaskFilamentColorSchema();
  }

  async createTaskFilamentColorDatabase(pageId, title) {
    const properties = this.buildTaskFilamentColorDatabaseProperties();
    this.logger.info(`Creating Notion database "${title}" under page ${pageId}`);
    return this.client.databases.create({
      parent: { type: "page_id", page_id: pageId },
      title: [{ type: "text", text: { content: title } }],
      is_inline: false,
      initial_data_source: { properties }
    });
  }

  async ensureTaskFilamentSpecDataSource() {
    if (!this.parentPageId) {
      this.logger.warn("Cannot infer Notion parent page for filament spec database; filament spec sync is disabled");
      return;
    }

    const databaseName = this.config.taskFilamentSpecDatabaseName || "耗材色卡";
    const existingDatabaseId = await this.findChildDatabase(this.parentPageId, databaseName);
    const database = existingDatabaseId
      ? await this.client.databases.retrieve({ database_id: existingDatabaseId })
      : await this.createTaskFilamentSpecDatabase(this.parentPageId, databaseName);
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(`Filament spec database "${databaseName}" has no data source`);

    this.taskFilamentSpecDataSourceId = dataSourceId;
    this.logger.info(`Using Notion filament spec database "${databaseName}" data source ${dataSourceId}`);
    await this.refreshTaskFilamentSpecSchema();
    await this.ensureTaskFilamentSpecSchema();
  }

  async createTaskFilamentSpecDatabase(pageId, title) {
    const properties = this.buildTaskFilamentSpecDatabaseProperties();
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

    const databaseName = this.config.taskFilamentDatabaseName || "耗材用量明细";
    const existingDatabaseId = await this.findChildDatabase(this.parentPageId, databaseName);
    const database = existingDatabaseId
      ? await this.client.databases.retrieve({ database_id: existingDatabaseId })
      : await this.createTaskFilamentDatabase(this.parentPageId, databaseName);
    const dataSourceId = database.data_sources?.[0]?.id;
    if (!dataSourceId) throw new Error(`Print task filament database "${databaseName}" has no data source`);

    this.taskFilamentDatabaseId = database.id;
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
    add(props.colorList, { type: "rich_text", rich_text: {} });
    add(props.colorType, { type: "rich_text", rich_text: {} });
    add(props.colorAlias, { type: "rich_text", rich_text: {} });
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
    add(props.displayImage, { type: "files", files: {} });
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
    if (props.spec && this.taskFilamentSpecDataSourceId) {
      add(props.spec, {
        type: "relation",
        relation: {
          data_source_id: this.taskFilamentSpecDataSourceId,
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
    add(props.startTime, { type: "date", date: {} });
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
    add(props.lastSync, { type: "date", date: {} });

    return properties;
  }

  buildTaskFilamentSpecDatabaseProperties() {
    const props = this.config.taskFilamentSpecProperties;
    const properties = {
      [props.title]: { type: "title", title: {} }
    };

    const add = (name, schema) => {
      if (name && name !== props.title) properties[name] = schema;
    };

    add(props.specKey, { type: "rich_text", rich_text: {} });
    add(props.material, { type: "rich_text", rich_text: {} });
    add(props.color, { type: "rich_text", rich_text: {} });
    add(props.lastSync, { type: "date", date: {} });

    return properties;
  }

  buildTaskFilamentColorDatabaseProperties() {
    const props = this.config.taskFilamentColorProperties;
    const properties = {
      [props.title]: { type: "title", title: {} }
    };

    const add = (name, schema) => {
      if (name && name !== props.title) properties[name] = schema;
    };

    add(props.colorKey, { type: "rich_text", rich_text: {} });
    add(props.alias, { type: "rich_text", rich_text: {} });
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

    this.assertProperty(this.config.properties.amsUid, "AMS filament UID lookup");
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
    const filter = this.taskGalleryViewFilter();
    const request = {
      name: viewName,
      type: "gallery",
      sorts: this.taskGalleryViewSorts(),
      ...(filter ? { filter } : {}),
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
      const view = await this.client.views.retrieve({ view_id: ref.id });
      if (view.name === name) return view;
    }
    return null;
  }

  taskGalleryViewSorts() {
    const startTime = this.taskSchema?.[this.config.taskProperties.startTime];
    if (!startTime) return [];
    return [{ property: startTime.id || this.config.taskProperties.startTime, direction: "descending" }];
  }

  taskGalleryViewFilter() {
    const propName = this.config.taskProperties.syncStatus;
    const syncStatus = this.taskSchema?.[propName];
    if (!syncStatus) return null;
    return {
      property: propId(propName, syncStatus),
      select: { does_not_equal: "重复" }
    };
  }

  taskGalleryViewConfiguration() {
    const props = this.config.taskProperties;
    const displayImage = this.taskSchema?.[props.displayImage];
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
      cover: displayImage
        ? { type: "property", property_id: propId(props.displayImage, displayImage) }
        : snapshot ? { type: "property", property_id: propId(props.snapshot, snapshot) } : { type: "page_cover" },
      cover_size: "small",
      cover_aspect: "cover",
      card_layout: "list"
    };
  }

  async ensureTaskFilamentCustomStatsViews() {
    if (
      !this.taskFilamentDatabaseId ||
      !this.taskFilamentDataSourceId ||
      !this.client.views?.list ||
      !this.client.views?.create ||
      !this.client.views?.update
    ) {
      return;
    }

    const viewRequests = [
      {
        name: "自定义统计",
        type: "table",
        filter: this.taskFilamentCustomStatsFilter(),
        sorts: this.taskFilamentCustomStatsViewSorts(),
        configuration: this.taskFilamentCustomStatsTableConfiguration()
      },
      {
        name: "自定义统计图",
        type: "chart",
        filter: this.taskFilamentCustomStatsFilter(),
        configuration: this.taskFilamentCustomStatsChartConfiguration()
      }
    ].filter((request) => request.configuration);

    if (viewRequests.length === 0) return;

    const viewRefs = await this.client.views.list({ data_source_id: this.taskFilamentDataSourceId, page_size: 100 });
    for (const request of viewRequests) {
      const existing = await this.findTaskFilamentViewByName(viewRefs.results || [], request.name);
      if (existing?.type === request.type) {
        await this.client.views.update({ view_id: existing.id, ...request });
        this.logger.info(`Updated Notion print task filament view "${request.name}"`);
        continue;
      }

      await this.client.views.create({
        data_source_id: this.taskFilamentDataSourceId,
        database_id: this.taskFilamentDatabaseId,
        ...request,
        position: { type: "end" }
      });
      this.logger.info(`Created Notion print task filament view "${request.name}"`);
    }
  }

  async findTaskFilamentViewByName(viewRefs, name) {
    for (const ref of viewRefs) {
      const view = await this.client.views.retrieve({ view_id: ref.id });
      if (view.name === name) return view;
    }
    return null;
  }

  taskFilamentCustomStatsViewSorts() {
    const props = this.config.taskFilamentProperties;
    const startTime = this.taskFilamentSchema?.[props.startTime];
    const weight = this.taskFilamentSchema?.[props.weight];
    return [
      startTime ? { property: propId(props.startTime, startTime), direction: "descending" } : null,
      weight ? { property: propId(props.weight, weight), direction: "descending" } : null
    ].filter(Boolean);
  }

  taskFilamentCustomStatsFilter() {
    const props = this.config.taskFilamentProperties;
    const status = this.taskFilamentSchema?.[props.status];
    if (!status) return undefined;

    return {
      property: propId(props.status, status),
      select: { does_not_equal: "失败" }
    };
  }

  taskFilamentCustomStatsTableConfiguration() {
    const props = this.config.taskFilamentProperties;
    const visiblePropertyNames = [
      props.title,
      props.spec,
      props.weight,
      props.task,
      props.startTime
    ].filter(Boolean);
    const propertyNames = uniq([
      ...visiblePropertyNames,
      ...Object.keys(this.taskFilamentSchema || {})
    ]);
    const visibleNames = new Set(visiblePropertyNames);
    const properties = propertyNames.map((name) => {
      const schema = this.taskFilamentSchema[name];
      if (!schema) return null;
      return {
        property_id: propId(name, schema),
        visible: visibleNames.has(name),
        wrap: true
      };
    }).filter(Boolean);
    const spec = this.taskFilamentSchema?.[props.spec];

    return {
      type: "table",
      properties,
      wrap_cells: true,
      ...(spec
        ? {
            group_by: {
              type: "relation",
              property_id: propId(props.spec, spec),
              sort: { type: "ascending" },
              hide_empty_groups: true
            }
          }
        : {})
    };
  }

  taskFilamentCustomStatsChartConfiguration() {
    const props = this.config.taskFilamentProperties;
    const spec = this.taskFilamentSchema?.[props.spec];
    const weight = this.taskFilamentSchema?.[props.weight];
    if (!spec || !weight) return null;

    return {
      type: "chart",
      chart_type: "bar",
      x_axis: {
        type: "relation",
        property_id: propId(props.spec, spec),
        sort: { type: "ascending" },
        hide_empty_groups: true
      },
      y_axis: {
        aggregator: "sum",
        property_id: propId(props.weight, weight)
      },
      sort: "y_descending",
      color_theme: "colorful",
      height: "medium",
      legend_position: "bottom",
      hide_empty_groups: true
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

  async refreshTaskFilamentColorSchema() {
    if (!this.taskFilamentColorDataSourceId) return null;
    const dataSource = await this.client.dataSources.retrieve({ data_source_id: this.taskFilamentColorDataSourceId });
    this.taskFilamentColorSchema = dataSource.properties || {};
    return this.taskFilamentColorSchema;
  }

  async ensureTaskFilamentColorSchema({ refresh = false } = {}) {
    if (!this.taskFilamentColorDataSourceId) return;
    if (refresh) await this.refreshTaskFilamentColorSchema();

    let changed = await this.ensureTaskFilamentColorTitleProperty();
    const expectedProperties = this.buildTaskFilamentColorDatabaseProperties();

    for (const [name, expectedSchema] of Object.entries(expectedProperties)) {
      if (name === this.config.taskFilamentColorProperties.title || expectedSchema.type === "title") continue;
      if (await this.ensureTaskFilamentColorProperty(name, expectedSchema)) changed = true;
    }

    if (changed) {
      await this.refreshTaskFilamentColorSchema();
      this.warnedMissingTaskFilamentColorProperties.clear();
    }

    this.assertTaskFilamentColorProperty(this.config.taskFilamentColorProperties.colorKey, "filament color lookup");
  }

  async ensureTaskFilamentColorTitleProperty() {
    const titleName = this.config.taskFilamentColorProperties.title;
    if (!titleName) return false;

    const existing = this.taskFilamentColorSchema[titleName];
    if (existing?.type === "title") return false;

    let changed = false;
    if (existing) {
      const tempName = this.availableTaskFilamentColorTempPropertyName(titleName);
      await this.renameTaskFilamentColorProperty(titleName, tempName);
      this.logger.warn(
        `Notion filament color property "${titleName}" has type "${existing.type}", expected "title"; renamed it to "${tempName}"`
      );
      await this.refreshTaskFilamentColorSchema();
      changed = true;
    }

    const titleProperty = this.findTaskFilamentColorTitleProperty();
    if (!titleProperty) throw new Error("Notion filament color database has no title property");

    if (titleProperty.name !== titleName) {
      await this.renameTaskFilamentColorProperty(titleProperty.name, titleName);
      this.logger.info(`Renamed Notion filament color title property "${titleProperty.name}" to "${titleName}"`);
      changed = true;
    }

    return changed;
  }

  async ensureTaskFilamentColorProperty(name, expectedSchema) {
    if (!name) return false;

    const existing = this.taskFilamentColorSchema[name];
    if (!existing) {
      await this.createTaskFilamentColorProperty(name, expectedSchema);
      this.logger.info(`Created missing Notion filament color property "${name}" (${expectedSchema.type})`);
      await this.refreshTaskFilamentColorSchema();
      return true;
    }

    if (existing.type === expectedSchema.type) return false;

    const tempName = this.availableTaskFilamentColorTempPropertyName(name);
    await this.renameTaskFilamentColorProperty(name, tempName);
    this.logger.warn(
      `Notion filament color property "${name}" has type "${existing.type}", expected "${expectedSchema.type}"; renamed it to "${tempName}"`
    );
    await this.refreshTaskFilamentColorSchema();

    await this.createTaskFilamentColorProperty(name, expectedSchema);
    this.logger.info(`Created replacement Notion filament color property "${name}" (${expectedSchema.type})`);
    await this.refreshTaskFilamentColorSchema();
    return true;
  }

  availableTaskFilamentColorTempPropertyName(name) {
    const names = new Set(Object.keys(this.taskFilamentColorSchema || {}));
    const base = `${name}-temp`;
    if (!names.has(base)) return base;

    let index = 1;
    while (names.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  async renameTaskFilamentColorProperty(name, nextName) {
    await this.client.dataSources.update({
      data_source_id: this.taskFilamentColorDataSourceId,
      properties: {
        [name]: { name: nextName }
      }
    });
  }

  async createTaskFilamentColorProperty(name, schema) {
    await this.client.dataSources.update({
      data_source_id: this.taskFilamentColorDataSourceId,
      properties: {
        [name]: schema
      }
    });
  }

  async refreshTaskFilamentSpecSchema() {
    if (!this.taskFilamentSpecDataSourceId) return null;
    const dataSource = await this.client.dataSources.retrieve({ data_source_id: this.taskFilamentSpecDataSourceId });
    this.taskFilamentSpecSchema = dataSource.properties || {};
    return this.taskFilamentSpecSchema;
  }

  async ensureTaskFilamentSpecSchema({ refresh = false } = {}) {
    if (!this.taskFilamentSpecDataSourceId) return;
    if (refresh) await this.refreshTaskFilamentSpecSchema();

    let changed = await this.ensureTaskFilamentSpecTitleProperty();
    const expectedProperties = this.buildTaskFilamentSpecDatabaseProperties();

    for (const [name, expectedSchema] of Object.entries(expectedProperties)) {
      if (name === this.config.taskFilamentSpecProperties.title || expectedSchema.type === "title") continue;
      if (await this.ensureTaskFilamentSpecProperty(name, expectedSchema)) changed = true;
    }

    if (changed) {
      await this.refreshTaskFilamentSpecSchema();
      this.warnedMissingTaskFilamentSpecProperties.clear();
    }

    this.assertTaskFilamentSpecProperty(this.config.taskFilamentSpecProperties.specKey, "filament spec lookup");
  }

  async ensureTaskFilamentSpecTitleProperty() {
    const titleName = this.config.taskFilamentSpecProperties.title;
    if (!titleName) return false;

    const existing = this.taskFilamentSpecSchema[titleName];
    if (existing?.type === "title") return false;

    let changed = false;
    if (existing) {
      const tempName = this.availableTaskFilamentSpecTempPropertyName(titleName);
      await this.renameTaskFilamentSpecProperty(titleName, tempName);
      this.logger.warn(
        `Notion filament spec property "${titleName}" has type "${existing.type}", expected "title"; renamed it to "${tempName}"`
      );
      await this.refreshTaskFilamentSpecSchema();
      changed = true;
    }

    const titleProperty = this.findTaskFilamentSpecTitleProperty();
    if (!titleProperty) throw new Error("Notion filament spec database has no title property");

    if (titleProperty.name !== titleName) {
      await this.renameTaskFilamentSpecProperty(titleProperty.name, titleName);
      this.logger.info(`Renamed Notion filament spec title property "${titleProperty.name}" to "${titleName}"`);
      changed = true;
    }

    return changed;
  }

  async ensureTaskFilamentSpecProperty(name, expectedSchema) {
    if (!name) return false;

    const existing = this.taskFilamentSpecSchema[name];
    if (!existing) {
      await this.createTaskFilamentSpecProperty(name, expectedSchema);
      this.logger.info(`Created missing Notion filament spec property "${name}" (${expectedSchema.type})`);
      await this.refreshTaskFilamentSpecSchema();
      return true;
    }

    if (existing.type === expectedSchema.type) return false;

    const tempName = this.availableTaskFilamentSpecTempPropertyName(name);
    await this.renameTaskFilamentSpecProperty(name, tempName);
    this.logger.warn(
      `Notion filament spec property "${name}" has type "${existing.type}", expected "${expectedSchema.type}"; renamed it to "${tempName}"`
    );
    await this.refreshTaskFilamentSpecSchema();

    await this.createTaskFilamentSpecProperty(name, expectedSchema);
    this.logger.info(`Created replacement Notion filament spec property "${name}" (${expectedSchema.type})`);
    await this.refreshTaskFilamentSpecSchema();
    return true;
  }

  availableTaskFilamentSpecTempPropertyName(name) {
    const names = new Set(Object.keys(this.taskFilamentSpecSchema || {}));
    const base = `${name}-temp`;
    if (!names.has(base)) return base;

    let index = 1;
    while (names.has(`${base}-${index}`)) index += 1;
    return `${base}-${index}`;
  }

  async renameTaskFilamentSpecProperty(name, nextName) {
    await this.client.dataSources.update({
      data_source_id: this.taskFilamentSpecDataSourceId,
      properties: {
        [name]: { name: nextName }
      }
    });
  }

  async createTaskFilamentSpecProperty(name, schema) {
    await this.client.dataSources.update({
      data_source_id: this.taskFilamentSpecDataSourceId,
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

  async syncTrays(trays, { signal } = {}) {
    if (signal && this.currentRequestSignal() !== signal) {
      return this.runWithRequestSignal(signal, () => this.syncTrays(trays, { signal }));
    }
    signal?.throwIfAborted();
    if (!this.amsSyncEnabled) return;

    this.pendingTraySync = trays;
    if (this.traySyncRunning) {
      this.logger.debug("Queued latest AMS snapshot while previous sync is still running");
      return this.traySyncPromise;
    }

    this.traySyncRunning = true;
    this.traySyncPromise = (async () => {
      try {
        while (this.pendingTraySync) {
          const nextTrays = this.pendingTraySync;
          this.pendingTraySync = null;
          try {
            signal?.throwIfAborted();
            await this.syncTrayBatch(nextTrays, { signal });
            signal?.throwIfAborted();
          } catch (error) {
            if (!this.pendingTraySync) throw error;
            this.logger.warn(
              `AMS sync failed while a newer snapshot was queued; continuing with the latest snapshot: ${error.message}`
            );
          }
        }
      } finally {
        this.traySyncRunning = false;
        this.traySyncPromise = null;
      }
    })();

    return this.traySyncPromise;
  }

  async syncTrayBatch(trays, { signal } = {}) {
    if (!this.amsSyncEnabled) return;

    signal?.throwIfAborted();
    await this.ensureAmsSchema({ refresh: true });
    await this.ensureTaskFilamentColorSchema();
    const colorAliases = await this.taskFilamentColorAliasMap();

    const seenAt = new Date();
    const uniqueTrays = uniqueByUid(trays);
    const activeUids = new Set(uniqueTrays.map((tray) => tray.uid));

    for (const tray of uniqueTrays) {
      signal?.throwIfAborted();
      await this.syncTray(tray, seenAt, colorAliases);
    }

    if (this.config.clearAbsentLoaded) {
      signal?.throwIfAborted();
      await this.clearAbsentLoaded(activeUids, seenAt);
    }
  }

  async syncTray(tray, seenAt, colorAliases = null) {
    const page = await this.findPageForTray(tray);
    const normalizedColor = normalizeColor(tray.color);
    const iconDescriptor = colorIconDescriptor(tray);
    let colorAlias = normalizedColor && colorAliases?.has(normalizedColor) ? colorAliases.get(normalizedColor) : "";
    if (normalizedColor && !colorAliases?.has(normalizedColor)) {
      const colorMapping = await this.upsertTaskFilamentColor(tray.color);
      colorAlias = colorMapping?.alias || "";
      colorAliases?.set(normalizedColor, colorAlias);
    }

    const properties = this.buildTrayProperties(tray, seenAt, colorAlias);
    const signature = this.stableTraySignature(page, properties, iconDescriptor);

    if (this.lastSignatures.get(tray.uid) === signature) {
      this.logger.debug(`No Notion changes for ${tray.uid} (${tray.slotLabel})`);
      return;
    }

    if (page) {
      if (this.pageMatchesTray(page, tray, colorAlias, iconDescriptor)) {
        this.lastSignatures.set(tray.uid, signature);
        this.logger.debug(`No Notion changes for ${tray.uid} (${tray.slotLabel})`);
        return;
      }

      const icon = await this.amsSwatchIcon(iconDescriptor);
      try {
        await this.updatePage(page.id, properties, tray, icon);
      } catch (error) {
        this.discardUnconfirmedAmsIcon(iconDescriptor, icon);
        throw error;
      }
      this.lastSignatures.set(tray.uid, signature);
      return;
    }

    if (!this.config.createMissingPages) {
      this.logger.warn(`No Notion row bound to AMS filament UID ${tray.uid}; skipping`);
      return;
    }

    const icon = await this.amsSwatchIcon(iconDescriptor);
    try {
      await this.createMissingPage(tray, properties, icon);
    } catch (error) {
      this.discardUnconfirmedAmsIcon(iconDescriptor, icon);
      throw error;
    }
    this.lastSignatures.set(tray.uid, signature);
  }

  stableTraySignature(page, properties, icon) {
    const lastSyncProp = this.config.properties.lastSync;
    const lastSyncSchema = lastSyncProp ? this.schema[lastSyncProp] : null;
    const lastSyncKey = lastSyncSchema ? propId(lastSyncProp, lastSyncSchema) : lastSyncProp;
    const stableProperties = { ...properties };
    if (lastSyncKey) delete stableProperties[lastSyncKey];
    return JSON.stringify({ pageId: page?.id || null, properties: stableProperties, icon });
  }

  pageMatchesTray(page, tray, colorAlias, iconDescriptor) {
    const props = this.config.properties;
    return (
      this.pagePropertyMatches(page, props.title, this.displayTitle(tray)) &&
      this.pagePropertyMatches(page, props.amsUid, tray.uid) &&
      this.pagePropertyMatches(page, props.remainPercent, tray.remainPercent) &&
      this.pagePropertyMatches(page, props.remainGrams, tray.remainGrams) &&
      this.pagePropertyMatches(page, props.amsSlot, tray.slotLabel) &&
      this.pagePropertyMatches(page, props.loaded, true) &&
      this.pagePropertyMatches(page, props.printer, this.config.printerName) &&
      this.pagePropertyMatches(page, props.material, tray.material) &&
      this.pagePropertyMatches(page, props.color, tray.color) &&
      this.pagePropertyMatches(page, props.colorList, colorListLabel(tray.colors, tray.color)) &&
      this.pagePropertyMatches(page, props.colorType, trayColorTypeLabel(tray)) &&
      this.pagePropertyMatches(page, props.colorAlias, colorLabel(tray.color, colorAlias)) &&
      this.pagePropertyMatches(page, props.tagUid, tray.tagUid) &&
      this.pagePropertyMatches(page, props.trayUuid, tray.trayUuid) &&
      this.pagePropertyMatches(page, props.trayWeight, tray.trayWeight) &&
      this.pageIconMatches(page.icon, iconDescriptor)
    );
  }

  pagePropertyMatches(page, propertyName, value) {
    if (!propertyName) return true;
    const schema = this.schema[propertyName];
    if (!schema) return true;
    const current = page.properties?.[propertyName];

    switch (schema.type) {
      case "title":
      case "rich_text":
      case "select":
      case "status":
      case "url":
      case "email":
      case "phone_number":
        return getPlainText(current) === String(value == null ? "" : value);
      case "number": {
        const expected = value == null || value === "" ? null : Number(value);
        const actual = current?.number == null ? null : Number(current.number);
        return expected === actual;
      }
      case "checkbox":
        return Boolean(current?.checkbox) === Boolean(value);
      case "multi_select": {
        const expected = (Array.isArray(value) ? value : value ? [value] : []).map(String).sort();
        const actual = Array.isArray(current?.multi_select)
          ? current.multi_select.map((item) => item.name).filter(Boolean).sort()
          : [];
        return JSON.stringify(expected) === JSON.stringify(actual);
      }
      default:
        return true;
    }
  }

  pageIconMatches(pageIcon, iconDescriptor) {
    if (!iconDescriptor) return true;
    if (iconDescriptor.type === "external") {
      const desiredUrl = iconDescriptor.external?.url || "";
      if (!desiredUrl) return true;
      const currentUrl = pageIcon?.type === "external" ? pageIcon.external?.url || "" : "";
      return currentUrl === desiredUrl;
    }
    if (!iconDescriptor.key) return true;
    if (!pageIcon) return false;
    if (pageIcon.type === "file" || pageIcon.type === "file_upload") return true;
    return false;
  }

  async findPageByUid(uid) {
    const propName = this.config.properties.amsUid;
    const propSchema = this.assertProperty(propName, "AMS filament UID lookup");
    const response = await this.client.dataSources.query({
      data_source_id: this.config.dataSourceId,
      filter: filterForExactValue(propName, propSchema, uid),
      page_size: 2
    });

    if (response.results.length > 1) {
      this.logger.warn(`Multiple Notion rows use AMS filament UID ${uid}; updating the first one`);
    }

    return response.results[0] || null;
  }

  async findPageByTrayUuid(trayUuid) {
    if (!trayUuid) return null;
    const propName = this.config.properties.trayUuid;
    if (!propName) return null;

    const propSchema = this.schema[propName];
    if (!propSchema) return null;

    const response = await this.client.dataSources.query({
      data_source_id: this.config.dataSourceId,
      filter: filterForExactValue(propName, propSchema, trayUuid),
      page_size: 2
    });

    if (response.results.length > 1) {
      this.logger.warn(`Multiple Notion rows use Tray UUID ${trayUuid}; updating the first one`);
    }

    return response.results[0] || null;
  }

  async findPageForTray(tray) {
    const byUid = await this.findPageByUid(tray.uid);
    if (byUid) return byUid;

    if (tray.trayUuid && tray.trayUuid !== tray.uid) {
      const byTrayUuid = await this.findPageByTrayUuid(tray.trayUuid);
      if (byTrayUuid) {
        this.logger.info(`Matched existing AMS row by Tray UUID ${tray.trayUuid}; updating stable UID to ${tray.uid}`);
        return byTrayUuid;
      }
    }

    return null;
  }

  buildTrayProperties(tray, seenAt, colorAlias = "") {
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
      this.valueFor(props.colorList, colorListLabel(tray.colors, tray.color)),
      this.valueFor(props.colorType, trayColorTypeLabel(tray)),
      this.valueFor(props.colorAlias, colorLabel(tray.color, colorAlias)),
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

  async syncPrinterStatus(printState, { signal } = {}) {
    if (signal && this.currentRequestSignal() !== signal) {
      return this.runWithRequestSignal(signal, () => this.syncPrinterStatus(printState, { signal }));
    }
    signal?.throwIfAborted();
    if (!this.printTaskSyncEnabled) return;
    if (!this.taskDataSourceId) return;

    const record = this.printTaskRecordFromPrinterState(printState);
    if (!record) return;

    const previous = this.activeTasks.get(record.taskKey);
    const merged = this.mergeTaskRecords(previous?.record, record);
    const shouldWrite = this.shouldWritePrintTask(previous, merged);
    const state = {
      record: merged,
      lastProgress: previous?.lastProgress ?? null,
      lastWriteAt: previous?.lastWriteAt || 0,
      lastStatus: previous?.lastStatus || "",
      writeInFlight: previous?.writeInFlight || false,
      pendingWrite: previous?.pendingWrite || false
    };
    this.activeTasks.set(record.taskKey, state);

    if (!shouldWrite && !state.pendingWrite) return;
    state.pendingWrite = true;
    if (state.writeInFlight) {
      this.logger.debug(`Queued print task status update while previous write is still running: ${record.taskKey}`);
      return;
    }

    await this.flushPrinterStatusTask(record.taskKey, { signal });
  }

  async flushPrinterStatusTask(taskKey, { signal } = {}) {
    let state = this.activeTasks.get(taskKey);
    if (!state || state.writeInFlight) return;

    state.writeInFlight = true;
    try {
      while (true) {
        state = this.activeTasks.get(taskKey) || state;
        if (!state.pendingWrite) break;
        state.pendingWrite = false;
        const record = state.record;
        try {
          signal?.throwIfAborted();
          await this.upsertPrintTask(record);
          signal?.throwIfAborted();
        } catch (error) {
          const latest = this.activeTasks.get(taskKey) || state;
          if (!latest.pendingWrite) {
            // Preserve the failed write as pending. The outer MQTT supervisor
            // will retry the same snapshot; without this marker the in-memory
            // merged record could make that retry look unchanged and drop it.
            latest.pendingWrite = true;
            this.activeTasks.set(taskKey, latest);
            throw error;
          }
          this.logger.warn(
            `Print task sync failed while a newer state was queued; continuing with the latest state for ${taskKey}: ${error.message}`
          );
          continue;
        }
        const latest = this.activeTasks.get(taskKey) || state;
        state = {
          ...latest,
          lastProgress: record.progress,
          lastWriteAt: Date.now(),
          lastStatus: record.status,
          writeInFlight: true
        };
        this.activeTasks.set(taskKey, state);
      }
    } finally {
      state = this.activeTasks.get(taskKey);
      if (state) {
        state.writeInFlight = false;
        this.activeTasks.set(taskKey, state);
      }
    }
  }

  async syncCloudPrintTasks(tasks, options = {}) {
    const { onTaskSynced, signal } = options;
    if (signal && this.currentRequestSignal() !== signal) {
      return this.runWithRequestSignal(signal, () => this.syncCloudPrintTasks(tasks, options));
    }
    if (!this.printTaskSyncEnabled) return { synced: 0, changed: 0, unchanged: 0, lastTaskTime: "" };
    if (!this.taskDataSourceId || !Array.isArray(tasks) || tasks.length === 0) {
      return { synced: 0, changed: 0, unchanged: 0, lastTaskTime: "" };
    }

    signal?.throwIfAborted();
    await this.ensureTaskSchema({ refresh: true });
    signal?.throwIfAborted();
    const records = tasks
      .map((task) => this.printTaskRecordFromCloudTask(task))
      .filter(Boolean)
      .sort((a, b) => printTaskRecordHistoryTimeMs(a) - printTaskRecordHistoryTimeMs(b));
    if (records.length === 0) return { synced: 0, changed: 0, unchanged: 0, lastTaskTime: "" };

    this.logger.info(`Syncing ${records.length} Bambu cloud print task(s) into Notion`);

    this.taskFilamentSpecPageCache.clear();
    this.taskFilamentColorPageCache.clear();
    this.cloudTaskBatchMode = true;
    let synced = 0;
    let changed = 0;
    let unchanged = 0;
    let lastTaskTime = "";
    try {
      for (const record of records) {
        signal?.throwIfAborted();
        const result = await this.upsertPrintTask(record);
        signal?.throwIfAborted();
        synced += 1;
        if (result?.changed === false) unchanged += 1;
        else changed += 1;
        const recordTimeMs = printTaskRecordHistoryTimeMs(record);
        if (recordTimeMs > 0) lastTaskTime = new Date(recordTimeMs).toISOString();
        if (onTaskSynced) {
          await onTaskSynced(record, { synced, changed, unchanged, lastTaskTime });
          signal?.throwIfAborted();
        }
      }
    } finally {
      this.cloudTaskBatchMode = false;
    }
    return { synced, changed, unchanged, lastTaskTime };
  }

  printTaskRecordFromCloudTask(task) {
    const taskId = task?.id == null ? "" : String(task.id);
    const taskKey = this.taskKey({ taskId });
    if (!taskKey) return null;

    const status = this.statusFromCloudTask(task.status);
    const startTime = toIsoDate(task.startTime);
    const endTime = this.isTerminalTaskStatus(status) ? toIsoDate(task.endTime) : null;
    const durationMinutes = this.isTerminalTaskStatus(status) ? this.durationMinutes(startTime, endTime, task.costTime) : null;
    const usedSlots = this.slotLabelsFromCloudTask(task);
    const snapshotUrl = task.snapShot || "";
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
      progress: status === "已完成" ? 100 : null,
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
    const taskId = !isZeroish(printState?.task_id) ? String(printState.task_id) : "";
    const subtaskId = !isZeroish(printState?.subtask_id) ? String(printState.subtask_id) : "";
    const taskKey = this.taskKey({
      taskId,
      subtaskId,
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
      taskId: taskId || subtaskId,
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
    if (!isZeroish(taskId)) return `bambu:${printerSerial}:task:${taskId}`;
    if (!isZeroish(subtaskId)) return `bambu:${printerSerial}:subtask:${subtaskId}`;
    if (!isZeroish(projectId) && !isZeroish(profileId)) return `bambu:${printerSerial}:project:${projectId}:profile:${profileId}`;
    if (gcodeFile && !isZeroish(gcodeStartTime)) {
      return `bambu:${printerSerial}:gcode:${hashString(`${gcodeFile}:${gcodeStartTime}`)}`;
    }
    return "";
  }

  statusFromCloudTask(status) {
    const value = Number(status);
    if (value === 1) return "运行中";
    if (value === 2) return "已完成";
    if (value === 3) return "失败";
    if (value === 4) return "运行中";
    if (value === 5) return "已取消";
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
    const uid = pickSlotUid(tray, this.config.uidFields);
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

  emptyTaskMedia(overrides = {}) {
    return {
      thumbnailFiles: null,
      snapshotFiles: null,
      displayImageFiles: null,
      pageCover: null,
      coverUpload: null,
      coverExternalUrl: "",
      snapshotUpload: null,
      snapshotExternalUrl: "",
      displayImageUpload: null,
      displayImageExternalUrl: "",
      ...overrides
    };
  }

  withPrintTaskLastSync(properties) {
    const value = this.taskValueFor(this.config.taskProperties.lastSync, new Date());
    return value ? { ...properties, [value[0]]: value[1] } : properties;
  }

  async upsertPrintTask(record) {
    this.currentRequestSignal()?.throwIfAborted();
    await this.ensureTaskSchema({ refresh: !this.cloudTaskBatchMode });
    const pages = await this.findTaskPagesByKey(record.taskKey);
    const canonical = pages.length > 0 ? this.chooseCanonicalTaskPage(pages) : null;
    if (canonical && pages.length <= 1) {
      const mediaPlan = this.taskMediaPlan(record, canonical);
      const comparableProperties = await this.buildPrintTaskProperties(
        record,
        canonical,
        this.emptyTaskMedia(),
        pages,
        { includeLastSync: false }
      );
      const matchesTask = !this.taskMediaPlanNeedsChanges(mediaPlan) && this.pagePropertiesMatch(canonical, comparableProperties);
      const matchesUsages = matchesTask ? await this.taskFilamentUsagesMatch(record, canonical) : false;
      if (matchesTask && matchesUsages) {
        this.lastTaskSignatures.set(record.taskKey, JSON.stringify({
          pageId: canonical.id,
          properties: comparableProperties,
          usages: record.filamentUsages || [],
          cover: ""
        }));
        this.logger.debug(`No Notion changes for print task ${record.taskKey}`);
        return { changed: false, action: "unchanged", pageId: canonical.id };
      }
    }

    const media = await this.prepareTaskMedia(record, canonical);
    const comparableProperties = await this.buildPrintTaskProperties(record, canonical, media, pages, { includeLastSync: false });
    const properties = this.withPrintTaskLastSync(comparableProperties);
    const signature = JSON.stringify({
      pageId: canonical?.id || null,
      properties: comparableProperties,
      usages: record.filamentUsages || [],
      cover: media.coverUpload?.id || media.coverExternalUrl || ""
    });

    if (canonical && this.lastTaskSignatures.get(record.taskKey) === signature && pages.length <= 1) {
      this.logger.debug(`No Notion changes for print task ${record.taskKey}`);
      return { changed: false, action: "unchanged", pageId: canonical.id };
    }

    if (this.config.dryRun) {
      this.logger.info(
        `[dry-run] Would ${canonical ? "update" : "create"} Notion print task "${record.title}" (${record.taskKey})`
      );
      return { changed: true, action: canonical ? "updated" : "created", pageId: canonical?.id || "" };
    }

    this.currentRequestSignal()?.throwIfAborted();
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

    const usagePages = await this.syncTaskFilamentUsages(record, pageId);
    this.currentRequestSignal()?.throwIfAborted();
    const usagePageIds = usagePages.map((item) => item.pageId).filter(Boolean);
    if (usagePageIds.length > 0) {
      await this.updateTaskFilamentUsageRelation(pageId, usagePageIds);
    }

    this.lastTaskSignatures.set(record.taskKey, signature);
    return { changed: true, action: canonical ? "updated" : "created", pageId };
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
    if (getDateValue(properties[props.startTime])) score += 6;
    if (getDateValue(properties[props.endTime])) score += 6;
    if (getPlainText(properties[props.title])) score += 3;
    if (getPlainText(properties[props.taskId])) score += 2;
    if (getFileValues(properties[props.snapshot]).length > 0) score += 4;
    if (getFileValues(properties[props.thumbnail]).length > 0) score += 3;
    if (getFileValues(properties[props.displayImage]).length > 0) score += 2;
    score += getRelationIds(properties[props.usedFilaments]).length;
    if (getNumberValue(properties[props.filamentWeight]) != null) score += 2;
    return score;
  }

  async countPrintTaskPages({ includeDuplicates = false } = {}) {
    if (!this.taskDataSourceId) return 0;

    await this.ensureTaskSchema();
    const filter = includeDuplicates ? null : this.taskGalleryViewFilter();
    let count = 0;
    let startCursor;
    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.taskDataSourceId,
        ...(filter ? { filter } : {}),
        page_size: 100,
        start_cursor: startCursor
      });
      count += (response.results || []).length;
      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);
    return count;
  }

  pagePropertyByIdentifier(page, property) {
    const properties = page?.properties || {};
    if (properties[property]) return properties[property];
    return Object.values(properties).find((value) => value?.id === property) || null;
  }

  pagePropertiesMatch(page, expectedProperties) {
    return Object.entries(expectedProperties || {}).every(([property, expected]) => {
      const existing = this.pagePropertyByIdentifier(page, property);
      return this.propertyValueMatches(existing, expected);
    });
  }

  propertyValueMatches(existing, expected) {
    if (!expected) return true;
    if ("title" in expected) return getPlainText(existing) === textPayloadValue(expected.title);
    if ("rich_text" in expected) return getPlainText(existing) === textPayloadValue(expected.rich_text);
    if ("number" in expected) {
      const actual = getNumberValue(existing);
      return expected.number == null ? actual == null : actual === Number(expected.number);
    }
    if ("date" in expected) return sameDateValue(getDateValue(existing), expected.date?.start || "");
    if ("select" in expected) return getSelectName(existing) === (expected.select?.name || "");
    if ("status" in expected) return getSelectName(existing) === (expected.status?.name || "");
    if ("url" in expected) return (existing?.url || "") === (expected.url || "");
    if ("relation" in expected) {
      return sameStringSet(getRelationIds(existing), (expected.relation || []).map((item) => item.id));
    }
    if ("files" in expected) {
      const actual = getFileValues(existing).map(fileSignature).sort();
      const desired = (expected.files || []).map(fileSignature).sort();
      return actual.length === desired.length && actual.every((value, index) => value === desired[index]);
    }
    return false;
  }

  async backfillTaskDisplayImages() {
    if (!this.taskDataSourceId) return { scanned: 0, updated: 0, skipped: 0, missingSource: 0 };

    await this.ensureTaskSchema({ refresh: true });
    const props = this.config.taskProperties;
    const displaySchema = this.assertTaskProperty(props.displayImage, "print task display image backfill");
    const syncStatusSchema = this.taskSchema?.[props.syncStatus];
    const filterParts = [
      { property: propId(props.displayImage, displaySchema), files: { is_empty: true } }
    ];
    if (syncStatusSchema) {
      filterParts.push({
        property: propId(props.syncStatus, syncStatusSchema),
        select: { does_not_equal: "重复" }
      });
    }

    const filter = filterParts.length === 1 ? filterParts[0] : { and: filterParts };
    let startCursor;
    let scanned = 0;
    let updated = 0;
    let skipped = 0;
    let missingSource = 0;

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.taskDataSourceId,
        filter,
        page_size: 100,
        start_cursor: startCursor
      });

      for (const page of response.results || []) {
        scanned += 1;
        const properties = page.properties || {};
        if (getSelectName(properties[props.syncStatus]) === "重复") {
          skipped += 1;
          continue;
        }
        if (getFileValues(properties[props.displayImage]).length > 0) {
          skipped += 1;
          continue;
        }

        const snapshotFiles = getFileValues(properties[props.snapshot]);
        const thumbnailFiles = getFileValues(properties[props.thumbnail]);
        const sourceFiles = snapshotFiles.length > 0 ? snapshotFiles : thumbnailFiles;
        const displayFiles = sourceFiles.map((file) => this.displayImageFileFromExisting(file)).filter(Boolean);
        if (displayFiles.length === 0) {
          missingSource += 1;
          continue;
        }

        if (!this.config.dryRun) {
          await this.client.pages.update({
            page_id: page.id,
            properties: compactObject([
              this.taskValueFor(props.displayImage, displayFiles)
            ])
          });
        }
        updated += 1;
      }

      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    if (scanned > 0 || updated > 0) {
      this.logger.info(
        `Backfilled print task display images: ${updated} updated, ${skipped} skipped, ${missingSource} missing source`
      );
    }
    return { scanned, updated, skipped, missingSource };
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

  withTaskFilamentLastSync(properties) {
    const value = this.taskFilamentValueFor(this.config.taskFilamentProperties.lastSync, new Date());
    return value ? { ...properties, [value[0]]: value[1] } : properties;
  }

  async taskFilamentUsagesMatch(record, taskPage) {
    const usages = record.filamentUsages || [];
    const taskPageId = typeof taskPage === "string" ? taskPage : taskPage?.id;
    if (!this.taskFilamentDataSourceId || !taskPageId || usages.length === 0) return true;

    await this.ensureTaskFilamentSchema();
    await this.ensureTaskFilamentSpecSchema();
    const usagePageIds = [];
    for (const usage of usages) {
      const detailKey = `${record.taskKey}:filament:${usage.index}`;
      const pages = await this.findTaskFilamentPagesByKey(detailKey);
      const page = pages[0] || null;
      if (!page || pages.length > 1) return false;
      usagePageIds.push(page.id);

      let specPageId = "";
      if (this.taskFilamentSpecDataSourceId) {
        const specPages = await this.findTaskFilamentSpecPagesByKey(this.filamentSpecKey(usage));
        specPageId = specPages[0]?.id || "";
        if (!specPageId) return false;
      }

      const title = this.taskFilamentUsageTitle(usage);
      const properties = this.buildTaskFilamentUsageProperties(
        record,
        taskPageId,
        usage,
        detailKey,
        title,
        specPageId,
        { includeLastSync: false }
      );
      if (!this.pagePropertiesMatch(page, properties)) return false;
    }

    const relationProperty = this.config.taskProperties.filamentUsages;
    if (relationProperty && this.taskSchema?.[relationProperty] && typeof taskPage !== "string") {
      const currentRelationIds = getRelationIds(taskPage.properties?.[relationProperty]);
      if (!sameStringSet(currentRelationIds, usagePageIds)) return false;
    }
    return true;
  }

  async syncTaskFilamentUsages(record, taskPageId) {
    const usages = record.filamentUsages || [];
    if (!this.taskFilamentDataSourceId || !taskPageId || usages.length === 0) return [];

    const refreshSchema = !this.cloudTaskBatchMode;
    await this.ensureTaskFilamentSchema({ refresh: refreshSchema });
    await this.ensureTaskFilamentColorSchema({ refresh: refreshSchema });
    await this.ensureTaskFilamentSpecSchema({ refresh: refreshSchema });

    const ids = [];
    for (const usage of usages) {
      const specPage = await this.upsertTaskFilamentSpec(usage);
      const page = await this.upsertTaskFilamentUsage(record, taskPageId, usage, specPage?.id || "");
      if (page?.id) {
        ids.push({
          pageId: page.id,
          usage,
          specPageId: specPage?.id || "",
          specKey: this.filamentSpecKey(usage)
        });
      }
    }
    return ids;
  }

  async upsertTaskFilamentSpec(usage) {
    if (!this.taskFilamentSpecDataSourceId) return null;

    const specKey = this.filamentSpecKey(usage);
    const cached = this.taskFilamentSpecPageCache.get(specKey);
    if (cached && this.cloudTaskBatchMode) return cached;

    const colorMapping = await this.upsertTaskFilamentColor(usage.color);
    const pages = await this.findTaskFilamentSpecPagesByKey(specKey);
    const page = pages[0] || null;
    const title = this.taskFilamentSpecTitle(usage, colorMapping?.alias);
    const properties = this.buildTaskFilamentSpecProperties(usage, specKey, title);
    const icon = swatchIcon(usage.color);

    if (this.config.dryRun) {
      this.logger.info(`[dry-run] Would ${page ? "update" : "create"} Notion filament spec "${title}"`);
      return null;
    }

    if (page) {
      await this.client.pages.update({
        page_id: page.id,
        properties,
        ...(icon ? { icon } : {})
      });
      this.taskFilamentSpecPageCache.set(specKey, page);
      return page;
    }

    const created = await this.client.pages.create({
      parent: { data_source_id: this.taskFilamentSpecDataSourceId },
      properties,
      ...(icon ? { icon } : {})
    });
    this.taskFilamentSpecPageCache.set(specKey, created);
    return created;
  }

  async upsertTaskFilamentColor(colorValue) {
    const color = normalizeColor(colorValue);
    if (!this.taskFilamentColorDataSourceId || !color) return null;

    const cached = this.taskFilamentColorPageCache.get(color);
    if (cached && this.cloudTaskBatchMode) return cached;

    const pages = await this.findTaskFilamentColorPagesByKey(color);
    const page = pages[0] || null;
    const alias = page ? getPlainText(page.properties?.[this.config.taskFilamentColorProperties.alias]) : "";
    const properties = this.buildTaskFilamentColorProperties(color);
    const icon = swatchIcon(color);
    const result = page ? { id: page.id, alias, color } : null;

    if (this.config.dryRun) {
      this.logger.info(`[dry-run] Would ${page ? "update" : "create"} Notion filament color "${color}"`);
      return null;
    }

    if (page) {
      if (this.taskFilamentColorPageMatches(page, color, icon)) {
        this.taskFilamentColorPageCache.set(color, result);
        return result;
      }

      await this.client.pages.update({
        page_id: page.id,
        properties,
        ...(icon ? { icon } : {})
      });
      this.taskFilamentColorPageCache.set(color, result);
      return result;
    }

    const created = await this.client.pages.create({
      parent: { data_source_id: this.taskFilamentColorDataSourceId },
      properties,
      ...(icon ? { icon } : {})
    });
    const createdResult = { id: created.id, alias: "", color };
    this.taskFilamentColorPageCache.set(color, createdResult);
    return createdResult;
  }

  taskFilamentColorPageMatches(page, color, icon) {
    const props = this.config.taskFilamentColorProperties;
    const textMatches = (propertyName, value) => {
      if (!propertyName) return true;
      const schema = this.taskFilamentColorSchema?.[propertyName];
      if (!schema) return true;
      return getPlainText(page.properties?.[propertyName]) === String(value == null ? "" : value);
    };

    return (
      textMatches(props.title, color) &&
      textMatches(props.colorKey, color) &&
      this.pageIconMatches(page.icon, icon)
    );
  }

  async taskFilamentColorAliasMap() {
    const aliases = new Map();
    if (!this.taskFilamentColorDataSourceId) return aliases;

    const props = this.config.taskFilamentColorProperties;
    let startCursor;

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.taskFilamentColorDataSourceId,
        page_size: 100,
        start_cursor: startCursor
      });

      for (const page of response.results || []) {
        const properties = page.properties || {};
        const color = normalizeColor(getPlainText(properties[props.colorKey]) || getPlainText(properties[props.title]));
        if (!color) continue;

        const alias = getPlainText(properties[props.alias]).trim();
        aliases.set(color, alias);
        this.taskFilamentColorPageCache.set(color, { id: page.id, alias, color });
      }

      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    return aliases;
  }

  async syncTaskFilamentSpecTitlesFromColorMappings() {
    if (!this.taskFilamentSpecDataSourceId || !this.taskFilamentColorDataSourceId) return;

    this.taskFilamentSpecPageCache.clear();
    this.taskFilamentColorPageCache.clear();

    const aliases = await this.taskFilamentColorAliasMap();
    const props = this.config.taskFilamentSpecProperties;
    let startCursor;
    let scanned = 0;
    let updated = 0;

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.taskFilamentSpecDataSourceId,
        page_size: 100,
        start_cursor: startCursor
      });

      for (const page of response.results || []) {
        scanned += 1;
        const properties = page.properties || {};
        const specKey = getPlainText(properties[props.specKey]);
        const separator = specKey.indexOf(":");
        const materialFromKey = separator >= 0 ? specKey.slice(0, separator) : "";
        const colorFromKey = separator >= 0 ? specKey.slice(separator + 1) : "";
        const material = getPlainText(properties[props.material]) || materialFromKey || "耗材";
        const color = normalizeColor(getPlainText(properties[props.color]) || colorFromKey);
        if (!color) continue;

        if (!aliases.has(color)) {
          const colorMapping = await this.upsertTaskFilamentColor(color);
          aliases.set(color, colorMapping?.alias || "");
        }

        const title = this.taskFilamentSpecTitle({ material, color }, aliases.get(color));
        const currentTitle = getPlainText(properties[props.title]);
        if (currentTitle === title) continue;

        const icon = swatchIcon(color);
        const updateProperties = compactObject([
          this.taskFilamentSpecValueFor(props.title, title),
          this.taskFilamentSpecValueFor(props.material, material),
          this.taskFilamentSpecValueFor(props.color, color),
          this.taskFilamentSpecValueFor(props.lastSync, new Date())
        ]);

        if (this.config.dryRun) {
          this.logger.info(`[dry-run] Would rename Notion filament spec "${currentTitle}" to "${title}"`);
          continue;
        }

        await this.client.pages.update({
          page_id: page.id,
          properties: updateProperties,
          ...(icon ? { icon } : {})
        });
        updated += 1;
      }

      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    if (updated > 0) {
      this.logger.info(`Updated ${updated}/${scanned} Notion filament spec title(s) from color aliases`);
    }
  }

  async syncAmsColorAliasesFromColorMappings() {
    if (!this.config.dataSourceId || !this.taskFilamentColorDataSourceId) return;

    const props = this.config.properties;
    if (!props.color || !props.colorAlias) return;

    this.taskFilamentColorPageCache.clear();
    const aliases = await this.taskFilamentColorAliasMap();
    let startCursor;
    let scanned = 0;
    let updated = 0;

    do {
      const response = await this.client.dataSources.query({
        data_source_id: this.config.dataSourceId,
        page_size: 100,
        start_cursor: startCursor
      });

      for (const page of response.results || []) {
        scanned += 1;
        const properties = page.properties || {};
        const color = normalizeColor(getPlainText(properties[props.color]));
        if (!color) continue;

        if (!aliases.has(color)) {
          const colorMapping = await this.upsertTaskFilamentColor(color);
          aliases.set(color, colorMapping?.alias || "");
        }

        const alias = colorLabel(color, aliases.get(color));
        const currentAlias = getPlainText(properties[props.colorAlias]);
        if (currentAlias === alias) continue;

        const updateProperties = compactObject([
          this.valueFor(props.colorAlias, alias),
          this.valueFor(props.lastSync, new Date())
        ]);

        if (this.config.dryRun) {
          this.logger.info(`[dry-run] Would update AMS color alias ${publicPageId(page.id)} to "${alias}"`);
          continue;
        }

        await this.client.pages.update({
          page_id: page.id,
          properties: updateProperties
        });
        updated += 1;
      }

      startCursor = response.has_more ? response.next_cursor : undefined;
    } while (startCursor);

    if (updated > 0) {
      this.logger.info(`Updated ${updated}/${scanned} AMS color alias(es) from color mappings`);
    }
  }

  async upsertTaskFilamentUsage(record, taskPageId, usage, specPageId = "") {
    const detailKey = `${record.taskKey}:filament:${usage.index}`;
    const pages = await this.findTaskFilamentPagesByKey(detailKey);
    const page = pages[0] || null;
    const title = this.taskFilamentUsageTitle(usage);
    const comparableProperties = this.buildTaskFilamentUsageProperties(
      record,
      taskPageId,
      usage,
      detailKey,
      title,
      specPageId,
      { includeLastSync: false }
    );
    if (page && pages.length === 1 && this.pagePropertiesMatch(page, comparableProperties)) {
      return page;
    }

    const properties = this.withTaskFilamentLastSync(comparableProperties);
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

  async findTaskFilamentSpecPagesByKey(specKey) {
    const propName = this.config.taskFilamentSpecProperties.specKey;
    const propSchema = this.assertTaskFilamentSpecProperty(propName, "filament spec lookup");
    const response = await this.client.dataSources.query({
      data_source_id: this.taskFilamentSpecDataSourceId,
      filter: filterForExactValue(propName, propSchema, specKey),
      page_size: 100
    });
    return response.results || [];
  }

  async findTaskFilamentColorPagesByKey(colorKey) {
    const propName = this.config.taskFilamentColorProperties.colorKey;
    const propSchema = this.assertTaskFilamentColorProperty(propName, "filament color lookup");
    const response = await this.client.dataSources.query({
      data_source_id: this.taskFilamentColorDataSourceId,
      filter: filterForExactValue(propName, propSchema, colorKey),
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

  filamentSpecKey(usage) {
    return `${usage.material || "耗材"}:${usage.color || "unknown"}`;
  }

  taskFilamentSpecTitle(usage, colorAlias = "") {
    return [
      usage.material || "耗材",
      colorLabel(usage.color, colorAlias)
    ].filter(Boolean).join(" · ");
  }

  buildTaskFilamentSpecProperties(usage, specKey, title) {
    const props = this.config.taskFilamentSpecProperties;
    return compactObject([
      this.taskFilamentSpecValueFor(props.title, title),
      this.taskFilamentSpecValueFor(props.specKey, specKey),
      this.taskFilamentSpecValueFor(props.material, usage.material),
      this.taskFilamentSpecValueFor(props.color, usage.color),
      this.taskFilamentSpecValueFor(props.lastSync, new Date())
    ]);
  }

  buildTaskFilamentColorProperties(color) {
    const props = this.config.taskFilamentColorProperties;
    return compactObject([
      this.taskFilamentColorValueFor(props.title, color),
      this.taskFilamentColorValueFor(props.colorKey, color),
      this.taskFilamentColorValueFor(props.lastSync, new Date())
    ]);
  }

  buildTaskFilamentUsageProperties(record, taskPageId, usage, detailKey, title, specPageId, { includeLastSync = true } = {}) {
    const props = this.config.taskFilamentProperties;
    return compactObject([
      this.taskFilamentValueFor(props.title, title),
      this.taskFilamentValueFor(props.detailKey, detailKey),
      this.taskFilamentValueFor(props.task, [taskPageId]),
      this.taskFilamentValueFor(props.spec, specPageId ? [specPageId] : []),
      this.taskFilamentValueFor(props.taskKey, record.taskKey),
      this.taskFilamentValueFor(props.taskId, record.taskId),
      this.taskFilamentValueFor(props.slot, usage.slot),
      this.taskFilamentValueFor(props.material, usage.material),
      this.taskFilamentValueFor(props.color, usage.color),
      this.taskFilamentValueFor(props.weight, usage.weight),
      this.taskFilamentValueFor(props.percent, usage.percent),
      this.taskFilamentValueFor(props.startTime, record.startTime),
      this.taskFilamentValueFor(props.status, record.status),
      includeLastSync ? this.taskFilamentValueFor(props.lastSync, new Date()) : null
    ]);
  }

  taskMediaPlan(record, page) {
    const props = this.config.taskProperties;
    const existingThumbnail = getFileValues(page?.properties?.[props.thumbnail]);
    const existingSnapshot = getFileValues(page?.properties?.[props.snapshot]);
    const existingDisplayImage = getFileValues(page?.properties?.[props.displayImage]);
    const existingCoverSource = getPlainText(page?.properties?.[props.rawCoverUrl]);
    const existingSnapshotSource = getPlainText(page?.properties?.[props.rawSnapshotUrl]);
    const hasStableThumbnail = existingThumbnail.some((file) => file.type === "file");
    const hasStableSnapshot = existingSnapshot.some((file) => file.type === "file");
    const hasStableDisplayImage = existingDisplayImage.some((file) => file.type === "file");
    const hasStablePageCover = page?.cover?.type === "file";
    const snapshotSourceChanged = Boolean(
      record.snapshotUrl &&
        existingSnapshotSource &&
        stableMediaSource(existingSnapshotSource) !== stableMediaSource(record.snapshotUrl)
    );
    const shouldClearSnapshot = Boolean(
      !record.snapshotUrl &&
        existingSnapshot.length > 0 &&
        (
          !this.isTerminalTaskStatus(record.status) ||
          (
            existingCoverSource &&
            existingSnapshotSource &&
            stableMediaSource(existingCoverSource) === stableMediaSource(existingSnapshotSource)
          )
        )
    );
    const needsSnapshotForDisplay = Boolean(
      record.snapshotUrl &&
        (!hasStableDisplayImage || !hasStablePageCover || snapshotSourceChanged)
    );
    const shouldUploadSnapshot = Boolean(
      record.snapshotUrl &&
        (
          !hasStableSnapshot ||
          snapshotSourceChanged ||
          needsSnapshotForDisplay
        )
    );
    const needsCoverForDisplay = Boolean(
      !record.snapshotUrl &&
        record.coverUrl &&
        !hasStableDisplayImage
    );
    const shouldUploadCover = Boolean(
      record.coverUrl &&
        (
          !hasStableThumbnail ||
          needsCoverForDisplay
        )
    );
    return {
      hasStableThumbnail,
      hasStableSnapshot,
      hasStableDisplayImage,
      hasStablePageCover,
      snapshotSourceChanged,
      shouldClearSnapshot,
      needsSnapshotForDisplay,
      shouldUploadSnapshot,
      needsCoverForDisplay,
      shouldUploadCover
    };
  }

  taskMediaPlanNeedsChanges(plan) {
    return Boolean(plan.shouldClearSnapshot || plan.shouldUploadCover || plan.shouldUploadSnapshot);
  }

  async prepareTaskMedia(record, page) {
    const plan = this.taskMediaPlan(record, page);
    const media = this.emptyTaskMedia({
      snapshotFiles: plan.shouldClearSnapshot ? [] : null
    });

    if (this.config.dryRun) return media;

    if (plan.shouldUploadCover) {
      media.coverUpload = await this.importNotionFile(record.coverUrl, `${record.taskId || "task"}-cover.png`);
      media.coverExternalUrl = record.coverUrl;
      if (!plan.hasStableThumbnail) {
        media.thumbnailFiles = [this.fileRequest(media.coverUpload, record.coverUrl, "任务缩略图")];
      }
    }

    if (plan.shouldUploadSnapshot) {
      media.snapshotUpload = await this.importNotionFile(record.snapshotUrl, `${record.taskId || "task"}-snapshot.jpg`);
      media.snapshotExternalUrl = record.snapshotUrl;
      if (!plan.hasStableSnapshot || plan.snapshotSourceChanged) {
        media.snapshotFiles = [this.fileRequest(media.snapshotUpload, record.snapshotUrl, "完成截图")];
      }
    }

    if (record.snapshotUrl && plan.shouldUploadSnapshot) {
      media.displayImageUpload = media.snapshotUpload;
      media.displayImageExternalUrl = record.snapshotUrl;
      media.displayImageFiles = [this.fileRequest(media.displayImageUpload, record.snapshotUrl, "展示图片")];
    } else if (!record.snapshotUrl && plan.needsCoverForDisplay && plan.shouldUploadCover) {
      media.displayImageUpload = media.coverUpload;
      media.displayImageExternalUrl = record.coverUrl;
      media.displayImageFiles = [this.fileRequest(media.displayImageUpload, record.coverUrl, "展示图片")];
    }

    const shouldSetCover = Boolean(media.displayImageFiles && (!plan.hasStablePageCover || record.snapshotUrl));
    if (shouldSetCover && (media.displayImageUpload || media.displayImageExternalUrl)) {
      media.pageCover = media.displayImageUpload
        ? { type: "file_upload", file_upload: { id: media.displayImageUpload.id } }
        : { type: "external", external: { url: media.displayImageExternalUrl } };
    }

    return media;
  }

  async importNotionFile(url, filename) {
    if (!url || !this.client.fileUploads?.create || !this.client.fileUploads?.send) return null;

    try {
      const signal = this.currentRequestSignal();
      const externalFile = await fetchExternalFile(url, { signal });
      const { bytes } = externalFile;
      const contentType = this.contentTypeForUpload(bytes, filename, externalFile.contentType);
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
        await awaitWithSignal(sleep(1000), signal);
        sent = await this.client.fileUploads.retrieve({ file_upload_id: upload.id });
      }

      if (sent.status !== "uploaded") {
        this.logger.warn(`Notion file upload for "${filename}" ended with status "${sent.status}"`);
        return null;
      }

      return sent;
    } catch (error) {
      this.throwIfRequestAborted(error);
      this.logger.warn(`Failed to upload Notion file "${filename}": ${error.message}`);
      return null;
    }
  }

  async uploadNotionFileBytes(bytes, filename, contentType) {
    if (!bytes || !this.client.fileUploads?.create || !this.client.fileUploads?.send) return null;

    try {
      const signal = this.currentRequestSignal();
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
        await awaitWithSignal(sleep(1000), signal);
        sent = await this.client.fileUploads.retrieve({ file_upload_id: upload.id });
      }

      if (sent.status !== "uploaded") {
        this.logger.warn(`Notion file upload for "${filename}" ended with status "${sent.status}"`);
        return null;
      }

      return sent;
    } catch (error) {
      this.throwIfRequestAborted(error);
      this.logger.warn(`Failed to upload Notion file "${filename}": ${error.message}`);
      return null;
    }
  }

  async amsSwatchIcon(descriptor) {
    if (!descriptor?.key) return undefined;
    const cachedId = this.amsIconUploadCache.get(descriptor.key);
    if (cachedId) {
      return { type: "file_upload", file_upload: { id: cachedId } };
    }

    const png = renderColorIconPng(descriptor);
    if (!png) return undefined;

    const filename = `ams-filament-${hashString(descriptor.key)}.png`;
    const upload = await this.uploadNotionFileBytes(png, filename, "image/png");
    if (!upload?.id) return undefined;

    this.amsIconUploadCache.set(descriptor.key, upload.id);
    return { type: "file_upload", file_upload: { id: upload.id } };
  }

  discardUnconfirmedAmsIcon(descriptor, icon) {
    if (!descriptor?.key || !icon?.file_upload?.id) return;
    if (this.amsIconUploadCache.get(descriptor.key) === icon.file_upload.id) {
      this.amsIconUploadCache.delete(descriptor.key);
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

  displayImageFileFromExisting(file) {
    const name = "展示图片";
    if (file?.type === "file" && file.file?.url) {
      return {
        type: "file",
        file: {
          url: file.file.url,
          ...(file.file.expiry_time ? { expiry_time: file.file.expiry_time } : {})
        },
        name
      };
    }
    if (file?.type === "external" && file.external?.url) {
      return { type: "external", external: { url: file.external.url }, name };
    }
    if (file?.type === "file_upload" && file.file_upload?.id) {
      return { type: "file_upload", file_upload: { id: file.file_upload.id }, name };
    }
    return null;
  }

  async buildPrintTaskProperties(record, page, media, duplicatePages = [], { includeLastSync = true } = {}) {
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
    const existingTitle = getPlainText(existing[props.title]);
    const keepExistingTitle =
      record.source === "mqtt" &&
      existingTitle &&
      (
        this.isTerminalTaskStatus(existingStatus) ||
        getDateValue(existing[props.endTime]) ||
        getFileValues(existing[props.snapshot]).length > 0
      );
    const progress = Math.max(getNumberValue(existing[props.progress]) ?? 0, record.progress ?? 0);
    const existingThumbnailFiles = getFileValues(existing[props.thumbnail]);
    const existingDisplayImageFiles = getFileValues(existing[props.displayImage]);
    const snapshotFiles = media.snapshotFiles;
    const thumbnailFiles = existingThumbnailFiles.some((file) => file.type === "file") ? null : media.thumbnailFiles;
    const displayImageFiles = existingDisplayImageFiles.some((file) => file.type === "file")
      ? media.displayImageFiles
      : (media.displayImageFiles || media.thumbnailFiles || media.snapshotFiles);
    const rawSnapshotUrl = record.snapshotUrl
      ? stableMediaSource(record.snapshotUrl)
      : (Array.isArray(snapshotFiles) && snapshotFiles.length === 0 ? "" : getPlainText(existing[props.rawSnapshotUrl]));

    return compactObject([
      this.taskValueFor(props.title, keepExistingTitle ? existingTitle : record.title),
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
      this.taskValueFor(props.displayImage, displayImageFiles),
      this.taskValueFor(props.rawCoverUrl, stableMediaSource(record.coverUrl) || getPlainText(existing[props.rawCoverUrl])),
      this.taskValueFor(props.rawSnapshotUrl, rawSnapshotUrl),
      includeLastSync ? this.taskValueFor(props.lastSync, new Date()) : null
    ]);
  }

  async filamentPageIdsForUids(uids) {
    const ids = [];
    for (const uid of uniq(uids)) {
      this.currentRequestSignal()?.throwIfAborted();
      const page = await this.findPageByUid(uid);
      if (page?.id) ids.push(page.id);
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
        return Array.isArray(value) ? [property, { files: value }] : null;
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
      case "select":
        return [property, value ? { select: { name: String(value) } } : { select: null }];
      case "relation":
        return [property, { relation: uniq(value || []).map((id) => ({ id })) }];
      default:
        return null;
    }
  }

  taskFilamentSpecValueFor(propertyName, value) {
    if (!propertyName || value === undefined) return null;
    const schema = this.taskFilamentSpecSchema[propertyName];
    if (!schema) {
      if (!this.warnedMissingTaskFilamentSpecProperties.has(propertyName)) {
        this.warnedMissingTaskFilamentSpecProperties.add(propertyName);
        this.logger.warn(`Notion filament spec property "${propertyName}" does not exist; ignoring it`);
      }
      return null;
    }

    const property = propId(propertyName, schema);
    switch (schema.type) {
      case "title":
        return [property, { title: textContent(value) }];
      case "rich_text":
        return [property, { rich_text: textContent(value) }];
      case "date":
        return [property, { date: value ? { start: value instanceof Date ? value.toISOString() : String(value) } : null }];
      default:
        return null;
    }
  }

  taskFilamentColorValueFor(propertyName, value) {
    if (!propertyName || value === undefined) return null;
    const schema = this.taskFilamentColorSchema[propertyName];
    if (!schema) {
      if (!this.warnedMissingTaskFilamentColorProperties.has(propertyName)) {
        this.warnedMissingTaskFilamentColorProperties.add(propertyName);
        this.logger.warn(`Notion filament color property "${propertyName}" does not exist; ignoring it`);
      }
      return null;
    }

    const property = propId(propertyName, schema);
    switch (schema.type) {
      case "title":
        return [property, { title: textContent(value) }];
      case "rich_text":
        return [property, { rich_text: textContent(value) }];
      case "date":
        return [property, { date: value ? { start: value instanceof Date ? value.toISOString() : String(value) } : null }];
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

  assertTaskFilamentSpecProperty(propertyName, label) {
    const schema = this.taskFilamentSpecSchema?.[propertyName];
    if (!schema) throw new Error(`Notion filament spec property "${propertyName}" is required for ${label}`);
    return schema;
  }

  assertTaskFilamentColorProperty(propertyName, label) {
    const schema = this.taskFilamentColorSchema?.[propertyName];
    if (!schema) throw new Error(`Notion filament color property "${propertyName}" is required for ${label}`);
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

  findTaskFilamentSpecTitleProperty() {
    const configured = this.config.taskFilamentSpecProperties.title;
    if (configured && this.taskFilamentSpecSchema[configured]?.type === "title") {
      return { name: configured, schema: this.taskFilamentSpecSchema[configured] };
    }

    const [name, schema] =
      Object.entries(this.taskFilamentSpecSchema).find(([, propertySchema]) => propertySchema.type === "title") || [];
    return name ? { name, schema } : null;
  }

  findTaskFilamentColorTitleProperty() {
    const configured = this.config.taskFilamentColorProperties.title;
    if (configured && this.taskFilamentColorSchema[configured]?.type === "title") {
      return { name: configured, schema: this.taskFilamentColorSchema[configured] };
    }

    const [name, schema] =
      Object.entries(this.taskFilamentColorSchema).find(([, propertySchema]) => propertySchema.type === "title") || [];
    return name ? { name, schema } : null;
  }

}
