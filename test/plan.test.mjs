import { test } from "node:test";
import assert from "node:assert/strict";
import { mergeRanges, invertRanges, auditPlacementGaps } from "../dist/cut/plan.js";

test("mergeRanges unions overlapping ranges from multiple sources", () => {
  const merged = mergeRanges([
    { start: 10, end: 20 },
    { start: 5, end: 12 },
    { start: 30, end: 35 },
  ]);
  assert.deepEqual(merged, [
    { start: 5, end: 20 },
    { start: 30, end: 35 },
  ]);
});

test("invertRanges returns what remains, clamped to media duration", () => {
  const clips = invertRanges(
    [
      { start: 0, end: 3 },
      { start: 10, end: 20 },
    ],
    25,
  );
  assert.deepEqual(clips, [
    { start: 3, end: 10 },
    { start: 20, end: 25 },
  ]);
});

test("invertRanges drops sub-50ms fragments", () => {
  const clips = invertRanges(
    [
      { start: 0, end: 10 },
      { start: 10.03, end: 20 },
    ],
    20,
  );
  assert.deepEqual(clips, []);
});

test("auditPlacementGaps flags gaps beyond tolerance only", () => {
  const audit = auditPlacementGaps(
    [
      { sourceStart: 0, sourceEnd: 5, timelineStart: 0, timelineEnd: 5.001 },
      { sourceStart: 10, sourceEnd: 15, timelineStart: 5.0, timelineEnd: 10 },
      { sourceStart: 20, sourceEnd: 25, timelineStart: 10.5, timelineEnd: 15.5 },
    ],
    0.02,
  );
  assert.equal(audit.gapCount, 1);
  assert.equal(audit.gaps[0].index, 1);
});
