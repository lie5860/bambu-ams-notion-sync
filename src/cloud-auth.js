import { chmod, mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";

export const CLOUD_REGIONS = {
  global: {
    label: "Global",
    apiBaseUrl: "https://api.bambulab.com",
    mqttBroker: "us.mqtt.bambulab.com"
  },
  china: {
    label: "China",
    apiBaseUrl: "https://api.bambulab.cn",
    mqttBroker: "cn.mqtt.bambulab.com"
  }
};

const DEFAULT_HEADERS = {
  "User-Agent": "bambu_network_agent/01.09.05.01",
  "X-BBL-Client-Name": "OrcaSlicer",
  "X-BBL-Client-Type": "slicer",
  "X-BBL-Client-Version": "01.09.05.51",
  "X-BBL-Language": "en-US",
  "X-BBL-OS-Type": "linux",
  "X-BBL-OS-Version": "6.2.0",
  "X-BBL-Agent-Version": "01.09.05.01",
  "X-BBL-Executable-info": "{}",
  "X-BBL-Agent-OS-Type": "linux",
  accept: "application/json",
  "Content-Type": "application/json"
};

function regionConfig(region) {
  return CLOUD_REGIONS[region] || CLOUD_REGIONS.global;
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      ...DEFAULT_HEADERS,
      ...(options.headers || {})
    }
  });

  const text = await response.text();
  let data = {};
  if (text.trim()) {
    try {
      data = JSON.parse(text);
    } catch {
      data = { message: text };
    }
  }

  if (!response.ok) {
    const message = data.message || data.error || response.statusText;
    throw new Error(`${response.status} ${message}`);
  }

  return data;
}

function tokenFromResponse(data) {
  return data.accessToken || data.token || "";
}

function isEmail(account) {
  return String(account || "").includes("@");
}

function expiresAt(data) {
  const seconds = Number(data.expiresIn || data.refreshExpiresIn || 0);
  return seconds > 0 ? new Date(Date.now() + seconds * 1000).toISOString() : "";
}

async function enrichToken(region, authData) {
  const token = tokenFromResponse(authData);
  if (!token) {
    throw new Error(authData.message || authData.error || "Login succeeded without an access token");
  }

  const regionInfo = regionConfig(region);
  const authHeader = { Authorization: `Bearer ${token}` };
  const profile = await requestJson(`${regionInfo.apiBaseUrl}/v1/design-user-service/my/preference`, {
    method: "GET",
    headers: authHeader
  });

  let devices = [];
  try {
    const deviceResponse = await requestJson(`${regionInfo.apiBaseUrl}/v1/iot-service/api/user/bind`, {
      method: "GET",
      headers: authHeader
    });
    devices = Array.isArray(deviceResponse.devices) ? deviceResponse.devices : [];
  } catch {
    devices = [];
  }

  return {
    region,
    apiBaseUrl: regionInfo.apiBaseUrl,
    mqttBroker: regionInfo.mqttBroker,
    uid: String(profile.uid || ""),
    accessToken: token,
    refreshToken: authData.refreshToken || token,
    expiresAt: expiresAt(authData),
    savedAt: new Date().toISOString(),
    devices: devices.map((device) => ({
      dev_id: device.dev_id || device.devId || device.id || "",
      name: device.name || device.dev_name || device.devName || "",
      model: device.dev_model_name || device.model || "",
      online: device.online ?? device.dev_online ?? null
    }))
  };
}

export async function loginWithPassword({ region, account, password }) {
  const regionInfo = regionConfig(region);
  const data = await requestJson(`${regionInfo.apiBaseUrl}/v1/user-service/user/login`, {
    method: "POST",
    body: JSON.stringify({ account, password, apiError: "" })
  });

  if (data.loginType === "verifyCode") {
    await sendVerificationCode({ region, account });
    return { needsCode: true, codeTarget: isEmail(account) ? "email" : "sms" };
  }

  if (data.loginType === "tfa") {
    return { needsTfa: true, tfaKey: data.tfaKey || "" };
  }

  return { token: await enrichToken(region, data) };
}

export async function sendVerificationCode({ region, account }) {
  const regionInfo = regionConfig(region);
  const email = isEmail(account);
  const endpoint = email
    ? "/v1/user-service/user/sendemail/code"
    : "/v1/user-service/user/sendsmscode";
  const payload = email
    ? { email: account, type: "codeLogin" }
    : { phone: account, type: "codeLogin" };

  await requestJson(`${regionInfo.apiBaseUrl}${endpoint}`, {
    method: "POST",
    body: JSON.stringify(payload)
  });
}

export async function loginWithCode({ region, account, code }) {
  const regionInfo = regionConfig(region);
  const data = await requestJson(`${regionInfo.apiBaseUrl}/v1/user-service/user/login`, {
    method: "POST",
    body: JSON.stringify({ account, code })
  });
  return { token: await enrichToken(region, data) };
}

export async function loginWithTfa({ region, tfaKey, tfaCode }) {
  const regionInfo = regionConfig(region);
  const data = await requestJson(`${regionInfo.apiBaseUrl}/api/sign-in/tfa`, {
    method: "POST",
    body: JSON.stringify({ tfaKey, tfaCode })
  });
  return { token: await enrichToken(region, data) };
}

export async function saveCloudToken(tokenFile, tokenData) {
  await mkdir(dirname(tokenFile), { recursive: true });
  await writeFile(tokenFile, `${JSON.stringify(tokenData, null, 2)}\n`, { mode: 0o600 });
  await chmod(tokenFile, 0o600);
}

export async function loadCloudToken(tokenFile) {
  const raw = await readFile(tokenFile, "utf8");
  return JSON.parse(raw);
}
