import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { get } from "node:http";
import { connect } from "node:net";
import test from "node:test";

function waitForServer(child) {
  return new Promise((resolve, reject) => {
    let output = "";
    const timer = setTimeout(() => reject(new Error(`cloud login server did not start: ${output}`)), 3_000);
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      output += chunk;
      const match = output.match(/Bambu Cloud login UI: http:\/\/(?:\[[^\]]+\]|[^:]+):(\d+)/);
      if (!match) return;
      clearTimeout(timer);
      resolve(Number(match[1]));
    });
    child.once("exit", (code, signal) => {
      clearTimeout(timer);
      reject(new Error(`cloud login server exited before listening (${code ?? signal}): ${output}`));
    });
  });
}

function sendMalformedRequest(port) {
  return new Promise((resolve) => {
    const socket = connect(port, "127.0.0.1", () => {
      socket.end("GET http://[ HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n");
    });
    socket.on("data", () => {});
    socket.on("error", () => resolve());
    socket.on("close", () => resolve());
  });
}

function statusRequest(port) {
  return new Promise((resolve, reject) => {
    const request = get({ host: "127.0.0.1", port, path: "/api/status" }, (response) => {
      response.resume();
      response.once("end", () => resolve(response.statusCode));
    });
    request.once("error", reject);
    request.setTimeout(2_000, () => request.destroy(new Error("status request timed out")));
  });
}

test("a malformed Cloud Login request cannot terminate the server", async (t) => {
  const child = spawn(process.execPath, ["src/cloud-login-server.js"], {
    cwd: new URL("..", import.meta.url),
    env: {
      ...process.env,
      CLOUD_LOGIN_HOST: "127.0.0.1",
      CLOUD_LOGIN_PORT: "0",
      NODE_OPTIONS: "--unhandled-rejections=strict"
    },
    stdio: ["ignore", "pipe", "pipe"]
  });
  t.after(() => {
    if (child.exitCode == null && child.signalCode == null) child.kill("SIGTERM");
  });
  child.stderr.resume();

  const port = await waitForServer(child);
  await sendMalformedRequest(port);
  assert.equal(await statusRequest(port), 200);
  assert.equal(child.exitCode, null);
});
