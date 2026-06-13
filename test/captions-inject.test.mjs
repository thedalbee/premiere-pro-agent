/**
 * captions-inject.test.mjs
 *
 * Unit tests for the caption injection generator.
 *
 * Pure-logic tests (always run):
 *   - rewriteCaptionTextBuffer: FlatBuffer tail-string re-pad (the only new
 *     logic vs. cut). Round-trips length field + utf8 + null + alignment pad.
 *   - selfValidateCaptions: count / ref-resolution / duplicate-ID checks.
 *
 * Fixture-dependent tests (skipped if the spike prproj is absent):
 *   - cap_spike/cap_spike_base.prproj: I35 backup whose sequence
 *     "I35_EDIT_CUT_v4" has a caption track with items — the donor source.
 *
 * Mirrors test/prproj-inject.test.mjs style.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";

const { injectCaptions, selfValidateCaptions, rewriteCaptionTextBuffer, TICKS_PER_SECOND } =
  await import("../dist/captions/captions-inject.js");

// ── fixtures ─────────────────────────────────────────────────────────────────
const FIXTURE =
  "/Users/dalbee/ws/premiere_pipeline/cap_spike/cap_spike_base.prproj";
const FIXTURE_SEQ = "I35_EDIT_CUT_v4"; // sequence with a populated caption track

function fixtureAvailable() {
  return fs.existsSync(FIXTURE);
}
function gunzip(p) {
  return zlib.gunzipSync(fs.readFileSync(p)).toString("utf8");
}
function makeTmpCopy(suffix) {
  const tmp = FIXTURE + "." + suffix + "-" + process.pid + ".prproj";
  fs.copyFileSync(FIXTURE, tmp);
  return tmp;
}
function cleanupTmp(tmp) {
  for (const p of [tmp, tmp + ".bak", tmp + ".captions-inject-debug.json"]) {
    try {
      fs.unlinkSync(p);
    } catch {
      /* ignore */
    }
  }
}

/**
 * Build a synthetic FlatBuffer-style tail string buffer:
 *   [head bytes][uint32 LE len][utf8][null][pad to (len+1)%4==0]
 */
function buildTailBuffer(text, headLen = 8) {
  const bytes = Buffer.from(text, "utf8");
  const pad = (4 - ((bytes.length + 1) % 4)) % 4;
  const head = Buffer.alloc(headLen, 0xab); // non-null head so it isn't mistaken for pad
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32LE(bytes.length, 0);
  return Buffer.concat([head, lenBuf, bytes, Buffer.alloc(1 + pad)]);
}

function decodeTail(buf) {
  let end = buf.length;
  while (end > 0 && buf[end - 1] === 0) end--;
  let start = end;
  while (start > 0 && buf[start - 1] !== 0) start--;
  const lenField = buf.readUInt32LE(start - 4);
  return { text: buf.subarray(start, end).toString("utf8"), lenField, byteLen: end - start };
}

// ── pure logic: TICKS ────────────────────────────────────────────────────────

test("TICKS_PER_SECOND constant is correct", () => {
  assert.equal(TICKS_PER_SECOND, 254016000000n);
});

// ── pure logic: rewriteCaptionTextBuffer ─────────────────────────────────────

test("rewriteCaptionTextBuffer: equal-length replacement keeps total size", () => {
  // both ASCII, exactly 11 bytes → same length path, buffer size unchanged
  const buf = buildTailBuffer("hello world"); // 11 bytes
  const before = buf.length;
  const out = rewriteCaptionTextBuffer(buf, "HELLO WORLD"); // 11 bytes
  const dec = decodeTail(out);
  assert.equal(dec.text, "HELLO WORLD");
  assert.equal(dec.lenField, 11);
  assert.equal(dec.byteLen, dec.lenField);
  assert.equal(out.length, before, "equal-length text must not change buffer size");
});

test("rewriteCaptionTextBuffer: shrink (diff not multiple of 4) re-pads", () => {
  const buf = buildTailBuffer("(물론) 저도 영상쟁이라서"); // 34 bytes
  const out = rewriteCaptionTextBuffer(buf, "패딩재계산성공했다"); // 27 bytes
  const dec = decodeTail(out);
  assert.equal(dec.text, "패딩재계산성공했다");
  assert.equal(dec.lenField, 27);
  // total trailing nulls = 1 (terminator) + pad; (27+1)%4==0 → pad 0 → 1 null
  let nulls = 0;
  for (let i = out.length - 1; i >= 0 && out[i] === 0; i--) nulls++;
  assert.equal(nulls, 1);
});

test("rewriteCaptionTextBuffer: grow (diff not multiple of 4) re-pads", () => {
  const buf = buildTailBuffer("가변길이됨"); // 15 bytes
  const out = rewriteCaptionTextBuffer(buf, "비사배수성공함"); // 21 bytes
  const dec = decodeTail(out);
  assert.equal(dec.text, "비사배수성공함");
  assert.equal(dec.lenField, 21);
  // (21+1)%4==2 → pad 2 → 1 terminator + 2 pad = 3 trailing nulls
  let nulls = 0;
  for (let i = out.length - 1; i >= 0 && out[i] === 0; i--) nulls++;
  assert.equal(nulls, 3);
});

test("rewriteCaptionTextBuffer: ASCII text round-trips", () => {
  const buf = buildTailBuffer("hello");
  const out = rewriteCaptionTextBuffer(buf, "Goodbye World");
  const dec = decodeTail(out);
  assert.equal(dec.text, "Goodbye World");
  assert.equal(dec.lenField, 13);
});

test("rewriteCaptionTextBuffer: head bytes are preserved unchanged", () => {
  const buf = buildTailBuffer("원본텍스트", 16);
  const head = Buffer.from(buf.subarray(0, 16));
  const out = rewriteCaptionTextBuffer(buf, "새로운텍스트가더길다");
  assert.deepEqual(out.subarray(0, 16), head, "head bytes must be untouched");
});

// ── pure logic: selfValidateCaptions ─────────────────────────────────────────

test("selfValidateCaptions: passes on count match + resolved refs", () => {
  const xml =
    `<PremiereData Version="3">\n` +
    `\t<CaptionDataClipTrack ObjectUID="abc-000-111" ClassID="x" Version="1">` +
    `<TrackItems Version="1">` +
    `<TrackItem Index="0" ObjectRef="10"/>` +
    `<TrackItem Index="1" ObjectRef="20"/>` +
    `</TrackItems></CaptionDataClipTrack>\n` +
    `\t<CaptionDataClipTrackItem ObjectID="10" ClassID="y" Version="1"></CaptionDataClipTrackItem>\n` +
    `\t<CaptionDataClipTrackItem ObjectID="20" ClassID="y" Version="1"></CaptionDataClipTrackItem>\n` +
    `</PremiereData>`;
  // priorItemCount 1, injected 1, firstNewId 20
  const r = selfValidateCaptions(xml, "abc-000-111", 1, 1, 20);
  assert.equal(r.captionTrackItemCount, 2);
  assert.equal(r.expectedCaptionCount, 2);
  assert.equal(r.allRefsResolved, true);
  assert.equal(r.newIdDuplicates, false);
  assert.equal(r.passed, true, `errors: ${r.errors.join(", ")}`);
});

test("selfValidateCaptions: catches count mismatch", () => {
  const xml =
    `<PremiereData Version="3">\n` +
    `\t<CaptionDataClipTrack ObjectUID="abc" ClassID="x" Version="1">` +
    `<TrackItems Version="1"><TrackItem Index="0" ObjectRef="10"/></TrackItems>` +
    `</CaptionDataClipTrack>\n` +
    `\t<CaptionDataClipTrackItem ObjectID="10" ClassID="y" Version="1"></CaptionDataClipTrackItem>\n` +
    `</PremiereData>`;
  // claims 2 prior + 1 injected = 3 expected, but only 1 present
  const r = selfValidateCaptions(xml, "abc", 2, 1, 11);
  assert.equal(r.captionTrackItemCount, 1);
  assert.equal(r.passed, false);
  assert.ok(r.errors.some((e) => e.includes("caption track has")));
});

test("selfValidateCaptions: detects unresolved ObjectRef", () => {
  const xml =
    `<PremiereData Version="3">\n` +
    `\t<CaptionDataClipTrack ObjectUID="abc" ClassID="x" Version="1">` +
    `<TrackItems Version="1"><TrackItem Index="0" ObjectRef="999"/></TrackItems>` +
    `</CaptionDataClipTrack>\n` +
    `</PremiereData>`;
  const r = selfValidateCaptions(xml, "abc", 0, 1, 999);
  assert.equal(r.allRefsResolved, false);
  assert.ok(r.errors.some((e) => e.includes("unresolved")));
});

// ── fixture-dependent: full injection round-trip ─────────────────────────────

test(
  "injectCaptions: throws if sequence not found",
  { skip: !fixtureAvailable() },
  async () => {
    await assert.rejects(
      () =>
        injectCaptions({
          prprojPath: FIXTURE,
          targetSequenceName: "NO_SUCH_SEQ_XYZ",
          captions: [{ startSec: 0, endSec: 1, text: "hi" }],
        }),
      /not found/i,
    );
  },
);

test(
  "injectCaptions: empty captions array rejected",
  { skip: !fixtureAvailable() },
  async () => {
    await assert.rejects(
      () =>
        injectCaptions({
          prprojPath: FIXTURE,
          targetSequenceName: FIXTURE_SEQ,
          captions: [],
        }),
      /empty/i,
    );
  },
);

test(
  "injectCaptions: 3 captions into a populated caption track → validation passes",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmp = makeTmpCopy("cap3");
    t.after(() => cleanupTmp(tmp));

    const captions = [
      { startSec: 100.0, endSec: 102.0, text: "첫 번째 주입 캡션" },
      { startSec: 102.0, endSec: 104.5, text: "두 번째 캡션은 조금 더 길다" },
      { startSec: 104.5, endSec: 106.0, text: "ASCII end caption" },
    ];

    const result = await injectCaptions({
      prprojPath: tmp,
      targetSequenceName: FIXTURE_SEQ,
      captions,
      debug: true,
    });

    assert.equal(result.captionsInjected, 3);
    assert.equal(result.objectsCreated, 15, "5 objects per caption");
    assert.ok(fs.existsSync(result.backupPath), "backup should exist");
    assert.equal(
      result.validation.captionTrackItemCount,
      result.validation.priorItemCount + 3,
      "track item count should grow by 3",
    );
    assert.equal(result.validation.allRefsResolved, true);
    assert.equal(result.validation.newIdDuplicates, false);
    assert.equal(
      result.validation.passed,
      true,
      `validation errors: ${result.validation.errors.join(", ")}`,
    );

    // Output must still gunzip and contain the injected text + sequence name.
    const out = gunzip(tmp);
    assert.ok(out.includes(FIXTURE_SEQ));
    // base64-encoded text won't appear as plaintext; verify the track grew and
    // the new TrackItem refs resolve to CaptionDataClipTrackItem objects.
    const newItemRefCount = (out.match(/<CaptionDataClipTrackItem ObjectID=/g) ?? []).length;
    assert.ok(newItemRefCount >= 3, "should have at least the cloned caption items");

    // Assert the injected timeline ticks are correct (not just that we wrote
    // *some* position). First caption: 100.0s → 102.0s.
    const expectStart = BigInt(Math.round(100.0 * Number(TICKS_PER_SECOND)));
    const expectEnd = BigInt(Math.round(102.0 * Number(TICKS_PER_SECOND)));
    assert.ok(
      out.includes(`<End>${expectEnd}</End>`),
      `expected injected <End>${expectEnd}</End> in output`,
    );
    assert.ok(
      out.includes(`<Start>${expectStart}</Start>`),
      `expected injected <Start>${expectStart}</Start> in output`,
    );
  },
);

// Resolve the ordered TrackItem refs of a caption track and each ref's Start
// ticks (the first item on a track omits <Start> ⇒ implicit 0). Returns the
// list in document order so callers can assert it is ticks-ascending.
function captionTrackOrder(xml, uid) {
  const esc = uid.replace(/-/g, "\\-");
  const trackRe = new RegExp(`\t<CaptionDataClipTrack ObjectUID="${esc}"[^>]*>[\\s\\S]*?<\\/CaptionDataClipTrack>`);
  const track = trackRe.exec(xml);
  assert.ok(track, `caption track ${uid} not found in output`);
  const refs = [...track[0].matchAll(/<TrackItem Index="(\d+)" ObjectRef="(\d+)"\/>/g)].map((m) => ({
    index: Number(m[1]),
    ref: Number(m[2]),
  }));
  return refs.map(({ index, ref }) => {
    const itemRe = new RegExp(`\t<CaptionDataClipTrackItem ObjectID="${ref}"[^>]*>[\\s\\S]*?<\\/CaptionDataClipTrackItem>`);
    const item = itemRe.exec(xml);
    assert.ok(item, `item ${ref} not found`);
    const sm = /<Start>(\d+)<\/Start>/.exec(item[0]);
    return { index, ref, start: sm ? BigInt(sm[1]) : 0n };
  });
}

test(
  "injectCaptions: out-of-order injection is re-sorted ticks-ascending with contiguous Index",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmp = makeTmpCopy("sorted");
    t.after(() => cleanupTmp(tmp));

    // The donor (last existing item) sits late in the timeline. Injecting an
    // EARLY caption (5–6s) and a LATE one (9000s) forces the early item to be
    // sorted into the middle of the list, not appended at the end. If step 6
    // appended (old behavior), the list would be out of ticks order here.
    const result = await injectCaptions({
      prprojPath: tmp,
      targetSequenceName: FIXTURE_SEQ,
      captions: [
        { startSec: 5.0, endSec: 6.0, text: "이른 캡션 — 중간으로 정렬돼야 함" },
        { startSec: 9000.0, endSec: 9001.0, text: "맨 끝 캡션" },
      ],
    });

    const out = gunzip(tmp);
    const order = captionTrackOrder(out, result.captionTrackUid);

    // (a) Index is contiguous 0..M-1 in document order.
    order.forEach((it, i) => assert.equal(it.index, i, `Index must be contiguous at position ${i}`));

    // (b) Start ticks are non-decreasing (the native Premiere invariant).
    for (let i = 1; i < order.length; i++) {
      assert.ok(
        order[i].start >= order[i - 1].start,
        `caption list not ticks-ascending at ${i}: ${order[i - 1].start} then ${order[i].start}`,
      );
    }

    // (c) The early 5s caption is NOT last (proves it was sorted in, not appended).
    const fiveSec = BigInt(Math.round(5.0 * Number(TICKS_PER_SECOND)));
    const fiveIdx = order.findIndex((it) => it.start === fiveSec);
    assert.ok(fiveIdx > 0, "5s caption should be found");
    assert.ok(fiveIdx < order.length - 1, "5s caption must be sorted into the middle, not appended last");

    // (d) The 9000s caption IS last.
    assert.equal(order[order.length - 1].start, BigInt(Math.round(9000.0 * Number(TICKS_PER_SECOND))));
  },
);

test(
  "injectCaptions: injected base64 text decodes to the requested caption text",
  { skip: !fixtureAvailable() },
  async (t) => {
    const tmp = makeTmpCopy("captext");
    t.after(() => cleanupTmp(tmp));

    const unique = "검증용유니크캡션텍스트";
    await injectCaptions({
      prprojPath: tmp,
      targetSequenceName: FIXTURE_SEQ,
      captions: [{ startSec: 200.0, endSec: 202.0, text: unique }],
    });

    const out = gunzip(tmp);
    // Find every FormattedTextData base64 and check one decodes to our text.
    let found = false;
    for (const m of out.matchAll(/FormattedTextData[^>]*>\s*([A-Za-z0-9+/=]+)/g)) {
      const data = Buffer.from(m[1], "base64");
      if (data.includes(Buffer.from(unique, "utf8"))) {
        found = true;
        break;
      }
    }
    assert.ok(found, "injected caption text should be present in a FormattedTextData payload");
  },
);
