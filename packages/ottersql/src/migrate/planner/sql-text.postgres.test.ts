import { postgresDatabase } from "@ottersql/testing";
import { describe, expect, test } from "vitest";

import { connect } from "../test-migrate.ts";
import { literal } from "./sql-text.ts";

const texts = ["plain", "it's", String.raw`C:\new\table`, String.raw`ends with \'`, "\\"];

describe("literal", () => {
  test.for(["on", "off"])(
    "reads back as the same text with standard_conforming_strings %s",
    async (setting) => {
      const client = await connect(await postgresDatabase());
      try {
        await client.query(`set standard_conforming_strings = ${setting}`);
        await client.query("set escape_string_warning = off");
        const select = texts.map((text, index) => `${literal(text)} as "${String(index)}"`);
        const { rows } = await client.query<string[]>({
          text: `select ${select.join(", ")}`,
          rowMode: "array",
        });
        expect(rows).toStrictEqual([texts]);
      } finally {
        await client.end();
      }
    },
  );
});
