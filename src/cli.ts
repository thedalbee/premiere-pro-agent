import { checkpoint } from "./commands/checkpoint.js";
import { cleanup } from "./commands/cleanup.js";
import { cut } from "./commands/cut.js";
import { doctor } from "./commands/doctor.js";
import { gaps } from "./commands/gaps.js";
import { setup } from "./commands/setup.js";
import { silence } from "./commands/silence.js";
import { status } from "./commands/status.js";
import { transcribeCommand } from "./commands/transcribe.js";
import { EXIT, type ExitCode } from "./output/exit-codes.js";

export interface Command {
  name: string;
  summary: string;
  run(argv: string[]): Promise<ExitCode>;
}

// `undo` (src/commands/undo.ts) is intentionally NOT registered yet: its
// destructive path (save → quit Premiere → swap checkpoint → reopen) is not
// live-verified. Ship it in v0.2 once verified; the code + tests already exist.
const COMMANDS: Command[] = [setup, doctor, status, transcribeCommand, silence, gaps, cut, checkpoint, cleanup];

function printUsage(): void {
  const width = Math.max(...COMMANDS.map((c) => c.name.length));
  const lines = [
    "ppro — CLI that lets AI agents edit your Adobe Premiere Pro timeline",
    "",
    "Usage: ppro <command> [options]",
    "",
    "Commands:",
    ...COMMANDS.map((c) => `  ${c.name.padEnd(width + 2)}${c.summary}`),
    "",
    "Global options:",
    "  --json   Machine-readable output on stdout (progress goes to stderr)",
    "  --help   Show this help",
    "",
  ];
  process.stdout.write(lines.join("\n"));
}

async function main(): Promise<ExitCode> {
  const [, , name, ...rest] = process.argv;

  if (!name || name === "help" || name === "--help" || name === "-h") {
    printUsage();
    return name ? EXIT.OK : EXIT.USAGE;
  }

  const command = COMMANDS.find((c) => c.name === name);
  if (!command) {
    process.stderr.write(`ppro: unknown command "${name}"\n\n`);
    printUsage();
    return EXIT.USAGE;
  }

  try {
    return await command.run(rest);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`ppro ${name}: ${message}\n`);
    return EXIT.FAILED;
  }
}

process.exitCode = await main();
