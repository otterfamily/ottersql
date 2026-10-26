// Declared here rather than taken from the DOM or Node types, which a project using ottersql may
// not load: every runtime ottersql supports has this timer.
declare function setTimeout(callback: () => void, milliseconds: number): unknown;

/** Resolves after `milliseconds`, with nothing but `setTimeout`, so it runs wherever JavaScript does. */
export async function wait(milliseconds: number): Promise<void> {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, milliseconds);
  });
}
