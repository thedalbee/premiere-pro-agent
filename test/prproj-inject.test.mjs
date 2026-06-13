/**
 * prproj-inject.test.mjs
 *
 * Unit tests for the prproj injection generator.
 * Uses /tmp/prproj_lab/I45_copy.prproj as the primary fixture:
 *   - FCP_XML_TEST: has 10 clips — used as a reject-non-empty test case
 *   - CUT_TEMPLATE: empty sequence — the normal injection target
 *   - I45_CLI_CUT: has 1,102 clips of the target media — donor source
 *
 * Falls back gracefully when fixtures are absent (CI without the test data).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";

// Build must run before tests (handled by npm test → tsc + node --test)
const { injectClips, selfValidate, sequenceExistsInPrproj, TICKS_PER_SECOND } = await import(
  "../dist/cut/prproj-inject.js"
);

// ── fixture paths ──────────────────────────────────────────────────────────
const FIXTURE_COPY = "/tmp/prproj_lab/I45_copy.prproj";
// findMediaSourceIds matches by <Title> in the prproj XML — the file does NOT
// need to exist on disk. Basename as found in Media Title elements.
const FIXTURE_MEDIA = "2026-06-11 23-33-37.mp4";
const EMPTY_SEQ = "CUT_TEMPLATE";        // empty sequence — the inject target
const NONEMPTY_SEQ = "FCP_XML_TEST";     // has clips — must be rejected

// ── helpers ────────────────────────────────────────────────────────────────
function fixtureAvailable() {
  return fs.existsSync(FIXTURE_COPY);
}

function gunzipFixture(filePath) {
  const buf = fs.readFileSync(filePath);
  return zlib.gunzipSync(buf).toString("utf8");
}

function makeTmpCopy(suffix) {
  const tmpProj = FIXTURE_COPY + "." + suffix + "-" + process.pid + ".prproj";
  fs.copyFileSync(FIXTURE_COPY, tmpProj);
  return tmpProj;
}

function cleanupTmp(tmpProj) {
  for (const p of [tmpProj, tmpProj + ".bak", tmpProj + ".inject-debug.json"]) {
    try { fs.unlinkSync(p); } catch { /* ignore */ }
  }
}

// ── smoke tests (always run) ───────────────────────────────────────────────

test("TICKS_PER_SECOND constant is correct", () => {
  assert.equal(TICKS_PER_SECOND, 254016000000n);
});

test("selfValidate catches mismatched clip count", () => {
  const fakeXml = `<?xml version="1.0" encoding="UTF-8"?>\n<PremiereData Version="3">\n\t<VideoClipTrack ObjectUID="aaa-000-111" ClassID="f68dcd81" Version="1">\n\t\t<ClipItems Version="3">\n\t\t\t<TrackItems Version="1">\n\t\t\t\t<TrackItem Index="0" ObjectRef="999"/>\n\t\t\t</TrackItems>\n\t\t</ClipItems>\n\t</VideoClipTrack>\n\t<AudioClipTrack ObjectUID="bbb-000-111" ClassID="097f6203" Version="7">\n\t\t<ClipItems Version="3">\n\t\t\t<TrackItems Version="1">\n\t\t\t\t<TrackItem Index="0" ObjectRef="999"/>\n\t\t\t</TrackItems>\n\t\t</ClipItems>\n\t</AudioClipTrack>\n\t<VideoClipTrackItem ObjectID="999" ClassID="368b" Version="8">\n\t</VideoClipTrackItem>\n</PremiereData>`;

  const result = selfValidate(fakeXml, "aaa-000-111", "bbb-000-111", 3, 1000);
  assert.equal(result.videoTrackItemCount, 1);
  assert.equal(result.audioTrackItemCount, 1);
  assert.equal(result.expectedClipCount, 3);
  assert.equal(result.passed, false);
  assert.ok(result.errors.length > 0, "should have errors for count mismatch");
});

test("selfValidate detects unresolved ObjectRefs", () => {
  const fakeXml = `<PremiereData Version="3">\n\t<VideoClipTrack ObjectUID="aaa" ClassID="x" Version="1"><ClipItems Version="3"><TrackItems Version="1"></TrackItems></ClipItems></VideoClipTrack>\n\t<AudioClipTrack ObjectUID="bbb" ClassID="y" Version="7"><ClipItems Version="3"><TrackItems Version="1"></TrackItems></ClipItems></AudioClipTrack>\n\t<Foo ObjectID="100" ClassID="x" Version="1"><Bar ObjectRef="99999"/></Foo>\n</PremiereData>`;
  const result = selfValidate(fakeXml, "aaa", "bbb", 0, 200);
  assert.equal(result.allRefsResolved, false);
  assert.ok(result.errors.some((e) => e.includes("unresolved")));
});

test("selfValidate passes on minimal well-formed XML", () => {
  const fakeXml = `<PremiereData Version="3">\n\t<VideoClipTrack ObjectUID="aaa" ClassID="x" Version="1"><ClipItems Version="3"><TrackItems Version="1"><TrackItem Index="0" ObjectRef="10"/></TrackItems></ClipItems></VideoClipTrack>\n\t<AudioClipTrack ObjectUID="bbb" ClassID="y" Version="7"><ClipItems Version="3"><TrackItems Version="1"><TrackItem Index="0" ObjectRef="11"/></TrackItems></ClipItems></AudioClipTrack>\n\t<VideoClipTrackItem ObjectID="10" ClassID="x" Version="1"></VideoClipTrackItem>\n\t<AudioClipTrackItem ObjectID="11" ClassID="y" Version="1"></AudioClipTrackItem>\n</PremiereData>`;
  const result = selfValidate(fakeXml, "aaa", "bbb", 1, 100);
  assert.equal(result.videoTrackItemCount, 1);
  assert.equal(result.audioTrackItemCount, 1);
  assert.equal(result.allRefsResolved, true);
  assert.equal(result.passed, true);
});

// ── fixture-dependent tests ────────────────────────────────────────────────

test("fixture prproj can be gunzipped and contains expected sequences", { skip: !fixtureAvailable() }, () => {
  const xml = gunzipFixture(FIXTURE_COPY);
  assert.ok(xml.includes("<PremiereData"), "should start with PremiereData");
  assert.ok(xml.includes("</PremiereData>"), "should end with PremiereData close");
  assert.ok(xml.includes("CUT_TEMPLATE"), "fixture should contain CUT_TEMPLATE");
  assert.ok(xml.includes("FCP_XML_TEST"), "fixture should contain FCP_XML_TEST");
});

test("sequenceExistsInPrproj: returns true for existing sequence", { skip: !fixtureAvailable() }, () => {
  assert.ok(sequenceExistsInPrproj(FIXTURE_COPY, "CUT_TEMPLATE"));
  assert.ok(sequenceExistsInPrproj(FIXTURE_COPY, "FCP_XML_TEST"));
});

test("sequenceExistsInPrproj: returns false for missing sequence", { skip: !fixtureAvailable() }, () => {
  assert.ok(!sequenceExistsInPrproj(FIXTURE_COPY, "DOES_NOT_EXIST_XYZ"));
});

test(
  "injectClips: rejects non-empty target sequence (FCP_XML_TEST has clips)",
  { skip: !fixtureAvailable() },
  async () => {
    // FCP_XML_TEST has clips — injectClips must refuse with a clear error
    await assert.rejects(
      () =>
        injectClips({
          prprojPath: FIXTURE_COPY,
          targetSequenceName: NONEMPTY_SEQ,
          mediaPath: FIXTURE_MEDIA,
          clips: [{ start: 0.5, end: 2.0 }],
        }),
      /already has \d+ clip|pass an empty sequence/i,
    );
  },
);

test(
  "injectClips: 3 clips into CUT_TEMPLATE (empty) → validation passes",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmpProj = makeTmpCopy("inject3");
    t.after(() => cleanupTmp(tmpProj));

    const clips = [
      { start: 0.5, end: 2.0 },
      { start: 3.0, end: 5.5 },
      { start: 8.0, end: 10.0 },
    ];

    const result = await injectClips({
      prprojPath: tmpProj,
      targetSequenceName: EMPTY_SEQ,
      mediaPath: FIXTURE_MEDIA,
      clips,
      debug: true,
    });

    assert.equal(result.clipsInjected, 3, "should inject 3 clips");
    assert.ok(fs.existsSync(result.backupPath), "backup should exist");

    // Verify output can be gunzipped and contains expected names
    const outXml = gunzipFixture(tmpProj);
    assert.ok(outXml.includes(EMPTY_SEQ), "output should still contain the sequence name");

    const val = result.validation;
    assert.equal(val.videoTrackItemCount, 3, "V1 should have 3 items");
    assert.equal(val.audioTrackItemCount, 3, "A1 should have 3 items");
    assert.equal(val.allRefsResolved, true, "all ObjectRefs should resolve");
    assert.equal(val.passed, true, `validation should pass — errors: ${val.errors.join(", ")}`);
  },
);

test(
  "injectClips: backup is created and matches original size",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmpProj = makeTmpCopy("bak");
    t.after(() => cleanupTmp(tmpProj));

    const origSize = fs.statSync(tmpProj).size;
    await injectClips({
      prprojPath: tmpProj,
      targetSequenceName: EMPTY_SEQ,
      mediaPath: FIXTURE_MEDIA,
      clips: [{ start: 1.0, end: 3.0 }],
    });
    const bakSize = fs.statSync(tmpProj + ".bak").size;
    // Backup should match original size (±gzip variance, so within 10%)
    assert.ok(
      Math.abs(bakSize - origSize) / origSize < 0.1,
      `backup size ${bakSize} should be close to original ${origSize}`,
    );
  },
);

test(
  "injectClips: throws if target sequence not found",
  { skip: !fixtureAvailable() },
  async () => {
    await assert.rejects(
      () =>
        injectClips({
          prprojPath: FIXTURE_COPY,
          targetSequenceName: "NONEXISTENT_SEQ_XYZ",
          mediaPath: FIXTURE_MEDIA,
          clips: [{ start: 0, end: 1 }],
        }),
      /not found/i,
    );
  },
);

test(
  "injectClips: media absent from project → clear error",
  { skip: !fixtureAvailable() },
  async () => {
    await assert.rejects(
      () =>
        injectClips({
          prprojPath: FIXTURE_COPY,
          targetSequenceName: EMPTY_SEQ,
          mediaPath: "definitely-not-in-project.mov",
          clips: [{ start: 0, end: 1 }],
        }),
      /not found in project|no donor/i,
    );
  },
);

test(
  "injectClips: 1 clip into CUT_TEMPLATE → output file grows (clip objects added)",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmpProj = makeTmpCopy("grow");
    t.after(() => cleanupTmp(tmpProj));

    const origSize = fs.statSync(tmpProj).size;
    const result = await injectClips({
      prprojPath: tmpProj,
      targetSequenceName: EMPTY_SEQ,
      mediaPath: FIXTURE_MEDIA,
      clips: [{ start: 2.0, end: 5.0 }],
    });

    const newSize = fs.statSync(tmpProj).size;
    assert.ok(newSize > origSize, `output file (${newSize}) should be larger than original (${origSize})`);
    assert.equal(result.clipsInjected, 1);
    assert.equal(result.validation.passed, true, `validation errors: ${result.validation.errors.join(", ")}`);
  },
);
