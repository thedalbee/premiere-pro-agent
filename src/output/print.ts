import os from "node:os";

// Doctor output gets pasted into GitHub issues — never leak the user's home path.
export function sanitizePath(text: string): string {
  return text.split(os.homedir()).join("~");
}

export function printJson(data: unknown): void {
  process.stdout.write(JSON.stringify(data, null, 2) + "\n");
}

// Progress and human-facing notes go to stderr so --json stdout stays machine-clean.
export function note(message: string): void {
  process.stderr.write(message + "\n");
}
