import { serve } from "./json-rpc.ts";
import { createMapper } from "./mapper.ts";

await serve(
  process.stdin,
  (data) => {
    process.stdout.write(data);
  },
  createMapper(),
);
