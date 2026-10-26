#!/usr/bin/env node
import { stderr, stdout } from "node:process";

import { detectAgent } from "./agent.ts";
import { main } from "./main.ts";

// The first two are the Node.js executable and this script.
const FIRST_ARGUMENT = 2;

process.exitCode = await main(process.argv.slice(FIRST_ARGUMENT), {
  cwd: process.cwd(),
  env: process.env,
  agent: detectAgent(process.env),
  now: new Date(),
  stdout: (text) => {
    stdout.write(text);
  },
  stderr: (text) => {
    stderr.write(text);
  },
});
