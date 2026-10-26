import type { Context } from "./context.ts";

/**
 * The environment variables coding agents set, after std-env's `detectAgent`, which ottersql
 * follows instead of depending on (ADR 0013). `AI_AGENT` names any agent that sets it.
 */
const agents: readonly (readonly [name: string, test: (env: Context["env"]) => boolean])[] = [
  ["claude", (env) => has(env, "CLAUDECODE", "CLAUDE_CODE")],
  ["replit", (env) => has(env, "REPL_ID")],
  ["gemini", (env) => has(env, "GEMINI_CLI")],
  ["codex", (env) => has(env, "CODEX_SANDBOX", "CODEX_THREAD_ID")],
  ["opencode", (env) => has(env, "OPENCODE")],
  ["pi", (env) => /\.pi[\/\\]agent/v.test(env["PATH"] ?? "")],
  ["auggie", (env) => has(env, "AUGMENT_AGENT")],
  ["goose", (env) => has(env, "GOOSE_PROVIDER")],
  ["junie", (env) => has(env, "JUNIE_DATA", "JUNIE_SHIM_PATH")],
  ["copilot", (env) => has(env, "COPILOT_AGENT", "COPILOT_CLI")],
  ["devin", (env) => /devin/v.test(env["EDITOR"] ?? "")],
  ["cursor", (env) => has(env, "CURSOR_AGENT")],
  ["kiro", (env) => /kiro/v.test(env["TERM_PROGRAM"] ?? "")],
];

const copilotAgents: ReadonlySet<string> = new Set([
  "github_copilot_vscode_agent",
  "github_copilot_cloud_agent",
]);

/** The coding agent `env` shows is running the command, such as `claude`, or `null`. */
export function detectAgent(env: Context["env"]): string | null {
  const named = env["AI_AGENT"]?.toLowerCase();
  if (named !== undefined && named !== "") {
    return copilotAgents.has(named) ? "copilot" : named;
  }
  return agents.find(([, test]) => test(env))?.[0] ?? null;
}

function has(env: Context["env"], ...names: readonly string[]): boolean {
  return names.some((name) => (env[name] ?? "") !== "");
}
