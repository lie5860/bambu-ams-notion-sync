import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import {
  loadStoredConfig,
  saveStoredConfig,
  updateStoredConfig
} from "../src/config-store.js";

function deferred() {
  let resolve;
  const promise = new Promise((resolvePromise) => {
    resolve = resolvePromise;
  });
  return { promise, resolve };
}

test("concurrent configuration mutations are serialized and atomically replace the file", async (t) => {
  const directory = await mkdtemp(join(tmpdir(), "bambu-config-test-"));
  const file = join(directory, "config.json");
  const previousPath = process.env.APP_CONFIG_FILE;
  process.env.APP_CONFIG_FILE = file;
  t.after(async () => {
    if (previousPath == null) delete process.env.APP_CONFIG_FILE;
    else process.env.APP_CONFIG_FILE = previousPath;
    await rm(directory, { recursive: true, force: true });
  });

  await saveStoredConfig({
    AMS_SYNC_ENABLED: "true",
    PRINT_TASK_HISTORY_LAST_TASK_TIME: ""
  });

  const firstUpdaterEntered = deferred();
  const releaseFirstUpdater = deferred();
  const first = updateStoredConfig(async (existing) => {
    firstUpdaterEntered.resolve();
    await releaseFirstUpdater.promise;
    return { ...existing, PRINT_TASK_HISTORY_LAST_TASK_TIME: "2026-07-20T00:00:00.000Z" };
  });
  await firstUpdaterEntered.promise;
  const second = updateStoredConfig((existing) => ({
    ...existing,
    AMS_SYNC_ENABLED: "false"
  }));
  releaseFirstUpdater.resolve();
  await Promise.all([first, second]);

  const stored = await loadStoredConfig();
  assert.equal(stored.PRINT_TASK_HISTORY_LAST_TASK_TIME, "2026-07-20T00:00:00.000Z");
  assert.equal(stored.AMS_SYNC_ENABLED, "false");
  assert.equal((await stat(file)).mode & 0o777, 0o600);
  const contents = await readFile(file, "utf8");
  assert.doesNotThrow(() => JSON.parse(contents));
});
