import { parseArgs } from "node:util";
import fs from "node:fs";
import path from "node:path";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { note, printJson, sanitizePath } from "../output/print.js";
import {
  WHISPER_MODEL,
  type Transcript,
  cleanupTempAudio,
  extractAudio,
  transcribe,
} from "../transcription/whisper.js";
import { mediaDurationSec } from "../audio/probe.js";
import { IS_MAC } from "../platform.js";

const AUDIO_EXTENSIONS = new Set([".wav", ".mp3", ".m4a", ".aac", ".flac", ".ogg"]);

async function runTranscribe(argv: string[]): Promise<ExitCode> {
  const { values, positionals } = parseArgs({
    args: argv,
    allowPositionals: true,
    options: {
      json: { type: "boolean", default: false },
      language: { type: "string", default: "auto" },
      output: { type: "string", short: "o" },
    },
  });

  // Local transcription runs on Apple Silicon (mlx) only — macOS-only by design.
  if (!IS_MAC) {
    const msg =
      "ppro transcribe uses a local Apple-Silicon model (mlx) and is macOS-only. " +
      "On Windows/Linux, generate a transcript with your own tool and pass removal ranges to `ppro cut`.";
    if (values.json) printJson({ ok: false, error: msg });
    else note(msg);
    return EXIT.MISSING_DEPENDENCY;
  }

  const inputPath = positionals[0];
  if (!inputPath) {
    note("usage: ppro transcribe <media-file> [--language ko] [-o out.transcript.json]");
    return EXIT.USAGE;
  }
  if (!fs.existsSync(inputPath)) {
    note(`ppro transcribe: file not found: ${sanitizePath(inputPath)}`);
    return EXIT.USAGE;
  }

  const stem = path.join(
    path.dirname(inputPath),
    path.basename(inputPath, path.extname(inputPath)),
  );
  const outputPath = values.output ?? `${stem}.transcript.json`;

  const extension = path.extname(inputPath).toLowerCase();
  const isAudio = AUDIO_EXTENSIONS.has(extension);
  const audioPath = isAudio ? inputPath : await extractAudio(inputPath, note);

  try {
    const started = Date.now();
    const result = await transcribe(audioPath, values.language, note);
    const durationSec = await mediaDurationSec(audioPath);

    const transcript: Transcript = {
      model: WHISPER_MODEL,
      language: result.language,
      durationSec: Math.round(durationSec * 1000) / 1000,
      words: result.words,
      text: result.text,
    };
    fs.writeFileSync(outputPath, JSON.stringify(transcript, null, 2));

    const elapsedSec = Math.round((Date.now() - started) / 1000);
    const summary = {
      ok: true,
      output: outputPath,
      words: transcript.words.length,
      language: transcript.language,
      mediaDurationSec: transcript.durationSec,
      transcribeSec: elapsedSec,
    };
    if (values.json) {
      printJson(summary);
    } else {
      process.stdout.write(
        `${transcript.words.length} words (${transcript.language}), ` +
          `${transcript.durationSec}s of media in ${elapsedSec}s\n` +
          `→ ${sanitizePath(outputPath)}\n`,
      );
    }
    return EXIT.OK;
  } finally {
    if (!isAudio) cleanupTempAudio(audioPath);
  }
}

export const transcribeCommand: Command = {
  name: "transcribe",
  summary: "Transcribe media to word-level timestamps (local Whisper, no API key)",
  run: runTranscribe,
};
