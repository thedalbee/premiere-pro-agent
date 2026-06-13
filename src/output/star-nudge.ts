import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { note } from "./print.js";

export const REPO_URL = "https://github.com/thedalbee/premiere-pro-agent";

const STAMP = path.join(os.homedir(), ".ppro", ".star-nudge");
const THROTTLE_MS = 24 * 60 * 60 * 1000; // at most once a day

// Gently invite a GitHub star after a successful operation.
// Tasteful by construction: only for interactive humans (TTY), never in
// --json/piped/CI output, never more than once a day, and silenceable via
// PPRO_NO_STAR=1. The nudge goes to stderr so it never pollutes stdout.
export function starNudge(): void {
  if (process.env.PPRO_NO_STAR) return;
  if (!process.stderr.isTTY) return;

  try {
    const lastShownMs = fs.statSync(STAMP).mtimeMs;
    if (Date.now() - lastShownMs < THROTTLE_MS) return;
  } catch {
    // No stamp yet — first success, fall through and show it.
  }

  try {
    fs.mkdirSync(path.dirname(STAMP), { recursive: true });
    fs.writeFileSync(STAMP, "");
  } catch {
    // If the stamp can't be written, still show once — never fail a command over a nudge.
  }

  note("");
  note("★ Enjoying ppro? A quick GitHub star helps other editors find it:");
  note(`  ${REPO_URL}`);
}
