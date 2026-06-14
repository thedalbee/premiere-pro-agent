import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import { rawWordGaps, wordGapsToRemovals } from "../audio/word-gaps.js";

const DEFAULT_MIN_DURATION_SEC = 0.5;
const DEFAULT_CROSSFADE_SEC = 0.025; // 25ms — click/pop guard, not a safety pad

interface TranscriptShape {
  durationSec?: number;
  words?: Array<{ start: number; end: number }>;
}

async function runGaps(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      "min-duration": { type: "string" },
      crossfade: { type: "string" },
      output: { type: "string", short: "o" },
    },
  });

  const transcriptPath = positionals[0];
  if (!transcriptPath) {
    note("usage: ppro gaps <transcript.json> [--min-duration 0.5] [--crossfade 0.025] [-o out.gaps.json]");
    return EXIT.USAGE;
  }
  if (!fs.existsSync(transcriptPath)) {
    note(`ppro gaps: file not found: ${sanitizePath(transcriptPath)}`);
    return EXIT.USAGE;
  }

  let transcript: TranscriptShape;
  try {
    transcript = JSON.parse(fs.readFileSync(transcriptPath, "utf8")) as TranscriptShape;
  } catch (err) {
    note(`ppro gaps: cannot parse ${sanitizePath(transcriptPath)}: ${String(err)}`);
    return EXIT.USAGE;
  }
  const words = transcript.words;
  if (!Array.isArray(words) || words.length === 0) {
    note("ppro gaps: transcript has no word-level timestamps (expected { words: [{start,end}] })");
    return EXIT.VALIDATION;
  }

  const minDurationSec =
    values["min-duration"] !== undefined ? Number.parseFloat(values["min-duration"]) : DEFAULT_MIN_DURATION_SEC;
  const crossfadeSec =
    values.crossfade !== undefined ? Number.parseFloat(values.crossfade) : DEFAULT_CROSSFADE_SEC;
  for (const [key, value] of [["min-duration", minDurationSec], ["crossfade", crossfadeSec]] as const) {
    if (Number.isNaN(value)) {
      note(`ppro gaps: ${key} is not a number`);
      return EXIT.USAGE;
    }
  }

  // Media duration: prefer the transcript's own value; fall back to the last
  // word's end (no trailing gap can then be inferred, which is the safe default).
  const lastWordEnd = words[words.length - 1].end;
  const durationSec = typeof transcript.durationSec === "number" ? transcript.durationSec : lastWordEnd;

  const ranges = wordGapsToRemovals(words, durationSec, minDurationSec, crossfadeSec);

  const stem0 = path.basename(transcriptPath, path.extname(transcriptPath));
  const stem = path.join(path.dirname(transcriptPath), stem0.replace(/\.transcript$/, ""));
  const outputPath = values.output ?? `${stem}.gaps.json`;

  const totalSec = Math.round(ranges.reduce((sum, r) => sum + r.duration, 0) * 1000) / 1000;
  const longestSec = ranges.reduce((max, r) => Math.max(max, r.duration), 0);
  const result = {
    source: path.resolve(transcriptPath),
    mediaDurationSec: Math.round(durationSec * 1000) / 1000,
    settings: { minDurationSec, crossfadeSec },
    // Numbers, not adjectives: count, total, longest, and how many words anchored.
    stats: {
      count: ranges.length,
      totalSec,
      longestSec: Math.round(longestSec * 1000) / 1000,
      removableShare: durationSec > 0 ? Math.round((totalSec / durationSec) * 1000) / 1000 : 0,
      speechSec: Math.round((durationSec - totalSec) * 1000) / 1000,
      words: words.length,
      rawGaps: rawWordGaps(words, durationSec).length,
    },
    ranges,
  };
  fs.writeFileSync(outputPath, JSON.stringify(result, null, 2));

  if (values.json) {
    printJson({ ok: true, output: outputPath, ...result.stats });
  } else {
    process.stdout.write(
      `${result.stats.count} removable gaps, ${result.stats.totalSec}s total ` +
        `(${(result.stats.removableShare * 100).toFixed(1)}% of media) from ${words.length} words, ` +
        `longest ${result.stats.longestSec}s\n` +
        `→ ${sanitizePath(outputPath)}  (feed to: ppro cut <media> --remove ${path.basename(outputPath)} --live)\n`,
    );
  }
  return EXIT.OK;
}

export const gaps: Command = {
  name: "gaps",
  summary: "Removal ranges from transcript word boundaries (no amplitude; for `cut --remove`)",
  run: runGaps,
};
