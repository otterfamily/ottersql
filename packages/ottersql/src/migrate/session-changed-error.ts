/**
 * The connection moved to another database session while a run held the ledger's lock, as a pool
 * or a pooler in transaction mode does, so the lock no longer kept other runs out. The lock stays
 * with the first session until that session ends.
 */
export class SessionChangedError extends Error {
  override readonly name = "SessionChangedError";

  constructor() {
    super(
      "The connection moved to another database session while it held the migration lock; migrations need one session for the whole run",
    );
  }
}
