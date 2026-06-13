import path from "node:path";

export const IS_MAC = process.platform === "darwin";
export const IS_WINDOWS = process.platform === "win32";

/**
 * Platforms where the UXP panel + Premiere automation are wired up at all.
 * macOS is fully supported; Windows is experimental (see isExperimentalPlatform).
 */
export function isSupportedPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "darwin" || platform === "win32";
}

/** True on platforms whose support exists in code but is not yet verified on real hardware. */
export function isExperimentalPlatform(platform: NodeJS.Platform = process.platform): boolean {
  return platform === "win32";
}

/**
 * Absolute path to Adobe's Unified Plugin Installer Agent (UPIA) for this OS.
 *
 * The macOS path is verified. The Windows path is best-effort and NOT yet
 * verified on real hardware — Adobe installs UPIA under the 32-bit Common Files
 * tree, but the exact leaf name can vary by Creative Cloud version. Returns null
 * on unsupported platforms.
 */
export function upiaPath(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  if (platform === "darwin") {
    return "/Library/Application Support/Adobe/Adobe Desktop Common/RemoteComponents/UPI/UnifiedPluginInstallerAgent/UnifiedPluginInstallerAgent.app/Contents/MacOS/UnifiedPluginInstallerAgent";
  }
  if (platform === "win32") {
    const commonFiles =
      env["CommonProgramFiles(x86)"] ??
      env.CommonProgramFiles ??
      "C:\\Program Files (x86)\\Common Files";
    return path.win32.join(
      commonFiles,
      "Adobe",
      "Adobe Desktop Common",
      "RemoteComponents",
      "UPI",
      "UnifiedPluginInstallerAgent",
      "UnifiedPluginInstallerAgent.exe",
    );
  }
  return null;
}

/** Directories that may contain an installed Premiere Pro, for `doctor` discovery. */
export function premiereSearchDirs(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  if (platform === "darwin") return ["/Applications"];
  if (platform === "win32") {
    const programFiles = env.ProgramFiles ?? "C:\\Program Files";
    return [path.win32.join(programFiles, "Adobe")];
  }
  return [];
}

/** The shell builtin that resolves an executable's location on this OS. */
export function whichCommand(platform: NodeJS.Platform = process.platform): "which" | "where" {
  return platform === "win32" ? "where" : "which";
}
