import {
  createMessageConnection,
  StreamMessageReader,
  StreamMessageWriter,
} from "vscode-jsonrpc/node";

import { createMapper } from "./mapper.ts";

const handle = createMapper();
const connection = createMessageConnection(
  new StreamMessageReader(process.stdin),
  new StreamMessageWriter(process.stdout),
);
connection.onRequest(async (method, params) => handle(method, params));
connection.listen();
