import { parseArgs } from "node:util";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { printJson, note } from "../output/print.js";
import { starNudge } from "../output/star-nudge.js";
import {
  IS_WINDOWS,
  isSupportedPlatform,
  isExperimentalPlatform,
  upiaPath,
} from "../platform.js";
import { zipDirectory } from "../archive/zip.js";

const run = promisify(execFile);

export interface PackageResult {
  ccxPath: string;
  pluginId: string;
  pluginVersion: string;
}

export async function packagePlugin(outputDir?: string): Promise<PackageResult> {
  // Resolve package root relative to dist/commands/setup.js
  const distCommands = path.dirname(fileURLToPath(import.meta.url));
  const distDir = path.dirname(distCommands);
  const packageRoot = path.dirname(distDir);
  const pluginDir = path.join(packageRoot, "plugin");

  const manifestPath = path.join(pluginDir, "manifest.json");
  const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as {
    id: string;
    version: string;
    host: unknown;
  };

  if (Array.isArray(manifest.host)) {
    throw new Error("manifest.host must be an object, not an array (UPIA error -267)");
  }

  const { id: pluginId, version: pluginVersion } = manifest;
  const ccxName = `premiere-pro-agent-${pluginVersion}.ccx`;
  const targetDir = outputDir ?? path.join(os.homedir(), ".ppro");

  fs.mkdirSync(targetDir, { recursive: true });

  const ccxPath = path.join(targetDir, ccxName);
  // Remove existing ccx before repackaging (zip -qr would append otherwise)
  try {
    fs.rmSync(ccxPath, { force: true });
  } catch {
    // ignore
  }

  if (IS_WINDOWS) {
    // No `zip` CLI on Windows — build the .ccx with the dependency-free writer.
    zipDirectory(pluginDir, ccxPath);
  } else {
    await run("zip", ["-qr", ccxPath, ".", "-x", ".*", "-x", "*/.*"], { cwd: pluginDir });
  }

  return { ccxPath, pluginId, pluginVersion };
}

async function runSetup(argv: string[]): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  // 1. Supported platforms only (macOS verified; Windows experimental, Linux unsupported)
  if (!isSupportedPlatform()) {
    const msg = `ppro setup: unsupported platform "${process.platform}" — macOS and Windows only`;
    if (values.json) {
      printJson({ ok: false, error: msg });
    } else {
      process.stderr.write(msg + "\n");
    }
    return EXIT.FAILED;
  }
  if (isExperimentalPlatform()) {
    note("⚠ Windows support is experimental and not yet verified on real hardware — please report issues.");
  }

  // 2. UPIA must exist
  const upia = upiaPath();
  if (!upia || !fs.existsSync(upia)) {
    const msg =
      "Adobe Unified Plugin Installer Agent not found.\n" +
      "Install the Adobe Creative Cloud desktop app first, then try again.";
    if (values.json) {
      printJson({ ok: false, error: msg });
    } else {
      process.stderr.write(msg + "\n");
    }
    return EXIT.MISSING_DEPENDENCY;
  }

  // 3. Package the plugin
  note("Packaging plugin…");
  let pkg: PackageResult;
  try {
    pkg = await packagePlugin();
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    if (values.json) {
      printJson({ ok: false, error: msg });
    } else {
      process.stderr.write(`ppro setup: failed to package plugin — ${msg}\n`);
    }
    return EXIT.FAILED;
  }
  note(`  → ${pkg.ccxPath}`);

  // 4. Install via UPIA
  note("Installing via UPIA…");
  let upiaOutput = "";
  try {
    const { stdout, stderr } = await run(upia, ["--install", pkg.ccxPath]);
    upiaOutput = (stdout + stderr).trim();
  } catch (error) {
    // UPIA exits 0 even on failure, but capture any real exec error
    upiaOutput = error instanceof Error ? error.message : String(error);
  }

  // UPIA prints "Installation Successful" on success, "Failed to install, status = <code>!" on failure
  const success = upiaOutput.includes("Installation Successful");

  if (!success) {
    const msg = `UPIA reported failure: ${upiaOutput}`;
    if (values.json) {
      printJson({ ok: false, error: msg, upiaOutput });
    } else {
      process.stderr.write(`ppro setup: ${msg}\n`);
    }
    return EXIT.FAILED;
  }

  // 5. Report success
  if (values.json) {
    printJson({
      ok: true,
      ccxPath: pkg.ccxPath,
      pluginId: pkg.pluginId,
      pluginVersion: pkg.pluginVersion,
      upiaOutput,
    });
  } else {
    process.stdout.write(
      [
        "Plugin installed successfully!",
        "",
        `  Plugin:  ${pkg.pluginId}  v${pkg.pluginVersion}`,
        `  CCX:     ${pkg.ccxPath}`,
        "",
        "Next steps:",
        "  1. If Premiere Pro is running, restart it.",
        '  2. Open the "Premiere Pro Agent" panel in Premiere Pro',
        '     (Window > UXP > Premiere Pro Agent or via the UXP plugins area).',
        "  3. Run `ppro status` to verify the connection.",
        "",
      ].join("\n"),
    );
    starNudge();
  }

  return EXIT.OK;
}

export const setup: Command = {
  name: "setup",
  summary: "Package and install the UXP plugin via UPIA (one-command setup)",
  run: runSetup,
};
