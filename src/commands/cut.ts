import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import { callPremiere } from "../premiere/client.js";
import { createCheckpoint } from "../premiere/checkpoint.js";
import {
  mergeRanges,
  invertRanges,
  snapToFrameGrid,
  auditPlacementGaps,
  type Range,
  type Placement,
} from "../cut/plan.js";
import { mediaDurationSec, mediaFps } from "../audio/probe.js";

const TICKS_PER_SECOND = 254016000000;
const GAP_TOLERANCE_SEC = 0.02;
const DURATION_TOLERANCE_SEC = 1.0;

interface CutActionResult {
  sequenceName: string;
  placedCount: number;
  requestedCount: number;
  sequenceEndSec: number;
  timebaseTicks: string | null;
  trackCounts: { video: number[]; audio: number[] };
  placements: Placement[];
}

function loadRemovals(filePath: string): Range[] {
  const parsed = JSON.parse(fs.readFileSync(filePath, "utf8")) as unknown;
  const list = Array.isArray(parsed)
    ? parsed
    : (parsed as { ranges?: unknown }).ranges;
  if (!Array.isArray(list)) {
    throw new Error(`${filePath}: expected an array or { ranges: [...] }`);
  }
  return list.map((entry, i) => {
    const range = entry as { start?: unknown; end?: unknown };
    if (typeof range.start !== "number" || typeof range.end !== "number" || range.end <= range.start) {
      throw new Error(`${filePath}: range #${i} needs numeric start < end`);
    }
    return { start: range.start, end: range.end };
  });
}

async function runCut(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      remove: { type: "string", multiple: true },
      sequence: { type: "string" },
      overwrite: { type: "boolean", default: false },
      "no-checkpoint": { type: "boolean", default: false },
      output: { type: "string", short: "o" },
    },
  });

  const mediaPath = positionals[0];
  if (!mediaPath || !values.remove || values.remove.length === 0) {
    note("usage: ppro cut <media-file> --remove <ranges.json> [--remove more.json] [--sequence NAME] [--overwrite]");
    return EXIT.USAGE;
  }
  if (!fs.existsSync(mediaPath)) {
    note(`ppro cut: file not found: ${sanitizePath(mediaPath)}`);
    return EXIT.USAGE;
  }

  const stem = path.basename(mediaPath, path.extname(mediaPath));
  const sequenceName = values.sequence ?? `${stem}_CUT`;
  const outputPath = values.output ?? path.join(path.dirname(mediaPath), `${stem}.cut.json`);

  const removals = mergeRanges(values.remove.flatMap((file) => loadRemovals(file)));
  const durationSec = await mediaDurationSec(mediaPath);
  const sourceFps = await mediaFps(mediaPath);
  let clips = invertRanges(removals, durationSec);
  if (sourceFps) {
    clips = snapToFrameGrid(clips, sourceFps);
    note(`clip boundaries snapped to ${Math.round(sourceFps * 100) / 100}fps frame grid`);
  }
  if (clips.length === 0) {
    note("ppro cut: the removals cover the entire media — nothing to place");
    return EXIT.VALIDATION;
  }
  const predictedSec = Math.round(clips.reduce((sum, c) => sum + (c.end - c.start), 0) * 1000) / 1000;
  const removedSec = Math.round((durationSec - predictedSec) * 1000) / 1000;

  note(
    `${clips.length} clips to place (${predictedSec}s kept, ${removedSec}s removed) → sequence "${sequenceName}"`,
  );

  if (!values["no-checkpoint"]) {
    const { checkpointPath } = await createCheckpoint();
    note(`checkpoint → ${sanitizePath(checkpointPath)}`);
  }

  note(`placing ${clips.length} clips in Premiere (this can take a while)...`);
  const timeoutMs = 60_000 + clips.length * 1_500;
  const result = (await callPremiere(
    "sequence.cut",
    {
      mediaPath: path.resolve(mediaPath),
      sequenceName,
      clips,
      overwrite: values.overwrite,
    },
    timeoutMs,
  )) as CutActionResult;

  // ── validation gates ──
  const gapAudit = auditPlacementGaps(result.placements, GAP_TOLERANCE_SEC);
  const durationDiff = Math.abs(result.sequenceEndSec - predictedSec);
  const fps = result.timebaseTicks ? Math.round((TICKS_PER_SECOND / Number(result.timebaseTicks)) * 100) / 100 : null;

  const failures: string[] = [];
  if (result.placedCount !== clips.length) {
    failures.push(`placed ${result.placedCount}/${clips.length} clips`);
  }
  if (gapAudit.gapCount > 0) {
    failures.push(`${gapAudit.gapCount} clip gap(s) over ${GAP_TOLERANCE_SEC}s (max ${gapAudit.maxGapSec}s)`);
  }
  if (durationDiff > DURATION_TOLERANCE_SEC) {
    failures.push(`sequence is ${result.sequenceEndSec}s, predicted ${predictedSec}s (diff ${durationDiff.toFixed(3)}s)`);
  }
  const audioMismatch = result.trackCounts.audio.some((count) => count > 0 && count !== result.placedCount);
  if (audioMismatch) {
    failures.push(`audio track clip counts ${JSON.stringify(result.trackCounts.audio)} != placed ${result.placedCount}`);
  }

  const report = {
    ok: failures.length === 0,
    media: path.resolve(mediaPath),
    sequence: result.sequenceName,
    createdAt: new Date().toISOString(),
    fps,
    predicted: { clips: clips.length, durationSec: predictedSec, removedSec },
    actual: {
      placed: result.placedCount,
      sequenceEndSec: result.sequenceEndSec,
      trackCounts: result.trackCounts,
    },
    validation: { failures, gapAudit, durationDiffSec: Math.round(durationDiff * 1000) / 1000 },
    placements: result.placements,
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  if (values.json) {
    const { placements: _omit, ...summary } = report;
    printJson({ ...summary, output: outputPath });
  } else {
    process.stdout.write(
      `${result.placedCount} clips placed, sequence "${result.sequenceName}" = ${result.sequenceEndSec}s` +
        (fps ? ` @ ${fps}fps` : "") +
        `\n→ ${sanitizePath(outputPath)}\n`,
    );
    if (failures.length > 0) {
      process.stdout.write(`validation FAILED:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`);
    } else {
      process.stdout.write("validation passed: zero gaps, duration matches, all audio tracks aligned\n");
    }
  }
  return failures.length === 0 ? EXIT.OK : EXIT.VALIDATION;
}

export const cut: Command = {
  name: "cut",
  summary: "Cut ranges out of a media file into a new Premiere sequence",
  run: runCut,
};
