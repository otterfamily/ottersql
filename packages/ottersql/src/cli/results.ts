import type { DeclarationFileProblem } from "../content-mapper/index.ts";
import type {
  ApplyResult,
  IrreversibleStep,
  ManualChange,
  Plan,
  PushResult,
  Step,
  StepRef,
  StepStatus,
} from "../migrate/index.ts";

// What `--json` prints in `result`, copied field by field rather than passed on from the library,
// so a field added to a library type does not change what agents read (ADR 0007).

/** A step of a migration file. */
interface StepRefJson {
  readonly migration: string;
  readonly step: number;
}

/** A planned step: what it does and how it runs, without its SQL. */
interface PlannedStepJson {
  readonly kind: Step["kind"];
  readonly object: string;
  readonly phase: Step["phase"];
  readonly reversal: Step["reversal"];
  readonly transaction: Step["transaction"];
  readonly lock: Step["lock"];
}

interface ManualJson {
  readonly object: string;
  readonly reason: string;
}

interface PlanJson {
  readonly steps: readonly PlannedStepJson[];
  readonly manual: readonly ManualJson[];
}

interface StepStatusJson extends StepRefJson {
  readonly kind: Step["kind"];
  readonly object: string;
  readonly phase: Step["phase"];
  readonly applied: boolean;
}

/** Why a step failed, with Postgres's SQLSTATE when it gave one. */
interface StepFailureJson {
  readonly sqlstate: string | null;
  readonly message: string;
}

interface IrreversibleStepJson extends StepRefJson {
  readonly kind: Step["kind"];
  readonly object: string;
}

interface ProblemJson {
  readonly file: string;
  readonly line: number;
  readonly column: number;
  readonly message: string;
}

export function stepRefJson({ migration, step }: StepRef): StepRefJson {
  return { migration, step };
}

export function plannedStepJson({
  kind,
  object,
  phase,
  reversal,
  transaction,
  lock,
}: Step): PlannedStepJson {
  return { kind, object, phase, reversal, transaction, lock };
}

export function manualJson({ object, reason }: ManualChange): ManualJson {
  return { object, reason };
}

export function planJson({ steps, manual }: Plan): PlanJson {
  return {
    steps: steps.map((step) => plannedStepJson(step)),
    manual: manual.map((change) => manualJson(change)),
  };
}

export function stepStatusJson({
  migration,
  step,
  kind,
  object,
  phase,
  applied,
}: StepStatus): StepStatusJson {
  return { migration, step, kind, object, phase, applied };
}

export function waitingJson({
  migration,
  step,
  phase,
}: NonNullable<ApplyResult["waiting"]>): StepRefJson & { readonly phase: Step["phase"] } {
  return { migration, step, phase };
}

export function failedStepJson({
  migration,
  step,
  code,
  message,
}: NonNullable<ApplyResult["failed"]>): StepRefJson & StepFailureJson {
  return { migration, step, sqlstate: code, message };
}

export function failedPushJson({
  kind,
  object,
  code,
  message,
}: NonNullable<PushResult["failed"]>): Pick<PlannedStepJson, "kind" | "object"> & StepFailureJson {
  return { kind, object, sqlstate: code, message };
}

export function irreversibleStepJson({
  migration,
  step,
  kind,
  object,
}: IrreversibleStep): IrreversibleStepJson {
  return { migration, step, kind, object };
}

export function problemJson({ file, line, column, message }: DeclarationFileProblem): ProblemJson {
  return { file, line, column, message };
}
