/**
 * Every failure code the command reports. Agents branch on them, so a code keeps its meaning once
 * published (ADR 0007); a new one is added here and to the README's list.
 */
export type FailureCode =
  | "database.connection_failed"
  | "database.driver_missing"
  | "database.query_failed"
  | "database.url_missing"
  | "internal"
  | "migrate.approval_by_agent"
  | "migrate.approval_required"
  | "migrate.baseline_mismatch"
  | "migrate.baseline_name_missing"
  | "migrate.baseline_unnamed"
  | "migrate.drift"
  | "migrate.file_invalid"
  | "migrate.history_mismatch"
  | "migrate.out_of_date"
  | "migrate.step_failed"
  | "project.peer_missing"
  | "project.tsconfig_invalid"
  | "project.tsconfig_unreadable"
  | "push.approval_by_agent"
  | "push.approval_required"
  | "push.manual"
  | "push.not_local"
  | "push.step_failed"
  | "schema.invalid"
  | "schema.unreadable"
  | "types.not_generated"
  | "types.out_of_date"
  | "types.query_invalid"
  | "usage.invalid";
