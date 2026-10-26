import { describe, expect, test } from "vitest";

import { frame, readFrames } from "./json-rpc.ts";

describe("framing messages as the Language Server Protocol does", () => {
  test("reads every whole message, keeping a partial one for later", () => {
    const first = frame({ id: 1, method: "initialize" });
    const second = frame({ id: 2, method: "transform", params: { text: "🦦 é" } });
    const bytes = Buffer.from(first + second);
    const cut = bytes.length - 3;
    const head = readFrames(bytes.subarray(0, cut));
    expect(head.messages).toStrictEqual([{ id: 1, method: "initialize" }]);
    const tail = readFrames(Buffer.concat([head.rest, bytes.subarray(cut)]));
    expect(tail.messages).toStrictEqual([{ id: 2, method: "transform", params: { text: "🦦 é" } }]);
    expect(tail.rest.byteLength).toBe(0);
  });

  test("counts the length in bytes and reads other headers", () => {
    const json = JSON.stringify({ text: "🦦" });
    const bytes = Buffer.from(
      `Content-Type: application/vscode-jsonrpc; charset=utf-8\r\ncontent-length: ${String(Buffer.byteLength(json))}\r\n\r\n${json}`,
    );
    expect(readFrames(bytes).messages).toStrictEqual([{ text: "🦦" }]);
  });
});
