import { parseArgs } from "node:util";
import type { Command } from "../cli.js";
import { EXIT, type ExitCode } from "../output/exit-codes.js";
import { printJson, sanitizePath } from "../output/print.js";
import { createCheckpoint } from "../premiere/checkpoint.js";

async function runCheckpoint(argv: string[]): Promise<ExitCode> {
  const { values } = parseArgs({
    args: argv,
    options: { json: { type: "boolean", default: false } },
  });

  const result = await createCheckpoint();
  if (values.json) {
    printJson({ ok: true, ...result });
  } else {
    process.stdout.write(`checkpoint saved → ${sanitizePath(result.checkpointPath)}\n`);
  }
  return EXIT.OK;
}

export const checkpoint: Command = {
  name: "checkpoint",
  summary: "Save the project and snapshot the .prproj file",
  run: runCheckpoint,
};
