import { createServer } from "node:http";
import { unlink } from "node:fs/promises";
import { resolve } from "node:path";
import { BambuMqttClient } from "./bambu.js";
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

class SyncRuntime {
  constructor() {
    this.logger = createLogger(process.env.LOG_LEVEL || "info");
    this.bambuClient = null;
    this.notionSync = null;
    this.running = false;
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
  }

  async restart() {
    await this.stop();
    const stored = await loadStoredConfig();

    try {
      const config = loadConfig({ ...process.env, ...stored });
      const notionConfig = {
        ...config.notion,
        dryRun: config.dryRun,
        printerName: config.bambu.printerName
      };

      this.logger = createLogger(config.logLevel);
      this.notionSync = new NotionAmsSync(notionConfig, this.logger);
      await this.notionSync.init();

      this.bambuClient = new BambuMqttClient(config.bambu, this.logger, async (trays) => {
        this.lastSyncAt = new Date().toISOString();
        this.lastTrayCount = trays.length;
        await this.notionSync.syncTrays(trays);
      });
      this.bambuClient.start();
      this.running = true;
      this.lastError = "";
    } catch (error) {
      this.running = false;
      this.lastError = error.message;
      this.logger.error("Sync service not started:", error.message);
    }
  }

  async stop() {
    this.bambuClient?.stop();
    this.bambuClient = null;
    this.notionSync = null;
    this.running = false;
  }

  async reset() {
    await this.stop();
    this.lastError = "";
    this.lastSyncAt = "";
    this.lastTrayCount = 0;
  }

  manualSync() {
    if (!this.bambuClient) throw new Error("Sync service is not running");
    const ok = this.bambuClient.requestManualSync();
    if (!ok) throw new Error("Bambu MQTT is not connected yet");
    return { requested: true };
  }

  status() {
    return {
      running: this.running,
      lastError: this.lastError,
      lastSyncAt: this.lastSyncAt,
      lastTrayCount: this.lastTrayCount,
      bambu: this.bambuClient?.status() || null
    };
  }
}

const runtime = new SyncRuntime();

function page() {
  const regions = Object.entries(CLOUD_REGIONS)
    .map(([value, region]) => `<option value="${value}">${region.label}</option>`)
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
    body { margin:0; background:var(--bg); color:var(--text); font-family:Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif; padding:28px 16px; }
    main { width:min(960px,100%); margin:0 auto; display:grid; gap:18px; }
    section { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:20px; box-shadow:0 8px 22px rgba(18,29,45,.06); }
    h1 { font-size:24px; margin:0 0 4px; }
    h2 { font-size:17px; margin:0 0 14px; }
    p { color:var(--muted); margin:0; line-height:1.55; }
    form { display:grid; gap:12px; }
    .grid { display:grid; grid-template-columns:repeat(2,minmax(0,1fr)); gap:12px; }
    label { display:grid; gap:6px; font-size:13px; color:#344054; }
    input, select { height:40px; border:1px solid var(--line); border-radius:6px; padding:0 11px; font:inherit; color:var(--text); background:#fff; min-width:0; }
    input:focus, select:focus { outline:2px solid rgba(11,107,203,.18); border-color:var(--accent); }
    button { height:40px; border:0; border-radius:6px; padding:0 14px; font:inherit; font-weight:650; cursor:pointer; background:var(--accent); color:#fff; }
    button.secondary { background:#eef4fb; color:#064f99; }
    button.danger { background:#b42318; }
    .buttons { display:flex; flex-wrap:wrap; gap:10px; }
    .status { border:1px solid var(--line); border-radius:6px; padding:12px; color:var(--muted); white-space:pre-wrap; font-size:14px; line-height:1.45; }
    .status.ok { color:var(--ok); background:#f1fbf6; border-color:#b8e0cd; }
    .status.warn { color:var(--warn); background:#fff8eb; border-color:#f2d5a3; }
    .status.bad { color:var(--bad); background:#fff4f3; border-color:#f3b8b2; }
    .device { border:1px solid var(--line); border-radius:6px; padding:10px 12px; display:grid; gap:4px; font-size:13px; margin-top:10px; }
    .confirm { display:none; gap:12px; margin-top:12px; border:1px solid #f3b8b2; background:#fff4f3; border-radius:6px; padding:12px; }
    .confirm.active { display:grid; }
    code { font-family:ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    @media (max-width:720px){ .grid{grid-template-columns:1fr;} }
  </style>
</head>
<body>
  <main>
    <section>
      <h1>Bambu AMS Notion Sync</h1>
      <p>配置 Bambu Cloud、Notion、同步周期，并支持手动同步。</p>
    </section>

    <section>
      <h2>状态</h2>
      <div id="status" class="status">加载中...</div>
      <div class="buttons" style="margin-top:12px">
        <button id="manualSync">立即同步</button>
        <button id="restart" class="secondary">重启同步服务</button>
      </div>
    </section>

    <section>
      <h2>配置</h2>
      <form id="configForm">
        <div class="grid">
          <label>同步方式
            <select name="BAMBU_CONNECTION_MODE">
              <option value="cloud">Cloud</option>
              <option value="local">Local MQTT</option>
            </select>
          </label>
          <label>同步周期（毫秒，10 分钟 = 600000）
            <input name="PUSHALL_INTERVAL_MS" inputmode="numeric" placeholder="600000">
          </label>
          <label>打印机 Serial
            <input name="BAMBU_PRINTER_SERIAL" required>
          </label>
          <label>打印机名称
            <input name="BAMBU_PRINTER_NAME">
          </label>
          <label>Notion Token
            <input name="NOTION_TOKEN" type="password" autocomplete="off" placeholder="保存后会隐藏">
          </label>
          <label>Notion 页面/数据库/Data source ID
            <input name="NOTION_DATA_SOURCE_ID" required>
          </label>
          <label>Local: 打印机 IP
            <input name="BAMBU_PRINTER_IP">
          </label>
          <label>Local: LAN Access Code
            <input name="BAMBU_ACCESS_CODE" type="password" autocomplete="off" placeholder="保存后会隐藏">
          </label>
          <label>Dry run
            <select name="DRY_RUN">
              <option value="true">true</option>
              <option value="false">false</option>
            </select>
          </label>
          <label>AMS 数据库名称
            <input name="NOTION_AMS_DATABASE_NAME">
          </label>
        </div>
        <div class="buttons">
          <button type="submit">保存并重启同步</button>
        </div>
      </form>
    </section>

    <section>
      <h2>Bambu Cloud 登录</h2>
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
        <button type="submit">登录 Bambu Cloud</button>
      </form>
      <form id="codeForm" style="display:none; margin-top:12px">
        <label>验证码
          <input name="code" autocomplete="one-time-code" required>
        </label>
        <button type="submit">提交验证码</button>
      </form>
      <form id="tfaForm" style="display:none; margin-top:12px">
        <label>MFA Code
          <input name="tfaCode" autocomplete="one-time-code" required>
        </label>
        <button type="submit">提交 MFA</button>
      </form>
      <div id="devices"></div>
    </section>

    <section>
      <h2>重置</h2>
      <p>清空本服务保存的 Web 配置和 Bambu Cloud 登录，用于模拟首次使用；不会删除 Notion 里的数据库或页面。</p>
      <div class="buttons" style="margin-top:12px">
        <button id="resetApp" class="danger">重置</button>
      </div>
      <div id="resetConfirm" class="confirm">
        <label>二次确认
          <input id="resetConfirmText" autocomplete="off" placeholder="输入 RESET">
        </label>
        <div class="buttons">
          <button id="confirmResetApp" class="danger">确认重置</button>
          <button id="cancelResetApp" class="secondary">取消</button>
        </div>
      </div>
    </section>
  </main>

  <script>
    const statusEl = document.querySelector("#status");
    const configForm = document.querySelector("#configForm");
    const loginForm = document.querySelector("#loginForm");
    const codeForm = document.querySelector("#codeForm");
    const tfaForm = document.querySelector("#tfaForm");
    const devicesEl = document.querySelector("#devices");
    const resetConfirm = document.querySelector("#resetConfirm");
    const resetConfirmText = document.querySelector("#resetConfirmText");
    let pendingTfaKey = "";

    function setStatus(text, kind = "") {
      statusEl.className = "status" + (kind ? " " + kind : "");
      statusEl.textContent = text;
    }

    function values(form) {
      return Object.fromEntries(new FormData(form).entries());
    }

    function appendLine(parent, label, value) {
      const span = document.createElement("span");
      if (label) span.append(label + ": ");
      if (label === "Serial") {
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
      for (const device of devices) {
        const div = document.createElement("div");
        div.className = "device";
        const title = document.createElement("strong");
        title.textContent = device.name || "Bambu Printer";
        div.appendChild(title);
        appendLine(div, "Serial", device.dev_id || "");
        appendLine(div, "Model", device.model || "-");

        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = "使用这台打印机";
        button.addEventListener("click", () => {
          configForm.elements.BAMBU_PRINTER_SERIAL.value = device.dev_id || "";
          configForm.elements.BAMBU_PRINTER_NAME.value = device.name || "";
          setStatus("已填入打印机 Serial，保存配置后会重启同步服务。", "warn");
        });
        div.appendChild(button);
        devicesEl.appendChild(div);
      }
    }

    async function refresh() {
      const data = await api("/api/status");
      for (const [key, value] of Object.entries(data.config)) {
        const input = configForm.elements[key];
        if (input) input.value = value;
      }
      renderDevices(data.bambuToken?.devices || []);
      const runtime = data.runtime;
      setStatus(JSON.stringify(runtime, null, 2), runtime.running ? "ok" : (runtime.lastError ? "bad" : "warn"));
    }

    configForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("保存中...", "warn");
        await api("/api/config", values(configForm));
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#manualSync").addEventListener("click", async () => {
      try {
        setStatus("已请求立即同步，等待 Bambu report...", "warn");
        await api("/api/sync", {});
        setTimeout(refresh, 1500);
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#restart").addEventListener("click", async () => {
      try {
        setStatus("正在重启同步服务...", "warn");
        await api("/api/restart", {});
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    document.querySelector("#resetApp").addEventListener("click", async () => {
      resetConfirm.classList.add("active");
      resetConfirmText.value = "";
      resetConfirmText.focus();
      setStatus("输入 RESET 后再确认重置。不会删除 Notion 数据。", "warn");
    });

    document.querySelector("#cancelResetApp").addEventListener("click", () => {
      resetConfirm.classList.remove("active");
      resetConfirmText.value = "";
      setStatus("已取消重置。", "warn");
    });

    document.querySelector("#confirmResetApp").addEventListener("click", async () => {
      const confirmation = resetConfirmText.value.trim();
      try {
        setStatus("正在重置...", "warn");
        await api("/api/reset", { confirmation });
        loginForm.reset();
        codeForm.reset();
        tfaForm.reset();
        codeForm.style.display = "none";
        tfaForm.style.display = "none";
        resetConfirm.classList.remove("active");
        resetConfirmText.value = "";
        await refresh();
        setStatus("已清空本机配置和 Bambu Cloud token，可以按新用户流程重新开始。", "warn");
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        setStatus("正在登录 Bambu Cloud...", "warn");
        const data = await api("/api/bambu/login", values(loginForm));
        if (data.needsCode) {
          codeForm.style.display = "grid";
          setStatus(data.codeTarget === "sms" ? "已发送短信验证码。" : "已发送邮箱验证码。", "warn");
        } else if (data.needsTfa) {
          pendingTfaKey = data.tfaKey || "";
          tfaForm.style.display = "grid";
          setStatus("需要 MFA。", "warn");
        } else {
          await refresh();
        }
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    codeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const login = values(loginForm);
        await api("/api/bambu/verify", { region: login.region, account: login.account, code: values(codeForm).code });
        codeForm.style.display = "none";
        await refresh();
      } catch (error) {
        setStatus(error.message, "bad");
      }
    });

    tfaForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      try {
        const login = values(loginForm);
        await api("/api/bambu/tfa", { region: login.region, tfaKey: pendingTfaKey, tfaCode: values(tfaForm).tfaCode });
        tfaForm.style.display = "none";
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
      await runtime.restart();
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/restart" && req.method === "POST") {
      await runtime.restart();
      sendJson(res, 200, { ok: true, runtime: runtime.status() });
      return;
    }

    if (pathname === "/api/sync" && req.method === "POST") {
      sendJson(res, 200, runtime.manualSync());
      return;
    }

    if (pathname === "/api/reset" && req.method === "POST") {
      if (body.confirmation !== "RESET") {
        sendJson(res, 400, { error: "Type RESET to confirm reset" });
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
