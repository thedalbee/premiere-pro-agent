import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  planCleanup,
  formatBytes,
  dirSizeBytes,
  cleanupCategories,
  scanCleanup,
  runCleanupWith,
} from "../dist/commands/cleanup.js";

const KNOWN = ["whisper", "checkpoints", "media-cache"];

// ── planCleanup: the consent gate (the whole point of T10) ──────────────────

test("planCleanup: no --yes => report only, deletes nothing", () => {
  const p = planCleanup({ yes: false, all: false, categories: ["whisper"], knownIds: KNOWN });
  assert.equal(p.reportOnly, true);
  assert.deepEqual(p.toDelete, []);
});

test("planCleanup: --yes with NO category and NO --all => still deletes nothing", () => {
  const p = planCleanup({ yes: true, all: false, categories: [], knownIds: KNOWN });
  assert.equal(p.authorized, false);
  assert.equal(p.reportOnly, true);
  assert.deepEqual(p.toDelete, []);
});

test("planCleanup: --yes --all => deletes every known category", () => {
  const p = planCleanup({ yes: true, all: true, categories: [], knownIds: KNOWN });
  assert.equal(p.authorized, true);
  assert.deepEqual(p.toDelete, KNOWN);
});

test("planCleanup: --yes with explicit categories => only those", () => {
  const p = planCleanup({ yes: true, all: false, categories: ["checkpoints"], knownIds: KNOWN });
  assert.deepEqual(p.toDelete, ["checkpoints"]);
});

test("planCleanup: unknown category => not authorized, nothing deleted", () => {
  const p = planCleanup({ yes: true, all: false, categories: ["bogus"], knownIds: KNOWN });
  assert.deepEqual(p.unknown, ["bogus"]);
  assert.equal(p.authorized, false);
  assert.deepEqual(p.toDelete, []);
});

// ── formatBytes ─────────────────────────────────────────────────────────────

test("formatBytes: scales B/KB/MB/GB", () => {
  assert.equal(formatBytes(0), "0 B");
  assert.equal(formatBytes(1023), "1023 B");
  assert.equal(formatBytes(1024), "1.0 KB");
  assert.equal(formatBytes(1024 * 1024), "1.0 MB");
  assert.equal(formatBytes(1.5 * 1024 * 1024 * 1024), "1.5 GB");
});

// ── dirSizeBytes ────────────────────────────────────────────────────────────

test("dirSizeBytes: sums files recursively; missing dir = 0", () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ppro-clean-size-"));
  try {
    fs.writeFileSync(path.join(root, "a.bin"), Buffer.alloc(100));
    fs.mkdirSync(path.join(root, "sub"));
    fs.writeFileSync(path.join(root, "sub", "b.bin"), Buffer.alloc(50));
    assert.equal(dirSizeBytes(root), 150);
    assert.equal(dirSizeBytes(path.join(root, "does-not-exist")), 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── cleanupCategories: path resolution per platform ─────────────────────────

test("cleanupCategories: darwin media cache under Library/Application Support", () => {
  const cats = cleanupCategories({ homedir: "/Users/x", platform: "darwin", env: {} });
  const media = cats.find((c) => c.id === "media-cache");
  assert.ok(media.paths.some((p) => p.includes("Library/Application Support/Adobe/Common/Media Cache")));
  const cp = cats.find((c) => c.id === "checkpoints");
  assert.deepEqual(cp.paths, ["/Users/x/.ppro/checkpoints"]);
});

test("cleanupCategories: win32 media cache under APPDATA", () => {
  const cats = cleanupCategories({
    homedir: "C:\\Users\\x",
    platform: "win32",
    env: { APPDATA: "C:\\Users\\x\\AppData\\Roaming" },
  });
  const media = cats.find((c) => c.id === "media-cache");
  assert.ok(media.paths.some((p) => p.includes("Adobe") && p.includes("Media Cache")));
});

// ── Integration: scan + the no-delete guarantee on a temp home ──────────────

function makeFakeHome() {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "ppro-clean-home-"));
  // checkpoints
  const cp = path.join(home, ".ppro", "checkpoints", "Proj");
  fs.mkdirSync(cp, { recursive: true });
  fs.writeFileSync(path.join(cp, "snap.prproj"), Buffer.alloc(200));
  // whisper model dir (default HF hub layout)
  const model = "mlx-community/whisper-large-v3-turbo".replace(/\//g, "--");
  const whisper = path.join(home, ".cache", "huggingface", "hub", "models--" + model);
  fs.mkdirSync(whisper, { recursive: true });
  fs.writeFileSync(path.join(whisper, "weights.bin"), Buffer.alloc(300));
  // media cache (darwin)
  const media = path.join(home, "Library", "Application Support", "Adobe", "Common", "Media Cache Files");
  fs.mkdirSync(media, { recursive: true });
  fs.writeFileSync(path.join(media, "x.cfa"), Buffer.alloc(80));
  return { home, cp, whisper, media };
}

const NOOP = () => {};

test("runCleanupWith: bare invocation reports sizes and deletes NOTHING", async () => {
  const { home, cp, whisper, media } = makeFakeHome();
  try {
    const ctx = { homedir: home, platform: "darwin", env: {} };
    const res = await runCleanupWith([], ctx, NOOP);
    assert.equal(res.reportOnly, true);
    assert.equal(res.deleted.length, 0);
    // every cache still present
    assert.ok(fs.existsSync(cp));
    assert.ok(fs.existsSync(whisper));
    assert.ok(fs.existsSync(media));
    // sizes were measured
    const total = res.reports.reduce((s, r) => s + r.sizeBytes, 0);
    assert.equal(total, 200 + 300 + 80);
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runCleanupWith: --yes with NO category deletes NOTHING (safety)", async () => {
  const { home, cp, whisper, media } = makeFakeHome();
  try {
    const ctx = { homedir: home, platform: "darwin", env: {} };
    const res = await runCleanupWith(["--yes"], ctx, NOOP);
    assert.equal(res.reportOnly, true);
    assert.equal(res.deleted.length, 0);
    assert.ok(fs.existsSync(cp));
    assert.ok(fs.existsSync(whisper));
    assert.ok(fs.existsSync(media));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runCleanupWith: --dry-run never deletes even with --all", async () => {
  const { home, cp, whisper, media } = makeFakeHome();
  try {
    const ctx = { homedir: home, platform: "darwin", env: {} };
    const res = await runCleanupWith(["--all", "--yes", "--dry-run"], ctx, NOOP);
    assert.equal(res.reportOnly, true);
    assert.equal(res.deleted.length, 0);
    assert.ok(fs.existsSync(cp));
    assert.ok(fs.existsSync(whisper));
    assert.ok(fs.existsSync(media));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runCleanupWith: --yes checkpoints deletes ONLY checkpoints", async () => {
  const { home, cp, whisper, media } = makeFakeHome();
  try {
    const ctx = { homedir: home, platform: "darwin", env: {} };
    const res = await runCleanupWith(["--yes", "checkpoints"], ctx, NOOP);
    assert.equal(res.reportOnly, false);
    assert.ok(res.deleted.some((d) => d.id === "checkpoints" && d.ok));
    assert.ok(!fs.existsSync(path.join(home, ".ppro", "checkpoints")));
    // others untouched
    assert.ok(fs.existsSync(whisper));
    assert.ok(fs.existsSync(media));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runCleanupWith: --yes --all deletes all three categories", async () => {
  const { home, cp, whisper, media } = makeFakeHome();
  try {
    const ctx = { homedir: home, platform: "darwin", env: {} };
    const res = await runCleanupWith(["--yes", "--all"], ctx, NOOP);
    assert.equal(res.reportOnly, false);
    assert.ok(!fs.existsSync(path.join(home, ".ppro", "checkpoints")));
    assert.ok(!fs.existsSync(whisper));
    assert.ok(!fs.existsSync(media));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});

test("runCleanupWith: unknown category returns USAGE and deletes nothing", async () => {
  const { home, cp } = makeFakeHome();
  try {
    const ctx = { homedir: home, platform: "darwin", env: {} };
    const res = await runCleanupWith(["--yes", "bogus"], ctx, NOOP);
    assert.equal(res.exitCode, 2); // EXIT.USAGE
    assert.equal(res.deleted.length, 0);
    assert.ok(fs.existsSync(cp));
  } finally {
    fs.rmSync(home, { recursive: true, force: true });
  }
});
