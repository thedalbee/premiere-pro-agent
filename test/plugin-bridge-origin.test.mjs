/**
 * plugin-bridge-origin.test.mjs
 *
 * WS :7300 hardening — reject browser web origins (DNS-rebinding / CSWSH) while
 * never locking out the native UXP client (which presents no http(s) origin).
 *
 *   - verifyOrigin: pure decision function.
 *   - PluginBridge: a real upgrade with an http(s) Origin is rejected; one with
 *     no Origin is accepted. (No Premiere involved — just the WS server.)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { WebSocket } from "ws";

const { verifyOrigin, PluginBridge } = await import("../dist/daemon/plugin-bridge.js");

// ── pure: verifyOrigin ───────────────────────────────────────────────────────
test("verifyOrigin: rejects http/https web origins (any case)", () => {
  assert.equal(verifyOrigin("http://evil.com"), false);
  assert.equal(verifyOrigin("https://evil.com"), false);
  assert.equal(verifyOrigin("HTTP://EVIL.COM"), false);
  assert.equal(verifyOrigin("https://127.0.0.1:7300"), false);
});

test("verifyOrigin: allows absent / native / app-scheme origins", () => {
  assert.equal(verifyOrigin(undefined), true);
  assert.equal(verifyOrigin(null), true);
  assert.equal(verifyOrigin(""), true);
  assert.equal(verifyOrigin("ws://localhost:7300"), true);
  // file:// sends the literal "null"; not yet rejected by design (see source).
  assert.equal(verifyOrigin("null"), true);
});

// ── integration: real WS upgrade ─────────────────────────────────────────────
const PORT = 20000 + Math.floor(Math.random() * 15000);

function connect(origin) {
  return new Promise((resolve) => {
    const opts = origin === undefined ? {} : { origin };
    const ws = new WebSocket(`ws://127.0.0.1:${PORT}`, opts);
    let settled = false;
    const settle = (outcome) => {
      if (settled) return;
      settled = true;
      // Keep a noop error sink so a trailing handshake-abort error does not
      // surface as an uncaughtException, then close best-effort.
      ws.on("error", () => {});
      try { ws.close(); } catch { /* noop */ }
      resolve(outcome);
    };
    ws.on("open", () => settle("open"));
    ws.on("error", () => settle("rejected"));
    ws.on("unexpected-response", () => settle("rejected"));
    setTimeout(() => settle("timeout"), 2000);
  });
}

test("PluginBridge: http origin is rejected, no origin is accepted", async (t) => {
  const bridge = new PluginBridge();
  bridge.start(PORT);
  t.after(() => bridge.stop());
  // Give the server a moment to bind.
  await new Promise((r) => setTimeout(r, 150));

  assert.equal(await connect("http://evil.com"), "rejected", "browser origin must be rejected");
  assert.equal(await connect(undefined), "open", "native client (no origin) must connect");
});

test("PluginBridge: a REJECTED upgrade is still logged (so a blocked plugin is diagnosable)", async (t) => {
  const logFile = path.join(os.tmpdir(), `ppro-origin-log-${process.pid}-${Date.now()}.log`);
  const prev = process.env.PPRO_BRIDGE_ORIGIN_LOG;
  process.env.PPRO_BRIDGE_ORIGIN_LOG = logFile;
  const port = 20000 + Math.floor(Math.random() * 15000);
  const bridge = new PluginBridge();
  bridge.start(port);
  t.after(() => {
    bridge.stop();
    if (prev === undefined) delete process.env.PPRO_BRIDGE_ORIGIN_LOG;
    else process.env.PPRO_BRIDGE_ORIGIN_LOG = prev;
    try { fs.unlinkSync(logFile); } catch { /* noop */ }
  });
  await new Promise((r) => setTimeout(r, 150));

  await new Promise((resolve) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, { origin: "https://evil.example" });
    ws.on("error", () => { ws.on("error", () => {}); resolve(); });
    ws.on("unexpected-response", () => { ws.on("error", () => {}); resolve(); });
    ws.on("open", () => { ws.close(); resolve(); });
    setTimeout(resolve, 2000);
  });
  await new Promise((r) => setTimeout(r, 100)); // let the append flush

  const log = fs.readFileSync(logFile, "utf8");
  assert.match(log, /origin=https:\/\/evil\.example decision=reject/, "rejected origin must be logged");
});
