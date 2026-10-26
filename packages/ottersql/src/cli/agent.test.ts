import { describe, expect, test } from "vitest";

import { detectAgent } from "./agent.ts";

describe("detecting the coding agent that runs the command", () => {
  test.for([
    { env: { CLAUDECODE: "1" }, agent: "claude" },
    { env: { CURSOR_AGENT: "1" }, agent: "cursor" },
    { env: { AI_AGENT: "Amp" }, agent: "amp" },
    { env: { AI_AGENT: "github_copilot_cloud_agent" }, agent: "copilot" },
    { env: { TERM_PROGRAM: "kiro" }, agent: "kiro" },
    { env: { CLAUDECODE: "" }, agent: null },
    { env: {}, agent: null },
  ])("finds $agent in $env", ({ env, agent }) => {
    expect(detectAgent(env)).toBe(agent);
  });
});
