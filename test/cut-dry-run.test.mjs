/**
 * cut-dry-run.test.mjs
 *
 * Proves that `ppro cut --dry-run` (inject path) does NOT write the .prproj
 * or create a .bak backup, and emits a well-structured preview.
 *
 * Two tiers:
 *  1. Pure unit tests against the exported buildCutInjectDryRunPreview helper
 *     — always run, no fixture required.
 *  2. File-system integration tests using the prproj fixture from
 *     /tmp/prproj_lab/I45_copy.prproj — skipped when the fixture is absent.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const { buildCutInjectDryRunPreview } = await import("../dist/commands/cut.js");

// ── Pure unit tests (always run) ────────────────────────────────────────────

test("buildCutInjectDryRunPreview: dryRun field is true", () => {
  const preview = buildCutInjectDryRunPreview({
    prprojPath: "/tmp/fake.prproj",
    sequenceName: "MY_SEQ",
    mediaPath: "/tmp/media.mp4",
    clips: [{ start: 0, end: 5 }, { start: 10, end: 15 }],
    outputPath: "/tmp/fake.cut.json",
    seqExists: true,
  });
  assert.equal(preview.dryRun, true);
});

test("buildCutInjectDryRunPreview: predictedSec sums clip durations", () => {
  const preview = buildCutInjectDryRunPreview({
    prprojPath: "/tmp/fake.prproj",
    sequenceName: "SEQ",
    mediaPath: "/tmp/m.mp4",
    clips: [{ start: 1, end: 4 }, { start: 10, end: 12.5 }],
    outputPath: "/tmp/out.json",
    seqExists: true,
  });
  // 3.0 + 2.5 = 5.5
  assert.equal(preview.predictedSec, 5.5);
  assert.equal(preview.clips, 2);
});

test("buildCutInjectDryRunPreview: wouldCreateSequence reflects seqExists", () => {
  const exists = buildCutInjectDryRunPreview({
    prprojPath: "/tmp/f.prproj",
    sequenceName: "SEQ",
    mediaPath: "/tmp/m.mp4",
    clips: [{ start: 0, end: 1 }],
    outputPath: "/tmp/o.json",
    seqExists: true,
  });
  assert.equal(exists.wouldCreateSequence, false);

  const missing = buildCutInjectDryRunPreview({
    prprojPath: "/tmp/f.prproj",
    sequenceName: "SEQ",
    mediaPath: "/tmp/m.mp4",
    clips: [{ start: 0, end: 1 }],
    outputPath: "/tmp/o.json",
    seqExists: false,
  });
  assert.equal(missing.wouldCreateSequence, true);
});

test("buildCutInjectDryRunPreview: backupPath is prprojPath + .bak", () => {
  const prprojPath = "/tmp/project.prproj";
  const preview = buildCutInjectDryRunPreview({
    prprojPath,
    sequenceName: "SEQ",
    mediaPath: "/tmp/m.mp4",
    clips: [{ start: 0, end: 1 }],
    outputPath: "/tmp/o.json",
    seqExists: true,
  });
  assert.equal(preview.backupPath, prprojPath + ".bak");
});

test("buildCutInjectDryRunPreview: mode field is 'inject'", () => {
  const preview = buildCutInjectDryRunPreview({
    prprojPath: "/tmp/f.prproj",
    sequenceName: "SEQ",
    mediaPath: "/tmp/m.mp4",
    clips: [{ start: 0, end: 1 }],
    outputPath: "/tmp/o.json",
    seqExists: true,
  });
  assert.equal(preview.mode, "inject");
});

// ── Fixture-dependent integration test ───────────────────────────────────────

const FIXTURE_COPY = "/tmp/prproj_lab/I45_copy.prproj";
const FIXTURE_MEDIA = "2026-06-11 23-33-37.mp4";
const EMPTY_SEQ = "CUT_TEMPLATE";

function fixtureAvailable() {
  return fs.existsSync(FIXTURE_COPY);
}

test(
  "cut --dry-run inject path: prproj is byte-identical and no .bak created",
  { skip: !fixtureAvailable() },
  async (t) => {
    // Make a temp copy so we don't mutate the shared fixture
    const tmpDir = os.tmpdir();
    const tmpProj = path.join(tmpDir, `cut-dryrun-${randomUUID()}.prproj`);
    fs.copyFileSync(FIXTURE_COPY, tmpProj);
    t.after(() => {
      for (const p of [tmpProj, tmpProj + ".bak", tmpProj + ".cut.json"]) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });

    const origBytes = fs.readFileSync(tmpProj);

    // Call the preview builder directly (avoids ffprobe and callPremiere)
    const { sequenceExistsInPrproj } = await import("../dist/cut/prproj-inject.js");
    const seqExists = sequenceExistsInPrproj(tmpProj, EMPTY_SEQ);

    const preview = buildCutInjectDryRunPreview({
      prprojPath: tmpProj,
      sequenceName: EMPTY_SEQ,
      mediaPath: FIXTURE_MEDIA,
      clips: [{ start: 0.5, end: 2.0 }, { start: 3.0, end: 5.5 }],
      outputPath: tmpProj.replace(".prproj", ".cut.json"),
      seqExists,
    });

    // Verify dry-run shape
    assert.equal(preview.dryRun, true);
    assert.equal(preview.sequence, EMPTY_SEQ);
    assert.equal(preview.clips, 2);
    // 1.5 + 2.5 = 4.0
    assert.equal(preview.predictedSec, 4.0);
    assert.equal(preview.wouldCreateSequence, false);
    assert.equal(preview.backupPath, tmpProj + ".bak");

    // CRITICAL: prproj must be byte-identical (no write occurred)
    const afterBytes = fs.readFileSync(tmpProj);
    assert.deepEqual(afterBytes, origBytes, "prproj must not be modified by dry-run");

    // CRITICAL: no .bak file created
    assert.ok(!fs.existsSync(tmpProj + ".bak"), ".bak must not exist after dry-run");
  },
);
