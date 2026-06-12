// Premiere Pro Agent — UXP plugin entry.
// Connects out to the local daemon (UXP can only be a WebSocket client),
// announces itself with a hello message, then serves actions from handlers/.

const PROTOCOL = 1;
const VERSION = "0.1.0";
// "localhost" (not 127.0.0.1) — UXP matches network permissions by the
// literal domain string in the loaded manifest, and the long-lived manifest
// entry is "ws://localhost". The daemon still binds to 127.0.0.1 only.
const WS_URL = "ws://localhost:7200";
const RECONNECT_MS = 2000;

// If handler loading dies (e.g. relative require unsupported in this UXP
// runtime), still connect and report the error through the hello message,
// so `ppro status` can show what broke without opening any GUI.
let handlers = {};
let loadError = null;
try {
  handlers = require("./handlers/index.js");
} catch (error) {
  loadError = String((error && error.message) || error);
}

const statusEl = document.getElementById("status");
const logEl = document.getElementById("log");

function setStatus(kind, text) {
  statusEl.className = kind;
  statusEl.textContent = text;
}

function log(text) {
  const time = new Date().toTimeString().slice(0, 8);
  logEl.textContent = `[${time}] ${text}\n` + logEl.textContent.split("\n").slice(0, 20).join("\n");
}

// Surface any uncaught error on the panel itself — there is no terminal here.
if (typeof window !== "undefined") {
  window.onerror = (message) => {
    setStatus("disconnected", `script error: ${message}`);
  };
}

let ws = null;

function connect() {
  try {
    ws = new WebSocket(WS_URL);
  } catch (error) {
    setStatus("disconnected", `WebSocket blocked: ${String((error && error.message) || error)}`);
    setTimeout(connect, RECONNECT_MS);
    return;
  }

  ws.onopen = () => {
    if (loadError) {
      setStatus("disconnected", `connected, but handlers failed: ${loadError}`);
    } else {
      setStatus("connected", "connected to daemon (:7200)");
    }
    ws.send(
      JSON.stringify({ type: "hello", protocol: PROTOCOL, version: VERSION, error: loadError || undefined }),
    );
  };

  ws.onmessage = async (event) => {
    let msg;
    try {
      msg = JSON.parse(event.data);
    } catch {
      return;
    }
    if (!msg.id || !msg.action) return;

    let reply;
    try {
      const handler = handlers[msg.action];
      if (!handler) throw new Error(`unknown action: ${msg.action}`);
      reply = { id: msg.id, ok: true, data: await handler(msg.params || {}) };
    } catch (error) {
      reply = { id: msg.id, ok: false, error: String((error && error.message) || error) };
      log(`${msg.action} failed: ${reply.error}`);
    }
    try {
      ws.send(JSON.stringify(reply));
    } catch {
      // socket dropped while handling — the daemon will time the call out
    }
  };

  ws.onclose = () => {
    setStatus("disconnected", "daemon not reachable — retrying every 2s");
    setTimeout(connect, RECONNECT_MS);
  };

  ws.onerror = () => {
    try {
      ws.close();
    } catch {
      // onclose drives the reconnect
    }
  };
}

connect();
