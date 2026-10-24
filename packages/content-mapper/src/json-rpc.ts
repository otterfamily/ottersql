interface Request {
  readonly id?: number | string;
  readonly method: string;
  readonly params?: unknown;
}

export type Handler = (method: string, params: unknown) => Promise<unknown>;

const HEADER_END = "\r\n\r\n";
const contentLength = /^content-length: (?<length>\d+)$/imv;

/**
 * Serves JSON-RPC 2.0 with `Content-Length` framing, the transport TypeScript's content mappers
 * use. Requests are handled one at a time, in arrival order, because they share one database.
 */
export async function serve(
  input: AsyncIterable<Uint8Array>,
  write: (data: string) => void,
  handle: Handler,
): Promise<void> {
  let buffered: Readonly<Buffer> = Buffer.alloc(0);
  for await (const chunk of input) {
    buffered = Buffer.concat([buffered, chunk]);
    for (let frame = takeFrame(buffered); frame !== null; frame = takeFrame(buffered)) {
      buffered = frame.rest;
      await respond(write, parseRequest(frame.body), handle);
    }
  }
}

function takeFrame(
  buffered: Readonly<Buffer>,
): { readonly body: string; readonly rest: Readonly<Buffer> } | null {
  const headerEnd = buffered.indexOf(HEADER_END);
  if (headerEnd === -1) {
    return null;
  }
  const header = buffered.subarray(0, headerEnd).toString();
  const length = Number(contentLength.exec(header)?.groups?.["length"]);
  const bodyStart = headerEnd + HEADER_END.length;
  if (Number.isNaN(length) || buffered.length < bodyStart + length) {
    return null;
  }
  return {
    body: buffered.subarray(bodyStart, bodyStart + length).toString(),
    rest: buffered.subarray(bodyStart + length),
  };
}

function parseRequest(body: string): Request {
  const value: unknown = JSON.parse(body);
  if (
    typeof value !== "object" ||
    value === null ||
    !("method" in value) ||
    typeof value.method !== "string"
  ) {
    throw new TypeError(`not a JSON-RPC request: ${body}`);
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
    const body = JSON.stringify({ jsonrpc: "2.0", id: request.id, ...outcome });
    write(`Content-Length: ${String(Buffer.byteLength(body))}${HEADER_END}${body}`);
  }
}

async function settle(handle: Handler, request: Request): Promise<object> {
  try {
    return { result: (await handle(request.method, request.params)) ?? null };
  } catch (error) {
    return {
      error: { code: -32_603, message: error instanceof Error ? error.message : String(error) },
    };
  }
}
