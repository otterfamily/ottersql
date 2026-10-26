/** Every message in `error`'s chain of causes: where a value from a row or a parameter must not appear. */
export function errorChainText(error: unknown): string {
  const messages: string[] = [];
  let current = error;
  while (current instanceof Error) {
    messages.push(current.message);
    current = current.cause;
  }
  return messages.join("\n");
}
