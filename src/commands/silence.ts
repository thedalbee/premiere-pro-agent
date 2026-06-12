import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import { DEFAULT_SETTINGS, detectSilence } from "../audio/silence.js";
import { mediaDurationSec } from "../transcription/whisper.js";

async function runSilence(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      threshold: { type: "string" },
      "min-duration": { type: "string" },
      "pad-lead": { type: "string" },
      "pad-tail": { type: "string" },
      output: { type: "string", short: "o" },
    },
  });

  const inputPath = positionals[0];
  if (!inputPath) {
    note(
      "usage: ppro silence <media-file> [--threshold -30] [--min-duration 0.5] " +
        "[--pad-lead 0.1] [--pad-tail 0.15] [-o out.silence.json]",
    );
    return EXIT.USAGE;
  }
  if (!fs.existsSync(inputPath)) {
    note(`ppro silence: file not found: ${sanitizePath(inputPath)}`);
    return EXIT.USAGE;
  }

  const settings = {
    thresholdDb: values.threshold !== undefined ? Number.parseFloat(values.threshold) : DEFAULT_SETTINGS.thresholdDb,
    minDurationSec:
      values["min-duration"] !== undefined
        ? Number.parseFloat(values["min-duration"])
        : DEFAULT_SETTINGS.minDurationSec,
    padLeadSec:
      values["pad-lead"] !== undefined ? Number.parseFloat(values["pad-lead"]) : DEFAULT_SETTINGS.padLeadSec,
    padTailSec:
      values["pad-tail"] !== undefined ? Number.parseFloat(values["pad-tail"]) : DEFAULT_SETTINGS.padTailSec,
  };
  for (const [key, value] of Object.entries(settings)) {
    if (Number.isNaN(value)) {
      note(`ppro silence: ${key} is not a number`);
      return EXIT.USAGE;
    }
  }

  const stem = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)),
  );
  const outputPath = values.output ?? `${stem}.silence.json`;

  const durationSec = await mediaDurationSec(inputPath);
  note(`scanning ${Math.round(durationSec)}s of audio (${settings.thresholdDb}dB, min ${settings.minDurationSec}s)`);

  const ranges = await detectSilence(inputPath, settings, durationSec);

  const totalSec = Math.round(ranges.reduce((sum, r) => sum + r.duration, 0) * 1000) / 1000;
  const longestSec = ranges.reduce((max, r) => Math.max(max, r.duration), 0);
  const result = {
    source: path.resolve(inputPath),
    mediaDurationSec: Math.round(durationSec * 1000) / 1000,
    settings,
    // Report numbers, not adjectives (lesson L090): count, total, longest.
    stats: {
      count: ranges.length,
      totalSec,
      longestSec: Math.round(longestSec * 1000) / 1000,
      silenceShare: Math.round((totalSec / durationSec) * 1000) / 1000,
      speechSec: Math.round((durationSec - totalSec) * 1000) / 1000,
    },
    ranges,
  };
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  if (values.json) {
    printJson({ ok: true, output: outputPath, ...result.stats });
  } else {
    process.stdout.write(
      `${result.stats.count} silent ranges, ${result.stats.totalSec}s total ` +
        `(${(result.stats.silenceShare * 100).toFixed(1)}% of media), longest ${result.stats.longestSec}s\n` +
        `→ ${sanitizePath(outputPath)}\n`,
    );
  }
  return EXIT.OK;
}

export const silence: Command = {
  name: "silence",
  summary: "Find silent ranges to remove (ffmpeg, outputs <stem>.silence.json)",
  run: runSilence,
};
