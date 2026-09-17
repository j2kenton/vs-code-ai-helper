/**
 * Marks work the runner is doing ON BEHALF OF a viewer (hostRelayV1.ts).
 *
 * The runner is a VS Code nobody is looking at: a native modal there stops
 * the action dead. The viewer meanwhile shows "Running on the runner: …" for
 * the full relay timeout and then blames the runner for not answering, while
 * the runner sits healthy behind a dialog that can still be clicked hours
 * later (review, 2026-09-17). `RELAYABLE_COMMAND_IDS_V1`'s own rule — "no
 * modal a runner could not answer" — cannot be checked by reading a command's
 * entry point, because the modals live deep inside (a prompt-size
 * confirmation, a drafted-edit confirmation).
 *
 * So a relayed command runs with this flag set, and each confirmation site
 * declines instead of asking, with a reason the relay hands back to the
 * viewer. Nothing is silently assumed: an unanswerable confirmation becomes a
 * refusal the user can see and retry deliberately (on the runner's own screen
 * if they want the dialog).
 *
 * Deliberately a plain module flag rather than a parameter threaded through
 * every call: the sites are several layers below the relay executor, and a
 * parameter would have to be added to every command signature in between.
 * The runner executes relayed requests one at a time per lane and never runs
 * a relayed and a local command in the same tick, so there is no interleaving
 * to get wrong; `runUnattendedV1` restores the previous value regardless.
 */

let unattendedDepth = 0;

/** Run `body` as unattended relayed work. Nestable; always restores. */
export async function runUnattendedV1<T>(body: () => Promise<T>): Promise<T> {
  unattendedDepth += 1;
  try {
    return await body();
  } finally {
    unattendedDepth -= 1;
  }
}

/**
 * True while this window is executing a request relayed from another window,
 * i.e. while no human can answer a dialog raised here.
 */
export function isUnattendedExecutionV1(): boolean {
  return unattendedDepth > 0;
}

/** The refusal a confirmation site reports instead of opening a modal. */
export function unattendedRefusalV1(what: string): string {
  return `${what} needs a confirmation, which cannot be answered on the runner. Nothing was changed — do this from the runner's own screen, or from a window that runs the workflow itself.`;
}

/** Tests only: clear any leaked depth between cases. */
export function resetUnattendedExecutionForTestV1(): void {
  unattendedDepth = 0;
}
