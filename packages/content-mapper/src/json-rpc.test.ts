import { describe, expect, test } from "vitest";

import { serve } from "./json-rpc.ts";

function frame(body: string): string {
  return `Content-Length: ${String(Buffer.byteLength(body))}\r\n\r\n${body}`;
}

async function echoOnly(method: string): Promise<unknown> {
  return method === "echo" ? "ok" : Promise.reject(new Error(`unknown method ${method}`));
}

const echo = (id: number): string => frame(JSON.stringify({ jsonrpc: "2.0", id, method: "echo" }));

/** The JSON-RPC responses `serve` writes for `input`. */
async function responses(...input: readonly string[]): Promise<unknown[]> {
  let written = "";
  await serve(
    input.map((text) => Buffer.from(text)),
    (data) => {
      written += data;
    },
    echoOnly,
  );
  return written
    .split(/Content-Length: \d+\r\n\r\n/v)
    .filter((body) => body !== "")
    .map((body): unknown => JSON.parse(body));
}

describe("serve", () => {
  test("answers requests in order, splitting frames that arrive in pieces", async () => {
    const request = echo(1);
    await expect(
      responses(request.slice(0, 10), request.slice(10), request),
    ).resolves.toStrictEqual([
      { jsonrpc: "2.0", id: 1, result: "ok" },
      { jsonrpc: "2.0", id: 1, result: "ok" },
    ]);
  });

  test("answers a body that is not JSON with a parse error and keeps serving", async () => {
    await expect(responses(frame("{oops"), echo(2))).resolves.toStrictEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 2, result: "ok" },
    ]);
  });

  test("skips a frame without a Content-Length header and keeps serving", async () => {
    await expect(responses("X-Other: 1\r\n\r\n", echo(3))).resolves.toStrictEqual([
      { jsonrpc: "2.0", id: null, error: { code: -32_700, message: "Parse error" } },
      { jsonrpc: "2.0", id: 3, result: "ok" },
    ]);
  });
});
