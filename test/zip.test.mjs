import { test } from "node:test";
import assert from "node:assert/strict";
import zlib from "node:zlib";
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, rmSync } from "node:fs";
import { execFileSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { createZip, collectZipEntries, zipDirectory } from "../dist/archive/zip.js";

// Independent validation: is Info-ZIP's `unzip` available? On macOS yes; on the
// Windows CI runner no — so the unzip-based integrity test self-skips there.
let hasUnzip = false;
try {
  execFileSync("unzip", ["-v"], { stdio: "ignore" });
  hasUnzip = true;
} catch {
  hasUnzip = false;
}

// Minimal in-process ZIP reader (no external `unzip`), so this test runs
// identically on macOS and Windows CI. Assumes no data descriptors (flags=0),
// which is exactly what createZip emits.
function readZip(buf) {
  const out = {};
  let i = 0;
  while (buf.readUInt32LE(i) === 0x04034b50) {
    const method = buf.readUInt16LE(i + 8);
    const compSize = buf.readUInt32LE(i + 18);
    const nameLen = buf.readUInt16LE(i + 26);
    const extraLen = buf.readUInt16LE(i + 28);
    const name = buf.toString("utf8", i + 30, i + 30 + nameLen);
    const dataStart = i + 30 + nameLen + extraLen;
    const raw = buf.subarray(dataStart, dataStart + compSize);
    out[name] = method === 8 ? zlib.inflateRawSync(raw) : Buffer.from(raw);
    i = dataStart + compSize;
  }
  return out;
}

test("createZip round-trips entries with correct names and content", () => {
  const entries = [
    { name: "manifest.json", data: Buffer.from('{"id":"test"}') },
    { name: "handlers/index.js", data: Buffer.from("export const x = 1;\n".repeat(50)) },
  ];
  const zip = createZip(entries);
  const read = readZip(zip);

  assert.deepEqual(Object.keys(read).sort(), ["handlers/index.js", "manifest.json"]);
  assert.equal(read["manifest.json"].toString(), '{"id":"test"}');
  assert.equal(read["handlers/index.js"].toString(), "export const x = 1;\n".repeat(50));
});

test("createZip uses forward-slash names for nested paths", () => {
  const zip = createZip([{ name: "a/b/c.txt", data: Buffer.from("hi") }]);
  assert.ok(Object.keys(readZip(zip)).includes("a/b/c.txt"));
});

test("zipDirectory packages a tree with manifest at root and skips dotfiles", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ppro-zip-test-"));
  try {
    writeFileSync(path.join(dir, "manifest.json"), '{"id":"d16fa6a4"}');
    mkdirSync(path.join(dir, "handlers"));
    writeFileSync(path.join(dir, "handlers", "main.js"), "console.log(1)");
    writeFileSync(path.join(dir, ".DS_Store"), "junk"); // must be excluded

    const outPath = path.join(dir, "out.ccx");
    zipDirectory(dir, outPath);
    const read = readZip(readFileSync(outPath));

    assert.ok("manifest.json" in read, "manifest.json must be at archive root");
    assert.ok("handlers/main.js" in read, "nested file must be present");
    assert.ok(!(".DS_Store" in read), "dotfiles must be excluded");
    assert.equal(read["manifest.json"].toString(), '{"id":"d16fa6a4"}');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("node-zip output passes an independent unzip integrity check", { skip: !hasUnzip }, () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ppro-zip-unzip-"));
  try {
    writeFileSync(path.join(dir, "manifest.json"), '{"id":"d16fa6a4","version":"0.1.0"}');
    mkdirSync(path.join(dir, "handlers"));
    writeFileSync(path.join(dir, "handlers", "main.js"), "console.log(1)\n".repeat(40));

    const outPath = path.join(dir, "out.ccx");
    zipDirectory(dir, outPath);

    // `unzip -t` is a separate zip implementation verifying CRCs and structure.
    const out = execFileSync("unzip", ["-t", outPath], { encoding: "utf8" });
    assert.match(out, /No errors detected in compressed data/);
    assert.match(out, /manifest\.json/);
    assert.match(out, /handlers\/main\.js/);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("collectZipEntries returns sorted forward-slash entries", () => {
  const dir = mkdtempSync(path.join(os.tmpdir(), "ppro-zip-collect-"));
  try {
    mkdirSync(path.join(dir, "sub"));
    writeFileSync(path.join(dir, "a.txt"), "a");
    writeFileSync(path.join(dir, "sub", "b.txt"), "b");
    const names = collectZipEntries(dir).map((e) => e.name);
    assert.deepEqual(names, ["a.txt", "sub/b.txt"]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
