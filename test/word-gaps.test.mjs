import { test } from "node:test";
import assert from "node:assert/strict";
import { rawWordGaps, wordGapsToRemovals } from "../dist/audio/word-gaps.js";

// "결과가" ... pause ... "올랐습니다" — gap between word ends/starts is the dead air.
const WORDS = [
  { start: 0.5, end: 1.0 }, // leading gap 0..0.5
  { start: 1.2, end: 1.8 }, // gap 1.0..1.2 (0.2s)
  { start: 4.0, end: 4.6 }, // gap 1.8..4.0 (2.2s)
];

test("rawWordGaps: leading + inter-word + trailing gaps", () => {
  const gaps = rawWordGaps(WORDS, 6.0);
  assert.deepEqual(gaps, [
    { start: 0, end: 0.5 }, // leading
    { start: 1.0, end: 1.2 },
    { start: 1.8, end: 4.0 },
    { start: 4.6, end: 6.0 }, // trailing to durationSec
  ]);
});

test("rawWordGaps: no leading gap when first word starts at 0, no trailing when duration == last end", () => {
  const gaps = rawWordGaps([{ start: 0, end: 1 }, { start: 2, end: 3 }], 3);
  assert.deepEqual(gaps, [{ start: 1, end: 2 }]);
});

test("rawWordGaps: overlapping/zero-width gaps are skipped", () => {
  // second word starts before first ends => no gap
  const gaps = rawWordGaps([{ start: 0, end: 2 }, { start: 1.5, end: 3 }], 3);
  assert.deepEqual(gaps, []);
});

test("rawWordGaps: empty words => no gaps (never 'remove everything')", () => {
  assert.deepEqual(rawWordGaps([], 100), []);
});

test("wordGapsToRemovals: min-duration filter then crossfade shrink", () => {
  // From WORDS @ duration 6.0, raw gaps: 0.5, 0.2, 2.2, 1.4.
  // min-duration 0.5 keeps: 0.5 (leading), 2.2, 1.4 (trailing); drops 0.2.
  // crossfade 0.025 shrinks each by 25ms per side.
  const removals = wordGapsToRemovals(WORDS, 6.0, 0.5, 0.025);
  assert.deepEqual(removals, [
    { start: 0.025, end: 0.475, duration: 0.45 },
    { start: 1.825, end: 3.975, duration: 2.15 },
    { start: 4.625, end: 5.975, duration: 1.35 },
  ]);
});

test("wordGapsToRemovals: a gap fully consumed by crossfade is dropped", () => {
  // 0.5s gap with 0.25s crossfade per side => 0 width => dropped.
  const removals = wordGapsToRemovals([{ start: 0, end: 1 }, { start: 1.5, end: 2 }], 2, 0.4, 0.25);
  assert.deepEqual(removals, []);
});
