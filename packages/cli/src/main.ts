import { apply } from "./apply.ts";
import { baseline } from "./baseline.ts";
import { check } from "./check.ts";
import { parseCommand, usage, UsageError, wantsJson } from "./command.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { generate } from "./generate.ts";
import { CommandError, exitCode, toJson, toText } from "./outcome.ts";
import type { Failure, Outcome } from "./outcome.ts";
import { status } from "./status.ts";

/** Everything the CLI reads from and writes to its process, so that tests can stand in for it. */
export interface Io extends Context {
  readonly stdout: (text: string) => void;
  readonly stderr: (text: string) => void;
}

interface Ran {
  readonly command: string;
  readonly outcome: Outcome;
}

/** Runs `ottersql <args>` and returns its exit code. */
export async function main(args: readonly string[], io: Io): Promise<number> {
  const ran = await run(args, io);
  if (ran === null) {
    io.stdout(usage);
    return 0;
  }
  if (wantsJson(args)) {
    io.stdout(toJson(ran.command, ran.outcome));
  } else {
    const { stdout, stderr } = toText(ran.outcome);
    io.stdout(stdout);
    io.stderr(stderr);
  }
  return exitCode(ran.outcome);
}

/** How the command ended, or `null` when it asked for help. */
async function run(args: readonly string[], io: Io): Promise<Ran | null> {
  const command = parsed(args, io);
  if ("ok" in command) {
    return { command: "ottersql", outcome: command };
  }
  if (command.name === "help") {
    return null;
  }
  try {
    return { command: command.name, outcome: await runCommand(io, command) };
  } catch (error) {
    return { command: command.name, outcome: failure(error, io) };
  }
}

function parsed(args: readonly string[], io: Io): Command | Failure {
  try {
    return parseCommand(args);
  } catch (error) {
    return failure(error, io);
  }
}

async function runCommand(
  context: Context,
  command: Exclude<Command, { name: "help" }>,
): Promise<Outcome> {
  if (command.name === "migrate generate") {
    return generate(context, command);
  }
  if (command.name === "migrate check") {
    return check(context, command);
  }
  if (command.name === "migrate status") {
    return status(context, command);
  }
  if (command.name === "migrate baseline") {
    return baseline(context, command);
  }
  return apply(context, command);
}

/** What a thrown error means for the user; an unexpected one is a bug, its stack on stderr. */
function failure(error: unknown, io: Io): Failure {
  if (error instanceof CommandError) {
    return error.failure;
  }
  if (error instanceof UsageError) {
    return {
      ok: false,
      kind: "invalid",
      code: "usage.invalid",
      why: error.message,
      fix: "Run `ottersql --help` for the commands and their options",
    };
  }
  io.stderr(`${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
  return {
    ok: false,
    kind: "failed",
    code: "internal",
    why: error instanceof Error ? error.message : String(error),
    fix: "This is a bug in ottersql; please report it with this output",
  };
}
