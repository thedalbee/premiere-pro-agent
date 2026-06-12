import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { callPremiere } from "./client.js";

export interface CheckpointResult {
  checkpointPath: string;
  projectPath: string;
}

// A checkpoint is a snapshot of the whole .prproj file — not a duplicated
// sequence (the user explicitly banned _v2-style sequence copies). Premiere
// saves first so the file on disk matches what the user sees.
export async function createCheckpoint(): Promise<CheckpointResult> {
  const info = (await callPremiere("project.info")) as { open: boolean; path?: string };
  if (!info.open || !info.path) {
    throw new Error("no project open — cannot create a checkpoint");
  }
  await callPremiere("project.save");

  const projectName = path.basename(info.path, ".prproj");
  const dir = path.join(os.homedir(), ".ppro", "checkpoints", projectName);
  fs.mkdirSync(dir, { recursive: true });

  const stamp = new Date().toISOString().replace(/[:.]/g, "-").replace(/-\d+Z$/, "Z");
  const checkpointPath = path.join(dir, `${stamp}.prproj`);
  fs.copyFileSync(info.path, checkpointPath);
  return { checkpointPath, projectPath: info.path };
}

export function listCheckpoints(projectPath: string): string[] {
  const dir = path.join(os.homedir(), ".ppro", "checkpoints", path.basename(projectPath, ".prproj"));
  if (!fs.existsSync(dir)) return [];
  return fs
    .readdirSync(dir)
    .filter((name) => name.endsWith(".prproj"))
    .sort()
    .map((name) => path.join(dir, name));
}
