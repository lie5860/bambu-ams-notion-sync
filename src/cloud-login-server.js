import "dotenv/config";
import { createServer } from "node:http";
import { resolve } from "node:path";
import {
  CLOUD_REGIONS,
  loadCloudToken,
  loginWithCode,
  loginWithPassword,
  loginWithTfa,
  saveCloudToken
} from "./cloud-auth.js";
import { parseBody } from "./http.js";

const PORT = Number(process.env.CLOUD_LOGIN_PORT || 3030);
const HOST = process.env.CLOUD_LOGIN_HOST || "127.0.0.1";
const TOKEN_FILE = resolve(process.env.BAMBU_CLOUD_TOKEN_FILE || ".bambu-cloud.json");

function sendJson(res, status, body) {
  if (res.destroyed || res.writableEnded || res.closed) return false;
  if (res.headersSent) {
    res.destroy();
    return false;
  }

  const payload = JSON.stringify(body);
  res.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(payload);
  return true;
}

function errorStatus(error, fallback) {
  const status = Number(error?.statusCode);
  return Number.isInteger(status) && status >= 400 && status <= 599 ? status : fallback;
}

function sendError(res, status, error) {
  if (res.destroyed || res.writableEnded || res.closed) return;
  if (res.headersSent) {
    res.destroy();
    return;
  }

  try {
    sendJson(res, status, { error: error?.message || "Request failed" });
  } catch {
    if (!res.destroyed) res.destroy();
  }
}

function maskTokenData(token) {
  return {
    region: token.region,
    uid: token.uid,
    mqttBroker: token.mqttBroker,
    expiresAt: token.expiresAt,
    savedAt: token.savedAt,
    devices: token.devices || []
  };
}

function page() {
  const regions = Object.entries(CLOUD_REGIONS)
    .map(([value, region]) => `<option value="${value}">${region.label}</option>`)
    .join("");

  return `<!doctype html>
<html lang="zh-CN">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Bambu Cloud Login</title>
  <style>
    :root {
      color-scheme: light;
      --bg: #f7f8fa;
      --surface: #ffffff;
      --text: #17202a;
      --muted: #667085;
      --line: #d8dee8;
      --accent: #0b6bcb;
      --accent-dark: #064f99;
      --ok: #16794f;
      --warn: #a05a00;
      --bad: #b42318;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      min-height: 100vh;
      font-family: Inter, ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      background: var(--bg);
      color: var(--text);
      display: grid;
      place-items: center;
      padding: 32px 16px;
    }
    main {
      width: min(720px, 100%);
      background: var(--surface);
      border: 1px solid var(--line);
      border-radius: 8px;
      padding: 28px;
      box-shadow: 0 10px 30px rgba(18, 29, 45, 0.08);
    }
    h1 { margin: 0 0 6px; font-size: 24px; line-height: 1.25; }
    .sub { margin: 0 0 24px; color: var(--muted); font-size: 14px; line-height: 1.55; }
    form { display: grid; gap: 14px; }
    label { display: grid; gap: 7px; font-size: 13px; color: #344054; }
    input, select {
      width: 100%;
      height: 42px;
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 0 12px;
      font: inherit;
      background: #fff;
      color: var(--text);
    }
    input:focus, select:focus {
      outline: 2px solid rgba(11, 107, 203, 0.18);
      border-color: var(--accent);
    }
    button {
      height: 42px;
      border: 0;
      border-radius: 6px;
      padding: 0 16px;
      font: inherit;
      font-weight: 650;
      cursor: pointer;
      background: var(--accent);
      color: #fff;
    }
    button:hover { background: var(--accent-dark); }
    button.secondary {
      background: #eef4fb;
      color: var(--accent-dark);
    }
    .row { display: grid; grid-template-columns: 160px 1fr; gap: 14px; }
    .hidden { display: none; }
    .status {
      margin-top: 18px;
      border-radius: 6px;
      border: 1px solid var(--line);
      padding: 12px;
      font-size: 14px;
      line-height: 1.5;
      white-space: pre-wrap;
      color: var(--muted);
    }
    .status.ok { color: var(--ok); border-color: #b8e0cd; background: #f1fbf6; }
    .status.warn { color: var(--warn); border-color: #f2d5a3; background: #fff8eb; }
    .status.bad { color: var(--bad); border-color: #f3b8b2; background: #fff4f3; }
    .devices { margin-top: 16px; display: grid; gap: 8px; }
    .device {
      border: 1px solid var(--line);
      border-radius: 6px;
      padding: 10px 12px;
      display: grid;
      gap: 4px;
      font-size: 13px;
    }
    code { font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace; }
    @media (max-width: 620px) {
      main { padding: 22px; }
      .row { grid-template-columns: 1fr; }
    }
  </style>
</head>
<body>
  <main>
    <h1>Bambu Cloud Login</h1>
    <p class="sub">本页面只在本机运行。密码不会保存；成功后保存 cloud token 到本地 <code>.bambu-cloud.json</code>。</p>

    <form id="loginForm">
      <div class="row">
        <label>区域
          <select id="region">${regions}</select>
        </label>
        <label>账号邮箱或手机号
          <input id="account" name="account" autocomplete="username" type="text" required>
        </label>
      </div>
      <label>密码
        <input id="password" name="password" autocomplete="current-password" type="password" required>
      </label>
      <button id="loginButton" type="submit">登录</button>
    </form>

    <form id="codeForm" class="hidden">
      <label>邮箱验证码
        <input id="code" inputmode="numeric" autocomplete="one-time-code" required>
      </label>
      <button type="submit">提交验证码</button>
    </form>

    <form id="tfaForm" class="hidden">
      <label>MFA Code
        <input id="tfaCode" inputmode="numeric" autocomplete="one-time-code" required>
      </label>
      <button type="submit">提交 MFA</button>
    </form>

    <div id="status" class="status">等待登录。</div>
    <div id="devices" class="devices"></div>
  </main>

  <script>
    const loginForm = document.querySelector("#loginForm");
    const codeForm = document.querySelector("#codeForm");
    const tfaForm = document.querySelector("#tfaForm");
    const statusBox = document.querySelector("#status");
    const devicesBox = document.querySelector("#devices");
    let pendingTfaKey = "";

    function status(text, kind = "") {
      statusBox.className = "status" + (kind ? " " + kind : "");
      statusBox.textContent = text;
    }

    async function post(path, body) {
      const response = await fetch(path, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body)
      });
      const data = await response.json();
      if (!response.ok) throw new Error(data.error || "Request failed");
      return data;
    }

    function renderDevices(devices = []) {
      devicesBox.innerHTML = "";
      if (!devices.length) return;
      for (const device of devices) {
        const div = document.createElement("div");
        div.className = "device";
        div.innerHTML = "<strong>" + (device.name || "Bambu Printer") + "</strong>" +
          "<span>Serial: <code>" + (device.dev_id || "") + "</code></span>" +
          "<span>Model: " + (device.model || "-") + "</span>";
        devicesBox.appendChild(div);
      }
    }

    function showSuccess(data) {
      const token = data.token || data.savedToken;
      status("登录成功。UID: " + token.uid + "\\nBroker: " + token.mqttBroker + "\\nToken 已保存到本地。", "ok");
      renderDevices(token.devices);
    }

    loginForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      devicesBox.innerHTML = "";
      codeForm.classList.add("hidden");
      tfaForm.classList.add("hidden");
      status("正在登录...", "warn");
      try {
        const body = {
          region: document.querySelector("#region").value,
          account: document.querySelector("#account").value,
          password: document.querySelector("#password").value
        };
        const data = await post("/api/login", body);
        if (data.needsCode) {
          status(data.codeTarget === "sms" ? "已发送短信验证码。" : "已发送邮箱验证码。", "warn");
          codeForm.classList.remove("hidden");
          document.querySelector("#code").focus();
        } else if (data.needsTfa) {
          pendingTfaKey = data.tfaKey || "";
          status("需要 MFA。", "warn");
          tfaForm.classList.remove("hidden");
          document.querySelector("#tfaCode").focus();
        } else {
          showSuccess(data);
        }
      } catch (error) {
        status(error.message, "bad");
      }
    });

    codeForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      status("正在验证...", "warn");
      try {
        const data = await post("/api/verify", {
          region: document.querySelector("#region").value,
          account: document.querySelector("#account").value,
          code: document.querySelector("#code").value
        });
        codeForm.classList.add("hidden");
        showSuccess(data);
      } catch (error) {
        status(error.message, "bad");
      }
    });

    tfaForm.addEventListener("submit", async (event) => {
      event.preventDefault();
      status("正在验证 MFA...", "warn");
      try {
        const data = await post("/api/tfa", {
          region: document.querySelector("#region").value,
          tfaKey: pendingTfaKey,
          tfaCode: document.querySelector("#tfaCode").value
        });
        tfaForm.classList.add("hidden");
        showSuccess(data);
      } catch (error) {
        status(error.message, "bad");
      }
    });

    fetch("/api/status")
      .then((res) => res.ok ? res.json() : null)
      .then((data) => {
        if (data && data.savedToken) showSuccess(data);
      })
      .catch(() => {});
  </script>
</body>
</html>`;
}

async function handleApi(req, res, pathname) {
  const controller = new AbortController();
  const abortRequest = () => {
    if (!controller.signal.aborted) controller.abort(new Error("Cloud login request was disconnected"));
  };
  const abortOnResponseClose = () => {
    if (!res.writableEnded) abortRequest();
  };
  req.once("aborted", abortRequest);
  res.once("close", abortOnResponseClose);
  if (req.aborted) abortRequest();

  try {
    if (pathname === "/api/status" && req.method === "GET") {
      try {
        const token = await loadCloudToken(TOKEN_FILE);
        sendJson(res, 200, { savedToken: maskTokenData(token) });
      } catch {
        sendJson(res, 200, { savedToken: null });
      }
      return;
    }

    const body = await parseBody(req);

    if (pathname === "/api/login" && req.method === "POST") {
      const result = await loginWithPassword({ ...body, signal: controller.signal });
      if (result.token) {
        await saveCloudToken(TOKEN_FILE, result.token);
        sendJson(res, 200, { token: maskTokenData(result.token) });
      } else {
        sendJson(res, 200, result);
      }
      return;
    }

    if (pathname === "/api/verify" && req.method === "POST") {
      const result = await loginWithCode({ ...body, signal: controller.signal });
      await saveCloudToken(TOKEN_FILE, result.token);
      sendJson(res, 200, { token: maskTokenData(result.token) });
      return;
    }

    if (pathname === "/api/tfa" && req.method === "POST") {
      const result = await loginWithTfa({ ...body, signal: controller.signal });
      await saveCloudToken(TOKEN_FILE, result.token);
      sendJson(res, 200, { token: maskTokenData(result.token) });
      return;
    }

    sendJson(res, 404, { error: "Not found" });
  } catch (error) {
    sendError(res, errorStatus(error, 400), error);
  } finally {
    req.removeListener("aborted", abortRequest);
    res.removeListener("close", abortOnResponseClose);
  }
}

async function handleRequest(req, res) {
  let url;
  try {
    url = new URL(req.url || "/", "http://localhost");
  } catch (cause) {
    const error = new Error("Invalid request URL", { cause });
    error.statusCode = 400;
    throw error;
  }

  if (url.pathname.startsWith("/api/")) {
    await handleApi(req, res, url.pathname);
    return;
  }

  res.writeHead(200, {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store"
  });
  res.end(page());
}

function handleRequestFailure(req, res, error) {
  try {
    console.error(`Cloud login request failed (${req.method || "UNKNOWN"}): ${error?.message || error}`);
    sendError(res, errorStatus(error, 500), error);
  } catch {
    try {
      if (!res.destroyed) res.destroy();
    } catch {
      // The request boundary must never create another uncaught error.
    }
  }
}

const server = createServer((req, res) => {
  req.on("error", () => {});
  res.on("error", () => {});
  try {
    Promise.resolve(handleRequest(req, res)).catch((error) => {
      handleRequestFailure(req, res, error);
    });
  } catch (error) {
    handleRequestFailure(req, res, error);
  }
});

server.headersTimeout = 30_000;
server.requestTimeout = 60_000;

server.listen(PORT, HOST, () => {
  const address = server.address();
  const listeningPort = typeof address === "object" && address ? address.port : PORT;
  const displayHost = HOST.includes(":") ? `[${HOST}]` : HOST;
  console.log(`Bambu Cloud login UI: http://${displayHost}:${listeningPort}`);
  console.log(`Token file: ${TOKEN_FILE}`);
});
