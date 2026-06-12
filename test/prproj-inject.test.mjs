/**
 * prproj-inject.test.mjs
 *
 * Unit tests for the prproj injection generator.
 * Uses /tmp/prproj_lab/I45_INJECT_MID.prproj as a fixture (the confirmed-working
 * injection sample from L099 experiment).
 *
 * Falls back gracefully when the fixture is absent (CI without the test data).
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";

// Build must run before tests (handled by npm test → tsc + node --test)
const { injectClips, selfValidate, TICKS_PER_SECOND } = await import(
  "../dist/cut/prproj-inject.js"
);

// ── fixture paths ──────────────────────────────────────────────────────────
const FIXTURE_PRPROJ = "/tmp/prproj_lab/I45_INJECT_MID.prproj";
// findMediaSourceIds matches by <Title> or <FilePath> in the prproj XML —
// the file does NOT need to exist on disk. Use the basename as found in the Media Title.
// (From I45.xml: <Title>2026-06-11 23-33-37.mp4</Title>)
const FIXTURE_MEDIA = "2026-06-11 23-33-37.mp4";
const TEMPLATE_SEQ = "FCP_XML_TEST";

// ── helpers ────────────────────────────────────────────────────────────────
function fixtureAvailable() {
  return fs.existsSync(FIXTURE_PRPROJ);
}

function gunzipFixture(filePath) {
  const buf = fs.readFileSync(filePath);
  return zlib.gunzipSync(buf).toString("utf8");
}

// ── smoke tests (always run) ───────────────────────────────────────────────

test("TICKS_PER_SECOND constant is correct", () => {
  assert.equal(TICKS_PER_SECOND, 254016000000n);
});

test("selfValidate catches mismatched clip count", () => {
  // Minimal XML that looks valid but has wrong track item count
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

test("fixture prproj can be gunzipped and is valid XML", { skip: !fixtureAvailable() }, () => {
  const xml = gunzipFixture(FIXTURE_PRPROJ);
  assert.ok(xml.includes("<PremiereData"), "should start with PremiereData");
  assert.ok(xml.includes("</PremiereData>"), "should end with PremiereData close");
  assert.ok(xml.includes("FCP_XML_TEST"), "fixture should contain template sequence");
});

test(
  "injectClips: 3 clips into FCP_XML_TEST template → validation passes",
  { skip: !fixtureAvailable() },
  async (t) => {
    // Work on a temp copy so we don't mutate the fixture
    const tmpProj = FIXTURE_PRPROJ + ".inject-test-" + process.pid + ".prproj";
    fs.copyFileSync(FIXTURE_PRPROJ, tmpProj);
    t.after(() => {
      for (const p of [tmpProj, tmpProj + ".bak", tmpProj + ".inject-debug.json"]) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });

    const clips = [
      { start: 0.5, end: 2.0 },
      { start: 3.0, end: 5.5 },
      { start: 8.0, end: 10.0 },
    ];

    const result = await injectClips({
      prprojPath: tmpProj,
      templateSequenceName: TEMPLATE_SEQ,
      newSequenceName: "INJECT_TEST_SEQ",
      mediaPath: FIXTURE_MEDIA,
      clips,
      debug: true,
    });

    assert.equal(result.clipsInjected, 3, "should inject 3 clips");
    assert.ok(fs.existsSync(result.backupPath), "backup should exist");

    // Verify output can be gunzipped
    const outXml = gunzipFixture(tmpProj);
    assert.ok(outXml.includes("INJECT_TEST_SEQ"), "output should contain new sequence name");
    assert.ok(outXml.includes("FCP_XML_TEST"), "original template sequence should still be present");

    const val = result.validation;
    assert.equal(val.videoTrackItemCount, 3, "V1 should have 3 items");
    assert.equal(val.audioTrackItemCount, 3, "A1 should have 3 items");
    assert.equal(val.allRefsResolved, true, "all ObjectRefs should resolve");
    assert.equal(val.passed, true, `validation should pass — errors: ${val.errors.join(", ")}`);
  },
);

test(
  "injectClips: backup is created",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmpProj = FIXTURE_PRPROJ + ".bak-test-" + process.pid + ".prproj";
    fs.copyFileSync(FIXTURE_PRPROJ, tmpProj);
    t.after(() => {
      for (const p of [tmpProj, tmpProj + ".bak", tmpProj + ".inject-debug.json"]) {
        try { fs.unlinkSync(p); } catch { /* ignore */ }
      }
    });

    const origSize = fs.statSync(tmpProj).size;
    await injectClips({
      prprojPath: tmpProj,
      templateSequenceName: TEMPLATE_SEQ,
      newSequenceName: "BAK_TEST_SEQ",
      mediaPath: FIXTURE_MEDIA,
      clips: [{ start: 1.0, end: 3.0 }],
    });
    const bakSize = fs.statSync(tmpProj + ".bak").size;
    // Backup should match original size (±gzip variance, so within 10%)
    assert.ok(Math.abs(bakSize - origSize) / origSize < 0.1, "backup size should be close to original");
  },
);

test(
  "injectClips: throws if template sequence not found",
  { skip: !fixtureAvailable() },
  async () => {
    await assert.rejects(
      () =>
        injectClips({
          prprojPath: FIXTURE_PRPROJ,
          templateSequenceName: "NONEXISTENT_TEMPLATE_XYZ",
          newSequenceName: "X",
          mediaPath: "/tmp/fake.mov",
          clips: [{ start: 0, end: 1 }],
        }),
      /not found/i,
    );
  },
);
