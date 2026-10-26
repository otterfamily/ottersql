import { describe, expect, test } from "vitest";

describe("ottersql/content-mapper", () => {
  test("exports what users call, not what the command or the mapper use inside the package", async () => {
    const entryPoint: object = await import("./index.ts");
    expect(Object.keys(entryPoint).toSorted()).toStrictEqual([
      "declarationFileName",
      "declarationFiles",
      "isGeneratedDeclarationFile",
    ]);
  });
});
