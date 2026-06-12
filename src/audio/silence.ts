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

export function detectSilence(
  mediaPath: string,
  settings: SilenceSettings,
  totalDurationSec: number,
): Promise<SilenceRange[]> {
  return new Promise((resolve, reject) => {
    execFile(
      "ffmpeg",
      [
        "-i",
        mediaPath,
        "-af",
        `silencedetect=n=${settings.thresholdDb}dB:d=${settings.minDurationSec}`,
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
