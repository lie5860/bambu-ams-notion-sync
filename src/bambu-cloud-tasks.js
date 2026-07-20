const REGION_BASE_URLS = {
  global: "https://api.bambulab.com",
  china: "https://api.bambulab.cn"
};

const DEFAULT_REQUEST_TIMEOUT_MS = 30_000;
const DEFAULT_BODY_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_RESPONSE_BYTES = 4 * 1024 * 1024;
const DEFAULT_MAX_TASKS = 20_000;
const MAX_PAGES = DEFAULT_MAX_TASKS;
const MAX_TIMEOUT_MS = 5 * 60 * 1000;

export class BambuCloudTaskError extends Error {
  constructor(message, { code = "BAMBU_CLOUD_TASK_ERROR", status, cause } = {}) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "BambuCloudTaskError";
    this.code = code;
    if (status !== undefined) this.status = status;
  }
}

function baseUrlForRegion(region) {
  return REGION_BASE_URLS[region] || REGION_BASE_URLS.global;
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isSafeInteger(number) && number > 0 ? number : fallback;
}

function boundedPositiveInteger(value, fallback, maximum) {
  return Math.min(positiveInteger(value, fallback), maximum);
}

function abortError() {
  const error = new Error("The operation was aborted");
  error.name = "AbortError";
  error.code = "ABORT_ERR";
  return error;
}

function createRequestControl(callerSignal) {
  const controller = new AbortController();
  let deadlineTimer = null;
  let timeoutPhase = "";

  const abortFromCaller = () => {
    if (!controller.signal.aborted) controller.abort(callerSignal?.reason || abortError());
  };

  if (callerSignal?.aborted) {
    abortFromCaller();
  } else {
    callerSignal?.addEventListener("abort", abortFromCaller, { once: true });
  }

  return {
    signal: controller.signal,
    get timeoutPhase() {
      return timeoutPhase;
    },
    setDeadline(timeoutMs, phase) {
      clearTimeout(deadlineTimer);
      if (controller.signal.aborted) return;
      deadlineTimer = setTimeout(() => {
        timeoutPhase = phase;
        const error = new Error(`Bambu cloud ${phase} timed out after ${timeoutMs}ms`);
        error.code = "ETIMEDOUT";
        controller.abort(error);
      }, timeoutMs);
    },
    cleanup() {
      clearTimeout(deadlineTimer);
      callerSignal?.removeEventListener("abort", abortFromCaller);
    }
  };
}

function awaitWithSignal(promise, signal) {
  const observedPromise = Promise.resolve(promise);
  if (!signal) return observedPromise;
  if (signal.aborted) {
    // A body read can be created just before cancellation wins the race. Keep
    // consuming its eventual rejection so it cannot terminate the process.
    observedPromise.catch(() => {});
    return Promise.reject(signal.reason || abortError());
  }

  return new Promise((resolve, reject) => {
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    const onAbort = () => {
      cleanup();
      reject(signal.reason || abortError());
    };

    signal.addEventListener("abort", onAbort, { once: true });
    observedPromise.then(
      (value) => {
        cleanup();
        resolve(value);
      },
      (error) => {
        cleanup();
        reject(error);
      }
    );
  });
}

function errorCode(error, fallback) {
  const seen = new Set();
  let current = error;
  while (current && typeof current === "object" && !seen.has(current)) {
    seen.add(current);
    if (current.code != null && current.code !== "") return String(current.code);
    current = current.cause;
  }
  return fallback;
}

function requestFailure(error, { control, callerSignal, status } = {}) {
  if (control?.timeoutPhase) {
    return new BambuCloudTaskError(`Bambu cloud ${control.timeoutPhase} timed out`, {
      code: "ETIMEDOUT",
      status,
      cause: control.signal.reason || error
    });
  }

  if (callerSignal?.aborted) {
    return new BambuCloudTaskError("Bambu cloud request was aborted", {
      code: "ABORT_ERR",
      status,
      cause: callerSignal.reason || error
    });
  }

  if (error instanceof BambuCloudTaskError) return error;

  return new BambuCloudTaskError(`Bambu cloud request failed: ${error?.message || String(error)}`, {
    code: errorCode(error, "BAMBU_CLOUD_REQUEST_FAILED"),
    status,
    cause: error
  });
}

async function readResponseBody(response, { maxBytes, signal }) {
  const rawContentLength = response.headers?.get?.("content-length");
  if (rawContentLength != null && rawContentLength !== "") {
    const contentLength = Number(rawContentLength);
    if (Number.isFinite(contentLength) && contentLength > maxBytes) {
      try {
        if (response.body?.cancel) await awaitWithSignal(response.body.cancel(), signal);
      } catch {
        // The size error remains the useful failure; cancellation is best effort.
      }
      throw new BambuCloudTaskError(
        `Bambu cloud response is too large (${contentLength} bytes; limit ${maxBytes})`,
        {
          code: "BAMBU_CLOUD_RESPONSE_TOO_LARGE",
          status: response.status
        }
      );
    }
  }

  if (!response.body?.getReader) {
    const text = await awaitWithSignal(response.text(), signal);
    const byteLength = new TextEncoder().encode(text).byteLength;
    if (byteLength > maxBytes) {
      throw new BambuCloudTaskError(
        `Bambu cloud response is too large (${byteLength} bytes; limit ${maxBytes})`,
        {
          code: "BAMBU_CLOUD_RESPONSE_TOO_LARGE",
          status: response.status
        }
      );
    }
    return text;
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let byteLength = 0;
  let text = "";
  let complete = false;

  try {
    while (true) {
      const { done, value } = await awaitWithSignal(reader.read(), signal);
      if (done) {
        complete = true;
        text += decoder.decode();
        return text;
      }

      byteLength += value.byteLength;
      if (byteLength > maxBytes) {
        throw new BambuCloudTaskError(
          `Bambu cloud response is too large (more than ${maxBytes} bytes)`,
          {
            code: "BAMBU_CLOUD_RESPONSE_TOO_LARGE",
            status: response.status
          }
        );
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!complete) {
      try {
        Promise.resolve(reader.cancel(signal?.reason)).catch(() => {});
      } catch {
        // Preserve the request failure if the stream is already unusable.
      }
    }
    try {
      reader.releaseLock?.();
    } catch {
      // A pending read releases its lock after cancellation settles.
    }
  }
}

function parseResponseJson(text, response) {
  if (!text.trim()) {
    if (!response.ok) return {};
    throw new BambuCloudTaskError("Bambu cloud returned an empty JSON response", {
      code: "BAMBU_CLOUD_INVALID_JSON",
      status: response.status
    });
  }

  try {
    return JSON.parse(text);
  } catch (error) {
    if (!response.ok) return { message: text };
    throw new BambuCloudTaskError("Bambu cloud returned invalid JSON", {
      code: "BAMBU_CLOUD_INVALID_JSON",
      status: response.status,
      cause: error
    });
  }
}

function responseErrorMessage(data, response) {
  const message = data && typeof data === "object" && !Array.isArray(data)
    ? data.message || data.error
    : "";
  return String(message || response.statusText || "HTTP error");
}

function validateTaskPage(data, { response, requestLimit, offset }) {
  if (!data || typeof data !== "object" || Array.isArray(data) || !Array.isArray(data.hits)) {
    throw new BambuCloudTaskError("Bambu cloud task response must contain a hits array", {
      code: "BAMBU_CLOUD_INVALID_SCHEMA",
      status: response.status
    });
  }

  if (data.total == null || data.total === "") {
    throw new BambuCloudTaskError("Bambu cloud task response must contain total", {
      code: "BAMBU_CLOUD_INVALID_PAGINATION",
      status: response.status
    });
  }

  const total = Number(data.total);
  if (!Number.isSafeInteger(total) || total < 0) {
    throw new BambuCloudTaskError("Bambu cloud task response total must be a non-negative safe integer", {
      code: "BAMBU_CLOUD_INVALID_PAGINATION",
      status: response.status
    });
  }

  if (data.hits.length > requestLimit || total < offset + data.hits.length) {
    throw new BambuCloudTaskError("Bambu cloud task response contains inconsistent pagination fields", {
      code: "BAMBU_CLOUD_INVALID_PAGINATION",
      status: response.status
    });
  }

  return { page: data.hits, total };
}

async function requestTaskPage(url, accessToken, {
  signal,
  fetchImpl,
  requestTimeoutMs,
  bodyTimeoutMs,
  maxResponseBytes,
  requestLimit,
  offset
}) {
  const control = createRequestControl(signal);
  let response;

  try {
    control.setDeadline(requestTimeoutMs, "request");
    try {
      if (control.signal.aborted) throw control.signal.reason || abortError();
      response = await awaitWithSignal(fetchImpl(url, {
        method: "GET",
        headers: {
          Authorization: `Bearer ${accessToken}`,
          accept: "application/json"
        },
        signal: control.signal
      }), control.signal);
    } catch (error) {
      throw requestFailure(error, { control, callerSignal: signal });
    }

    if (!response || typeof response !== "object" || typeof response.ok !== "boolean") {
      throw new BambuCloudTaskError("Bambu cloud fetch returned an invalid response", {
        code: "BAMBU_CLOUD_INVALID_RESPONSE"
      });
    }

    control.setDeadline(bodyTimeoutMs, "response body");
    let text;
    try {
      text = await readResponseBody(response, {
        maxBytes: maxResponseBytes,
        signal: control.signal
      });
    } catch (error) {
      throw requestFailure(error, {
        control,
        callerSignal: signal,
        status: response.status
      });
    }

    const data = parseResponseJson(text, response);
    if (!response.ok) {
      throw new BambuCloudTaskError(
        `${response.status} ${responseErrorMessage(data, response)}`,
        {
          code: "BAMBU_CLOUD_HTTP_ERROR",
          status: response.status
        }
      );
    }

    return {
      ...validateTaskPage(data, { response, requestLimit, offset }),
      status: response.status
    };
  } finally {
    control.cleanup();
  }
}

export function cloudPrintTaskTimeMs(task) {
  const candidates = [task?.endTime, task?.startTime, task?.createTime, task?.createdTime, task?.updateTime];
  for (const value of candidates) {
    if (value == null || value === "" || value === "0") continue;
    const number = Number(value);
    const millis = Number.isFinite(number) ? (number < 10_000_000_000 ? number * 1000 : number) : Date.parse(String(value));
    if (Number.isFinite(millis)) return millis;
  }
  return 0;
}

export async function fetchCloudPrintTasks({
  cloud,
  printerSerial,
  limit = 0,
  pageSize = 100,
  sinceTime = "",
  logger,
  signal,
  fetchImpl = globalThis.fetch,
  requestTimeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  bodyTimeoutMs = DEFAULT_BODY_TIMEOUT_MS,
  maxResponseBytes = DEFAULT_MAX_RESPONSE_BYTES,
  maxPages,
  maxTasks = DEFAULT_MAX_TASKS
}) {
  if (!cloud?.accessToken) return [];
  if (typeof fetchImpl !== "function") {
    throw new BambuCloudTaskError("Fetch is not available", { code: "BAMBU_CLOUD_FETCH_UNAVAILABLE" });
  }

  const tasks = [];
  const baseUrl = baseUrlForRegion(cloud.region);
  let offset = 0;
  let pageCount = 0;
  const safeLimit = Number.isSafeInteger(Number(limit)) && Number(limit) > 0 ? Number(limit) : 0;
  const safePageSize = boundedPositiveInteger(pageSize, 100, 100);
  const safeRequestTimeoutMs = boundedPositiveInteger(requestTimeoutMs, DEFAULT_REQUEST_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const safeBodyTimeoutMs = boundedPositiveInteger(bodyTimeoutMs, DEFAULT_BODY_TIMEOUT_MS, MAX_TIMEOUT_MS);
  const safeMaxResponseBytes = boundedPositiveInteger(
    maxResponseBytes,
    DEFAULT_MAX_RESPONSE_BYTES,
    DEFAULT_MAX_RESPONSE_BYTES
  );
  const safeMaxTasks = boundedPositiveInteger(maxTasks, DEFAULT_MAX_TASKS, DEFAULT_MAX_TASKS);
  const defaultMaxPages = Math.ceil((safeLimit || safeMaxTasks) / safePageSize);
  const safeMaxPages = boundedPositiveInteger(maxPages, defaultMaxPages, MAX_PAGES);
  const sinceMs = Number.isFinite(Date.parse(sinceTime)) ? Date.parse(sinceTime) : 0;

  if (safeLimit > safeMaxTasks) {
    throw new BambuCloudTaskError(
      `Requested Bambu cloud task limit ${safeLimit} exceeds maximum ${safeMaxTasks}`,
      { code: "BAMBU_CLOUD_MAX_TASKS_EXCEEDED" }
    );
  }

  while (true) {
    if (pageCount >= safeMaxPages) {
      throw new BambuCloudTaskError(
        `Bambu cloud task pagination exceeded ${safeMaxPages} pages`,
        { code: "BAMBU_CLOUD_MAX_PAGES_EXCEEDED" }
      );
    }

    const remaining = safeLimit > 0 ? safeLimit - tasks.length : safePageSize;
    const requestLimit = Math.max(1, Math.min(safePageSize, remaining));
    const url = new URL(`${baseUrl}/v1/user-service/my/tasks`);
    url.searchParams.set("deviceId", printerSerial);
    url.searchParams.set("limit", String(requestLimit));
    url.searchParams.set("offset", String(offset));

    const { page, total, status } = await requestTaskPage(url, cloud.accessToken, {
      signal,
      fetchImpl,
      requestTimeoutMs: safeRequestTimeoutMs,
      bodyTimeoutMs: safeBodyTimeoutMs,
      maxResponseBytes: safeMaxResponseBytes,
      requestLimit,
      offset
    });
    pageCount += 1;

    if (safeLimit === 0 && sinceMs === 0 && total > safeMaxTasks) {
      throw new BambuCloudTaskError(
        `Bambu cloud task response contains ${total} tasks; maximum is ${safeMaxTasks}`,
        { code: "BAMBU_CLOUD_MAX_TASKS_EXCEEDED", status }
      );
    }

    const newTasks = sinceMs > 0
      ? page.filter((task) => {
          const taskTimeMs = cloudPrintTaskTimeMs(task);
          return taskTimeMs === 0 || taskTimeMs > sinceMs;
        })
      : page;
    if (tasks.length + newTasks.length > safeMaxTasks) {
      throw new BambuCloudTaskError(
        `Bambu cloud task collection exceeded ${safeMaxTasks} tasks`,
        { code: "BAMBU_CLOUD_MAX_TASKS_EXCEEDED", status }
      );
    }
    tasks.push(...newTasks);
    offset += page.length;

    if (logger && page.length > 0) {
      logger.info(`Fetched ${tasks.length}/${total} Bambu cloud print task(s)`);
    }

    const reachedSinceTime = sinceMs > 0 && page.some((task) => {
      const taskTimeMs = cloudPrintTaskTimeMs(task);
      return taskTimeMs > 0 && taskTimeMs <= sinceMs;
    });
    if (reachedSinceTime) break;
    if (safeLimit > 0 && tasks.length >= safeLimit) break;
    if (offset >= total) break;
    if (page.length === 0) {
      throw new BambuCloudTaskError(
        `Bambu cloud task pagination stopped at offset ${offset} before total ${total}`,
        { code: "BAMBU_CLOUD_INVALID_PAGINATION", status }
      );
    }
  }

  return safeLimit > 0 ? tasks.slice(0, safeLimit) : tasks;
}
