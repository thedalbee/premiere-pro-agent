import { test } from "node:test";
import assert from "node:assert/strict";
import { pollForReconnect } from "../dist/commands/cut.js";

// Fake-clock deps: each sleep advances a virtual clock by the requested ms, so
// the adaptive polling/progress timing is fully deterministic (no real waiting).
function makeDeps({ connectsAtMs = Infinity } = {}) {
  let t = 0;
  const progressCalls = [];
  return {
    progressCalls,
    deps: {
      isConnected: async () => t >= connectsAtMs,
      now: () => t,
      sleep: async (ms) => {
        t += ms;
      },
      onProgress: (elapsedMs) => progressCalls.push(elapsedMs),
      pollMs: 500,
      progressMs: 10000,
    },
  };
}

test("pollForReconnect: returns true when the plugin connects before the deadline", async () => {
  const { deps, progressCalls } = makeDeps({ connectsAtMs: 12000 });
  const ok = await pollForReconnect(180000, deps);
  assert.equal(ok, true);
  // One liveness note fired at ~10s, before it connected at 12s.
  assert.deepEqual(progressCalls, [10000]);
});

test("pollForReconnect: returns false at the deadline when it never connects", async () => {
  const { deps, progressCalls } = makeDeps({ connectsAtMs: Infinity });
  const ok = await pollForReconnect(35000, deps);
  assert.equal(ok, false);
  // Progress notes fire at the 10s cadence: 10s, 20s, 30s (not again at 35s).
  assert.deepEqual(progressCalls, [10000, 20000, 30000]);
});

test("pollForReconnect: returns true on the very first poll when already connected", async () => {
  const { deps, progressCalls } = makeDeps({ connectsAtMs: 0 });
  const ok = await pollForReconnect(180000, deps);
  assert.equal(ok, true);
  assert.deepEqual(progressCalls, []);
});

test("pollForReconnect: emits no progress note when it connects within the first interval", async () => {
  const { deps, progressCalls } = makeDeps({ connectsAtMs: 3000 });
  const ok = await pollForReconnect(180000, deps);
  assert.equal(ok, true);
  assert.deepEqual(progressCalls, []);
});
