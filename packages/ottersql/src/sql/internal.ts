// What other layers of the package use and users do not: kept out of package.json "exports", so
// it can change without a release note, and in one file, so a layer's surface to the others is
// visible and knip finds what no layer uses any more (ADR 0013).
export { baseCodecs } from "./decode.ts";
export type { PgClient } from "./pg-driver.ts";
export {
  fileOffset,
  holdsQueries,
  lineAndColumn,
  offsetOfPosition,
  readQueryFile,
} from "./query-file.ts";
export type { Query, Span } from "./query-file.ts";
export { isIdentifier } from "./query-name.ts";
export { columnNamesProblem } from "./query.ts";
export { lineComments, splitStatements } from "./statements.ts";
export type { Located } from "./statements.ts";
export { rangeSubtypes } from "./type-info.ts";
