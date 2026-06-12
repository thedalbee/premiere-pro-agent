import { execFile } from "node:child_process";
import { promisify } from "node:util";

const run = promisify(execFile);

export async function mediaDurationSec(inputPath: string): Promise<number> {
  const { stdout } = await run("ffprobe", [
    "-v",
    "error",
    "-show_entries",
    "format=duration",
    "-of",
    "default=noprint_wrappers=1:nokey=1",
    inputPath,
  ]);
  return Number.parseFloat(stdout.trim());
}

// Frame rate of the first video stream, or null for audio-only media.
export async function mediaFps(inputPath: string): Promise<number | null> {
  try {
    const { stdout } = await run("ffprobe", [
      "-v",
      "error",
      "-select_streams",
      "v:0",
      "-show_entries",
      "stream=r_frame_rate",
      "-of",
      "default=noprint_wrappers=1:nokey=1",
      inputPath,
    ]);
    const [num, den] = stdout.trim().split("/").map(Number);
    if (!num || !den) return null;
    return num / den;
  } catch {
    return null;
  }
}
