import { parseArgs } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import { WHISPER_MODEL } from "../transcription/whisper.js";

// `cleanup` reports reclaimable caches and only ever deletes when the user gives
// explicit consent: `--yes` PLUS category names (or `--all`). `--yes` alone
// deletes nothing — these caches are expensive to lose (model re-download,
// undo-history loss, media re-conform), so blanket deletion is by design
// impossible. Ephemeral temp (transcription WAV, setup .ccx, undo temp) is NOT a
// cleanup target — it is managed at its own call sites.

export interface CleanupEnv {
  homedir: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
}

export interface CleanupCategory {
  id: string;
  label: string;
  cost: string;
  paths: string[];
}

// Whisper/HF model dir, resolved from ctx (env override, else ctx.homedir). Mirrors
// transcription/whisper.huggingfaceModelDir but honors ctx.homedir so cleanup is
// fully injectable — a test must never resolve to the real ~/.cache and delete it.
function whisperModelPath(ctx: CleanupEnv): string {
  const cacheRoot =
    ctx.env.HUGGINGFACE_HUB_CACHE ??
    (ctx.env.HF_HOME
      ? path.join(ctx.env.HF_HOME, "hub")
      : path.join(ctx.homedir, ".cache", "huggingface", "hub"));
  return path.join(cacheRoot, "models--" + WHISPER_MODEL.replace(/\//g, "--"));
}

function mediaCachePaths(ctx: CleanupEnv): string[] {
  if (ctx.platform === "win32") {
    const appData = ctx.env.APPDATA ?? path.join(ctx.homedir, "AppData", "Roaming");
    const base = path.join(appData, "Adobe", "Common");
    return [path.join(base, "Media Cache Files"), path.join(base, "Media Cache")];
  }
  // darwin (and any non-Windows default)
  const base = path.join(ctx.homedir, "Library", "Application Support", "Adobe", "Common");
  return [path.join(base, "Media Cache Files"), path.join(base, "Media Cache")];
}

export function cleanupCategories(ctx: CleanupEnv): CleanupCategory[] {
  return [
    {
      id: "whisper",
      label: "Whisper model cache",
      cost: "re-downloaded (~1.5GB) on the next transcribe",
      // Only this project's model dir — never the whole HF hub (may hold the
      // user's other, unrelated models).
      paths: [whisperModelPath(ctx)],
    },
    {
      id: "checkpoints",
      label: "Project checkpoints / .prproj snapshots",
      cost: "undo history and project snapshots are lost",
      paths: [path.join(ctx.homedir, ".ppro", "checkpoints")],
    },
    {
      id: "media-cache",
      label: "Premiere media cache",
      cost: "Premiere re-conforms media on next open (slower first load)",
      paths: mediaCachePaths(ctx),
    },
  ];
}

/** Recursive on-disk size in bytes. Missing/unreadable dirs count as 0; symlinks
 * are not followed (counted as neither file nor dir) so we never escape the tree. */
export function dirSizeBytes(dir: string): number {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return 0;
  }
  let total = 0;
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      total += dirSizeBytes(full);
    } else if (entry.isFile()) {
      try {
        total += fs.statSync(full).size;
      } catch {
        /* skip unreadable file */
      }
    }
  }
  return total;
}

export function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  const units = ["KB", "MB", "GB", "TB"];
  let value = n / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}

export interface PathReport {
  path: string;
  exists: boolean;
  sizeBytes: number;
}
export interface CategoryReport {
  id: string;
  label: string;
  cost: string;
  paths: PathReport[];
  sizeBytes: number;
}

export function scanCleanup(ctx: CleanupEnv): CategoryReport[] {
  return cleanupCategories(ctx).map((c) => {
    const paths: PathReport[] = c.paths.map((p) => {
      const exists = fs.existsSync(p);
      return { path: p, exists, sizeBytes: exists ? dirSizeBytes(p) : 0 };
    });
    return {
      id: c.id,
      label: c.label,
      cost: c.cost,
      paths,
      sizeBytes: paths.reduce((s, p) => s + p.sizeBytes, 0),
    };
  });
}

export interface CleanupPlan {
  authorized: boolean;
  selected: string[];
  unknown: string[];
  toDelete: string[];
  reportOnly: boolean;
}

/** Pure consent gate. Deletion requires `--yes` AND a non-empty, fully-known
 * selection (explicit ids or `--all`). Anything else => report only, delete nothing. */
export function planCleanup(args: {
  yes: boolean;
  all: boolean;
  categories: string[];
  knownIds: string[];
}): CleanupPlan {
  const unknown = args.categories.filter((c) => !args.knownIds.includes(c));
  const selected = args.all
    ? [...args.knownIds]
    : args.categories.filter((c) => args.knownIds.includes(c));
  const authorized = args.yes && selected.length > 0 && unknown.length === 0;
  const toDelete = authorized ? selected : [];
  return { authorized, selected, unknown, toDelete, reportOnly: toDelete.length === 0 };
}

export interface DeletionResult {
  id: string;
  path: string;
  ok: boolean;
  error?: string;
}

export interface CleanupRunResult {
  exitCode: ExitCode;
  reportOnly: boolean;
  plan: CleanupPlan;
  reports: CategoryReport[];
  deleted: DeletionResult[];
}

type Writer = (s: string) => void;

export async function runCleanupWith(
  argv: string[],
  ctx: CleanupEnv,
  out: Writer = (s) => process.stdout.write(s),
): Promise<CleanupRunResult> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      yes: { type: "boolean", default: false },
      all: { type: "boolean", default: false },
      "dry-run": { type: "boolean", default: false },
    },
  });

  const reports = scanCleanup(ctx);
  const knownIds = reports.map((r) => r.id);
  const dryRun = Boolean(values["dry-run"]);
  const plan = planCleanup({
    // --dry-run hard-forces report-only by withholding authorization.
    yes: Boolean(values.yes) && !dryRun,
    all: Boolean(values.all),
    categories: positionals,
    knownIds,
  });

  if (plan.unknown.length > 0) {
    note(
      `ppro cleanup: unknown categor${plan.unknown.length > 1 ? "ies" : "y"}: ${plan.unknown.join(", ")}`,
    );
    note(`known categories: ${knownIds.join(", ")} (or --all)`);
    if (values.json) {
      printJson({ ok: false, error: "unknown_category", unknown: plan.unknown, known: knownIds });
    }
    return { exitCode: EXIT.USAGE, reportOnly: true, plan, reports, deleted: [] };
  }

  const deleted: DeletionResult[] = [];
  if (!plan.reportOnly) {
    for (const id of plan.toDelete) {
      const cat = reports.find((r) => r.id === id);
      if (!cat) continue;
      for (const p of cat.paths) {
        if (!p.exists) continue;
        try {
          fs.rmSync(p.path, { recursive: true, force: true });
          deleted.push({ id, path: p.path, ok: true });
        } catch (err) {
          deleted.push({ id, path: p.path, ok: false, error: String(err) });
        }
      }
    }
  }

  if (values.json) {
    printJson({
      ok: true,
      reportOnly: plan.reportOnly,
      categories: reports.map((r) => ({
        id: r.id,
        label: r.label,
        cost: r.cost,
        sizeBytes: r.sizeBytes,
        paths: r.paths.map((p) => ({
          path: sanitizePath(p.path),
          exists: p.exists,
          sizeBytes: p.sizeBytes,
        })),
      })),
      deleted: deleted.map((d) => ({ ...d, path: sanitizePath(d.path) })),
    });
    return { exitCode: EXIT.OK, reportOnly: plan.reportOnly, plan, reports, deleted };
  }

  out("ppro cleanup — protected caches (nothing is deleted without consent)\n\n");
  for (const r of reports) {
    out(`  ${r.id.padEnd(13)} ${formatBytes(r.sizeBytes).padStart(9)}  ${r.label}\n`);
    out(`  ${" ".repeat(23)}  cost if removed: ${r.cost}\n`);
    for (const p of r.paths) {
      out(`  ${" ".repeat(23)}  ${p.exists ? "" : "(absent) "}${sanitizePath(p.path)}\n`);
    }
    out("\n");
  }

  if (plan.reportOnly) {
    const total = reports.reduce((s, r) => s + r.sizeBytes, 0);
    out(`Total reclaimable: ${formatBytes(total)}\n`);
    out("Nothing was deleted. To remove, re-run with --yes and category names, e.g.:\n");
    out("  ppro cleanup --yes checkpoints media-cache    (or --yes --all)\n");
  } else {
    const okCount = deleted.filter((d) => d.ok).length;
    out(`Deleted ${okCount} path(s) for: ${plan.toDelete.join(", ")}\n`);
    for (const d of deleted.filter((x) => !x.ok)) {
      out(`  failed: ${sanitizePath(d.path)} (${d.error})\n`);
    }
  }
  return { exitCode: EXIT.OK, reportOnly: plan.reportOnly, plan, reports, deleted };
}

async function runCleanup(argv: string[]): Promise<ExitCode> {
  const ctx: CleanupEnv = {
    homedir: os.homedir(),
    platform: process.platform,
    env: process.env,
  };
  const result = await runCleanupWith(argv, ctx);
  return result.exitCode;
}

export const cleanup: Command = {
  name: "cleanup",
  summary: "Report reclaimable caches; delete only with --yes + category names",
  run: runCleanup,
};
