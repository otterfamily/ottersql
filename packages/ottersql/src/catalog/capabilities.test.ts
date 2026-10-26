import { describe, expect, test } from "vitest";

import { loadCatalog } from "./index.ts";

describe("capabilities", () => {
  test("records the engine and version the schema was read on", async () => {
    const catalog = await loadCatalog("");
    const { engine, version } = catalog.capabilities;
    expect({ engine, major: version.major }).toStrictEqual({ engine: "postgres", major: 18 });
  });
});
