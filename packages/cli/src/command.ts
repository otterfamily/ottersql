import { parseArgs } from "node:util";

import { isMigrationLabel } from "@ottersql/migrate";

/** What the command line asks for, parsed once where it enters. */
export type Command =
  | { readonly name: "help" }
  | {
      readonly name: "migrate generate";
      readonly migration: string;
      readonly project: Project;
      /** Writes a file for steps written by hand instead of the planned changes. */
      readonly empty: boolean;
    }
  | { readonly name: "migrate check"; readonly project: Project }
  | {
      readonly name: "migrate apply";
      readonly project: Project;
      readonly phase: "expand" | "contract" | null;
      readonly approve: string | null;
    };

/** The tsconfig to read the schema's place from; `null` for `tsconfig.json` if there is one. */
export type Project = string | null;

/** Arguments that name no command; the message says why. */
export class UsageError extends Error {
  override readonly name = "UsageError";
}

export const usage = `Usage: ottersql <command> [options]

Commands:
  ottersql migrate generate <name>   Write what schema.sql adds as the next migration
  ottersql migrate check             Check that the migrations build schema.sql
  ottersql migrate apply             Apply the pending migration steps to DATABASE_URL

Options:
  --json                Print one JSON object on stdout: { ok, command, result } or
                        { ok: false, command, code, why, fix, where?, result? }
  --project <tsconfig>  The tsconfig whose @ottersql/content-mapper "schema" option names
                        schema.sql (default: tsconfig.json, else db/schema.sql)
  --phase <phase>       apply: only "expand" steps (before the app deploys) or
                        "contract" steps (after it)
  --approve <approval>  apply: run steps that cannot be undone; the approval comes from the
                        refusal that listed them, and only a person can give it
  --empty               generate: write a file for steps written by hand, such as moving data
  -h, --help            Show this help

Migrations live in the migrations/ directory next to schema.sql.

Exit codes:
  0  Done
  1  Ran and failed, such as a step the database rejected
  2  Nothing ran: the arguments, the files or the migration history are wrong
  3  Nothing ran: steps that cannot be undone need a person's approval
  4  Ran and found something to fix, such as migrations that do not build schema.sql
`;

const options = {
  json: { type: "boolean" },
  project: { type: "string" },
  phase: { type: "string" },
  approve: { type: "string" },
  empty: { type: "boolean" },
  help: { type: "boolean", short: "h" },
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
  const [group, verb, ...rest] = positionals;
  if (group === undefined || verb === undefined) {
    throw new UsageError("Name a command; run `ottersql --help` for the list");
  }
  const name = `${group} ${verb}`;
  refuseOtherOptions(name, values);
  return commandOf(name, rest, values);
}

/** The options only one command takes. */
const optionCommands = {
  phase: "migrate apply",
  approve: "migrate apply",
  empty: "migrate generate",
} as const;

function refuseOtherOptions(name: string, values: Values): void {
  for (const option of ["phase", "approve", "empty"] as const) {
    if (name !== optionCommands[option] && values[option] !== undefined) {
      throw new UsageError(`${name} takes no --${option}`);
    }
  }
}

function commandOf(name: string, rest: readonly string[], values: Values): Command {
  const project = values.project ?? null;
  switch (name) {
    case "migrate generate": {
      return { name, migration: parseMigrationName(rest), project, empty: values.empty === true };
    }
    case "migrate check": {
      noMore(rest);
      return { name, project };
    }
    case "migrate apply": {
      noMore(rest);
      return { name, project, phase: parsePhase(values.phase), approve: values.approve ?? null };
    }
    default: {
      throw new UsageError(`Unknown command: ${name}; run \`ottersql --help\` for the list`);
    }
  }
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
  if (!isMigrationLabel(name)) {
    throw new UsageError(
      `A migration name is lowercase letters, digits and underscores, not ${JSON.stringify(name)}`,
    );
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

function noMore(rest: readonly string[]): void {
  if (rest.length > 0) {
    throw new UsageError(`Unexpected argument: ${rest.join(" ")}`);
  }
}
