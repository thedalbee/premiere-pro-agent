export interface Range {
  start: number;
  end: number;
}

export interface Placement {
  sourceStart: number;
  sourceEnd: number;
  timelineStart: number;
  timelineEnd: number;
}

// Union of possibly-overlapping removal ranges from multiple sources
// (silence detection + agent-judged retakes, fillers, ...).
export function mergeRanges(ranges: Range[]): Range[] {
  if (ranges.length === 0) return [];
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  const merged: Range[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const last = merged[merged.length - 1];
    if (sorted[i].start <= last.end) {
      last.end = Math.max(last.end, sorted[i].end);
    } else {
      merged.push({ ...sorted[i] });
    }
  }
  return merged;
}

// What remains of the media after the removals are taken out.
export function invertRanges(removals: Range[], totalDuration: number): Range[] {
  const merged = mergeRanges(removals);
  const clips: Range[] = [];
  let cursor = 0;
  for (const removal of merged) {
    if (removal.start > cursor) {
      clips.push({ start: cursor, end: Math.min(removal.start, totalDuration) });
    }
    cursor = Math.max(cursor, removal.end);
  }
  if (cursor < totalDuration) {
    clips.push({ start: cursor, end: totalDuration });
  }
  return clips.filter((clip) => clip.end - clip.start > 0.05);
}

// Premiere aligns clip boundaries to source frames; boundaries that sit
// between frames drift when placed and open sub-frame gaps (lesson L088).
// Snapping to the frame grid keeps every boundary placeable as-is.
export function snapToFrameGrid(clips: Range[], fps: number): Range[] {
  return clips
    .map((clip) => ({
      start: Math.round(clip.start * fps) / fps,
      end: Math.round(clip.end * fps) / fps,
    }))
    .filter((clip) => clip.end - clip.start > 0.05);
}

export interface GapAuditResult {
  gapCount: number;
  maxGapSec: number;
  gaps: Array<{ index: number; gapSec: number }>;
}

// Adjacent clips must butt together exactly. Tolerance covers Premiere's
// source-frame alignment drift of up to ~1ms per boundary (lesson L088).
export function auditPlacementGaps(placements: Placement[], toleranceSec: number): GapAuditResult {
  const gaps: Array<{ index: number; gapSec: number }> = [];
  for (let i = 0; i < placements.length - 1; i++) {
    const gap = placements[i + 1].timelineStart - placements[i].timelineEnd;
    if (Math.abs(gap) > toleranceSec) {
      gaps.push({ index: i, gapSec: Math.round(gap * 10000) / 10000 });
    }
  }
  const maxGapSec = gaps.reduce((max, g) => Math.max(max, Math.abs(g.gapSec)), 0);
  return { gapCount: gaps.length, maxGapSec, gaps: gaps.slice(0, 20) };
}
