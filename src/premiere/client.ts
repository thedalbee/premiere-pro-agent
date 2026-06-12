import { spawn } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";

const CONTROL_URL = "http://127.0.0.1:7201";
const START_TIMEOUT_MS = 10_000;

export interface DaemonHealth {
  ok: boolean;
  daemon: { version: string; protocol: number; pid: number };
  plugin: {
    connected: boolean;
    version: string | null;
    protocol: number | null;
    protocolMatches: boolean | null;
    helloError: string | null;
  };
}

export class PluginNotConnectedError extends Error {
  constructor() {
    super(
      "Premiere plugin is not connected. Open Premiere Pro with the " +
        "Premiere Pro Agent panel loaded, then try again.",
    );
  }
}

// "foreign" = something answered on 7201 but it is not our daemon
// (e.g. a leftover daemon from another tool holding the port).
export async function daemonHealth(): Promise<DaemonHealth | "foreign" | null> {
  try {
    const res = await fetch(`${CONTROL_URL}/health`, { signal: AbortSignal.timeout(1_000) });
    if (!res.ok) return "foreign";
    const payload = (await res.json()) as Partial<DaemonHealth>;
    if (!payload?.daemon?.version) return "foreign";
    return payload as DaemonHealth;
  } catch {
    return null;
  }
}

export async function ensureDaemon(): Promise<DaemonHealth> {
  const existing = await daemonHealth();
  if (existing === "foreign") {
    throw new Error(
      "port 7201 is held by another process that is not the ppro daemon. " +
        "Find it with: lsof -nP -i :7201",
    );
  }
  if (existing) return existing;

  const daemonPath = new URL("../daemon/main.js", import.meta.url).pathname;
  const child = spawn(process.execPath, [daemonPath], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();

  const deadline = Date.now() + START_TIMEOUT_MS;
  while (Date.now() < deadline) {
    await sleep(250);
    const health = await daemonHealth();
    if (health === "foreign") {
      throw new Error(
        "port 7201 was taken by another process while starting the daemon. " +
          "Find it with: lsof -nP -i :7201",
      );
    }
    if (health) return health;
  }
  throw new Error("daemon did not start within 10s — run `ppro doctor` to diagnose");
}

export async function callPremiere(
  action: string,
  params: Record<string, unknown> = {},
  timeoutMs?: number,
): Promise<unknown> {
  await ensureDaemon();
  const res = await fetch(`${CONTROL_URL}/rpc`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ action, params, timeout: timeoutMs }),
  });
  const payload = (await res.json()) as { ok: boolean; data?: unknown; error?: string };
  if (res.status === 502) {
    throw new PluginNotConnectedError();
  }
  if (!payload.ok) {
    throw new Error(payload.error ?? `action "${action}" failed`);
  }
  return payload.data;
}
