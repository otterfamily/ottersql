import type { DriverQuery } from "./connection.ts";
import { QueryError } from "./query-error.ts";
import { wait } from "./wait.ts";

/** Postgres's isolation levels; it runs `read uncommitted` as `read committed`, so that one is left out. */
export type IsolationLevel = "read committed" | "repeatable read" | "serializable";

/** How a transaction runs; what is left out follows the database's defaults. */
export type TransactionOptions = {
  /**
   * Settings for this transaction only, as `SET LOCAL` gives them: `{ "app.user_id": "42" }` for
   * row-level security, `{ statement_timeout: "5s" }`. They end with the transaction, so a pooled
   * connection never carries them to the next one.
   */
  readonly settings?: Readonly<Record<string, string>>;
  /**
   * Runs the callback again, on a new transaction, when Postgres rejects it with a serialization
   * failure (40001) or a deadlock (40P01), until it has run `attempts` times in all, waiting a
   * random, growing while between runs. Only for callbacks that do nothing but query the database:
   * anything else they do happens again too.
   */
  readonly retry?: { readonly attempts: number };
} & (
  | {
      readonly isolation?: IsolationLevel;
      /** Postgres rejects writes in a read-only transaction. */
      readonly readOnly?: boolean;
      readonly deferrable?: never;
    }
  | {
      readonly isolation: "serializable";
      readonly readOnly: true;
      /**
       * Waits for a snapshot no serializable transaction can invalidate, then runs without risk of
       * a serialization failure: for long reports. Postgres honours it only for serializable,
       * read-only transactions, hence the other two options.
       */
      readonly deferrable: boolean;
    }
);

const isolationLevels: ReadonlySet<string> = new Set<IsolationLevel>([
  "read committed",
  "repeatable read",
  "serializable",
]);

/**
 * How a transaction runs, checked by ottersql, for a driver to start it with: what is left out
 * follows the database's defaults.
 */
export interface TransactionMode {
  readonly isolation: IsolationLevel | undefined;
  readonly readOnly: boolean | undefined;
  readonly deferrable: boolean | undefined;
}

/** The mode `options` ask for, checked, since it is spliced into SQL. */
export function transactionMode({
  isolation,
  readOnly,
  deferrable,
}: TransactionOptions): TransactionMode {
  if (isolation !== undefined && !isolationLevels.has(isolation)) {
    throw new TypeError(`unknown isolation level: ${isolation}`);
  }
  return { isolation, readOnly, deferrable };
}

/**
 * `mode` as BEGIN and SET TRANSACTION take it, such as `isolation level serializable read only`,
 * or `""` for the defaults. Separated by spaces, which Postgres accepts like commas, since
 * postgres.js strips everything but letters and spaces from its begin options.
 */
export function transactionModeSql({ isolation, readOnly, deferrable }: TransactionMode): string {
  const modes: string[] = [];
  if (isolation !== undefined) {
    modes.push(`isolation level ${isolation}`);
  }
  if (readOnly !== undefined) {
    modes.push(readOnly ? "read only" : "read write");
  }
  if (deferrable !== undefined) {
    modes.push(deferrable ? "deferrable" : "not deferrable");
  }
  return modes.join(" ");
}

/** Applies `settings` for the rest of the transaction, before any other statement. */
export async function applySettings(
  query: DriverQuery,
  settings: TransactionOptions["settings"],
): Promise<void> {
  if (settings !== undefined && Object.keys(settings).length > 0) {
    // One statement for any number of settings; set_config's third argument makes them local.
    await query("select set_config(key, value, true) from json_each_text($1)", [
      JSON.stringify(settings),
    ]);
  }
}

/** SQLSTATEs after which running the whole transaction again can succeed. */
const RETRYABLE: ReadonlySet<string> = new Set(["40001", "40P01"]);

const FIRST_WAIT_MS = 10;
const WAIT_GROWTH = 2;
const LONGEST_WAIT_MS = 1000;

/** Runs `attempt` up to `retry.attempts` times while it fails in a way a new attempt can fix. */
export async function retrying<Result>(
  retry: TransactionOptions["retry"],
  attempt: () => Promise<Result>,
): Promise<Result> {
  const attempts = retry?.attempts ?? 1;
  if (!Number.isInteger(attempts) || attempts < 1) {
    throw new RangeError(`retry.attempts must be a whole number from 1, not ${String(attempts)}`);
  }
  for (let run = 1; ; run += 1) {
    try {
      return await attempt();
    } catch (error) {
      if (run >= attempts || !(error instanceof QueryError) || !RETRYABLE.has(error.code)) {
        throw error;
      }
      await wait(backoff(run));
    }
  }
}

/** A random wait up to a limit that doubles with each run ("full jitter"), so retries spread out. */
function backoff(run: number): number {
  return Math.random() * Math.min(LONGEST_WAIT_MS, FIRST_WAIT_MS * WAIT_GROWTH ** (run - 1));
}
