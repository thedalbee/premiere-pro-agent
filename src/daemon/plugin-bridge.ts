import { WebSocketServer, WebSocket } from "ws";
import crypto from "node:crypto";
import { PROTOCOL } from "../version.js";

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

  start(port = 7200): void {
    const server = new WebSocketServer({ host: "127.0.0.1", port });
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
