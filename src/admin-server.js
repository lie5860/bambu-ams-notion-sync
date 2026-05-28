import { createServer } from "node:http";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { BambuMqttClient } from "./bambu.js";
import { fetchCloudPrintTasks } from "./bambu-cloud-tasks.js";
import { CLOUD_REGIONS, loadCloudToken, loginWithCode, loginWithPassword, loginWithTfa, saveCloudToken } from "./cloud-auth.js";
import { loadConfig } from "./config.js";
import { loadStoredConfig, maskConfig, mergeConfig, resetStoredConfig, saveStoredConfig } from "./config-store.js";
import { createLogger } from "./logger.js";
import { NotionAmsSync } from "./notion-sync.js";

const HOST = process.env.ADMIN_HOST || "127.0.0.1";
const PORT = Number(process.env.ADMIN_PORT || 3030);

function sendJson(res, status, body) {
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(JSON.stringify(body));
}

function isSetupError(error) {
  return (
    error.message?.startsWith("Missing required env:") ||
    error.message?.startsWith("Cannot read Bambu cloud token file")
  );
}

function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    req.on("data", (chunk) => {
      raw += chunk;
      if (raw.length > 200_000) {
        reject(new Error("Request body too large"));
        req.destroy();
      }
    });
    req.on("end", () => {
      try {
        resolveBody(raw ? JSON.parse(raw) : {});
      } catch {
        reject(new Error("Invalid JSON"));
      }
    });
  });
}

async function removeIfExists(file) {
  try {
    await unlink(file);
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
}

function configEnabled(value) {
  return ["1", "true", "yes", "y", "on"].includes(String(value || "").toLowerCase());
}

function syncFlagsFromStored(config) {
  return {
    ams: configEnabled(config.AMS_SYNC_ENABLED),
    printHistory: configEnabled(config.PRINT_TASK_HISTORY_SYNC_ON_START)
  };
}

class SyncRuntime {
  constructor() {
    this.logger = createLogger(process.env.LOG_LEVEL || "info");
    this.bambuClient = null;
    this.notionSync = null;
    this.running = false;
    this.starting = false;
    this.startupPhase = "";
    this.maintenanceRunning = false;
    this.pendingManualSync = false;
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
    this.lastTaskHistorySyncAt = "";
    this.lastTaskHistoryCount = 0;
    this.lastTaskHistoryCheckpointAt = "";
    this.enabledSyncs = { ams: false, printHistory: false };
  }

  async restart({ forceTaskHistorySync = false } = {}) {
    await this.stop();
    const stored = await loadStoredConfig();
    this.enabledSyncs = syncFlagsFromStored(stored);
    if (!this.enabledSyncs.ams && !this.enabledSyncs.printHistory) {
      this.lastError = "";
      this.logger.info("All sync features are disabled; waiting for the user to enable AMS or print history sync");
      return;
    }

    this.starting = true;
    this.startupPhase = "加载配置";
    this.lastError = "";

    try {
      const config = loadConfig({ ...process.env, ...stored });
      const notionConfig = {
        ...config.notion,
        dryRun: config.dryRun,
        printerName: config.bambu.printerName,
        printerSerial: config.bambu.printerSerial
      };

      this.logger = createLogger(config.logLevel);
      this.notionSync = new NotionAmsSync(notionConfig, this.logger);
      this.startupPhase = "初始化 Notion";
      await this.notionSync.init({
        deferMaintenance: true,
        enableAmsSync: config.notion.amsSyncEnabled,
        enablePrintTaskSync: config.notion.printTaskHistorySyncOnStart
      });

      if (config.notion.amsSyncEnabled) {
        this.startupPhase = "连接打印机";
        this.bambuClient = new BambuMqttClient(
          config.bambu,
          this.logger,
          async (trays) => {
            this.lastSyncAt = new Date().toISOString();
            this.lastTrayCount = trays.length;
            await this.notionSync.syncTrays(trays);
          },
          config.notion.printTaskHistorySyncOnStart
            ? (printState) => this.notionSync.syncPrinterStatus(printState)
            : null,
          () => this.flushPendingManualSync()
        );
        this.bambuClient.start();
      }
      this.running = true;
      this.starting = false;
      this.startupPhase = "";
      this.lastError = "";
      this.runStartupMaintenance().catch((error) => {
        this.logger.error("Startup maintenance failed:", error.stack || error.message);
      });
      this.syncPrintTaskHistory(config, { ignoreCooldown: forceTaskHistorySync }).catch((error) => {
        this.logger.error("Print task history sync failed:", error.stack || error.message);
      });
    } catch (error) {
      this.running = false;
      this.starting = false;
      this.startupPhase = "";
      this.pendingManualSync = false;
      this.lastError = error.message;
      if (isSetupError(error)) {
        this.logger.warn("Sync service waiting for setup:", error.message);
      } else {
        this.logger.error("Sync service not started:", error.message);
      }
    }
  }

  async runStartupMaintenance() {
    if (!this.notionSync || this.maintenanceRunning) return;
    this.maintenanceRunning = true;
    try {
      await this.notionSync.runStartupMaintenance();
    } finally {
      this.maintenanceRunning = false;
    }
  }

  flushPendingManualSync() {
    if (!this.pendingManualSync) return;
    this.pendingManualSync = false;
    const ok = this.bambuClient?.requestManualSync();
    if (!ok) this.pendingManualSync = true;
  }

  async stop() {
    this.bambuClient?.stop();
    this.bambuClient = null;
    this.notionSync = null;
    this.running = false;
    this.starting = false;
    this.startupPhase = "";
    this.maintenanceRunning = false;
    this.pendingManualSync = false;
  }

  async reset() {
    await this.stop();
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
    this.lastTaskHistorySyncAt = "";
    this.lastTaskHistoryCount = 0;
    this.lastTaskHistoryCheckpointAt = "";
    this.enabledSyncs = { ams: false, printHistory: false };
  }

  async manualSync() {
    if (this.starting) {
      this.pendingManualSync = true;
      return {
        requested: false,
        pending: true,
        message: "同步服务正在启动，连接打印机后会自动执行这次同步。"
      };
    }

    const stored = await loadStoredConfig();
    const enabledSyncs = syncFlagsFromStored(stored);
    if (!enabledSyncs.ams && !enabledSyncs.printHistory) {
      throw new Error("请先打开至少一个同步开关");
    }

    const messages = [];
    let pending = false;
    if (enabledSyncs.ams) {
      if (!this.bambuClient) throw new Error("AMS 同步服务尚未运行");
      const ok = this.bambuClient.requestManualSync();
      if (!ok) {
        this.pendingManualSync = true;
        pending = true;
        messages.push("AMS 同步正在等待拓竹云连接；连接后会自动执行这次同步。");
      } else {
        messages.push("已请求打印机立即回报完整 AMS 状态。");
      }
    }

    if (enabledSyncs.printHistory) {
      const config = loadConfig({ ...process.env, ...stored });
      this.syncPrintTaskHistory(config, { ignoreCooldown: true }).catch((error) => {
        this.logger.error("Manual print task history sync failed:", error.stack || error.message);
      });
      messages.push("已开始同步打印历史。");
    }

    return { requested: !pending, pending, message: messages.join(" ") };
  }

  status() {
    return {
      running: this.running,
      starting: this.starting,
      startupPhase: this.startupPhase,
      maintenanceRunning: this.maintenanceRunning,
      pendingManualSync: this.pendingManualSync,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      lastTrayCount: this.lastTrayCount,
      lastTaskHistorySyncAt: this.lastTaskHistorySyncAt,
      lastTaskHistoryCount: this.lastTaskHistoryCount,
      lastTaskHistoryCheckpointAt: this.lastTaskHistoryCheckpointAt,
      enabledSyncs: this.enabledSyncs,
      bambu: this.bambuClient?.status() || null
    };
  }

  async syncPrintTaskHistory(config, { ignoreCooldown = false } = {}) {
    if (!config.notion.printTaskHistorySyncOnStart || !config.bambu.cloud?.accessToken || !this.notionSync) return;

    const stored = await loadStoredConfig();
    const now = Date.now();
    this.lastTaskHistoryCheckpointAt = stored.PRINT_TASK_HISTORY_LAST_TASK_TIME || "";
    const lastStartedAt = Date.parse(stored.PRINT_TASK_HISTORY_LAST_SYNC_AT || "");
    const minIntervalMs = Math.max(0, config.notion.printTaskHistoryMinIntervalMs || 0);
    if (!ignoreCooldown && minIntervalMs > 0 && Number.isFinite(lastStartedAt) && now - lastStartedAt < minIntervalMs) {
      const nextAt = new Date(lastStartedAt + minIntervalMs).toISOString();
      this.lastTaskHistorySyncAt = stored.PRINT_TASK_HISTORY_LAST_SYNC_AT || this.lastTaskHistorySyncAt;
      this.logger.info(`Skipping print task history sync; next allowed at ${nextAt}`);
      return;
    }

    const startedAt = new Date(now).toISOString();
    await saveStoredConfig({ ...stored, PRINT_TASK_HISTORY_LAST_SYNC_AT: startedAt });
    this.lastTaskHistorySyncAt = startedAt;

    const tasks = await fetchCloudPrintTasks({
      cloud: config.bambu.cloud,
      printerSerial: config.bambu.printerSerial,
      limit: config.notion.printTaskHistoryLimit,
      pageSize: config.notion.printTaskHistoryPageSize,
      sinceTime: stored.PRINT_TASK_HISTORY_LAST_TASK_TIME,
      logger: this.logger
    });
    if (tasks.length === 0) {
      this.logger.info("No new Bambu cloud print task(s) to sync");
      this.lastTaskHistoryCount = 0;
      return;
    }

    const result = await this.notionSync.syncCloudPrintTasks(tasks, {
      onTaskSynced: async (_record, { lastTaskTime }) => {
        if (config.dryRun || !lastTaskTime) return;
        const latest = await loadStoredConfig();
        await saveStoredConfig({ ...latest, PRINT_TASK_HISTORY_LAST_TASK_TIME: lastTaskTime });
        this.lastTaskHistoryCheckpointAt = lastTaskTime;
      }
    });
    this.lastTaskHistorySyncAt = startedAt;
    this.lastTaskHistoryCount = result.synced;
  }
}

const runtime = new SyncRuntime();

function page() {
  const regions = Object.entries(CLOUD_REGIONS)
    .map(([value, region]) => {
      const label = value === "china" ? "中国区" : value === "global" ? "海外区" : region.label;
      return `<option value="${value}">${label}</option>`;
    })
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bambu AMS Notion Sync</title>
  <style>
    :root { color-scheme: light; --bg:#f6f7f9; --surface:#fff; --text:#182230; --muted:#667085; --line:#d9e0ea; --accent:#0b6bcb; --bad:#b42318; --ok:#16794f; --warn:#a05a00; }
    * { box-sizing: border-box; }
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding:36px 16px; }
    main { width:min(960px,100%); margin:0 auto; display:grid; gap:16px; }
    section { background:var(--surface); border:1px solid var(--line); border-radius:8px; box-shadow:0 8px 22px rgba(18,29,45,.06); }
    h1 { font-size:24px; margin:0 0 4px; }
    h2 { font-size:17px; margin:0; }
    h3 { font-size:14px; margin:0; }
    p { color:var(--muted); margin:0; line-height:1.55; }
    form { display:grid; gap:12px; }
    .hero { padding:24px; }
    .panel { overflow:hidden; }
    .panelHeader { width:100%; height:auto; border:0; background:transparent; color:var(--text); display:grid; grid-template-columns:auto 1fr auto auto; gap:14px; align-items:center; padding:20px 22px; text-align:left; cursor:pointer; }
    .stepNo { width:30px; height:30px; display:grid; place-items:center; border-radius:999px; background:#eef4fb; color:#064f99; font-weight:750; }
    .stepCopy { display:grid; gap:3px; min-width:0; }
    .summary { color:var(--muted); font-size:13px; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .pill { border:1px solid var(--line); border-radius:999px; padding:4px 9px; color:var(--muted); background:#fff; font-size:12px; font-weight:700; white-space:nowrap; }
    .pill.ok { color:var(--ok); border-color:#b8e0cd; background:#f1fbf6; }
    .pill.warn { color:var(--warn); border-color:#f2d5a3; background:#fff8eb; }
    .pill.bad { color:var(--bad); border-color:#f3b8b2; background:#fff4f3; }
    .chevron { color:var(--muted); transition:transform .16s ease; }
    .panel.open .chevron { transform:rotate(180deg); }
    .panelBody { display:none; gap:16px; padding:18px 22px 22px; border-top:1px solid var(--line); }
    .panel.open .panelBody { display:grid; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .switches { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    .switch { display:grid; grid-template-columns:1fr auto auto; gap:12px; align-items:center; border:1px solid var(--line); border-radius:6px; padding:12px; background:#fff; }
    .switchCopy { display:grid; gap:3px; min-width:0; }
    .switchCopy strong { color:#263445; font-size:13px; }
    .switchCopy small { color:var(--muted); font-size:12px; line-height:1.35; }
    .switch input { position:absolute; opacity:0; pointer-events:none; }
    .switchKnob { width:42px; height:24px; border-radius:999px; background:#d7dee8; position:relative; transition:background .16s ease; }
    .switchKnob::after { content:""; position:absolute; width:18px; height:18px; border-radius:999px; background:#fff; top:3px; left:3px; box-shadow:0 1px 3px rgba(18,29,45,.18); transition:transform .16s ease; }
    .switch input:checked + .switchKnob { background:var(--accent); }
    .switch input:checked + .switchKnob::after { transform:translateX(18px); }
    label { display:grid; gap:6px; font-size:13px; color:#344054; }
    input, select { height:40px; border:1px solid var(--line); border-radius:6px; padding:0 11px; font:inherit; color:var(--text); background:#fff; min-width:0; }
    input:focus, select:focus { outline:2px solid rgba(11,107,203,.18); border-color:var(--accent); }
    button { height:40px; border:0; border-radius:6px; padding:0 14px; font:inherit; font-weight:650; cursor:pointer; background:var(--accent); color:#fff; }
    button.secondary { background:#eef4fb; color:#064f99; }
    button.danger { background:#b42318; }
    .buttons { display:flex; flex-wrap:wrap; gap:10px; }
    .progress { border:1px solid #e4e9f2; border-radius:6px; padding:14px; display:grid; gap:12px; background:#f8fafc; }
    .progressHead { display:flex; justify-content:space-between; gap:12px; align-items:center; color:#263445; font-size:13px; font-weight:750; }
    .progressMeta { color:#475467; font-size:12px; font-weight:650; text-align:right; min-width:0; max-width:50%; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; border:1px solid #dfe6f0; border-radius:999px; padding:3px 8px; background:#fff; }
    .progressTrack { height:5px; border-radius:999px; background:#e8edf4; overflow:hidden; }
    .progressFill { display:block; height:100%; width:0; border-radius:inherit; background:var(--accent); transition:width .2s ease; }
    .progress.ok .progressFill { background:var(--ok); }
    .progress.warn .progressFill { background:var(--accent); }
    .progress.bad .progressFill { background:var(--bad); }
    .progressSteps { display:flex; flex-wrap:wrap; gap:7px; }
    .progressStep { display:inline-flex; align-items:center; gap:6px; min-width:0; color:#667085; font-size:12px; line-height:1; border:1px solid transparent; border-radius:999px; padding:5px 8px; background:transparent; }
    .progressDot { width:7px; height:7px; flex:0 0 auto; border-radius:999px; border:0; background:#cfd7e3; }
    .progressStep span:last-child { overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
    .progressStep.done { color:#16794f; background:#f1fbf6; }
    .progressStep.active { color:#064f99; font-weight:750; border-color:#bfdbf7; background:#eef6ff; }
    .progressStep.done .progressDot { background:var(--ok); }
    .progressStep.active .progressDot { background:var(--accent); box-shadow:0 0 0 3px rgba(11,107,203,.12); }
    .progressStep.bad { color:var(--bad); font-weight:700; }
    .progressStep.bad .progressDot { background:var(--bad); }
    .status { border:1px solid var(--line); border-radius:6px; padding:12px; color:var(--muted); white-space:pre-wrap; font-size:14px; line-height:1.45; }
    .status.ok { color:var(--ok); background:#f1fbf6; border-color:#b8e0cd; }
    .status.warn { color:#475467; background:#fffaf2; border-color:#f2d5a3; border-left:3px solid #d18a00; }
    .status.bad { color:var(--bad); background:#fff4f3; border-color:#f3b8b2; }
    .device { border:1px solid var(--line); border-radius:6px; padding:10px 12px; display:grid; gap:6px; font-size:13px; margin-top:10px; }
    .confirm { display:none; gap:12px; border:1px solid #f3b8b2; background:#fff4f3; border-radius:6px; padding:12px; }
    .confirm.active { display:grid; }
    .subtle { color:var(--muted); font-size:13px; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    [hidden] { display:none !important; }
    @media (max-width:720px){ .grid,.switches{grid-template-columns:1fr;} .panelHeader{grid-template-columns:auto 1fr auto;} .pill{grid-column:2 / 4; justify-self:start;} .progressHead{display:grid;} .progressMeta{text-align:left; max-width:100%; justify-self:start;} }
  </style>
</head>
<body>
  <main>
    <section class="hero">
      <h1>Bambu AMS Notion Sync</h1>
      <p>按顺序完成拓竹云、Notion 和同步设置。已完成的步骤会自动收起，需要修改时再展开。</p>
    </section>

    <section id="bambuPanel" class="panel" data-panel="bambu">
      <button class="panelHeader" type="button" data-open-panel="bambu">
        <span class="stepNo">1</span>
        <span class="stepCopy">
          <h2>拓竹云</h2>
          <span id="bambuSummary" class="summary">检查登录状态...</span>
        </span>
        <span id="bambuPill" class="pill warn">待登录</span>
        <span class="chevron">⌄</span>
      </button>
      <div class="panelBody">
        <div id="bambuTokenBox" class="status"></div>

        <form id="loginForm">
          <div class="grid">
            <label>区域
              <select name="region">${regions}</select>
            </label>
            <label>账号邮箱或手机号
              <input name="account" autocomplete="username" required>
            </label>
            <label>密码
              <input name="password" type="password" autocomplete="current-password" required>
            </label>
          </div>
          <button type="submit">登录拓竹云</button>
        </form>

        <form id="codeForm" hidden>
          <label>验证码
            <input name="code" autocomplete="one-time-code" required>
          </label>
          <button type="submit">提交验证码</button>
        </form>

        <form id="tfaForm" hidden>
          <label>多因素验证码
            <input name="tfaCode" autocomplete="one-time-code" required>
          </label>
          <button type="submit">提交 MFA</button>
        </form>

        <div id="devices"></div>

        <form id="bambuSettingsForm">
          <h3>打印机设置</h3>
          <div class="grid">
            <label>同步方式
              <select name="BAMBU_CONNECTION_MODE">
                <option value="cloud">云端同步</option>
                <option value="local">局域网同步</option>
              </select>
            </label>
            <label>打印机序列号
              <input name="BAMBU_PRINTER_SERIAL">
            </label>
            <label>打印机名称
              <input name="BAMBU_PRINTER_NAME">
            </label>
            <label>局域网同步：打印机 IP
              <input name="BAMBU_PRINTER_IP">
            </label>
            <label>局域网同步：访问码
              <input name="BAMBU_ACCESS_CODE" type="password" autocomplete="off" placeholder="保存后会隐藏">
            </label>
          </div>
          <div class="buttons">
            <button type="submit">保存 Bambu 设置</button>
            <button id="resetApp" type="button" class="danger">重置</button>
          </div>
        </form>

        <div id="resetConfirm" class="confirm">
          <p>只清空拓竹云登录和打印机设置，不会删除 Notion 配置或 Notion 数据。</p>
          <label>二次确认
            <input id="resetConfirmText" autocomplete="off" placeholder="输入 重置">
          </label>
          <div class="buttons">
            <button id="confirmResetApp" type="button" class="danger">确认重置</button>
            <button id="cancelResetApp" type="button" class="secondary">取消</button>
          </div>
        </div>
      </div>
    </section>

    <section id="notionPanel" class="panel" data-panel="notion">
      <button class="panelHeader" type="button" data-open-panel="notion">
        <span class="stepNo">2</span>
        <span class="stepCopy">
          <h2>Notion</h2>
          <span id="notionSummary" class="summary">等待配置 Notion 密钥和页面 ID</span>
        </span>
        <span id="notionPill" class="pill warn">待配置</span>
        <span class="chevron">⌄</span>
      </button>
      <div class="panelBody">
        <form id="notionForm">
          <div class="grid">
            <label>Notion 密钥
              <input name="NOTION_TOKEN" type="password" autocomplete="off" placeholder="保存后会隐藏">
            </label>
            <label>Notion 页面/数据库 ID
              <input name="NOTION_DATA_SOURCE_ID" required>
            </label>
            <label>AMS 数据库名称
              <input name="NOTION_AMS_DATABASE_NAME">
            </label>
          </div>
          <button type="submit">保存 Notion 配置</button>
        </form>
      </div>
    </section>

    <section id="syncPanel" class="panel" data-panel="sync">
      <button class="panelHeader" type="button" data-open-panel="sync">
        <span class="stepNo">3</span>
        <span class="stepCopy">
          <h2>同步</h2>
          <span id="syncSummary" class="summary">等待前两步完成</span>
        </span>
        <span id="syncPill" class="pill warn">未启动</span>
        <span class="chevron">⌄</span>
      </button>
      <div class="panelBody">
        <div id="startupProgress" class="progress" role="progressbar" aria-label="同步服务启动进度" aria-valuemin="0" aria-valuemax="100">
          <div class="progressHead">
            <span id="startupProgressTitle">启动进度</span>
            <span id="startupProgressMeta" class="progressMeta">等待状态</span>
          </div>
          <div class="progressTrack"><span id="startupProgressBar" class="progressFill"></span></div>
          <div id="startupProgressSteps" class="progressSteps"></div>
        </div>
        <div id="status" class="status">加载中...</div>
        <form id="syncForm">
          <div class="switches">
            <label class="switch">
              <span class="switchCopy">
                <strong>AMS 数据</strong>
                <small>当前料盘、RFID、余量和颜色</small>
              </span>
              <input name="AMS_SYNC_ENABLED" type="checkbox" value="true">
              <span class="switchKnob" aria-hidden="true"></span>
            </label>
            <label class="switch">
              <span class="switchCopy">
                <strong>打印历史</strong>
                <small>Bambu Cloud 已完成任务记录</small>
              </span>
              <input name="PRINT_TASK_HISTORY_SYNC_ON_START" type="checkbox" value="true">
              <span class="switchKnob" aria-hidden="true"></span>
            </label>
          </div>
          <div class="grid">
            <label>同步周期（毫秒，10 分钟 = 600000）
              <input name="PUSHALL_INTERVAL_MS" inputmode="numeric" placeholder="600000">
            </label>
            <label>任务历史冷却（毫秒，5 分钟 = 300000）
              <input name="PRINT_TASK_HISTORY_MIN_INTERVAL_MS" inputmode="numeric" placeholder="300000">
            </label>
            <label>试运行模式
              <select name="DRY_RUN">
                <option value="true">开启：只预览，不写入 Notion</option>
                <option value="false">关闭：正式写入 Notion</option>
              </select>
            </label>
          </div>
          <div class="buttons">
            <button type="submit">保存同步设置</button>
            <button id="manualSync" type="button">立即同步</button>
            <button id="resetTaskHistoryCheckpoint" type="button" class="secondary">清空任务历史时间</button>
            <button id="restart" type="button" class="secondary">重启同步服务</button>
          </div>
        </form>
      </div>
    </section>
  </main>

  <script>
    const statusEl = document.querySelector("#status");
    const bambuSettingsForm = document.querySelector("#bambuSettingsForm");
    const notionForm = document.querySelector("#notionForm");
    const syncForm = document.querySelector("#syncForm");
    const loginForm = document.querySelector("#loginForm");
    const codeForm = document.querySelector("#codeForm");
    const tfaForm = document.querySelector("#tfaForm");
    const devicesEl = document.querySelector("#devices");
    const bambuTokenBox = document.querySelector("#bambuTokenBox");
    const startupProgressEl = document.querySelector("#startupProgress");
    const startupProgressTitle = document.querySelector("#startupProgressTitle");
    const startupProgressMeta = document.querySelector("#startupProgressMeta");
    const startupProgressBar = document.querySelector("#startupProgressBar");
    const startupProgressSteps = document.querySelector("#startupProgressSteps");
    const resetConfirm = document.querySelector("#resetConfirm");
    const resetConfirmText = document.querySelector("#resetConfirmText");
    const panels = {
      bambu: document.querySelector("#bambuPanel"),
      notion: document.querySelector("#notionPanel"),
      sync: document.querySelector("#syncPanel")
    };
    let pendingTfaKey = "";
    let pendingLoginStep = "";
    let selectedPanel = "";
    const STARTUP_STEPS = ["配置", "Notion", "打印机", "可同步", "后台维护"];

    function setStatus(text, kind = "") {
      statusEl.className = "status" + (kind ? " " + kind : "");
      statusEl.textContent = text;
    }

    function formValues(form) {
      const values = Object.fromEntries(new FormData(form).entries());
      for (const input of form.querySelectorAll('input[type="checkbox"][name]')) {
        values[input.name] = input.checked ? "true" : "false";
      }
      return values;
    }

    function setFormValues(form, config) {
      for (const [key, value] of Object.entries(config || {})) {
        const input = form.elements[key];
        if (!input) continue;
        if (input.type === "checkbox") input.checked = value === true || value === "true";
        else input.value = value;
      }
    }

    function setPill(id, text, kind) {
      const pill = document.querySelector("#" + id);
      pill.textContent = text;
      pill.className = "pill " + kind;
    }

    function openPanel(name, manual = false) {
      if (manual && panels[name]?.classList.contains("open")) {
        for (const panel of Object.values(panels)) panel.classList.remove("open");
        selectedPanel = "__closed__";
        return;
      }

      for (const [panelName, panel] of Object.entries(panels)) {
        panel.classList.toggle("open", panelName === name);
      }
      if (manual) selectedPanel = name;
    }

    function hasNotionConfig(config) {
      return Boolean(config.NOTION_TOKEN && config.NOTION_DATA_SOURCE_ID);
    }

    function regionLabel(region) {
      if (region === "china") return "中国区";
      if (region === "global") return "海外区";
      return region || "-";
    }

    function chooseDefaultPanel(data) {
      if (selectedPanel) return;
      if (!data.bambuToken) {
        openPanel("bambu");
      } else if (!hasNotionConfig(data.config || {})) {
        openPanel("notion");
      } else {
        openPanel("sync");
      }
    }

    function enabledText(value) {
      return value ? "开启" : "关闭";
    }

    function runtimeText(runtime, config = {}) {
      if (!runtime) return "同步服务未启动";
      const flags = runtime.enabledSyncs || {
        ams: config.AMS_SYNC_ENABLED === "true",
        printHistory: config.PRINT_TASK_HISTORY_SYNC_ON_START === "true"
      };
      const lines = [
        "服务: " + (runtime.starting ? "启动中" : runtime.running ? "运行中" : "未启动"),
        "同步开关: AMS " + enabledText(flags.ams) + " · 打印历史 " + enabledText(flags.printHistory)
      ];
      if (flags.ams) {
        lines.push(
          "拓竹云连接: " + (runtime.bambu?.connected ? "已连接" : "未连接"),
          "最近 AMS 同步: " + (runtime.lastSyncAt ? new Date(runtime.lastSyncAt).toLocaleString() : "-"),
          "最近耗材数: " + (runtime.lastTrayCount ?? 0)
        );
      } else {
        lines.push("AMS 同步: 未开启");
      }
      if (flags.printHistory) {
        lines.push(
          "任务历史: " + (runtime.lastTaskHistorySyncAt ? (runtime.lastTaskHistoryCount ?? 0) + " 条 · " + new Date(runtime.lastTaskHistorySyncAt).toLocaleString() : "同步中/未同步"),
          "历史同步到: " + (runtime.lastTaskHistoryCheckpointAt ? new Date(runtime.lastTaskHistoryCheckpointAt).toLocaleString() : "-")
        );
      } else {
        lines.push("任务历史: 未开启");
      }
      if (runtime.startupPhase) lines.splice(1, 0, "启动阶段: " + runtime.startupPhase);
      if (runtime.maintenanceRunning) lines.push("后台维护: 运行中");
      if (runtime.pendingManualSync) lines.push("立即同步: 等待连接后执行");
      if (runtime.lastError) lines.push("提示: " + runtime.lastError);
      return lines.join("\\n");
    }

    function statusKind(runtime) {
      if (runtime?.starting) return "warn";
      if (runtime?.running) return "ok";
      if (!runtime?.lastError) return "warn";
      if (runtime.lastError.startsWith("Missing required env:") || runtime.lastError.startsWith("Cannot read Bambu cloud token file")) return "warn";
      return "bad";
    }

    function startupProgressState(runtime) {
      const flags = runtime?.enabledSyncs || { ams: false, printHistory: false };
      if (!flags.ams && !flags.printHistory) {
        return {
          title: "等待选择同步内容",
          meta: "AMS 和打印历史均未开启",
          percent: 0,
          activeIndex: 0,
          doneUntil: -1,
          kind: "warn"
        };
      }

      if (runtime?.starting) {
        const phase = runtime.startupPhase || "启动中";
        const activeIndex = phase === "初始化 Notion" ? 1 : phase === "连接打印机" ? 2 : 0;
        return {
          title: "同步服务启动中",
          meta: phase,
          percent: [16, 42, 66][activeIndex],
          activeIndex,
          doneUntil: activeIndex - 1,
          kind: "warn"
        };
      }

      if (runtime?.running) {
        if (!runtime.bambu?.connected) {
          return {
            title: "等待打印机连接",
            meta: runtime.pendingManualSync ? "连接后执行立即同步" : "正在连接打印机",
            percent: 72,
            activeIndex: 2,
            doneUntil: 1,
            kind: "warn"
          };
        }

        if (runtime.maintenanceRunning) {
          return {
            title: "同步服务可用",
            meta: "后台维护中",
            percent: 88,
            activeIndex: 4,
            doneUntil: 3,
            kind: "warn"
          };
        }

        return {
          title: "同步服务运行中",
          meta: "全部就绪",
          percent: 100,
          activeIndex: 4,
          doneUntil: 4,
          kind: "ok"
        };
      }

      const kind = statusKind(runtime);
      return {
        title: runtime?.lastError ? "同步服务待处理" : "等待启动",
        meta: runtime?.lastError || "等待前两步完成",
        percent: 0,
        activeIndex: 0,
        doneUntil: -1,
        failedIndex: kind === "bad" ? 0 : -1,
        kind
      };
    }

    function renderStartupProgress(runtime) {
      const state = startupProgressState(runtime || {});
      startupProgressEl.className = "progress " + state.kind;
      startupProgressEl.setAttribute("aria-valuenow", String(state.percent));
      startupProgressTitle.textContent = state.title;
      startupProgressMeta.textContent = state.meta;
      startupProgressBar.style.width = state.percent + "%";
      startupProgressSteps.innerHTML = "";

      STARTUP_STEPS.forEach((label, index) => {
        const item = document.createElement("div");
        let className = "progressStep";
        if (index <= state.doneUntil) className += " done";
        else if (index === state.activeIndex) className += " active";
        if (index === state.failedIndex) className += " bad";
        item.className = className;

        const dot = document.createElement("span");
        dot.className = "progressDot";
        const text = document.createElement("span");
        text.textContent = label;
        item.append(dot, text);
        startupProgressSteps.appendChild(item);
      });
    }

    function appendLine(parent, label, value) {
      const span = document.createElement("span");
      span.append(label + ": ");
      if (label === "序列号") {
        const code = document.createElement("code");
        code.textContent = value || "";
        span.appendChild(code);
      } else {
        span.append(value || "-");
      }
      parent.appendChild(span);
    }

    async function api(path, body) {
      const res = await fetch(path, {
        method: body ? "POST" : "GET",
        headers: body ? { "Content-Type": "application/json" } : {},
        body: body ? JSON.stringify(body) : undefined
      });
      const data = await res.json();
      if (!res.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    function renderDevices(devices = []) {
      devicesEl.innerHTML = "";
      if (devices.length === 0) return;

      for (const device of devices) {
        const div = document.createElement("div");
        div.className = "device";
        const title = document.createElement("strong");
        title.textContent = device.name || "Bambu Printer";
        div.appendChild(title);
        appendLine(div, "序列号", device.dev_id || "");
        appendLine(div, "型号", device.model || "-");

        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "使用这台打印机";
        button.addEventListener("click", async () => {
          try {
            await api("/api/config", {
              BAMBU_PRINTER_SERIAL: device.dev_id || "",
              BAMBU_PRINTER_NAME: device.name || ""
            });
            selectedPanel = "";
            await refresh();
          } catch (error) {
            setStatus(error.message, "bad");
          }
        });
        div.appendChild(button);
        devicesEl.appendChild(div);
      }
    }

    function renderBambu(data) {
      const token = data.bambuToken;
      const config = data.config || {};
      const ready = Boolean(token);
      if (ready) {
        pendingLoginStep = "";
        pendingTfaKey = "";
      }
      document.querySelector("#bambuSummary").textContent = ready
        ? "已登录 " + regionLabel(token.region) + " · " + ((token.devices || []).length) + " 台设备"
        : "等待登录拓竹云";
      setPill("bambuPill", ready ? "已登录" : "待登录", ready ? "ok" : "warn");
      loginForm.hidden = ready;
      codeForm.hidden = ready || pendingLoginStep !== "code";
      tfaForm.hidden = ready || pendingLoginStep !== "tfa";
      bambuTokenBox.hidden = !ready;
      bambuTokenBox.textContent = ready
        ? "账号 UID: " + (token.uid || "-") + "\\n消息服务器: " + (token.mqttBroker || "-") + "\\n登录凭据保存时间: " + (token.savedAt || "-")
        : "";
      setFormValues(bambuSettingsForm, config);
      renderDevices(token?.devices || []);
    }

    function renderNotion(data) {
      const config = data.config || {};
      const ready = hasNotionConfig(config);
      document.querySelector("#notionSummary").textContent = ready
        ? "已配置 · " + (config.NOTION_DATA_SOURCE_ID || "").slice(-12)
        : "等待 Notion 密钥和页面 ID";
      setPill("notionPill", ready ? "已配置" : "待配置", ready ? "ok" : "warn");
      setFormValues(notionForm, config);
    }

    function renderSync(data) {
      const runtime = data.runtime || {};
      const config = data.config || {};
      const flags = runtime.enabledSyncs || {
        ams: config.AMS_SYNC_ENABLED === "true",
        printHistory: config.PRINT_TASK_HISTORY_SYNC_ON_START === "true"
      };
      setFormValues(syncForm, config);
      renderStartupProgress(runtime);
      setStatus(runtimeText(runtime, config), statusKind(runtime));
      if (runtime.starting) {
        document.querySelector("#syncSummary").textContent = "启动中 · " + (runtime.startupPhase || "初始化");
        setPill("syncPill", "启动中", "warn");
      } else if (!flags.ams && !flags.printHistory) {
        document.querySelector("#syncSummary").textContent = "请选择要同步的数据";
        setPill("syncPill", "未启用", "warn");
      } else if (runtime.running) {
        document.querySelector("#syncSummary").textContent = flags.ams
          ? "运行中 · " + (runtime.bambu?.connected ? "拓竹云已连接" : "等待连接拓竹云")
          : "运行中 · 打印历史已开启";
        setPill("syncPill", "运行中", "ok");
      } else if (runtime.lastError) {
        document.querySelector("#syncSummary").textContent = runtime.lastError;
        setPill("syncPill", "待处理", statusKind(runtime));
      } else {
        document.querySelector("#syncSummary").textContent = "等待前两步完成";
        setPill("syncPill", "未启动", "warn");
      }
    }

    async function refresh() {
      const data = await api("/api/status");
      renderBambu(data);
      renderNotion(data);
      renderSync(data);
      chooseDefaultPanel(data);
    }

    for (const button of document.querySelectorAll("[data-open-panel]")) {
      button.addEventListener("click", () => openPanel(button.dataset.openPanel, true));
    }

    bambuSettingsForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("保存 Bambu 设置中...", "warn");
        await api("/api/config", formValues(bambuSettingsForm));
        selectedPanel = "";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    notionForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("保存 Notion 配置中...", "warn");
        await api("/api/config", formValues(notionForm));
        selectedPanel = "";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    syncForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("保存同步设置中...", "warn");
        await api("/api/config", formValues(syncForm));
        selectedPanel = "sync";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#manualSync").addEventListener("click", async () => {
      try {
        setStatus("已请求立即同步...", "warn");
        const result = await api("/api/sync", {});
        setStatus(result.message || "已请求立即同步。", result.pending ? "warn" : "ok");
        setTimeout(refresh, 1500);
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#resetTaskHistoryCheckpoint").addEventListener("click", async () => {
      try {
        setStatus("已清空任务历史时间。下次触发历史同步会从最早任务开始。", "warn");
        await api("/api/task-history/checkpoint/reset", {});
        selectedPanel = "sync";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#restart").addEventListener("click", async () => {
      try {
        setStatus("正在重启同步服务...", "warn");
        await api("/api/restart", {});
        selectedPanel = "sync";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#resetApp").addEventListener("click", () => {
      resetConfirm.classList.add("active");
      resetConfirmText.value = "";
      resetConfirmText.focus();
      setStatus("输入“重置”后再确认重置拓竹云登录。不会删除 Notion 数据。", "warn");
    });

    document.querySelector("#cancelResetApp").addEventListener("click", () => {
      resetConfirm.classList.remove("active");
      resetConfirmText.value = "";
      setStatus("已取消重置。", "warn");
    });

    document.querySelector("#confirmResetApp").addEventListener("click", async () => {
      const confirmation = resetConfirmText.value.trim();
      try {
        setStatus("正在重置拓竹云登录...", "warn");
        await api("/api/bambu/reset", { confirmation });
        loginForm.reset();
        codeForm.reset();
        tfaForm.reset();
        pendingLoginStep = "";
        pendingTfaKey = "";
        resetConfirm.classList.remove("active");
        resetConfirmText.value = "";
        selectedPanel = "bambu";
        await refresh();
        setStatus("已清空拓竹云登录和打印机设置，可以重新登录。", "warn");
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("正在登录拓竹云...", "warn");
        const data = await api("/api/bambu/login", formValues(loginForm));
        if (data.needsCode) {
          pendingLoginStep = "code";
          selectedPanel = "bambu";
          codeForm.hidden = false;
          setStatus(data.codeTarget === "sms" ? "已发送短信验证码。" : "已发送邮箱验证码。", "warn");
        } else if (data.needsTfa) {
          pendingLoginStep = "tfa";
          pendingTfaKey = data.tfaKey || "";
          selectedPanel = "bambu";
          tfaForm.hidden = false;
          setStatus("需要多因素验证码。", "warn");
        } else {
          pendingLoginStep = "";
          pendingTfaKey = "";
          selectedPanel = "";
          await refresh();
        }
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    codeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const login = formValues(loginForm);
        await api("/api/bambu/verify", { region: login.region, account: login.account, code: formValues(codeForm).code });
        pendingLoginStep = "";
        codeForm.hidden = true;
        selectedPanel = "";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    tfaForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const login = formValues(loginForm);
        await api("/api/bambu/tfa", { region: login.region, tfaKey: pendingTfaKey, tfaCode: formValues(tfaForm).tfaCode });
        pendingLoginStep = "";
        pendingTfaKey = "";
        tfaForm.hidden = true;
        selectedPanel = "";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    refresh().catch((error) => setStatus(error.message, "bad"));
    setInterval(() => refresh().catch(() => {}), 10000);
  </script>
</body>
</html>`;
}

function maskedTokenData(token) {
  if (!token) return null;
  return {
    region: token.region,
    uid: token.uid,
    mqttBroker: token.mqttBroker,
    expiresAt: token.expiresAt,
    savedAt: token.savedAt,
    devices: token.devices || []
  };
}

async function saveBambuToken(body) {
  const settings = await loadStoredConfig();
  const tokenFile = resolve(settings.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
  await saveCloudToken(tokenFile, body.token);
  if (!settings.BAMBU_PRINTER_SERIAL && body.token.devices?.length === 1) {
    settings.BAMBU_PRINTER_SERIAL = body.token.devices[0].dev_id;
    settings.BAMBU_PRINTER_NAME = body.token.devices[0].name || settings.BAMBU_PRINTER_NAME;
    await saveStoredConfig(settings);
  }
  await runtime.restart();
}

async function resetBambuLogin() {
  const existing = await loadStoredConfig();
  const tokenFile = resolve(existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
  await runtime.reset();
  await removeIfExists(tokenFile);
  await saveStoredConfig({
    ...existing,
    BAMBU_CONNECTION_MODE: "cloud",
    BAMBU_PRINTER_SERIAL: "",
    BAMBU_PRINTER_NAME: "",
    BAMBU_PRINTER_IP: "",
    BAMBU_ACCESS_CODE: ""
  });
}

async function handleApi(req, res, pathname) {
  try {
    if (pathname === "/api/status" && req.method === "GET") {
      const config = await loadStoredConfig();
      let token = null;
      try {
        token = await loadCloudToken(resolve(config.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json"));
      } catch {
        token = null;
      }
      sendJson(res, 200, { config: maskConfig(config), bambuToken: maskedTokenData(token), runtime: runtime.status() });
      return;
    }

    const body = await parseBody(req);

    if (pathname === "/api/config" && req.method === "POST") {
      const existing = await loadStoredConfig();
      const next = mergeConfig(existing, body);
      await saveStoredConfig(next);
      await runtime.restart({
        forceTaskHistorySync:
          !configEnabled(existing.PRINT_TASK_HISTORY_SYNC_ON_START) &&
          configEnabled(next.PRINT_TASK_HISTORY_SYNC_ON_START)
      });
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/restart" && req.method === "POST") {
      await runtime.restart();
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/sync" && req.method === "POST") {
      sendJson(res, 200, await runtime.manualSync());
      return;
    }

    if (pathname === "/api/task-history/checkpoint/reset" && req.method === "POST") {
      const existing = await loadStoredConfig();
      await saveStoredConfig({
        ...existing,
        PRINT_TASK_HISTORY_LAST_TASK_TIME: "",
        PRINT_TASK_HISTORY_LAST_SYNC_AT: ""
      });
      runtime.lastTaskHistorySyncAt = "";
      runtime.lastTaskHistoryCount = 0;
      runtime.lastTaskHistoryCheckpointAt = "";
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/bambu/reset" && req.method === "POST") {
      if (!["重置", "RESET"].includes(body.confirmation)) {
        sendJson(res, 400, { error: "请输入“重置”确认操作" });
        return;
      }

      await resetBambuLogin();
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/reset" && req.method === "POST") {
      if (!["重置", "RESET"].includes(body.confirmation)) {
        sendJson(res, 400, { error: "请输入“重置”确认操作" });
        return;
      }

      const existing = await loadStoredConfig();
      const tokenFile = resolve(existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");
      await runtime.reset();
      await removeIfExists(tokenFile);
      await resetStoredConfig({
        BAMBU_CLOUD_TOKEN_FILE: existing.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json"
      });
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/bambu/login" && req.method === "POST") {
      const result = await loginWithPassword(body);
      if (result.token) {
        await saveBambuToken(result);
        sendJson(res, 200, { token: maskedTokenData(result.token) });
      } else {
        sendJson(res, 200, result);
      }
      return;
    }

    if (pathname === "/api/bambu/verify" && req.method === "POST") {
      const result = await loginWithCode(body);
      await saveBambuToken(result);
      sendJson(res, 200, { token: maskedTokenData(result.token) });
      return;
    }

    if (pathname === "/api/bambu/tfa" && req.method === "POST") {
      const result = await loginWithTfa(body);
      await saveBambuToken(result);
      sendJson(res, 200, { token: maskedTokenData(result.token) });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendJson(res, 400, { error: error.message });
  }
}

const server = createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host || `${HOST}:${PORT}`}`);
  if (url.pathname.startsWith("/api/")) {
    handleApi(req, res, url.pathname);
    return;
  }
  res.writeHead(200, { "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" });
  res.end(page());
});

server.listen(PORT, HOST, async () => {
  console.log(`Admin UI: http://${HOST === "0.0.0.0" ? "localhost" : HOST}:${PORT}`);
  await runtime.restart();
});

process.on("SIGINT", async () => {
  await runtime.stop();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  await runtime.stop();
  process.exit(0);
});
