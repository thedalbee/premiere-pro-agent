import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import net from "node:net";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { sanitizePath, printJson } from "../output/print.js";
import {
  IS_WINDOWS,
  isSupportedPlatform,
  premiereSearchDirs,
  whichCommand,
} from "../platform.js";

const run = promisify(execFile);

type Status = "ok" | "info" | "fail";

interface Check {
  name: string;
  status: Status;
  detail: string;
  hint?: string;
}

async function checkPlatform(): Promise<Check> {
  if (!isSupportedPlatform()) {
    return {
      name: "platform",
      status: "fail",
      detail: `unsupported platform: ${process.platform}`,
      hint: "ppro supports macOS and Windows (experimental).",
    };
  }
  const label = IS_WINDOWS ? "Windows (experimental)" : "macOS";
  return { name: label, status: "ok", detail: `${os.release()} (${os.arch()})` };
}

function findPremiereApp(): string | null {
  let entries: string[];
  try {
    entries = fs.readdirSync("/Applications");
  } catch {
    return null;
  }
  const candidates = entries.filter((name) => name.startsWith("Adobe Premiere Pro"));
  if (candidates.length === 0) return null;
  candidates.sort();
  const dir = candidates[candidates.length - 1];
  const app = fs
    .readdirSync(path.join("/Applications", dir))
    .find((name) => name.endsWith(".app"));
  return app ? path.join("/Applications", dir, app) : null;
}

async function checkPremiere(): Promise<Check> {
  const app = findPremiereApp();
  if (!app) {
    return {
      name: "Premiere Pro",
      status: "fail",
      detail: "not found in /Applications",
      hint: "Install Adobe Premiere Pro 25.6 or newer.",
    };
  }
  let version = "unknown version";
  try {
    const { stdout } = await run("plutil", [
      "-extract",
      "CFBundleShortVersionString",
      "raw",
      path.join(app, "Contents", "Info.plist"),
    ]);
    version = stdout.trim();
  } catch {
    // version stays unknown; presence of the app is the main signal
  }
  let running = false;
  try {
    await run("pgrep", ["-f", "Adobe Premiere Pro"]);
    running = true;
  } catch {
    running = false;
  }
  return {
    name: "Premiere Pro",
    status: "ok",
    detail: `${version} — ${running ? "running" : "not running"}`,
    hint: running ? undefined : "Open your project in Premiere before running edit commands.",
  };
}

// EXPERIMENTAL (unverified on real Windows): discover Premiere under Program Files\Adobe.
function findPremiereExeWindows(): string | null {
  for (const base of premiereSearchDirs("win32")) {
    let entries: string[];
    try {
      entries = fs.readdirSync(base);
    } catch {
      continue;
    }
    const candidates = entries.filter((n) => n.startsWith("Adobe Premiere Pro")).sort().reverse();
    for (const dir of candidates) {
      const exe = path.join(base, dir, "Adobe Premiere Pro.exe");
      if (fs.existsSync(exe)) return exe;
    }
  }
  return null;
}

async function checkPremiereWindows(): Promise<Check> {
  const exe = findPremiereExeWindows();
  if (!exe) {
    return {
      name: "Premiere Pro",
      status: "fail",
      detail: "not found under Program Files\\Adobe",
      hint: "Install Adobe Premiere Pro 25.6 or newer.",
    };
  }
  let running = false;
  try {
    const { stdout } = await run("tasklist", ["/FI", "IMAGENAME eq Adobe Premiere Pro.exe"]);
    running = stdout.includes("Adobe Premiere Pro.exe");
  } catch {
    running = false;
  }
  return {
    name: "Premiere Pro",
    status: "ok",
    detail: `found — ${running ? "running" : "not running"} (experimental)`,
    hint: running ? undefined : "Open your project in Premiere before running edit commands.",
  };
}

function checkPort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.connect({ port, host: "127.0.0.1" });
    const done = (listening: boolean) => {
      socket.destroy();
      resolve(listening);
    };
    socket.setTimeout(500);
    socket.once("connect", () => done(true));
    socket.once("timeout", () => done(false));
    socket.once("error", () => done(false));
  });
}

async function checkBridge(): Promise<Check> {
  const listening = await checkPort(7300);
  return {
    name: "bridge",
    status: "info",
    detail: listening
      ? "port 7300 is in use (plugin bridge or another process)"
      : "port 7300 not in use (daemon auto-starts when needed)",
  };
}

async function checkFfmpeg(): Promise<Check> {
  try {
    const { stdout: located } = await run(whichCommand(), ["ffmpeg"]);
    const { stdout } = await run("ffmpeg", ["-version"]);
    const firstLine = stdout.split("\n")[0].replace("ffmpeg version ", "");
    const ffmpegPath = located.split("\n")[0].trim(); // `where` can list several
    return {
      name: "ffmpeg",
      status: "ok",
      detail: `${firstLine.split(" ")[0]} (${sanitizePath(ffmpegPath)})`,
    };
  } catch {
    return {
      name: "ffmpeg",
      status: "fail",
      detail: "not found",
      hint: IS_WINDOWS
        ? "Install ffmpeg (e.g. winget install Gyan.FFmpeg) and ensure it is on PATH."
        : "Install with: brew install ffmpeg",
    };
  }
}

async function checkWhisper(): Promise<Check> {
  if (IS_WINDOWS) {
    // mlx is Apple-Silicon only. Transcription is intentionally macOS-only;
    // on Windows you bring your own transcript, so this is informational, not a failure.
    return {
      name: "whisper",
      status: "info",
      detail: "local transcription (mlx) is macOS-only — provide your own transcript on Windows",
    };
  }
  const python = process.env.PPRO_PYTHON ?? "python3";
  try {
    await run(python, [
      "-c",
      "import importlib.util, sys; sys.exit(0 if importlib.util.find_spec('mlx_whisper') else 1)",
    ]);
    return {
      name: "whisper",
      status: "ok",
      detail: `mlx_whisper available (${sanitizePath(python)})`,
    };
  } catch {
    return {
      name: "whisper",
      status: "fail",
      detail: `mlx_whisper not importable via ${sanitizePath(python)}`,
      hint: "Install with: pip install mlx-whisper (or set PPRO_PYTHON to a Python that has it)",
    };
  }
}

const SYMBOL: Record<Status, string> = { ok: "✓", info: "○", fail: "✗" };

async function runDoctor(argv: string[]): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  const checks: Check[] = [
    await checkPlatform(),
    IS_WINDOWS ? await checkPremiereWindows() : await checkPremiere(),
    await checkBridge(),
    await checkFfmpeg(),
    await checkWhisper(),
  ];

  const failed = checks.filter((c) => c.status === "fail");
  const ok = failed.length === 0;

  if (values.json) {
    printJson({ ok, checks });
  } else {
    process.stdout.write("ppro doctor — environment check\n\n");
    const width = Math.max(...checks.map((c) => c.name.length));
    for (const check of checks) {
      process.stdout.write(
        `  ${SYMBOL[check.status]} ${check.name.padEnd(width + 2)}${check.detail}\n`,
      );
      if (check.hint) {
        process.stdout.write(`    ${" ".repeat(width + 2)}→ ${check.hint}\n`);
      }
    }
    process.stdout.write(
      `\n${checks.length} checks: ${checks.length - failed.length} passed, ${failed.length} failed\n`,
    );
  }

  return ok ? EXIT.OK : EXIT.MISSING_DEPENDENCY;
}

export const doctor: Command = {
  name: "doctor",
  summary: "Check the environment: Premiere Pro, plugin bridge, ffmpeg, whisper",
  run: runDoctor,
};
