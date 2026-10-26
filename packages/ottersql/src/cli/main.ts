import { parseCommand, usage, UsageError, wantsJson } from "./command.ts";
import type { Command } from "./command.ts";
import type { Context } from "./context.ts";
import { CommandError, exitCode, toJson, toText } from "./outcome.ts";
import type { Failure, Outcome } from "./outcome.ts";

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

/**
 * Runs `command`, loading its module only now: a command that reads files starts without the
 * code, and the optional peers, that one connecting to a database or running PGlite needs.
 */
async function runCommand(
  context: Context,
  command: Exclude<Command, { name: "help" }>,
): Promise<Outcome> {
  if (command.name === "push") {
    const { push } = await import("./push.ts");
    return push(context, command);
  }
  if (command.name === "types") {
    const { types } = await import("./types.ts");
    return types(context, command);
  }
  return runMigrate(context, command);
}

/** The migrate commands that work from files alone. */
async function runMigrate(
  context: Context,
  command: Exclude<Command, { name: "help" | "push" | "types" }>,
): Promise<Outcome> {
  if (command.name === "migrate generate") {
    const { generate } = await import("./generate.ts");
    return generate(context, command);
  }
  if (command.name === "migrate check") {
    const { check } = await import("./check.ts");
    return check(context, command);
  }
  return runMigrateOnDatabase(context, command);
}

/** The migrate commands that connect to the database. */
async function runMigrateOnDatabase(
  context: Context,
  command: Extract<Command, { name: "migrate status" | "migrate baseline" | "migrate apply" }>,
): Promise<Outcome> {
  if (command.name === "migrate status") {
    const { status } = await import("./status.ts");
    return status(context, command);
  }
  if (command.name === "migrate baseline") {
    const { baseline } = await import("./baseline.ts");
    return baseline(context, command);
  }
  const { apply } = await import("./apply.ts");
  return apply(context, command);
}

/** The optional peer an error says is not installed, from Node's ERR_MODULE_NOT_FOUND. */
function missingPeer(error: unknown): string | null {
  if (!(error instanceof Error) || !("code" in error) || error.code !== "ERR_MODULE_NOT_FOUND") {
    return null;
  }
  return error.message.includes("'@electric-sql/pglite'") ? "@electric-sql/pglite" : null;
}

/** What a thrown error means for the user; an unexpected one is a bug, its stack on stderr. */
function failure(error: unknown, io: Io): Failure {
  if (error instanceof CommandError) {
    return error.failure;
  }
  const peer = missingPeer(error);
  if (peer !== null) {
    return {
      ok: false,
      kind: "invalid",
      code: "project.peer_missing",
      why: `This command runs Postgres in-process with ${peer}, which is not installed`,
      fix: `Install it next to ottersql: npm install --save-dev ${peer}`,
    };
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
