/**
 * whisper-model-cache.test.mjs
 *
 * First-run UX: derive the Hugging Face cache dir for the Whisper model so the
 * CLI can warn about the ~1.5GB download only when the model isn't cached yet.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import path from "node:path";

const { huggingfaceModelDir, isModelCached, WHISPER_MODEL } = await import(
  "../dist/transcription/whisper.js"
);

const MODEL = "mlx-community/whisper-large-v3-turbo";
const SLUG = "models--mlx-community--whisper-large-v3-turbo";

test("huggingfaceModelDir: default ~/.cache/huggingface/hub", () => {
  const dir = huggingfaceModelDir(MODEL, {});
  assert.equal(dir, path.join(os.homedir(), ".cache", "huggingface", "hub", SLUG));
});

test("huggingfaceModelDir: HUGGINGFACE_HUB_CACHE wins", () => {
  const dir = huggingfaceModelDir(MODEL, { HUGGINGFACE_HUB_CACHE: "/custom/hub" });
  assert.equal(dir, path.join("/custom/hub", SLUG));
});

test("huggingfaceModelDir: HF_HOME falls back to <HF_HOME>/hub", () => {
  const dir = huggingfaceModelDir(MODEL, { HF_HOME: "/hf" });
  assert.equal(dir, path.join("/hf", "hub", SLUG));
});

test("isModelCached: false for a guaranteed-absent cache root", () => {
  assert.equal(isModelCached(MODEL, { HUGGINGFACE_HUB_CACHE: "/nonexistent-ppro-test-xyz" }), false);
});

test("WHISPER_MODEL is the turbo model", () => {
  assert.equal(WHISPER_MODEL, MODEL);
});
