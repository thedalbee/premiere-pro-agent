import { test } from "node:test";
import assert from "node:assert/strict";
import { parseSilenceDetect, applyPadding } from "../dist/audio/silence.js";

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
