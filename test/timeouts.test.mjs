import { test } from "node:test";
import assert from "node:assert/strict";
import {
  reopenTimeoutMs,
  reconnectTimeoutMs,
  projectInfoTimeoutMs,
} from "../dist/premiere/timeouts.js";

// Each resolver: env var name, default, and the live getter.
const cases = [
  { name: "reopen", env: "PPRO_REOPEN_TIMEOUT_MS", def: 30000, fn: reopenTimeoutMs },
  { name: "reconnect", env: "PPRO_RECONNECT_TIMEOUT_MS", def: 30000, fn: reconnectTimeoutMs },
  { name: "projectInfo", env: "PPRO_PROJECT_INFO_TIMEOUT_MS", def: 5000, fn: projectInfoTimeoutMs },
];

function withEnv(name, value, body) {
  const had = Object.prototype.hasOwnProperty.call(process.env, name);
  const prev = process.env[name];
  try {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
    body();
  } finally {
    if (had) process.env[name] = prev;
    else delete process.env[name];
  }
}

for (const c of cases) {
  test(`${c.name}: returns default when env var is unset`, () => {
    withEnv(c.env, undefined, () => {
      assert.equal(c.fn(), c.def);
    });
  });

  test(`${c.name}: returns the overridden value for a valid positive integer`, () => {
    withEnv(c.env, "120000", () => {
      assert.equal(c.fn(), 120000);
    });
  });

  test(`${c.name}: falls back to default on a malformed value`, () => {
    withEnv(c.env, "abc", () => {
      assert.equal(c.fn(), c.def);
    });
  });

  test(`${c.name}: falls back to default on a non-positive value`, () => {
    withEnv(c.env, "0", () => {
      assert.equal(c.fn(), c.def);
    });
    withEnv(c.env, "-5", () => {
      assert.equal(c.fn(), c.def);
    });
  });

  test(`${c.name}: falls back to default on an empty string`, () => {
    withEnv(c.env, "", () => {
      assert.equal(c.fn(), c.def);
    });
  });
}
