interface Request {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export type Handler = (method: string, params: unknown) => Promise<unknown>;

/** An error a handler throws to answer with a specific JSON-RPC error code. */
export class RpcError extends Error {
  override readonly name = "RpcError";
  readonly code: number;

  constructor(code: number, message: string) {
    super(message);
    this.code = code;
  }
}

// JSON-RPC 2.0 error codes.
const PARSE_ERROR = -32_700;
const INTERNAL_ERROR = -32_603;
export const METHOD_NOT_FOUND = -32_601;

const HEADER_END = "\r\n\r\n";
const contentLength = /^content-length: (?<length>\d+)$/imv;

/**
 * Serves JSON-RPC 2.0 with `Content-Length` framing, the transport TypeScript's content mappers
 * use. Requests are handled one at a time, in arrival order, because they share one database.
 */
export async function serve(
  input: AsyncIterable<Uint8Array> | Iterable<Uint8Array>,
  write: (data: string) => void,
  handle: Handler,
): Promise<void> {
  let buffered: Readonly<Buffer> = Buffer.alloc(0);
  for await (const chunk of input) {
    buffered = Buffer.concat([buffered, chunk]);
    for (let frame = takeFrame(buffered); frame !== null; frame = takeFrame(buffered)) {
      buffered = frame.rest;
      const request = frame.body === null ? null : parseRequest(frame.body);
      if (request === null) {
        reply(write, null, parseError);
      } else {
        await respond(write, request, handle);
      }
    }
  }
}

const parseError = { error: { code: PARSE_ERROR, message: "Parse error" } };

/** The next complete frame; its body is `null` when the header has no usable Content-Length. */
function takeFrame(
  buffered: Readonly<Buffer>,
): { readonly body: string | null; readonly rest: Readonly<Buffer> } | null {
  const headerEnd = buffered.indexOf(HEADER_END);
  if (headerEnd === -1) {
    return null;
  }
  const length = bodyLength(buffered.subarray(0, headerEnd).toString());
  const bodyStart = headerEnd + HEADER_END.length;
  if (Number.isNaN(length)) {
    return { body: null, rest: buffered.subarray(bodyStart) };
  }
  if (buffered.length < bodyStart + length) {
    return null;
  }
  return {
    body: buffered.subarray(bodyStart, bodyStart + length).toString(),
    rest: buffered.subarray(bodyStart + length),
  };
}

function bodyLength(header: string): number {
  return Number(contentLength.exec(header)?.groups?.["length"]);
}

/** The request in `body`, or `null` when it is not a JSON-RPC request. */
function parseRequest(body: string): Request | null {
  let value: unknown = null;
  try {
    value = JSON.parse(body);
  } catch {
    return null;
  }
  if (
    typeof value !== "object" ||
    value === null ||
    !("method" in value) ||
    typeof value.method !== "string"
  ) {
    return null;
  }
  const id =
    "id" in value && (typeof value.id === "number" || typeof value.id === "string")
      ? value.id
      : undefined;
  const params = "params" in value ? value.params : undefined;
  return id === undefined ? { method: value.method, params } : { id, method: value.method, params };
}

async function respond(
  write: (data: string) => void,
  request: Request,
  handle: Handler,
): Promise<void> {
  const outcome = await settle(handle, request);
  if (request.id !== undefined) {
    reply(write, request.id, outcome);
  }
}

function reply(write: (data: string) => void, id: number | string | null, outcome: object): void {
  const body = JSON.stringify({ jsonrpc: "2.0", id, ...outcome });
  write(`Content-Length: ${String(Buffer.byteLength(body))}${HEADER_END}${body}`);
}

async function settle(handle: Handler, request: Request): Promise<object> {
  try {
    return { result: (await handle(request.method, request.params)) ?? null };
  } catch (error) {
    const code = error instanceof RpcError ? error.code : INTERNAL_ERROR;
    return { error: { code, message: error instanceof Error ? error.message : String(error) } };
  }
}
