import { spawn } from "node:child_process";
import { once } from "node:events";
import { text } from "node:stream/consumers";

/** What a finished command printed and exited with. */
export interface Run {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

export async function run(command: string, args: readonly string[], cwd: string): Promise<Run> {
  const child = spawn(command, args, { cwd });
  const [stdout, stderr, exit] = await Promise.all([
    text(child.stdout),
    text(child.stderr),
    once(child, "exit"),
  ]);
  const code: unknown = exit[0];
  return { exitCode: typeof code === "number" ? code : 1, stdout, stderr };
}

/** What `command` printed; throws with its output when it fails. */
export async function succeeded(
  command: string,
  args: readonly string[],
  cwd: string,
): Promise<string> {
  const result = await run(command, args, cwd);
  if (result.exitCode !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed:\n${result.stdout}${result.stderr}`);
  }
  return result.stdout;
}
