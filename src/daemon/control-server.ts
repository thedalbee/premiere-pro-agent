import http from "node:http";
import { PROTOCOL, cliVersion } from "../version.js";
import type { PluginBridge } from "./plugin-bridge.js";

// Premiere mutations must run one at a time even when agents call in
// parallel, so every /rpc is chained onto the previous one.
let queue: Promise<unknown> = Promise.resolve();

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk) => {
      body += chunk;
    });
    req.on("end", () => resolve(body));
    req.on("error", reject);
  });
}

export function createControlServer(bridge: PluginBridge): http.Server {
  return http.createServer(async (req, res) => {
    const respond = (code: number, payload: unknown) => {
      // The client may have given up on a long action; don't crash on its corpse.
      if (res.destroyed || res.writableEnded) return;
      res.writeHead(code, { "content-type": "application/json" });
      res.end(JSON.stringify(payload));
    };

    if (req.method === "GET" && req.url === "/health") {
      return respond(200, {
        ok: true,
        daemon: { version: cliVersion(), protocol: PROTOCOL, pid: process.pid },
        plugin: bridge.info(),
      });
    }

    if (req.method === "POST" && req.url === "/rpc") {
      try {
        const body = JSON.parse((await readBody(req)) || "{}") as {
          action?: string;
          params?: Record<string, unknown>;
          timeout?: number;
        };
        if (!body.action) {
          return respond(400, { ok: false, error: "action required" });
        }
        if (!bridge.info().connected) {
          // 502: the daemon is fine but its upstream (the plugin) is not there.
          return respond(502, { ok: false, error: "plugin not connected" });
        }
        const call = queue.then(() => bridge.call(body.action!, body.params ?? {}, body.timeout));
        queue = call.catch(() => {});
        const data = await call;
        return respond(200, { ok: true, data });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        return respond(500, { ok: false, error: message });
      }
    }

    return respond(404, {
      ok: false,
      error: "endpoints: GET /health | POST /rpc {action, params, timeout}",
    });
  });
}
