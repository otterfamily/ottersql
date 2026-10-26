import { describe, expect, test } from "vitest";

import { CatalogShapeError } from "./catalog-json.ts";
import { decode } from "./codes.ts";

describe("decode", () => {
  test("rejects a code Postgres added after ottersql, as a catalog of a shape it does not read", () => {
    expect(() => decode({ f: "function" }, "z", "pg_proc.prokind")).toThrow(
      new CatalogShapeError('unknown pg_proc.prokind "z"'),
    );
  });
});
