/** What a command reads from the process it runs in, apart from files. */
export interface Context {
  readonly cwd: string;
  readonly env: Readonly<Record<string, string | undefined>>;
  /** The AI agent running the command, such as `claude`; `null` for a person or a script. */
  readonly agent: string | null;
  readonly now: Date;
}
