import { test } from "node:test";
import assert from "node:assert/strict";
import {
  parseSilenceDetect,
  applyPadding,
  percentile,
  adaptiveThresholdDb,
  parseAstatsRmsDb,
} from "../dist/audio/silence.js";

const SAMPLE_STDERR = `
[silencedetect @ 0x600] silence_start: 41.2
[silencedetect @ 0x600] silence_end: 43.8 | silence_duration: 2.6
[silencedetect @ 0x600] silence_start: 100.0
`;

test("parseSilenceDetect pairs start/end lines", () => {
  const ranges = parseSilenceDetect(SAMPLE_STDERR, 120);
  assert.equal(ranges.length, 2);
  assert.deepEqual(ranges[0], { start: 41.2, end: 43.8 });
});

test("parseSilenceDetect closes trailing silence at media end", () => {
  const ranges = parseSilenceDetect(SAMPLE_STDERR, 120);
  assert.deepEqual(ranges[1], { start: 100.0, end: 120 });
});

test("applyPadding shrinks ranges and drops ones the pads consume", () => {
  const padded = applyPadding(
    [
      { start: 10, end: 12 },
      { start: 20, end: 20.2 },
    ],
    0.1,
    0.15,
  );
  assert.equal(padded.length, 1);
  assert.deepEqual(padded[0], { start: 10.1, end: 11.85, duration: 1.75 });
});

// ── Adaptive threshold (opt-in voice-band path) ─────────────────────────────

test("percentile: interpolates and handles edges", () => {
  const v = [10, 20, 30, 40, 50];
  assert.equal(percentile(v, 0), 10);
  assert.equal(percentile(v, 50), 30);
  assert.equal(percentile(v, 100), 50);
  assert.equal(percentile([5], 5), 5);
  assert.ok(Number.isNaN(percentile([], 5)));
});

test("percentile: ignores non-finite values (-inf digital-silent windows)", () => {
  // p5 over the finite floor only, -Infinity dropped.
  assert.equal(percentile([-Infinity, -60, -50, -40, -30], 50), -45);
});

test("adaptiveThresholdDb: noise-floor p5 + margin, rounded to 0.1dB", () => {
  // floor (p5) of a flat -50 array is -50; +12 margin → -38.
  const flat = new Array(20).fill(-50);
  assert.equal(adaptiveThresholdDb(flat, 12), -38);
});

test("adaptiveThresholdDb: falls back to default when no usable measurement", () => {
  assert.equal(adaptiveThresholdDb([], 12), -30); // DEFAULT_SETTINGS.thresholdDb
  assert.equal(adaptiveThresholdDb([-Infinity, -Infinity], 12), -30);
});

test("parseAstatsRmsDb: extracts per-window RMS, keeps -inf as -Infinity", () => {
  const stderr = [
    "[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=-48.213000",
    "[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=-inf",
    "[Parsed_ametadata_4 @ 0x1] lavfi.astats.Overall.RMS_level=-22.500000",
    "unrelated line",
  ].join("\n");
  const vals = parseAstatsRmsDb(stderr);
  assert.equal(vals.length, 3);
  assert.equal(vals[0], -48.213);
  assert.equal(vals[1], -Infinity);
  assert.equal(vals[2], -22.5);
});
