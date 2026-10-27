/**
 * The connection moved to another database session while a run held the ledger's lock, as a pool
 * or a pooler in transaction mode does, so the lock no longer kept other runs out. The lock stays
 * with the first session until that session ends. `finished` says the run had done its work and
 * recorded it when the move came to light, as it gave the lock up.
 */
export class SessionChangedError extends Error {
  override readonly name = "SessionChangedError";
  readonly finished: boolean;

  constructor(finished: boolean) {
    super(
      `The connection moved to another database session while it held the migration lock; migrations need one session for the whole run${finished ? ". The run finished and recorded what it did" : ""}`,
    );
    this.finished = finished;
  }
}
