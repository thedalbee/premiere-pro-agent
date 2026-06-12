import { parseArgs } from "node:util";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { printJson, sanitizePath } from "../output/print.js";
import { ensureDaemon, callPremiere, PluginNotConnectedError } from "../premiere/client.js";

interface ProjectInfo {
  open: boolean;
  name?: string;
  path?: string;
  sequenceCount?: number;
  activeSequence?: { name: string } | null;
}

async function runStatus(argv: string[]): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  const health = await ensureDaemon();

  let project: ProjectInfo | null = null;
  let pluginError: string | null = null;
  if (health.plugin.connected) {
    try {
      project = (await callPremiere("project.info")) as ProjectInfo;
    } catch (error) {
      pluginError = error instanceof Error ? error.message : String(error);
    }
  }

  if (values.json) {
    printJson({
      ok: health.plugin.connected && !pluginError,
      daemon: health.daemon,
      plugin: health.plugin,
      project,
      error: pluginError ?? undefined,
    });
  } else {
    process.stdout.write("ppro status\n\n");
    process.stdout.write(
      `  daemon   v${health.daemon.version} (protocol ${health.daemon.protocol}, pid ${health.daemon.pid})\n`,
    );
    if (health.plugin.connected) {
      let skew = "";
      if (health.plugin.protocolMatches === false) {
        skew = "  ← protocol mismatch, re-run `ppro setup`";
      } else if (health.plugin.version === null) {
        skew = "  ← no handshake: an old/foreign panel is connected, unload it";
      }
      process.stdout.write(`  plugin   connected, v${health.plugin.version ?? "?"}${skew}\n`);
      if (health.plugin.helloError) {
        process.stdout.write(`           ✗ plugin internal error: ${health.plugin.helloError}\n`);
      }
    } else {
      process.stdout.write(
        "  plugin   not connected\n           → open Premiere Pro with the Premiere Pro Agent panel loaded\n",
      );
    }
    if (project) {
      if (project.open) {
        process.stdout.write(`  project  ${project.name} (${sanitizePath(project.path ?? "")})\n`);
        process.stdout.write(
          `  active   ${project.activeSequence?.name ?? "no active sequence"} — ${project.sequenceCount} sequence(s) total\n`,
        );
      } else {
        process.stdout.write("  project  none open\n");
      }
    }
    if (pluginError) {
      process.stdout.write(`  error    ${pluginError}\n`);
    }
  }

  if (!health.plugin.connected || pluginError) {
    return EXIT.NO_CONNECTION;
  }
  return EXIT.OK;
}

export const status: Command = {
  name: "status",
  summary: "Show daemon, plugin, and open project state",
  run: runStatus,
};
