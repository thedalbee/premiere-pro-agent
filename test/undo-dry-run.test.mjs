/**
 * undo-dry-run.test.mjs
 *
 * Proves that `ppro undo --dry-run` does NOT move the project file, does NOT
 * create an undone-* file, and emits a well-structured preview object.
 *
 * Tests call the exported buildUndoDryRunPreview helper directly — no
 * callPremiere or Premiere connection required.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const { buildUndoDryRunPreview, undonePathFor } = await import("../dist/commands/undo.js");

// ── Pure unit tests (always run) ────────────────────────────────────────────

test("buildUndoDryRunPreview: dryRun field is true", () => {
  const preview = buildUndoDryRunPreview("/tmp/proj.prproj", "/tmp/proj.prproj.checkpoint-1");
  assert.equal(preview.dryRun, true);
});

test("buildUndoDryRunPreview: returns correct projectPath and checkpointPath", () => {
  const projectPath = "/tmp/my-project.prproj";
  const checkpointPath = "/tmp/my-project.prproj.checkpoint-42";
  const preview = buildUndoDryRunPreview(projectPath, checkpointPath);
  assert.equal(preview.projectPath, projectPath);
  assert.equal(preview.checkpointPath, checkpointPath);
});

test("buildUndoDryRunPreview: undonePath matches undone-<ts> pattern in same dir", () => {
  const projectPath = "/tmp/some-dir/project.prproj";
  const preview = buildUndoDryRunPreview(projectPath, "/tmp/some-dir/project.prproj.checkpoint-1");
  const dir = path.dirname(projectPath);
  assert.ok(
    preview.undonePath.startsWith(path.join(dir, "undone-")),
    `undonePath "${preview.undonePath}" should start with "${path.join(dir, "undone-")}"`,
  );
  assert.ok(preview.undonePath.endsWith(".prproj"), "undonePath should end with .prproj");
});

// ── File-system integration: dry-run must NOT touch any file ─────────────────

test("undo --dry-run: no file is created or moved in the project directory", async (t) => {
  // Create a temp dir with a fake project file and a fake checkpoint
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "undo-dryrun-"));
  const projectPath = path.join(tmpDir, "my-project.prproj");
  const checkpointPath = path.join(tmpDir, "my-project.prproj.checkpoint-1");
  const origContent = "fake prproj content";
  fs.writeFileSync(projectPath, origContent);
  fs.writeFileSync(checkpointPath, "fake checkpoint content");

  t.after(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  // Capture directory listing before dry-run
  const before = fs.readdirSync(tmpDir).sort();

  // Execute the dry-run preview (pure computation — no fs writes)
  const preview = buildUndoDryRunPreview(projectPath, checkpointPath);

  // Verify shape
  assert.equal(preview.dryRun, true);
  assert.equal(preview.projectPath, projectPath);
  assert.equal(preview.checkpointPath, checkpointPath);
  assert.ok(preview.undonePath.includes("undone-"), "undonePath should contain 'undone-'");

  // CRITICAL: directory listing must be identical (nothing created or moved)
  const after = fs.readdirSync(tmpDir).sort();
  assert.deepEqual(after, before, "no files should be created or removed in dry-run");

  // CRITICAL: project file must be byte-identical
  const afterContent = fs.readFileSync(projectPath, "utf8");
  assert.equal(afterContent, origContent, "project file must not be modified");

  // CRITICAL: no undone-* file created
  const undoneFiles = fs.readdirSync(tmpDir).filter((f) => f.startsWith("undone-"));
  assert.equal(undoneFiles.length, 0, "no undone-* file should be created by dry-run");
});

test("undonePathFor: collision avoidance appends -N suffix", () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "undone-collision-"));
  try {
    const projectPath = path.join(tmpDir, "proj.prproj");
    // Pre-create the first candidate so collision avoidance kicks in
    const firstPath = undonePathFor(projectPath);
    fs.writeFileSync(firstPath, "");
    const secondPath = undonePathFor(projectPath);
    assert.notEqual(secondPath, firstPath, "second path should differ from first");
    assert.ok(secondPath.includes("-2"), "second path should have -2 suffix");
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("buildUndoDryRunPreview: does not throw when paths are strings (no fs access)", () => {
  // Paths don't need to exist — preview is pure computation
  assert.doesNotThrow(() => {
    buildUndoDryRunPreview(
      "/nonexistent/project.prproj",
      "/nonexistent/project.prproj.checkpoint-99",
    );
  });
});
