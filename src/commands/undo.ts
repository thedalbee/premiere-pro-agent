import { execFile } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import * as readline from "node:readline/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { parseArgs, promisify } from "node:util";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import { callPremiere, daemonHealth, type DaemonHealth } from "../premiere/client.js";
import { listCheckpoints } from "../premiere/checkpoint.js";

const run = promisify(execFile);

const PREMIERE_APP_NAME = "Adobe Premiere Pro";
const PREMIERE_PROCESS_PATTERN = "Adobe Premiere Pro";
const PREMIERE_QUIT_TIMEOUT_MS = 30_000;
const PLUGIN_RECONNECT_TIMEOUT_MS = 60_000;
const POLL_MS = 500;

interface ProjectInfo {
  open: boolean;
  name?: string;
  path?: string;
  sequenceCount?: number;
  activeSequence?: { name: string } | null;
}

interface StatusReport {
  daemon: DaemonHealth["daemon"] | null;
  plugin: DaemonHealth["plugin"] | null;
  project: ProjectInfo | null;
}

function latestCheckpoint(projectPath: string): string | null {
  const checkpoints = listCheckpoints(projectPath);
  return checkpoints.length > 0 ? checkpoints[checkpoints.length - 1] : null;
}

function timestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z");
}

/** Exported for testing: computes the path the current project would be moved to on undo. */
export function undonePathFor(projectPath: string): string {
  const dir = path.dirname(projectPath);
  const base = `undone-${timestamp()}`;
  let candidate = path.join(dir, `${base}.prproj`);
  let i = 2;
  while (fs.existsSync(candidate)) {
    candidate = path.join(dir, `${base}-${i}.prproj`);
    i += 1;
  }
  return candidate;
}

export interface UndoDryRunPreview {
  dryRun: true;
  projectPath: string;
  checkpointPath: string;
  undonePath: string;
}

/**
 * Exported for testing: computes the undo dry-run preview without touching any file.
 * Validates that both project and checkpoint files exist before returning.
 */
export function buildUndoDryRunPreview(
  projectPath: string,
  checkpointPath: string,
): UndoDryRunPreview {
  return {
    dryRun: true,
    projectPath,
    checkpointPath,
    undonePath: undonePathFor(projectPath),
  };
}

async function confirmUndo(projectPath: string, checkpointPath: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({
    input: process.stdin,
    output: process.stderr,
  });
  try {
    const answer = await rl.question(
      [
        `Premiere will restart and restore this checkpoint:`,
        `  project:    ${sanitizePath(projectPath)}`,
        `  checkpoint: ${sanitizePath(checkpointPath)}`,
        "Continue? Type yes to proceed: ",
      ].join("\n"),
    );
    return answer.trim().toLowerCase() === "yes";
  } finally {
    rl.close();
  }
}

async function premiereIsRunning(): Promise<boolean> {
  try {
    await run("pgrep", ["-f", PREMIERE_PROCESS_PATTERN]);
    return true;
  } catch {
    return false;
  }
}

async function quitPremiere(): Promise<void> {
  await run("osascript", ["-e", `tell application "${PREMIERE_APP_NAME}" to quit`]);
}

async function waitForPremiereExit(timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await premiereIsRunning())) return true;
    await sleep(POLL_MS);
  }
  return !(await premiereIsRunning());
}

async function openProject(projectPath: string): Promise<void> {
  await run("open", [projectPath]);
}

async function waitForStatus(projectPath: string, timeoutMs: number): Promise<StatusReport & { reconnected: boolean }> {
  const deadline = Date.now() + timeoutMs;
  let last: StatusReport = { daemon: null, plugin: null, project: null };

  while (Date.now() < deadline) {
    await sleep(POLL_MS);
    const health = await daemonHealth();
    if (!health || health === "foreign") {
      continue;
    }

    last = { daemon: health.daemon, plugin: health.plugin, project: null };
    if (!health.plugin.connected) {
      continue;
    }

    try {
      const project = (await callPremiere("project.info", {}, 5_000)) as ProjectInfo;
      last = { daemon: health.daemon, plugin: health.plugin, project };
      if (project.open && project.path && path.resolve(project.path) === path.resolve(projectPath)) {
        return { ...last, reconnected: true };
      }
    } catch {
      // Premiere may still be launching or the panel may still be reconnecting.
    }
  }

  return { ...last, reconnected: false };
}

async function runUndo(argv: string[]): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: {
      json: { type: "boolean", default: false },
      yes: { type: "boolean", short: "y", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const info = (await callPremiere("project.info", {}, 5_000)) as ProjectInfo;
  if (!info.open || !info.path) {
    const msg = "ppro undo: no project open — cannot find the active project";
    if (values.json) printJson({ ok: false, error: msg });
    else note(msg);
    return EXIT.FAILED;
  }

  const projectPath = info.path;
  const checkpointPath = latestCheckpoint(projectPath);
  if (!checkpointPath) {
    const msg = `ppro undo: no checkpoints found for ${sanitizePath(projectPath)}`;
    if (values.json) printJson({ ok: false, error: msg, projectPath });
    else note(msg);
    return EXIT.USAGE;
  }
  if (!fs.existsSync(projectPath)) {
    const msg = `ppro undo: project file not found: ${sanitizePath(projectPath)}`;
    if (values.json) printJson({ ok: false, error: msg, projectPath, checkpointPath });
    else note(msg);
    return EXIT.USAGE;
  }
  if (!fs.existsSync(checkpointPath)) {
    const msg = `ppro undo: checkpoint file not found: ${sanitizePath(checkpointPath)}`;
    if (values.json) printJson({ ok: false, error: msg, projectPath, checkpointPath });
    else note(msg);
    return EXIT.USAGE;
  }

  // Compute the undone path (read-only, uses timestamp + collision avoidance)
  const undonePath = undonePathFor(projectPath);

  // ── dry-run: print plan without saving, quitting, or moving any file ──────
  if (values["dry-run"]) {
    const preview = {
      dryRun: true,
      projectPath,
      checkpointPath,
      undonePath,
    };
    if (values.json) {
      printJson(preview);
    } else {
      process.stdout.write(
        `[dry-run] would restore checkpoint — no files moved, Premiere not restarted\n` +
          `  project:    ${sanitizePath(projectPath)}\n` +
          `  checkpoint: ${sanitizePath(checkpointPath)}\n` +
          `  would move current project → ${sanitizePath(undonePath)}\n`,
      );
    }
    return EXIT.OK;
  }

  if (!values.yes) {
    const confirmed = await confirmUndo(projectPath, checkpointPath);
    if (!confirmed) {
      const msg = "ppro undo: cancelled";
      if (values.json) printJson({ ok: false, cancelled: true, error: msg, projectPath, checkpointPath });
      else note(msg);
      return EXIT.USAGE;
    }
  }

  note("saving project before restart...");
  await callPremiere("project.save", {}, 10_000);

  note("quitting Premiere Pro...");
  await quitPremiere();
  const exited = await waitForPremiereExit(PREMIERE_QUIT_TIMEOUT_MS);
  if (!exited) {
    const msg = "Premiere Pro did not exit within 30s — aborting before touching the project file";
    if (values.json) printJson({ ok: false, error: msg, projectPath, checkpointPath });
    else note(`ppro undo: ${msg}`);
    return EXIT.FAILED;
  }

  const restoreTempPath = `${projectPath}.undo-restore-tmp`;
  note(`moving current project aside → ${sanitizePath(undonePath)}`);
  fs.renameSync(projectPath, undonePath);
  try {
    fs.rmSync(restoreTempPath, { force: true });
    fs.copyFileSync(checkpointPath, restoreTempPath);
    fs.renameSync(restoreTempPath, projectPath);
  } catch (error) {
    fs.rmSync(restoreTempPath, { force: true });
    if (!fs.existsSync(projectPath) && fs.existsSync(undonePath)) {
      fs.renameSync(undonePath, projectPath);
    }
    throw error;
  }

  note(`restored checkpoint → ${sanitizePath(projectPath)}`);
  note("reopening project...");
  await openProject(projectPath);

  note("waiting for plugin reconnect...");
  const status = await waitForStatus(projectPath, PLUGIN_RECONNECT_TIMEOUT_MS);
  if (!status.reconnected) {
    note("WARNING: plugin did not reconnect to the restored project within 60s.");
  } else {
    note("plugin reconnected.");
  }

  const result = {
    ok: status.reconnected,
    projectPath,
    checkpointPath,
    undonePath,
    status: {
      daemon: status.daemon,
      plugin: status.plugin,
      project: status.project,
    },
  };

  if (values.json) {
    printJson(result);
  } else {
    process.stdout.write(
      [
        `restored ${sanitizePath(projectPath)}`,
        `checkpoint: ${sanitizePath(checkpointPath)}`,
        `undo backup: ${sanitizePath(undonePath)}`,
        status.project?.open
          ? `status: ${status.project.name ?? "project"} open, active sequence ${status.project.activeSequence?.name ?? "none"}`
          : "status: plugin/project status not confirmed",
        "",
      ].join("\n"),
    );
  }

  return status.reconnected ? EXIT.OK : EXIT.NO_CONNECTION;
}

export const undo: Command = {
  name: "undo",
  summary: "Restore the active project from its latest checkpoint (--dry-run to preview without restarting)",
  run: runUndo,
};
