export const DEFAULT_FETCH_TIMEOUT_MS = 30_000;
export const DEFAULT_JSON_RESPONSE_MAX_BYTES = 1024 * 1024;

function timeoutError(timeoutMs, cause) {
  const error = new Error(`Request timed out after ${timeoutMs}ms`, { cause });
  error.name = "TimeoutError";
  error.code = "ETIMEDOUT";
  return error;
}

export function awaitWithSignal(operation, signal) {
  const observedOperation = Promise.resolve(operation);
  if (!signal) return observedOperation;
  if (signal.aborted) {
    // The operation may have been created immediately before the owner aborted.
    // Keep observing it so a later rejection cannot become process-fatal under
    // --unhandled-rejections=strict, even though the caller is already done.
    observedOperation.catch(() => {});
    return Promise.reject(signal.reason);
  }

  return new Promise((resolve, reject) => {
    const onAbort = () => {
      cleanup();
      reject(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    observedOperation.then(
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

export async function withTimeout(operation, {
  timeoutMs = DEFAULT_FETCH_TIMEOUT_MS,
  signal: callerSignal
} = {}) {
  if (callerSignal?.aborted) throw callerSignal.reason;

  const timeoutSignal = AbortSignal.timeout(timeoutMs);
  const signal = callerSignal
    ? AbortSignal.any([callerSignal, timeoutSignal])
    : timeoutSignal;

  try {
    return await awaitWithSignal(Promise.resolve().then(() => {
      if (signal.aborted) throw signal.reason;
      return operation(signal);
    }), signal);
  } catch (error) {
    if (timeoutSignal.aborted && signal.reason === timeoutSignal.reason) {
      throw timeoutError(timeoutMs, error);
    }
    throw error;
  }
}

export function fetchWithTimeout(input, options = {}, timeoutMs = DEFAULT_FETCH_TIMEOUT_MS) {
  return withTimeout(
    (signal) => fetch(input, { ...options, signal }),
    { timeoutMs, signal: options.signal }
  );
}

function responseTooLarge(maxBytes) {
  const error = new Error(`Response body exceeds ${maxBytes} bytes`);
  error.code = "RESPONSE_TOO_LARGE";
  return error;
}

function cancelBody(body, reason) {
  try {
    Promise.resolve(body?.cancel?.(reason)).catch(() => {});
  } catch {
    // Cancellation is best effort and must not replace the original request failure.
  }
}

export async function readResponseText(response, {
  maxBytes = DEFAULT_JSON_RESPONSE_MAX_BYTES,
  signal
} = {}) {
  const contentLength = Number(response.headers?.get?.("content-length"));
  if (Number.isFinite(contentLength) && contentLength > maxBytes) {
    cancelBody(response.body);
    throw responseTooLarge(maxBytes);
  }

  if (!response.body?.getReader) {
    const text = await awaitWithSignal(response.text(), signal);
    if (new TextEncoder().encode(text).byteLength > maxBytes) throw responseTooLarge(maxBytes);
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
      if (byteLength > maxBytes) throw responseTooLarge(maxBytes);
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    if (!complete) cancelBody(reader, signal?.reason);
    try {
      reader.releaseLock?.();
    } catch {
      // Cancellation may still be releasing a pending stream read.
    }
  }
}

export function parseBody(req) {
  return new Promise((resolveBody, reject) => {
    let raw = "";
    let settled = false;

    const cleanup = () => {
      req.off("data", onData);
      req.off("end", onEnd);
      req.off("aborted", onAborted);
      req.off("error", onError);
      req.off("close", onClose);
    };
    const settle = (callback, value) => {
      if (settled) return;
      settled = true;
      cleanup();
      callback(value);
    };
    const fail = (error) => settle(reject, error);
    const onData = (chunk) => {
      raw += chunk;
      if (raw.length > 100_000) {
        const error = new Error("Request body too large");
        error.statusCode = 413;
        fail(error);
        req.destroy();
      }
    };
    const onEnd = () => {
      try {
        settle(resolveBody, raw ? JSON.parse(raw) : {});
      } catch {
        fail(new Error("Invalid JSON"));
      }
    };
    const onAborted = () => {
      const error = new Error("Request aborted");
      error.code = "ECONNABORTED";
      fail(error);
    };
    const onError = (error) => fail(error);
    const onClose = () => {
      if (req.complete) return;
      const error = new Error("Request closed before body was complete");
      error.code = "ECONNRESET";
      fail(error);
    };

    req.on("data", onData);
    req.on("end", onEnd);
    req.on("aborted", onAborted);
    req.on("error", onError);
    req.on("close", onClose);

    if (req.aborted || req.destroyed) onAborted();
  });
}
