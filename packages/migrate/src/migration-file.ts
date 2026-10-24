import { splitStatements } from "@ottersql/sql";

import type { MigrationFile } from "./migrations.ts";
import { locks, phases, reversals, stepKinds, transactions } from "./plan.ts";
import type { Plan, Step } from "./plan.ts";

/** Where in a migration file a problem is: in a named file, or in text read on its own. */
interface Where {
  readonly file: string | null;
  readonly line: number;
}

/** A migration file that cannot be read; the message says where, as `file` and `line` do. */
export class MigrationFileError extends Error {
  override readonly name = "MigrationFileError";
  /** The name of the file, when the text came from a `MigrationFile`. */
  readonly file: string | null;
  /** The line the problem is on, counted from 1. */
  readonly line: number;

  constructor(where: Where, problem: string) {
    super(`${where.file === null ? "" : `${where.file} `}line ${String(where.line)}: ${problem}`);
    this.file = where.file;
    this.line = where.line;
  }
}

const STEP = "-- ottersql:step ";
const CLEANUP = "-- ottersql:cleanup ";
const MANUAL = "-- ottersql:manual ";

/**
 * A migration file for `plan`: each step's SQL under a `-- ottersql:step` line that carries what
 * the applier and a reviewer need, so the file stays plain SQL. Changes left to a person are listed
 * as comments, for them to write as steps.
 */
export function renderMigration(plan: Plan): string {
  const manual = plan.manual.map(({ object, reason }) => `${MANUAL}${object}\n-- ${reason}\n`);
  const steps = plan.steps.map((step) =>
    [
      `${STEP}${attributes(step)}`,
      ...(step.reason === null ? [] : [`-- ${step.reason}`]),
      ...step.cleanup.map((sql) => `${CLEANUP}${sql};`),
      ...step.statements.map((sql) => `${sql};`),
      "",
    ].join("\n"),
  );
  return [...manual, ...steps].join("\n");
}

function attributes(step: Step): string {
  return [
    `kind=${step.kind}`,
    `object=${JSON.stringify(step.object)}`,
    `phase=${step.phase}`,
    `reversal=${step.reversal}`,
    `transaction=${step.transaction}`,
    `lock=${JSON.stringify(step.lock)}`,
  ].join(" ");
}

const attribute = /\b(?<key>\w+)=(?<value>"(?:[^"\\]|\\.)*"|\S+)/gv;

/** The steps of `file`; a `MigrationFileError` names it. */
export function readMigration(file: MigrationFile): Step[] {
  return readSteps(file.text, file.name);
}

/** The steps of a migration file, as written: a person may have edited the generated file. */
export function readMigrationFile(text: string): Step[] {
  return readSteps(text, null);
}

function readSteps(text: string, file: string | null): Step[] {
  const lines = text.split("\n");
  const starts = lines.flatMap((line, index) => (line.startsWith(STEP) ? [index] : []));
  const stray = lines
    .slice(0, starts[0] ?? lines.length)
    .findIndex((line) => splitStatements(line).length > 0);
  if (stray !== -1) {
    throw new MigrationFileError(
      { file, line: stray + 1 },
      "SQL must follow a -- ottersql:step line",
    );
  }
  return starts.map((start, position) =>
    readStep(lines.slice(start, starts[position + 1] ?? lines.length), { file, line: start + 1 }),
  );
}

function readStep(lines: readonly string[], where: Where): Step {
  const [header = "", ...body] = lines;
  const cleanup = body
    .filter((text) => text.startsWith(CLEANUP))
    .flatMap((text) => splitStatements(text.slice(CLEANUP.length)));
  const statements = splitStatements(body.filter((text) => !text.startsWith(CLEANUP)).join("\n"));
  if (statements.length === 0) {
    throw new MigrationFileError(where, "the step has no SQL");
  }
  return { ...parseHeader(header.slice(STEP.length), where), statements, cleanup, reason: null };
}

function parseHeader(text: string, where: Where): Omit<Step, "statements" | "cleanup" | "reason"> {
  const values = new Map(
    [...text.matchAll(attribute)].map((match) => {
      const value = match.groups?.["value"] ?? "";
      return [
        match.groups?.["key"] ?? "",
        value.startsWith('"') ? String(JSON.parse(value)) : value,
      ];
    }),
  );
  const read = (key: string): string => {
    const value = values.get(key);
    if (value === undefined) {
      throw new MigrationFileError(where, `${key} is missing`);
    }
    return value;
  };
  const pick = <Value extends string>(key: string, allowed: readonly Value[]): Value => {
    const value = read(key);
    const found = allowed.find((item) => item === value);
    if (found === undefined) {
      throw new MigrationFileError(
        where,
        `${key} must be one of ${allowed.join(", ")}, not "${value}"`,
      );
    }
    return found;
  };
  return {
    kind: pick("kind", stepKinds),
    object: read("object"),
    phase: pick("phase", phases),
    reversal: pick("reversal", reversals),
    transaction: pick("transaction", transactions),
    lock: pick("lock", locks),
  };
}
