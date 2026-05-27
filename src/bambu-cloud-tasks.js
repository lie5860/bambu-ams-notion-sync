const REGION_BASE_URLS = {
  global: "https://api.bambulab.com",
  china: "https://api.bambulab.cn"
};

function baseUrlForRegion(region) {
  return REGION_BASE_URLS[region] || REGION_BASE_URLS.global;
}

async function requestJson(url, accessToken) {
  const response = await fetch(url, {
    headers: {
      Authorization: `Bearer ${accessToken}`,
      accept: "application/json"
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

export async function fetchCloudPrintTasks({ cloud, printerSerial, limit = 0, pageSize = 100, logger }) {
  if (!cloud?.accessToken) return [];

  const tasks = [];
  const baseUrl = baseUrlForRegion(cloud.region);
  let offset = 0;
  let total = null;
  const safePageSize = Math.max(1, Math.min(Number(pageSize) || 100, 100));

  do {
    const remaining = limit > 0 ? limit - tasks.length : safePageSize;
    const requestLimit = Math.max(1, Math.min(safePageSize, remaining));
    const url = new URL(`${baseUrl}/v1/user-service/my/tasks`);
    url.searchParams.set("deviceId", printerSerial);
    url.searchParams.set("limit", String(requestLimit));
    url.searchParams.set("offset", String(offset));

    const data = await requestJson(url, cloud.accessToken);
    const page = Array.isArray(data.hits) ? data.hits : [];
    total = Number.isFinite(Number(data.total)) ? Number(data.total) : tasks.length + page.length;
    tasks.push(...page);
    offset += page.length;

    if (logger && page.length > 0) {
      logger.info(`Fetched ${tasks.length}/${total} Bambu cloud print task(s)`);
    }

    if (page.length === 0) break;
    if (limit > 0 && tasks.length >= limit) break;
  } while (tasks.length < total);

  return limit > 0 ? tasks.slice(0, limit) : tasks;
}
