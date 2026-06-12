import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import { sanitizePath } from "../dist/output/print.js";

test("sanitizePath replaces every home directory occurrence with ~", () => {
  const home = os.homedir();
  const input = `${home}/.ppro/checkpoints and ${home}/ws/video.mov`;
  assert.equal(sanitizePath(input), "~/.ppro/checkpoints and ~/ws/video.mov");
});

test("sanitizePath leaves other paths untouched", () => {
  assert.equal(sanitizePath("/opt/homebrew/bin/ffmpeg"), "/opt/homebrew/bin/ffmpeg");
});
