import { execFile } from "node:child_process";

export interface SilenceRange {
  start: number;
  end: number;
  duration: number;
}

export interface SilenceSettings {
  thresholdDb: number;
  minDurationSec: number;
  padLeadSec: number;
  padTailSec: number;
}

// Verified defaults from production use (lesson L090): -30dB threshold,
// breathing pads so cuts never clip the end or start of speech.
export const DEFAULT_SETTINGS: SilenceSettings = {
  thresholdDb: -30,
  minDurationSec: 0.5,
  padLeadSec: 0.1,
  padTailSec: 0.15,
};

export function parseSilenceDetect(
  stderr: string,
  totalDurationSec: number,
): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  let openStart: number | null = null;

  for (const line of stderr.split("\n")) {
    const startMatch = line.match(/silence_start: ([\d.]+)/);
    if (startMatch) {
      openStart = Number.parseFloat(startMatch[1]);
      continue;
    }
    const endMatch = line.match(/silence_end: ([\d.]+)/);
    if (endMatch && openStart !== null) {
      ranges.push({ start: openStart, end: Number.parseFloat(endMatch[1]) });
      openStart = null;
    }
  }

  // A recording that ends in silence emits silence_start with no
  // silence_end — close it at the end of the media instead of dropping it.
  if (openStart !== null && openStart < totalDurationSec) {
    ranges.push({ start: openStart, end: totalDurationSec });
  }
  return ranges;
}

// Shrink each silence so the cut leaves breathing room around speech:
// keep padLead seconds after the speech that just ended, and padTail
// seconds before the speech that comes next.
export function applyPadding(
  ranges: Array<{ start: number; end: number }>,
  padLeadSec: number,
  padTailSec: number,
): SilenceRange[] {
  const padded: SilenceRange[] = [];
  for (const range of ranges) {
    const start = range.start + padLeadSec;
    const end = range.end - padTailSec;
    if (end - start <= 0) continue;
    padded.push({
      start: Math.round(start * 1000) / 1000,
      end: Math.round(end * 1000) / 1000,
      duration: Math.round((end - start) * 1000) / 1000,
    });
  }
  return padded;
}

// ── Voice-band + adaptive-threshold refinement (opt-in) ────────────────────
// Optional improvement over the fixed -30dB magic number: restrict to the voice
// band (~300-3400Hz) so low rumble / high hiss don't read as "sound", and derive
// the threshold from the recording's own noise floor (low percentile of per-window
// RMS + a margin) instead of a constant. Off by default; silence.json schema is
// unchanged (the computed value simply lands in settings.thresholdDb).

export const VOICE_BAND_FILTER = "highpass=f=300,lowpass=f=3400";

/** Linear-interpolated p-th percentile (p in 0..100) of finite values; NaN if none. */
export function percentile(values: number[], p: number): number {
  const finite = values.filter((v) => Number.isFinite(v));
  if (finite.length === 0) return NaN;
  const sorted = [...finite].sort((a, b) => a - b);
  if (sorted.length === 1) return sorted[0];
  const rank = (p / 100) * (sorted.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return sorted[lo];
  return sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** Adaptive silence threshold (dB): low percentile of per-window RMS (the noise
 * floor) plus a margin, so the cut sits just above room tone. Falls back to the
 * fixed default when there is no usable measurement. */
export function adaptiveThresholdDb(
  rmsDbValues: number[],
  marginDb: number,
  percentileP = 5,
  fallbackDb: number = DEFAULT_SETTINGS.thresholdDb,
): number {
  const floor = percentile(rmsDbValues, percentileP);
  if (!Number.isFinite(floor)) return fallbackDb;
  return Math.round((floor + marginDb) * 10) / 10;
}

/** Parse per-window RMS_level dB values from ffmpeg astats/ametadata stderr.
 * "-inf" (digital-silent windows) is kept as -Infinity; percentile() drops it. */
export function parseAstatsRmsDb(stderr: string): number[] {
  const out: number[] = [];
  for (const line of stderr.split("\n")) {
    const m = line.match(/lavfi\.astats\.Overall\.RMS_level=(-?inf|-?[\d.]+)/);
    if (m) {
      out.push(m[1].endsWith("inf") ? -Infinity : Number.parseFloat(m[1]));
    }
  }
  return out;
}

/** Measure per-window voice-band RMS (dB) across the media, for noise-floor
 * estimation. ~1s windows after resampling to 16kHz and the voice-band filter. */
export function measureVoiceBandRmsDb(mediaPath: string): Promise<number[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-hide_banner",
        "-nostats",
        "-i",
        mediaPath,
        "-map",
        "0:a:0",
        "-af",
        `aresample=16000,${VOICE_BAND_FILTER},asetnsamples=n=16000:p=0,` +
          `astats=metadata=1:reset=1,ametadata=mode=print:key=lavfi.astats.Overall.RMS_level`,
        "-f",
        "null",
        "-",
      ],
      { timeout: 600_000, maxBuffer: 64 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        const values = parseAstatsRmsDb(stderr);
        if (values.length === 0 && error) {
          reject(error);
          return;
        }
        resolve(values);
      },
    );
  });
}

export function detectSilence(
  mediaPath: string,
  settings: SilenceSettings,
  totalDurationSec: number,
  options: { bandpass?: boolean } = {},
): Promise<SilenceRange[]> {
  const silenceFilter = `silencedetect=n=${settings.thresholdDb}dB:d=${settings.minDurationSec}`;
  const filterChain = options.bandpass ? `${VOICE_BAND_FILTER},${silenceFilter}` : silenceFilter;
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-i",
        mediaPath,
        "-af",
        filterChain,
        "-f",
        "null",
        "-",
      ],
      { timeout: 600_000, maxBuffer: 32 * 1024 * 1024 },
      (error, _stdout, stderr) => {
        // ffmpeg analysis output goes to stderr; only treat it as a failure
        // when no silencedetect markers came through at all.
        if (error && !stderr.includes("silence_start") && !stderr.includes("silencedetect")) {
          reject(error);
          return;
        }
        const raw = parseSilenceDetect(stderr, totalDurationSec);
        resolve(applyPadding(raw, settings.padLeadSec, settings.padTailSec));
      },
    );
  });
}
