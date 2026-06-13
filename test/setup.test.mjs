import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readdirSync, rmSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { packagePlugin } from "../dist/commands/setup.js";

// Create an isolated temp dir to use as fake output location for each test
function makeTempDir() {
  return mkdtempSync(path.join(os.tmpdir(), "ppro-setup-test-"));
}

test("packagePlugin writes a .ccx file to the specified output dir", async () => {
  const tmpDir = makeTempDir();
  try {
    const result = await packagePlugin(tmpDir);

    assert.ok(existsSync(result.ccxPath), `ccx not found at ${result.ccxPath}`);
    assert.ok(result.ccxPath.endsWith(".ccx"), "output file should have .ccx extension");
    assert.equal(result.pluginId, "d16fa6a4", "plugin id should match manifest");
    assert.equal(result.pluginVersion, "0.1.0", "version should match manifest");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("packaged .ccx contains manifest.json at root level", async () => {
  const tmpDir = makeTempDir();
  try {
    const result = await packagePlugin(tmpDir);

    // List zip contents and verify manifest.json is at root (no path prefix)
    const listing = execFileSync("unzip", ["-Z1", result.ccxPath], { encoding: "utf8" });
    const entries = listing.split("\n").map((e) => e.trim()).filter(Boolean);

    assert.ok(
      entries.includes("manifest.json"),
      `manifest.json not found at zip root. Entries:\n${entries.join("\n")}`,
    );
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test("packagePlugin is idempotent — second call overwrites existing ccx", async () => {
  const tmpDir = makeTempDir();
  try {
    const first = await packagePlugin(tmpDir);
    const second = await packagePlugin(tmpDir);

    assert.equal(first.ccxPath, second.ccxPath, "both runs should produce same path");
    assert.ok(existsSync(second.ccxPath), "ccx should exist after second run");
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});
