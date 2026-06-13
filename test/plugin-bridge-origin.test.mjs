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
function connect(port, origin) {
  return new Promise((resolve) => {
    const opts = origin === undefined ? {} : { origin };
    const ws = new WebSocket(`ws://127.0.0.1:${port}`, opts);
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

// One test owns the process-global env toggle so observe/enforce never race.
test("PluginBridge: observe-by-default never blocks but logs would-reject; enforce blocks http", async (t) => {
  const logFile = path.join(os.tmpdir(), `ppro-origin-log-${process.pid}-${Date.now()}.log`);
  const prevLog = process.env.PPRO_BRIDGE_ORIGIN_LOG;
  const prevEnf = process.env.PPRO_ENFORCE_ORIGIN;
  process.env.PPRO_BRIDGE_ORIGIN_LOG = logFile;
  const port = 20000 + Math.floor(Math.random() * 15000);
  const bridge = new PluginBridge();
  bridge.start(port);
  t.after(() => {
    bridge.stop();
    if (prevLog === undefined) delete process.env.PPRO_BRIDGE_ORIGIN_LOG;
    else process.env.PPRO_BRIDGE_ORIGIN_LOG = prevLog;
    if (prevEnf === undefined) delete process.env.PPRO_ENFORCE_ORIGIN;
    else process.env.PPRO_ENFORCE_ORIGIN = prevEnf;
    try { fs.unlinkSync(logFile); } catch { /* noop */ }
  });
  await new Promise((r) => setTimeout(r, 150));

  // Observe (default): a browser origin still connects (not bricked) but is logged.
  delete process.env.PPRO_ENFORCE_ORIGIN;
  assert.equal(await connect(port, "https://evil.example"), "open", "observe mode must not block any origin");
  await new Promise((r) => setTimeout(r, 100)); // let the append flush
  assert.match(
    fs.readFileSync(logFile, "utf8"),
    /origin=https:\/\/evil\.example verdict=reject enforced=false/,
    "observe mode must log the would-reject verdict",
  );

  // Enforce: the browser origin is now rejected; the native client (no origin) still connects.
  process.env.PPRO_ENFORCE_ORIGIN = "1";
  assert.equal(await connect(port, "http://evil.com"), "rejected", "enforce must reject browser origins");
  assert.equal(await connect(port, undefined), "open", "native client (no origin) must connect");
});
