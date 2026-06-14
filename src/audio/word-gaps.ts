import { applyPadding, type SilenceRange } from "./silence.js";

// Transcript-driven removal ranges: instead of measuring amplitude, treat the
// gap between word[i].end and word[i+1].start as removable dead air. Because the
// word boundaries are accurate, no large safety padding is needed — only a tiny
// crossfade margin to avoid clicks/pops at the join. This is the "transcript is
// truth" path (decision-agnostic; cut still just receives removal ranges).

export interface TranscriptWordLike {
  start: number;
  end: number;
}

/** Raw removable gaps between words (plus the leading gap before the first word
 * and the trailing gap after the last word), as {start,end}. No min-duration
 * filter, no crossfade — pure boundary arithmetic. Overlapping/zero gaps
 * (word[i+1].start <= word[i].end) are skipped. Empty input => no gaps. */
export function rawWordGaps(
  words: TranscriptWordLike[],
  durationSec: number,
): Array<{ start: number; end: number }> {
  if (words.length === 0) return [];
  const gaps: Array<{ start: number; end: number }> = [];

  const first = words[0];
  if (first.start > 0) gaps.push({ start: 0, end: first.start });

  for (let i = 0; i < words.length - 1; i++) {
    const start = words[i].end;
    const end = words[i + 1].start;
    if (end > start) gaps.push({ start, end });
  }

  const last = words[words.length - 1];
  if (durationSec > last.end) gaps.push({ start: last.end, end: durationSec });

  return gaps;
}

/** Removal ranges from word boundaries: keep only gaps >= minDurationSec, then
 * shrink each by a small crossfadeSec on both sides (the padding tail disappears
 * because the boundaries are already accurate). */
export function wordGapsToRemovals(
  words: TranscriptWordLike[],
  durationSec: number,
  minDurationSec: number,
  crossfadeSec: number,
): SilenceRange[] {
  const raw = rawWordGaps(words, durationSec).filter((g) => g.end - g.start >= minDurationSec);
  return applyPadding(raw, crossfadeSec, crossfadeSec);
}
