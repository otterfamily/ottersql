import { serveJsonRpc } from "./json-rpc.ts";
import { createMapper } from "./mapper.ts";

/** Answers TypeScript's content mapper requests over stdin and stdout until the process ends. */
export function serve(): void {
  serveJsonRpc(createMapper());
}
