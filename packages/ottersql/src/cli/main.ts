import { createRequire } from "node:module";

import { QueryError } from "../sql/query-error.ts";
import { parseCommand, usage, UsageError, wantsJson } from "./command.ts";
import type { Command, Runnable } from "./command.ts";
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
  if (typeof ran === "string") {
    io.stdout(ran);
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

/** How the command ended, or the text to print when it asked for help or the version. */
async function run(args: readonly string[], io: Io): Promise<Ran | string> {
  const command = parsed(args, io);
  if ("ok" in command) {
    return { command: "ottersql", outcome: command };
  }
  if (command.name === "help" || command.name === "version") {
    return command.name === "help" ? usage() : `${version()}\n`;
  }
  try {
    return { command: command.name, outcome: await runCommand(io, command.name, command) };
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

type Runner<Name extends keyof Runnable> = (
  context: Context,
  command: Runnable[Name],
) => Promise<Outcome>;

/**
 * Each command's module, loaded only when it runs: a command that reads files starts without the
 * code, and the optional peers, that one connecting to a database or running PGlite needs.
 */
const modules: {
  readonly [Name in keyof Runnable]: () => Promise<{ readonly run: Runner<Name> }>;
} = {
  "migrate generate": async () => import("./commands/generate.ts"),
  "migrate check": async () => import("./commands/check.ts"),
  "migrate status": async () => import("./commands/status.ts"),
  "migrate baseline": async () => import("./commands/baseline.ts"),
  "migrate apply": async () => import("./commands/apply.ts"),
  push: async () => import("./commands/push.ts"),
  types: async () => import("./commands/types.ts"),
};

/** `name` is passed beside `command` so that TypeScript can match the module to the command. */
async function runCommand<Name extends keyof Runnable>(
  context: Context,
  name: Name,
  command: Runnable[Name],
): Promise<Outcome> {
  const commandModule = await modules[name]();
  return commandModule.run(context, command);
}

/** This package's version, read from its package.json, which is beside both src and dist. */
function version(): string {
  const manifest: unknown = createRequire(import.meta.url)("../../package.json");
  const value: unknown =
    typeof manifest === "object" && manifest !== null ? Reflect.get(manifest, "version") : null;
  return String(value);
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
  const known = knownFailure(error);
  if (known !== null) {
    return known;
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

/** The failure an error the command expects stands for, or `null` for any other. */
function knownFailure(error: unknown): Failure | null {
  if (error instanceof CommandError) {
    return error.failure;
  }
  if (error instanceof QueryError) {
    return {
      ok: false,
      kind: "failed",
      code: "database.query_failed",
      why: `The database rejected a statement: ${error.message} (SQLSTATE ${error.code})`,
      fix: "Check that the database user may do this and that the database is the one DATABASE_URL should name",
      result: { sqlstate: error.code, constraint: error.constraint, table: error.table },
    };
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
  return error instanceof UsageError
    ? {
        ok: false,
        kind: "invalid",
        code: "usage.invalid",
        why: error.message,
        fix: "Run `ottersql --help` for the commands and their options",
      }
    : null;
}
