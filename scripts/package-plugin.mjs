#!/usr/bin/env node
// Packages plugin/ into dist/premiere-pro-agent-<version>.ccx (a zip).
// UPIA rejects manifests where "host" is an array (-267 invalid manifest),
// so we validate the shape before zipping.
import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const pluginDir = path.join(root, "plugin");
const manifest = JSON.parse(readFileSync(path.join(pluginDir, "manifest.json"), "utf8"));

if (Array.isArray(manifest.host)) {
  console.error("manifest.host must be an object, not an array (UPIA error -267)");
  process.exit(1);
}

const outDir = path.join(root, "dist");
mkdirSync(outDir, { recursive: true });
const out = path.join(outDir, `premiere-pro-agent-${manifest.version}.ccx`);
rmSync(out, { force: true });

execFileSync("zip", ["-qr", out, ".", "-x", ".*", "-x", "*/.*"], { cwd: pluginDir, stdio: "inherit" });
console.log(out);
