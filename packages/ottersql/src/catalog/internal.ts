// What other layers of the package use and users do not: kept out of package.json "exports", so
// it can change without a release note, and in one file, so a layer's surface to the others is
// visible and knip finds what no layer uses any more (ADR 0013).
export { readRelations, readTypeRefs } from "./by-oid.ts";
export type { Relation } from "./by-oid.ts";
export {
  findDomain,
  findEnum,
  findRange,
  findTable,
  nameKey,
  referencesTable,
  sameType,
} from "./find.ts";
