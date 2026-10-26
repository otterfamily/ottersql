import { describe, expect, test } from "vitest";

describe("ottersql/catalog", () => {
  test("exports what users call, not what other layers use inside the package", async () => {
    const entryPoint: object = await import("./index.ts");
    expect(Object.keys(entryPoint).toSorted()).toStrictEqual([
      "CatalogShapeError",
      "SchemaError",
      "loadCatalog",
      "openSchema",
      "readCatalog",
    ]);
  });
});
