import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { PROTOCOL } from "../version.js";

/**
 * Decide whether a WebSocket upgrade may proceed based on its Origin header.
 *
 * The bridge binds to 127.0.0.1, but a malicious web page in any browser can
 * still try to reach ws://127.0.0.1:7300 (DNS-rebinding / cross-site WebSocket
 * hijacking). Browsers ALWAYS attach an http(s):// Origin to such a request, so
 * rejecting http/https origins blocks every browser vector while never locking
 * out the native UXP client — a ws:// client that connects from a
 * manifest-declared host and does not present an http/https web origin.
 *
 * We deliberately do NOT yet reject `null`/`file://`/app-scheme origins: until
 * the real UXP Origin value has been observed (it is logged on connect, see
 * `recordOrigin`), a stricter rule risks locking out the plugin. Tighten this
 * once that value is known.
 */
export function verifyOrigin(origin: string | undefined | null): boolean {
  if (!origin) return true; // no Origin header → native client, allow
  const lower = origin.toLowerCase();
  if (lower.startsWith("http://") || lower.startsWith("https://")) return false;
  return true; // ws://, null, app-specific schemes → allow (and log for review)
}

function originLogPath(): string {
  return (
    process.env.PPRO_BRIDGE_ORIGIN_LOG ?? path.join(os.homedir(), ".ppro", "bridge-origins.log")
  );
}

/**
 * Append EVERY upgrade attempt's Origin + decision to ~/.ppro/bridge-origins.log
 * (override with PPRO_BRIDGE_ORIGIN_LOG). This must record REJECTED attempts too
 * — if the real UXP client ever presents an http(s) origin it would be rejected
 * and never reach `connection`, so logging only accepted connections would hide
 * exactly the failure we need to diagnose. The daemon is spawned with stdio
 * "ignore", so a file is the only durable sink. Best-effort: never throws.
 */
function recordOrigin(origin: string | undefined, allowed: boolean): void {
  try {
    const file = originLogPath();
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(
      file,
      `${new Date().toISOString()} origin=${origin ?? "<none>"} decision=${allowed ? "allow" : "reject"}\n`,
    );
  } catch {
    /* logging is diagnostic only — never throw */
  }
}

interface Pending {
  resolve(value: unknown): void;
  reject(reason: Error): void;
  timer: NodeJS.Timeout;
}

export interface PluginInfo {
  connected: boolean;
  version: string | null;
  protocol: number | null;
  protocolMatches: boolean | null;
  helloError: string | null;
}

const DEFAULT_TIMEOUT_MS = 30_000;
const PORT_RETRY_MS = 2_000;

export class PluginBridge {
  private server: WebSocketServer | null = null;
  private plugin: WebSocket | null = null;
  private pluginVersion: string | null = null;
  private pluginProtocol: number | null = null;
  private pluginHelloError: string | null = null;
  private pending = new Map<string, Pending>();

  start(port = 7300): void {
    const server = new WebSocketServer({
      host: "127.0.0.1",
      port,
      // Reject browser web origins (DNS-rebinding / CSWSH). The native UXP
      // client presents no http(s) web origin, so it is unaffected. Logging the
      // decision here (not in `connection`) captures rejected attempts too, so a
      // plugin blocked by this rule still leaves a diagnosable trail.
      verifyClient: (info: { origin?: string }) => {
        const allow = verifyOrigin(info.origin);
        recordOrigin(info.origin, allow);
        return allow;
      },
    });
    this.server = server;

    server.on("connection", (socket) => {
      this.plugin = socket;

      socket.on("message", (raw) => {
        let msg: Record<string, unknown>;
        try {
          msg = JSON.parse(String(raw));
        } catch {
          return;
        }

        if (msg.type === "hello") {
          this.pluginVersion = typeof msg.version === "string" ? msg.version : null;
          this.pluginProtocol = typeof msg.protocol === "number" ? msg.protocol : null;
          this.pluginHelloError = typeof msg.error === "string" ? msg.error : null;
          return;
        }

        const pending = this.pending.get(String(msg.id));
        if (!pending) return;
        clearTimeout(pending.timer);
        this.pending.delete(String(msg.id));
        if (msg.ok) {
          pending.resolve(msg.data);
        } else {
          pending.reject(new Error(String(msg.error ?? "plugin returned an error")));
        }
      });

      socket.on("close", () => {
        if (this.plugin === socket) {
          this.plugin = null;
          this.pluginVersion = null;
          this.pluginProtocol = null;
          this.pluginHelloError = null;
        }
        for (const [id, pending] of this.pending) {
          clearTimeout(pending.timer);
          pending.reject(new Error("plugin disconnected while the call was in flight"));
          this.pending.delete(id);
        }
      });

      socket.on("error", () => {
        // close handler does the cleanup
      });
    });

    server.on("error", (error: NodeJS.ErrnoException) => {
      if (error.code === "EADDRINUSE") {
        // Another process (e.g. a dying daemon) still holds the port — retry
        // until it frees up instead of crashing (lesson L087).
        server.close();
        if (this.server === server) this.server = null;
        setTimeout(() => {
          if (this.server === null) this.start(port);
        }, PORT_RETRY_MS);
      }
    });
  }

  info(): PluginInfo {
    const connected = this.plugin?.readyState === WebSocket.OPEN;
    return {
      connected,
      version: this.pluginVersion,
      protocol: this.pluginProtocol,
      protocolMatches: connected && this.pluginProtocol !== null ? this.pluginProtocol === PROTOCOL : null,
      helloError: this.pluginHelloError,
    };
  }

  call(action: string, params: Record<string, unknown> = {}, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<unknown> {
    return new Promise((resolve, reject) => {
      if (this.plugin?.readyState !== WebSocket.OPEN) {
        reject(new Error("plugin not connected"));
        return;
      }
      const id = crypto.randomUUID();
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`action "${action}" timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.plugin.send(JSON.stringify({ id, action, params }));
    });
  }

  stop(): void {
    for (const [, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.reject(new Error("daemon shutting down"));
    }
    this.pending.clear();
    this.server?.close();
  }
}
