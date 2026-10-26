import { describe, expect, test } from "vitest";

import { parseJsonc } from "./jsonc.ts";

describe("reading tsconfig JSON", () => {
  test.for([
    { text: '{ "a": 1 }', value: { a: 1 } },
    { text: '{\n  // a comment\n  "a": 1 /* and another */\n}', value: { a: 1 } },
    { text: '{ "a": [1, 2,], "b": { "c": 3, }, }', value: { a: [1, 2], b: { c: 3 } } },
    { text: '{ "a": 1, // last\n}', value: { a: 1 } },
    {
      text: String.raw`{ "url": "http://x/*y*/", "comma": ",]", "quote": "\"//" }`,
      value: { url: "http://x/*y*/", comma: ",]", quote: '"//' },
    },
  ])("reads $text", ({ text, value }) => {
    expect(parseJsonc(text)).toStrictEqual({ value });
  });

  test("reports where invalid JSON fails, counting from the original text", () => {
    const text = '{\n  /* 🦦 comment */\n  "a": 1\n  "b": 2\n}';
    const result = parseJsonc(text);
    expect(result).toMatchObject({ offset: text.indexOf('"b"') });
  });
});
