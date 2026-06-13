import { test } from "node:test";
import assert from "node:assert/strict";
import {
  isSupportedPlatform,
  isExperimentalPlatform,
  upiaPath,
  premiereSearchDirs,
  whichCommand,
} from "../dist/platform.js";

test("isSupportedPlatform: mac and windows supported, linux not", () => {
  assert.equal(isSupportedPlatform("darwin"), true);
  assert.equal(isSupportedPlatform("win32"), true);
  assert.equal(isSupportedPlatform("linux"), false);
});

test("isExperimentalPlatform: only windows", () => {
  assert.equal(isExperimentalPlatform("win32"), true);
  assert.equal(isExperimentalPlatform("darwin"), false);
});

test("upiaPath: mac returns the verified .app path", () => {
  const p = upiaPath("darwin");
  assert.ok(p && p.endsWith("/Contents/MacOS/UnifiedPluginInstallerAgent"));
  assert.ok(p.startsWith("/Library/Application Support/Adobe"));
});

test("upiaPath: windows returns an .exe under Common Files, honoring env", () => {
  const p = upiaPath("win32", { "CommonProgramFiles(x86)": "D:\\Common" });
  assert.equal(
    p,
    "D:\\Common\\Adobe\\Adobe Desktop Common\\RemoteComponents\\UPI\\UnifiedPluginInstallerAgent\\UnifiedPluginInstallerAgent.exe",
  );
});

test("upiaPath: windows falls back to default Common Files when env absent", () => {
  const p = upiaPath("win32", {});
  assert.ok(p && p.startsWith("C:\\Program Files (x86)\\Common Files\\Adobe"));
  assert.ok(p.endsWith("UnifiedPluginInstallerAgent.exe"));
});

test("upiaPath: unsupported platform returns null", () => {
  assert.equal(upiaPath("linux"), null);
});

test("premiereSearchDirs: mac scans /Applications", () => {
  assert.deepEqual(premiereSearchDirs("darwin"), ["/Applications"]);
});

test("premiereSearchDirs: windows scans Program Files\\Adobe, honoring env", () => {
  assert.deepEqual(premiereSearchDirs("win32", { ProgramFiles: "D:\\PF" }), ["D:\\PF\\Adobe"]);
});

test("whichCommand: where on windows, which elsewhere", () => {
  assert.equal(whichCommand("win32"), "where");
  assert.equal(whichCommand("darwin"), "which");
  assert.equal(whichCommand("linux"), "which");
});
