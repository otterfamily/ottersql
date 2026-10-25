import { lineComments, splitStatements } from "@ottersql/sql/tooling";
import type { Located } from "@ottersql/sql/tooling";

import { isMigrationFileName, migrationNameRule } from "./migration-name.ts";
import type { MigrationFile } from "./migrations.ts";
import { locks, phases, reversals, stepKinds, transactions } from "./plan.ts";
import type { OutsideStep, Plan, Step } from "./plan.ts";

/** Where in a migration file a problem is: in a named file or in text read on its own, on a line or in the name. */
interface Where {
  readonly file: string | null;
  readonly line: number | null;
}

/** A migration file that cannot be read; the message says where, as `file` and `line` do. */
export class MigrationFileError extends Error {
  override readonly name = "MigrationFileError";
  /** The name of the file, when the text came from a `MigrationFile`. */
  readonly file: string | null;
  /** The line the problem is on, counted from 1; `null` for a problem with the file's name. */
  readonly line: number | null;

  constructor(where: Where, problem: string) {
    const place = [where.file, where.line === null ? null : `line ${String(where.line)}`]
      .filter((part) => part !== null)
      .join(" ");
    super(`${place}: ${problem}`);
    this.file = where.file;
    this.line = where.line;
  }
}

const PREFIX = "ottersql:";
const directiveNames = ["step", "cleanup", "manual"] as const;
const stepAttributes = ["kind", "object", "phase", "reversal", "transaction", "lock"] as const;
const cleanupAttributes = ["schema", "index"] as const;

/**
 * A migration file for `plan`: each step's SQL under a `-- ottersql:step` line that carries what
 * the applier and a reviewer need, so the file stays plain SQL. Changes left to a person are listed
 * as comments, for them to write as steps.
 */
export function renderMigration(plan: Plan): string {
  const manual = plan.manual.map(
    ({ object, reason }) => `-- ${PREFIX}manual ${object}\n-- ${reason}\n`,
  );
  const steps = plan.steps.map((step) =>
    [
      `-- ${PREFIX}step ${stepHeader(step)}`,
      ...(step.reason === null ? [] : [`-- ${step.reason}`]),
      ...(step.transaction === "outside" && step.cleanup !== null
        ? [
            `-- ${PREFIX}cleanup schema=${JSON.stringify(step.cleanup.schema)} index=${JSON.stringify(step.cleanup.name)}`,
          ]
        : []),
      ...step.statements.map((sql) => `${sql};`),
      "",
    ].join("\n"),
  );
  return [...manual, ...steps].join("\n");
}

/**
 * A migration file with no steps yet, for a person to write them: data to move, or objects
 * ottersql does not plan. It explains the step line, which on its own is a plain comment here.
 */
export function emptyMigration(): string {
  return [
    "-- Steps written by hand. Each starts with a line such as",
    `-- -- ${PREFIX}step kind=custom object="public.users"`,
    "-- followed by its SQL. A step that leaves out phase, reversal, transaction or lock runs after",
    "-- the deploy, in a transaction, and waits for approval: say what it does, such as",
    `-- -- ${PREFIX}step kind=custom object="public.users" phase=contract reversal=lossy lock="row exclusive"`,
    "-- for an UPDATE that fills a column. Whatever the steps create must be in schema.sql too.",
    "",
  ].join("\n");
}

function stepHeader(step: Step): string {
  return [
    `kind=${step.kind}`,
    `object=${JSON.stringify(step.object)}`,
    `phase=${step.phase}`,
    `reversal=${step.reversal}`,
    `transaction=${step.transaction}`,
    `lock=${JSON.stringify(step.lock)}`,
  ].join(" ");
}

/** The steps of `file`; a `MigrationFileError` names it. */
export function readMigration(file: MigrationFile): Step[] {
  if (!isMigrationFileName(file.name)) {
    throw new MigrationFileError({ file: file.name, line: null }, migrationNameRule);
  }
  return readSteps(file.text, file.name);
}

/**
 * The steps of a migration file, as written: a person may have edited the generated file. Only
 * `--` comments outside strings can be directives, and a directive that is misspelt, misplaced
 * or carries attributes it should not is refused rather than read as a plain comment.
 */
export function readMigrationFile(text: string): Step[] {
  return readSteps(text, null);
}

interface Directive {
  readonly name: (typeof directiveNames)[number];
  readonly values: ReadonlyMap<string, string>;
  readonly start: number;
  readonly end: number;
  readonly where: Where;
}

function readSteps(original: string, file: string | null): Step[] {
  const text = original.replaceAll("\r\n", "\n");
  const directives = lineComments(text).flatMap((comment) => {
    const found = directiveIn(text, comment, file);
    return found === null ? [] : [found];
  });
  const steps = directives.filter(({ name }) => name === "step");
  const [stray] = splitStatements(text.slice(0, steps[0]?.start ?? text.length));
  if (stray !== undefined) {
    throw new MigrationFileError(
      { file, line: lineAt(text, stray.start) },
      "SQL must follow a -- ottersql:step line",
    );
  }
  return steps.map((header, position) => {
    const end = steps[position + 1]?.start ?? text.length;
    const cleanups = directives.filter(
      ({ name, start }) => name === "cleanup" && start > header.start && start < end,
    );
    const statements = splitStatements(text.slice(header.end, end)).map(({ text: sql }) => sql);
    return readStep(header, statements, cleanups);
  });
}

function lineAt(text: string, offset: number): number {
  return text.slice(0, offset).split("\n").length;
}

/** The directive `comment` holds, or `null` when it is a plain comment. */
function directiveIn(text: string, comment: Located, file: string | null): Directive | null {
  const body = comment.text.slice("--".length).trimStart();
  if (!body.startsWith(PREFIX)) {
    return null;
  }
  const where = { file, line: lineAt(text, comment.start) };
  const lineStart = text.lastIndexOf("\n", comment.start - 1) + 1;
  if (text.slice(lineStart, comment.start).trim() !== "") {
    throw new MigrationFileError(where, "a -- ottersql: directive must be on a line of its own");
  }
  const [word = "", ...rest] = body.slice(PREFIX.length).split(/\s+/v);
  const name = directiveName(word, where);
  return {
    name,
    values:
      name === "manual" ? new Map() : attributes(rest.join(" "), allowedAttributes[name], where),
    start: comment.start,
    end: comment.start + comment.text.length,
    where,
  };
}

const allowedAttributes = { step: stepAttributes, cleanup: cleanupAttributes } as const;

function directiveName(word: string, where: Where): Directive["name"] {
  const name = directiveNames.find((candidate) => candidate === word);
  if (name === undefined) {
    throw new MigrationFileError(
      where,
      `unknown directive ${PREFIX}${word}; the directives are step, cleanup and manual`,
    );
  }
  return name;
}

// A word is a run of non-space characters, a quoted value counting as one even with spaces in it.
const word = /(?:[^\s"]|"(?:[^"\\]|\\.)*")+/gv;
const keyValue = /^(?<key>\w+)=(?<value>[^"]+|"(?:[^"\\]|\\.)*")$/v;

/** The attributes of `text`, each named in `allowed` and given once. */
function attributes(
  text: string,
  allowed: readonly string[],
  where: Where,
): ReadonlyMap<string, string> {
  const values = new Map<string, string>();
  for (const [found] of text.matchAll(word)) {
    const { key, value } = attribute(found, where);
    if (!allowed.includes(key) || values.has(key)) {
      throw new MigrationFileError(
        where,
        values.has(key) ? `${key} is given twice` : `unknown attribute ${key}`,
      );
    }
    values.set(key, value);
  }
  return values;
}

/** The key and the unquoted value of `found`, a word such as `phase=expand` or `lock="none"`. */
function attribute(found: string, where: Where): { readonly key: string; readonly value: string } {
  const groups = keyValue.exec(found)?.groups;
  const key = groups?.["key"];
  const value = groups?.["value"];
  if (key === undefined || value === undefined) {
    throw new MigrationFileError(
      where,
      `expected attributes such as key=value, not ${JSON.stringify(found)}`,
    );
  }
  return { key, value: value.startsWith('"') ? String(JSON.parse(value)) : value };
}

function required(directive: Directive, key: string): string {
  const value = directive.values.get(key);
  if (value === undefined) {
    throw new MigrationFileError(directive.where, `${key} is missing`);
  }
  return value;
}

function oneOf<Value extends string>(
  directive: Directive,
  key: string,
  allowed: readonly Value[],
): Value {
  const value = required(directive, key);
  const found = allowed.find((item) => item === value);
  if (found === undefined) {
    throw new MigrationFileError(
      directive.where,
      `${key} must be one of ${allowed.join(", ")}, not "${value}"`,
    );
  }
  return found;
}

/**
 * What a step written by hand runs as when its line leaves it out: the safest settings, which make
 * applying it wait for a person's approval.
 */
const customDefaults: ReadonlyMap<string, string> = new Map([
  ["phase", "contract"],
  ["reversal", "irreversible"],
  ["transaction", "inside"],
  ["lock", "access exclusive"],
]);

function readStep(
  written: Directive,
  statements: readonly string[],
  cleanups: readonly Directive[],
): Step {
  const header =
    written.values.get("kind") === "custom"
      ? { ...written, values: new Map([...customDefaults, ...written.values]) }
      : written;
  if (statements.length === 0) {
    throw new MigrationFileError(header.where, "the step has no SQL");
  }
  const common = {
    kind: oneOf(header, "kind", stepKinds),
    object: required(header, "object"),
    phase: oneOf(header, "phase", phases),
    reversal: oneOf(header, "reversal", reversals),
    lock: oneOf(header, "lock", locks),
    statements,
    reason: null,
  };
  const transaction = oneOf(header, "transaction", transactions);
  if (transaction === "inside") {
    refuseCleanup(cleanups);
    return { ...common, transaction };
  }
  return { ...common, transaction, cleanup: cleanupOf(cleanups) };
}

/** A step inside a transaction rolls back when it fails, so it leaves nothing to clean up. */
function refuseCleanup(cleanups: readonly Directive[]): void {
  const [cleanup] = cleanups;
  if (cleanup !== undefined) {
    throw new MigrationFileError(cleanup.where, "only a step outside a transaction has a cleanup");
  }
}

function cleanupOf(cleanups: readonly Directive[]): OutsideStep["cleanup"] {
  const [cleanup, extra] = cleanups;
  if (extra !== undefined) {
    throw new MigrationFileError(extra.where, "a step has one cleanup at most");
  }
  return cleanup === undefined
    ? null
    : { schema: required(cleanup, "schema"), name: required(cleanup, "index") };
}
