import { parseArgs } from "node:util";

import { migrationLabelProblem } from "../migrate/files/migration-name.ts";
import { DEFAULT_LOCK_WAIT } from "../migrate/run/run-lock.ts";

/** What the command line asks for, parsed once where it enters. */
export type Command =
  | { readonly name: "help" }
  | { readonly name: "version" }
  | {
      readonly name: "migrate generate";
      readonly migration: string;
      readonly project: Project;
      /** Writes a file for steps written by hand instead of the planned changes. */
      readonly empty: boolean;
    }
  | { readonly name: "migrate check"; readonly project: Project }
  | { readonly name: "migrate status"; readonly project: Project }
  | {
      readonly name: "migrate baseline";
      /** The first migration's name, needed only while there are no migrations. */
      readonly migration: string | null;
      readonly project: Project;
    }
  | { readonly name: "push"; readonly project: Project; readonly approve: string | null }
  | {
      readonly name: "types";
      readonly project: Project;
      /** Reports declaration files that are missing or out of date instead of writing them. */
      readonly check: boolean;
    }
  | {
      readonly name: "migrate apply";
      readonly project: Project;
      readonly phase: "expand" | "contract" | null;
      readonly approve: string | null;
      /** Milliseconds to wait for another run that holds the migration lock; `null` for the default. */
      readonly lockWait: number | null;
    };

/** The commands that run, each by its name. */
export type Runnable = {
  readonly [Run in Exclude<Command, { name: "help" | "version" }> as Run["name"]]: Run;
};

/** The tsconfig to read the schema's place from; `null` for `tsconfig.json` if there is one. */
export type Project = string | null;

/** Arguments that name no command; the message says why. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

const MILLISECONDS_PER_SECOND = 1000;

export function usage(): string {
  return `Usage: ottersql <command> [options]

Commands:
  ottersql migrate generate <name>   Write what schema.sql adds as the next migration
  ottersql migrate check             Check that the migrations build schema.sql
  ottersql migrate status            List the steps applied to DATABASE_URL, and changes made
                                     there outside the migrations
  ottersql migrate apply             Apply the pending migration steps to DATABASE_URL
  ottersql migrate baseline [<name>] Start from the existing database at DATABASE_URL: write its
                                     schema as the first migration and record it as applied

  ottersql push                      Bring the database at DATABASE_URL, on this machine only, to
                                     schema.sql directly, without migrations

  ottersql types                     Write queries.d.sql.ts next to each .sql query file, for
                                     tools that cannot run TypeScript 7.1 content mappers; they
                                     need "allowArbitraryExtensions" in tsconfig.json

Options:
  --json                Print one JSON object on stdout: { ok, command, result } or
                        { ok: false, command, code, why, fix, where?, result? }
  --project <tsconfig>  The tsconfig whose ottersql "schema" option names
                        schema.sql (default: tsconfig.json, else db/schema.sql)
  --phase <phase>       apply: only "expand" steps (before the app deploys) or
                        "contract" steps (after it)
  --approve <approval>  apply, push: run steps that cannot be undone; the approval comes from the
                        refusal that listed them, and only a person can give it
  --lock-wait <seconds> apply: how long to wait for another run applying migrations to the same
                        database (default: ${String(DEFAULT_LOCK_WAIT / MILLISECONDS_PER_SECOND)})
  --empty               generate: write a file for steps written by hand, such as moving data
  --check               types: report declaration files that are missing or out of date
  -h, --help            Show this help

Migrations live in the migrations/ directory next to schema.sql.

Exit codes:
  0  Done
  1  Failed, such as a step the database rejected or a lock another run kept too long
  2  Nothing ran: the arguments, the files or the migration history are wrong
  3  Nothing ran: steps that cannot be undone need a person's approval
  4  Ran and found something to fix, such as migrations that do not build schema.sql, or a
     database changed outside its migrations
`;
}

const options = {
  json: { type: "boolean" },
  project: { type: "string" },
  phase: { type: "string" },
  approve: { type: "string" },
  "lock-wait": { type: "string" },
  empty: { type: "boolean" },
  check: { type: "boolean" },
  help: { type: "boolean", short: "h" },
  version: { type: "boolean" },
} as const;

/** Whether the output is to be JSON; read apart from parsing, so that usage errors honour it. */
export function wantsJson(args: readonly string[]): boolean {
  return args.includes("--json");
}

const parseConfig = { options, allowPositionals: true, strict: true } as const;

type Parsed = ReturnType<typeof parseArgs<typeof parseConfig>>;
type Values = Parsed["values"];

/** Throws a `UsageError` when `args` name no command or options it does not take. */
export function parseCommand(args: readonly string[]): Command {
  const { values, positionals } = parse(args);
  if (values.help === true) {
    return { name: "help" };
  }
  if (values.version === true) {
    return { name: "version" };
  }
  const { name, rest } = commandName(positionals);
  refuseOtherOptions(name, values);
  if (!isRunnable(name)) {
    throw unknownCommand(name);
  }
  return parsers[name]({ rest, values, project: values.project ?? null });
}

function unknownCommand(name: string): UsageError {
  return new UsageError(`Unknown command: ${name}; run \`ottersql --help\` for the list`);
}

/** The command's name, one word or a group and a verb, and the arguments after it. */
function commandName(positionals: readonly string[]): { name: string; rest: readonly string[] } {
  const [group, ...afterGroup] = positionals;
  if (group !== undefined && isOneWordCommand(group)) {
    return { name: group, rest: afterGroup };
  }
  if (group !== undefined && group !== "migrate") {
    throw unknownCommand(group);
  }
  const [verb, ...rest] = afterGroup;
  if (group === undefined || verb === undefined) {
    throw new UsageError("Name a command; run `ottersql --help` for the list");
  }
  return { name: `${group} ${verb}`, rest };
}

/** Whether `word` names a command by itself; the others are a group and a verb. */
function isOneWordCommand(word: string): boolean {
  return !word.includes(" ") && isRunnable(word);
}

/** The options only some commands take. */
const optionCommands = {
  phase: ["migrate apply"],
  approve: ["migrate apply", "push"],
  "lock-wait": ["migrate apply"],
  empty: ["migrate generate"],
  check: ["types"],
} as const satisfies Record<string, readonly (keyof Runnable)[]>;

function refuseOtherOptions(name: string, values: Values): void {
  for (const [option, commands] of Object.entries(optionCommands)) {
    const takers: readonly string[] = commands;
    if (!takers.includes(name) && Object.hasOwn(values, option)) {
      throw new UsageError(`${name} takes no --${option}`);
    }
  }
}

/** What follows a command's name, and the --project that every command takes. */
interface Input {
  readonly rest: readonly string[];
  readonly values: Values;
  readonly project: Project;
}

type Parser<Name extends keyof Runnable> = (input: Input) => Runnable[Name];

/** How each command reads what follows its name. */
const parsers: { readonly [Name in keyof Runnable]: Parser<Name> } = {
  "migrate generate": ({ rest, values, project }) => ({
    name: "migrate generate",
    migration: parseMigrationName(rest),
    project,
    empty: values.empty === true,
  }),
  "migrate check": withoutArguments(({ project }) => ({ name: "migrate check", project })),
  "migrate status": withoutArguments(({ project }) => ({ name: "migrate status", project })),
  "migrate baseline": ({ rest, project }) => ({
    name: "migrate baseline",
    migration: rest.length === 0 ? null : parseMigrationName(rest),
    project,
  }),
  "migrate apply": withoutArguments(({ values, project }) => ({
    name: "migrate apply",
    project,
    phase: parsePhase(values.phase),
    approve: values.approve ?? null,
    lockWait: parseLockWait(values["lock-wait"]),
  })),
  push: withoutArguments(({ values, project }) => ({
    name: "push",
    project,
    approve: values.approve ?? null,
  })),
  types: withoutArguments(({ values, project }) => ({
    name: "types",
    project,
    check: values.check === true,
  })),
};

function isRunnable(name: string): name is keyof Runnable {
  return Object.hasOwn(parsers, name);
}

/** `parser` for a command that takes no arguments after its name. */
function withoutArguments<Name extends keyof Runnable>(parser: Parser<Name>): Parser<Name> {
  return (input) => {
    noMore(input.rest);
    return parser(input);
  };
}

function parse(args: readonly string[]): Parsed {
  try {
    return parseArgs({ ...parseConfig, args: [...args] });
  } catch (error) {
    if (error instanceof TypeError) {
      throw new UsageError(error.message, { cause: error });
    }
    throw error;
  }
}

function parseMigrationName(rest: readonly string[]): string {
  const [name, ...more] = rest;
  if (name === undefined) {
    throw new UsageError("Name the migration, such as `add_users`");
  }
  noMore(more);
  const problem = migrationLabelProblem(name);
  if (problem !== null) {
    throw new UsageError(problem);
  }
  return name;
}

function parsePhase(phase: string | undefined): "expand" | "contract" | null {
  if (phase === undefined) {
    return null;
  }
  if (phase === "expand" || phase === "contract") {
    return phase;
  }
  throw new UsageError(`--phase is expand or contract, not ${JSON.stringify(phase)}`);
}

function parseLockWait(seconds: string | undefined): number | null {
  if (seconds === undefined) {
    return null;
  }
  // Plain decimals only: Number would also take hexadecimal, exponents and blank text.
  if (!/^\d+(?:\.\d+)?$/v.test(seconds)) {
    throw new UsageError(`--lock-wait is a number of seconds, not ${JSON.stringify(seconds)}`);
  }
  return Number(seconds) * MILLISECONDS_PER_SECOND;
}

function noMore(rest: readonly string[]): void {
  if (rest.length > 0) {
    throw new UsageError(`Unexpected argument: ${rest.join(" ")}`);
  }
}
