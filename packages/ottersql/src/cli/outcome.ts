import type { FailureCode } from "./codes.ts";

/**
 * How a command ended. The JSON output and the exit code are promises agents rely on (ADR 0007),
 * so a failure's `code` keeps its meaning once published.
 */
export type Outcome = Success | Failure;

interface Success {
  readonly ok: true;
  readonly result: object;
  /** The result for people, one line each. */
  readonly lines: readonly string[];
}

export interface Failure {
  readonly ok: false;
  /** Decides the exit code; `code` says more within it. */
  readonly kind: FailureKind;
  readonly code: FailureCode;
  readonly why: string;
  readonly fix: string;
  /** A path relative to the working directory, and a 1-based line when one is known. */
  readonly where?: { readonly file: string; readonly line?: number };
  readonly result?: object;
  /** Details for people, printed between `why` and `fix`. */
  readonly lines?: readonly string[];
}

type FailureKind = keyof typeof exitCodes;

/** Ends a command early with `failure`, from however deep it was found. */
export class CommandError extends Error {
  override readonly name = "CommandError";
  readonly failure: Failure;

  constructor(failure: Omit<Failure, "ok">) {
    super(failure.why);
    this.failure = { ok: false, ...failure };
  }
}

// Grouped as Prisma 8 and drizzle-kit do: the code says how to react, `code` says exactly what.
const exitCodes = {
  failed: 1,
  invalid: 2,
  approval: 3,
  finding: 4,
} as const;

export function exitCode(outcome: Outcome): number {
  return outcome.ok ? 0 : exitCodes[outcome.kind];
}

/** The one JSON value `--json` prints. */
export function toJson(command: string, outcome: Outcome): string {
  const body = outcome.ok
    ? { ok: true, command, result: outcome.result }
    : {
        ok: false,
        command,
        code: outcome.code,
        why: outcome.why,
        fix: outcome.fix,
        ...(outcome.where === undefined ? {} : { where: outcome.where }),
        ...(outcome.result === undefined ? {} : { result: outcome.result }),
      };
  return `${JSON.stringify(body)}\n`;
}

/** What people read: a success on stdout, a failure on stderr. */
export function toText(outcome: Outcome): { readonly stdout: string; readonly stderr: string } {
  if (outcome.ok) {
    return { stdout: joinLines(outcome.lines), stderr: "" };
  }
  const where =
    outcome.where === undefined
      ? []
      : [
          `  at ${outcome.where.file}${outcome.where.line === undefined ? "" : `:${String(outcome.where.line)}`}`,
        ];
  return {
    stdout: "",
    stderr: joinLines([outcome.why, ...where, ...(outcome.lines ?? []), `Fix: ${outcome.fix}`]),
  };
}

function joinLines(lines: readonly string[]): string {
  return lines.map((line) => `${line}\n`).join("");
}

/** ` (SQLSTATE 23505)`, or nothing when the failure was not the database's. */
export function sqlstateNote(code: string | null): string {
  return code === null ? "" : ` (SQLSTATE ${code})`;
}
