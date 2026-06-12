import fs from "node:fs";

// Bumped only when the daemon↔plugin message shape changes.
// A mismatch means the installed plugin and the CLI are from different
// releases — doctor tells the user to re-run `ppro setup`.
export const PROTOCOL = 1;

let cached: string | null = null;

export function cliVersion(): string {
  if (cached) return cached;
  const packageJson = new URL("../package.json", import.meta.url);
  cached = (JSON.parse(fs.readFileSync(packageJson, "utf8")) as { version: string }).version;
  return cached;
}
