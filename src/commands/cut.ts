import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import { starNudge } from "../output/star-nudge.js";
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
import { injectClips, sequenceExistsInPrproj } from "../cut/prproj-inject.js";

const TICKS_PER_SECOND = 254016000000;
const GAP_TOLERANCE_SEC = 0.02;
const DURATION_TOLERANCE_SEC = 1.0;

// Polling: how long to wait for the plugin to reconnect after project reopen
const PLUGIN_RECONNECT_TIMEOUT_MS = 30_000;
const PLUGIN_RECONNECT_POLL_MS = 500;

interface CutActionResult {
  sequenceName: string;
  startIndex: number;
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

// ── inject path helpers ───────────────────────────────────────────────────

async function waitForPluginReconnect(timeoutMs: number): Promise<boolean> {
  const { daemonHealth } = await import("../premiere/client.js");
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    await sleep(PLUGIN_RECONNECT_POLL_MS);
    const health = await daemonHealth();
    if (health && health !== "foreign" && health.plugin.connected) {
      return true;
    }
  }
  return false;
}

async function runCutInject(
  prprojPath: string,
  sequenceName: string,
  mediaPath: string,
  clips: Array<{ start: number; end: number }>,
  outputPath: string,
  jsonOutput: boolean,
): Promise<ExitCode> {
  // Step 1: check Premiere connection and verify / create target sequence
  note("checking Premiere project status...");
  let projectInfo: { open: boolean; path?: string; name?: string } = { open: false };
  let premiereConnected = false;
  try {
    projectInfo = (await callPremiere("project.info", {}, 5_000)) as typeof projectInfo;
    premiereConnected = true;
  } catch {
    note("Premiere plugin not connected — will inject without close/reopen cycle");
  }

  const isTargetProjectOpen =
    premiereConnected &&
    projectInfo.open &&
    projectInfo.path &&
    path.resolve(projectInfo.path) === path.resolve(prprojPath);

  // Step 2: check whether the target sequence already exists in the prproj XML
  let seqExists = sequenceExistsInPrproj(prprojPath, sequenceName);

  if (!seqExists) {
    // Sequence does not exist in the file — try to create it via UXP
    if (!premiereConnected || !isTargetProjectOpen) {
      note(
        `ERROR: Sequence "${sequenceName}" not found in project and Premiere is not connected ` +
          `(or a different project is open). Create the sequence in Premiere first, or open the ` +
          `project and run this command again.`,
      );
      return EXIT.USAGE;
    }

    note(`sequence "${sequenceName}" not found — creating via Premiere UXP...`);
    try {
      await callPremiere("sequence.create", { name: sequenceName, mediaPath }, 15_000);
      note(`created sequence "${sequenceName}". Saving project...`);
      await callPremiere("project.save", {}, 10_000);
      note("project saved. Re-reading prproj...");
      // Re-check that the sequence now appears in the saved file
      seqExists = sequenceExistsInPrproj(prprojPath, sequenceName);
      if (!seqExists) {
        note(
          `ERROR: Sequence "${sequenceName}" was created in Premiere but could not be found in ` +
            `the saved prproj file. Please verify the project path and try again.`,
        );
        return EXIT.VALIDATION;
      }
    } catch (err) {
      note(`ERROR: could not create sequence via UXP: ${String(err)}`);
      note(`Create the sequence "${sequenceName}" manually in Premiere, save the project, then retry.`);
      return EXIT.USAGE;
    }
  }

  // Step 3: close the project if it's open (we'll modify the file)
  const needsClose = isTargetProjectOpen;
  if (needsClose) {
    note(`closing project "${projectInfo.name}" before injection...`);
    try {
      await callPremiere("project.close", { saveFirst: false }, 10_000);
    } catch (err) {
      note(
        `WARNING: project.close failed (${String(err)}). ` +
          `Please close "${projectInfo.name}" in Premiere manually, then press Enter.`,
      );
      await new Promise<void>((resolve) => {
        process.stdin.once("data", () => resolve());
        process.stdin.resume();
      });
    }
  }

  const result = await doInject(prprojPath, sequenceName, mediaPath, clips, outputPath, jsonOutput, premiereConnected);
  if (result !== EXIT.OK && result !== EXIT.VALIDATION) return result;

  if (needsClose) {
    // Step 4: reopen the project
    note(`reopening project: ${sanitizePath(prprojPath)}`);
    try {
      await callPremiere("project.open", { path: prprojPath }, 30_000);
    } catch (err) {
      note(`WARNING: project.open failed: ${String(err)}`);
      note(`Please reopen "${path.basename(prprojPath)}" manually in Premiere.`);
    }

    // Step 5: poll for plugin reconnect
    note("waiting for plugin to reconnect...");
    const reconnected = await waitForPluginReconnect(PLUGIN_RECONNECT_TIMEOUT_MS);
    if (!reconnected) {
      note("WARNING: plugin did not reconnect within 30s — sequence may not be open in Premiere yet.");
    } else {
      note("plugin reconnected.");
    }
  }

  return result;
}

async function doInject(
  prprojPath: string,
  sequenceName: string,
  mediaPath: string,
  clips: Array<{ start: number; end: number }>,
  outputPath: string,
  jsonOutput: boolean,
  withValidationGate: boolean,
): Promise<ExitCode> {
  const predictedSec =
    Math.round(clips.reduce((sum, c) => sum + (c.end - c.start), 0) * 1000) / 1000;

  note(`injecting ${clips.length} clips into "${sequenceName}" via prproj...`);
  note(`A .bak backup will be created. Verify the project opens in Premiere after injection.`);

  const injectResult = await injectClips({
    prprojPath,
    targetSequenceName: sequenceName,
    mediaPath,
    clips,
    debug: true,
  });

  const val = injectResult.validation;
  const failures: string[] = [...val.errors];
  if (!val.wellFormed) failures.push("output XML is not well-formed");
  if (!val.allRefsResolved) failures.push("some ObjectRefs are unresolved");

  if (withValidationGate) {
    if (val.videoTrackItemCount !== clips.length) {
      failures.push(`V1 has ${val.videoTrackItemCount} items, expected ${clips.length}`);
    }
    if (val.audioTrackItemCount !== clips.length) {
      failures.push(`A1 has ${val.audioTrackItemCount} items, expected ${clips.length}`);
    }
  }

  const report = {
    ok: failures.length === 0,
    mode: "inject",
    media: path.resolve(mediaPath),
    prproj: prprojPath,
    sequence: sequenceName,
    backup: injectResult.backupPath,
    debugFile: injectResult.debugPath,
    createdAt: new Date().toISOString(),
    predicted: { clips: clips.length, durationSec: predictedSec },
    actual: {
      injected: injectResult.clipsInjected,
      objectsCreated: injectResult.objectsCreated,
    },
    validation: { failures, ...val },
  };
  fs.writeFileSync(outputPath, JSON.stringify(report, null, 2));

  if (jsonOutput) {
    printJson(report);
  } else {
    process.stdout.write(
      `${injectResult.clipsInjected} clips injected → sequence "${sequenceName}" (${predictedSec}s)\n` +
        `backup: ${sanitizePath(injectResult.backupPath)}\n` +
        `→ ${sanitizePath(outputPath)}\n`,
    );
    if (failures.length > 0) {
      process.stdout.write(`validation FAILED:\n${failures.map((f) => `  ✗ ${f}`).join("\n")}\n`);
    } else {
      process.stdout.write("validation passed.\n");
      starNudge();
    }
  }

  return failures.length === 0 ? EXIT.OK : EXIT.VALIDATION;
}

// ── live (API loop) path ──────────────────────────────────────────────────

async function runCutLive(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      remove: { type: "string", multiple: true },
      sequence: { type: "string" },
      template: { type: "string" },
      resume: { type: "boolean", default: false },
      overwrite: { type: "boolean", default: false },
      "no-checkpoint": { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      live: { type: "boolean", default: false }, // accepted but this branch only runs with --live
    },
  });

  const mediaPath = positionals[0];
  if (!mediaPath || !values.remove || values.remove.length === 0) {
    note("usage: ppro cut <media-file> --remove <ranges.json> --live [--sequence NAME] [--template SEQUENCE] [--overwrite] [--resume]");
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

  if (!values["no-checkpoint"] && !values.resume) {
    const { checkpointPath } = await createCheckpoint();
    note(`checkpoint → ${sanitizePath(checkpointPath)}`);
  }

  note(`placing ${clips.length} clips in Premiere (this can take a while)...`);
  const timeoutMs = 120_000 + clips.length * 3_000;
  const result = (await callPremiere(
    "sequence.cut",
    {
      mediaPath: path.resolve(mediaPath),
      sequenceName,
      clips,
      overwrite: values.overwrite,
      templateName: values.template,
      resume: values.resume,
    },
    timeoutMs,
  )) as CutActionResult;

  // ── validation gates ──
  const gapAudit = auditPlacementGaps(result.placements, GAP_TOLERANCE_SEC);
  const durationDiff = Math.abs(result.sequenceEndSec - predictedSec);
  const fps = result.timebaseTicks ? Math.round((TICKS_PER_SECOND / Number(result.timebaseTicks)) * 100) / 100 : null;

  const failures: string[] = [];
  const startIndex = result.startIndex ?? 0;
  if (startIndex + result.placedCount !== clips.length) {
    failures.push(`placed ${startIndex}+${result.placedCount}/${clips.length} clips`);
  }
  if (result.trackCounts.video[0] !== clips.length) {
    failures.push(`V1 has ${result.trackCounts.video[0]} items, expected ${clips.length}`);
  }
  if (gapAudit.gapCount > 0) {
    failures.push(`${gapAudit.gapCount} clip gap(s) over ${GAP_TOLERANCE_SEC}s (max ${gapAudit.maxGapSec}s)`);
  }
  if (durationDiff > DURATION_TOLERANCE_SEC) {
    failures.push(`sequence is ${result.sequenceEndSec}s, predicted ${predictedSec}s (diff ${durationDiff.toFixed(3)}s)`);
  }
  const audioMismatch = result.trackCounts.audio.some((count) => count > 0 && count !== clips.length);
  if (audioMismatch) {
    failures.push(`audio track clip counts ${JSON.stringify(result.trackCounts.audio)} != expected ${clips.length}`);
  }

  const report = {
    ok: failures.length === 0,
    mode: "live",
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
      starNudge();
    }
  }
  return failures.length === 0 ? EXIT.OK : EXIT.VALIDATION;
}

// ── main entry point ──────────────────────────────────────────────────────

async function runCut(argv: string[]): Promise<ExitCode> {
  // Default path is inject. --live opts into the API loop path.
  const isLive = argv.includes("--live");

  if (isLive) {
    return runCutLive(argv);
  }

  // ── inject path (default) ─────────────────────────────────────────────────
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      remove: { type: "string", multiple: true },
      sequence: { type: "string" },
      "no-checkpoint": { type: "boolean", default: false },
      output: { type: "string", short: "o" },
      prproj: { type: "string" },
      // --resume is live-only
      resume: { type: "boolean", default: false },
    },
  });

  if (values.resume) {
    note("ppro cut: --resume is only available with --live");
    return EXIT.USAGE;
  }

  const mediaPath = positionals[0];
  if (!mediaPath || !values.remove || values.remove.length === 0) {
    note(
      "usage: ppro cut <media-file> --remove <ranges.json> [--sequence NAME] [--prproj path.prproj]\n" +
        "       ppro cut <media-file> --remove <ranges.json> --live [--sequence NAME] [--template SEQUENCE] [--overwrite] [--resume]",
    );
    return EXIT.USAGE;
  }
  if (!fs.existsSync(mediaPath)) {
    note(`ppro cut: file not found: ${sanitizePath(mediaPath)}`);
    return EXIT.USAGE;
  }

  // Determine .prproj path
  let prprojPath = values.prproj;
  if (!prprojPath) {
    // Ask Premiere for the current project path
    try {
      const info = (await callPremiere("project.info", {}, 5_000)) as {
        open: boolean;
        path?: string;
      };
      if (info.open && info.path) {
        prprojPath = info.path;
        note(`using open project: ${sanitizePath(prprojPath)}`);
      }
    } catch {
      // plugin not running — prprojPath stays undefined
    }
  }
  if (!prprojPath) {
    note("ppro cut: cannot determine .prproj path. Either pass --prproj or have a project open in Premiere.");
    return EXIT.USAGE;
  }
  if (!fs.existsSync(prprojPath)) {
    note(`ppro cut: prproj not found: ${sanitizePath(prprojPath)}`);
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
    `${clips.length} clips to place (${predictedSec}s kept, ${removedSec}s removed) → inject into "${sequenceName}"`,
  );

  return runCutInject(prprojPath, sequenceName, path.resolve(mediaPath), clips, outputPath, values.json ?? false);
}

export const cut: Command = {
  name: "cut",
  summary: "Cut ranges out of a media file into a Premiere sequence",
  run: runCut,
};
