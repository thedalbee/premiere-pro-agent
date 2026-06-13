import { spawn } from "node:child_process";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const run = promisify(execFile);

export const WHISPER_MODEL = "mlx-community/whisper-large-v3-turbo";

/**
 * Local Hugging Face hub directory a model would be cached in. Honors
 * HUGGINGFACE_HUB_CACHE / HF_HOME, else ~/.cache/huggingface/hub. Used only to
 * tailor the first-run message, so an env-mismatch is harmless (it just shows a
 * download hint that may be unnecessary).
 */
export function huggingfaceModelDir(model: string, env: NodeJS.ProcessEnv = process.env): string {
  const cacheRoot =
    env.HUGGINGFACE_HUB_CACHE ??
    (env.HF_HOME
      ? path.join(env.HF_HOME, "hub")
      : path.join(os.homedir(), ".cache", "huggingface", "hub"));
  return path.join(cacheRoot, "models--" + model.replace(/\//g, "--"));
}

/** Best-effort: is the Whisper model already downloaded locally? */
export function isModelCached(model: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    return fs.existsSync(huggingfaceModelDir(model, env));
  } catch {
    return false;
  }
}

export interface TranscriptWord {
  text: string;
  start: number;
  end: number;
  confidence: number;
}

export interface Transcript {
  model: string;
  language: string;
  durationSec: number;
  words: TranscriptWord[];
  text: string;
}

// Runs inside the user's Python. Anti-hallucination settings
// (condition_on_previous_text=False, compression_ratio_threshold=2.0)
// are required — without them Whisper loops on Korean speech.
const PYTHON_SCRIPT = `
import json, sys
import mlx_whisper

audio_path, language, model = sys.argv[1], sys.argv[2], sys.argv[3]
result = mlx_whisper.transcribe(
    audio_path,
    path_or_hf_repo=model,
    language=None if language == "auto" else language,
    word_timestamps=True,
    condition_on_previous_text=False,
    temperature=(0.0, 0.2, 0.4, 0.6),
    compression_ratio_threshold=2.0,
    no_speech_threshold=0.6,
    verbose=False,
)
words = [
    {
        "text": w["word"].strip(),
        "start": round(float(w["start"]), 3),
        "end": round(float(w["end"]), 3),
        "confidence": round(float(w.get("probability", 1.0)), 4),
    }
    for seg in result["segments"]
    for w in seg.get("words", [])
]
print(json.dumps({
    "language": result.get("language", language),
    "words": words,
    "text": result.get("text", "").strip(),
}, ensure_ascii=False))
`;

export async function extractAudio(inputPath: string, onNote: (note: string) => void): Promise<string> {
  const wavPath = path.join(
    os.tmpdir(),
    `ppro-${path.basename(inputPath, path.extname(inputPath))}-16k.wav`,
  );
  onNote(`extracting audio → ${wavPath}`);
  await run("ffmpeg", [
    "-y",
    "-i",
    inputPath,
    "-vn",
    "-ar",
    "16000",
    "-ac",
    "1",
    "-c:a",
    "pcm_s16le",
    wavPath,
  ]);
  return wavPath;
}

export function transcribe(
  audioPath: string,
  language: string,
  onNote: (note: string) => void,
): Promise<Pick<Transcript, "language" | "words" | "text">> {
  const python = process.env.PPRO_PYTHON ?? "python3";
  if (isModelCached(WHISPER_MODEL)) {
    onNote(`transcribing with ${WHISPER_MODEL}`);
  } else {
    onNote(
      `first run: downloading the Whisper model (${WHISPER_MODEL}, ~1.5GB) — ` +
        `this can take a few minutes and may look idle; it is cached for next time`,
    );
  }

  return new Promise((resolve, reject) => {
    const child = spawn(python, ["-c", PYTHON_SCRIPT, audioPath, language, WHISPER_MODEL]);
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`whisper failed (exit ${code}): ${stderr.split("\n").slice(-5).join(" ")}`));
        return;
      }
      try {
        resolve(JSON.parse(stdout));
      } catch {
        reject(new Error("whisper returned unparseable output"));
      }
    });
  });
}

export function cleanupTempAudio(wavPath: string): void {
  try {
    fs.unlinkSync(wavPath);
  } catch {
    // temp file cleanup is best-effort
  }
}
