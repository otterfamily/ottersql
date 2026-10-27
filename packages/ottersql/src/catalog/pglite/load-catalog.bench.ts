import { BENCHMARK_TABLES, benchmarkSchemaSql } from "@ottersql/testing/benchmark-schema";
import { describe, test } from "vitest";

import { loadCatalog } from "../index.ts";

describe("loadCatalog", () => {
  test("cost by schema size", async ({ bench }) => {
    await bench.compare(
      bench("an empty schema", async () => {
        await loadCatalog("");
      }),
      bench(`${String(BENCHMARK_TABLES)} tables with keys, checks, indexes and comments`, async () => {
        await loadCatalog(benchmarkSchemaSql);
      }),
      { iterations: 20, time: 0 },
    );
  });
});
