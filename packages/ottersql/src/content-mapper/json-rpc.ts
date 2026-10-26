import { stdin, stdout } from "node:process";

/** JSON-RPC 2.0's code for a method the server does not have. */
export const METHOD_NOT_FOUND = -32_601;
const INTERNAL_ERROR = -32_603;

/** An error a handler throws to answer a request with a JSON-RPC error code. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

const HEADER_END = "\r\n\r\n";

/**
 * The messages complete in `bytes`, framed as the Language Server Protocol frames them (a
 * `Content-Length` header, a blank line, then that many bytes of JSON), and what is left of it.
 */
export function readFrames(bytes: Uint8Array): {
  readonly messages: unknown[];
  readonly rest: Uint8Array;
} {
  const messages: unknown[] = [];
  let rest = bytes;
  let next = nextFrame(rest);
  while (next !== null) {
    messages.push(next.message);
    ({ rest } = next);
    next = nextFrame(rest);
  }
  return { messages, rest };
}

/** The first whole message in `bytes` and what follows it, or `null` while it is incomplete. */
function nextFrame(
  bytes: Uint8Array,
): { readonly message: unknown; readonly rest: Uint8Array } | null {
  const buffer = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const headerEnd = buffer.indexOf(HEADER_END);
  const length = /^content-length: *(?<length>\d+)$/imv.exec(
    buffer.subarray(0, Math.max(headerEnd, 0)).toString("ascii"),
  )?.groups?.["length"];
  const start = headerEnd + HEADER_END.length;
  if (headerEnd === -1 || length === undefined || buffer.length < start + Number(length)) {
    return null;
  }
  const end = start + Number(length);
  return {
    message: JSON.parse(buffer.subarray(start, end).toString("utf8")),
    rest: bytes.subarray(end),
  };
}

/** `message` framed for the Language Server Protocol's base protocol. */
export function frame(message: unknown): string {
  const json = JSON.stringify(message);
  return `Content-Length: ${String(Buffer.byteLength(json, "utf8"))}${HEADER_END}${json}`;
}

/**
 * Answers JSON-RPC 2.0 requests on stdin and stdout until stdin ends, after vscode-jsonrpc's
 * stream connection, which ottersql follows instead of depending on (ADR 0013). Requests run
 * concurrently, as TypeScript may send several; notifications, which take no answer, are ignored.
 */
export function serveJsonRpc(handle: (method: string, params: unknown) => Promise<unknown>): void {
  let pending: Uint8Array = new Uint8Array();
  stdin.on("data", (chunk: Uint8Array) => {
    const { messages, rest } = readFrames(Buffer.concat([pending, chunk]));
    pending = rest;
    for (const message of messages) {
      void answer(message, handle);
    }
  });
}

async function answer(
  message: unknown,
  handle: (method: string, params: unknown) => Promise<unknown>,
): Promise<void> {
  if (
    typeof message !== "object" ||
    message === null ||
    !("id" in message) ||
    !("method" in message)
  ) {
    return;
  }
  const { id, method } = message;
  const params: unknown = "params" in message ? message.params : undefined;
  const reply = await handle(String(method), params).then(
    (result) => ({ jsonrpc: "2.0", id, result: result ?? null }),
    (error: unknown) => ({
      jsonrpc: "2.0",
      id,
      error: {
        code: error instanceof RpcError ? error.code : INTERNAL_ERROR,
        message: error instanceof Error ? error.message : String(error),
      },
    }),
  );
  stdout.write(frame(reply));
}
