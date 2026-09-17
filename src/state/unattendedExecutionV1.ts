import { AsyncLocalStorage } from "node:async_hooks";

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
 * So a relayed command runs inside `runUnattendedV1`, and each confirmation
 * site declines instead of asking, with a reason the relay hands back to the
 * viewer. Nothing is silently assumed: an unanswerable confirmation becomes a
 * refusal the user can see and retry deliberately (on the runner's own screen
 * if they want the dialog).
 *
 * Scoped with `AsyncLocalStorage`, NOT a module flag (verification review,
 * 2026-09-17). The runner runs relayed requests concurrently, and its own
 * scheduled work runs alongside them; a process-wide flag therefore gagged
 * confirmations belonging to work the user WAS driving, and leaked
 * permanently whenever the relay's deadline abandoned a command that kept
 * running. A context tracks exactly the call tree it was opened around.
 */

const unattended = new AsyncLocalStorage<true>();

/** Run `body` as unattended relayed work. Nestable; scoped to this call tree. */
export async function runUnattendedV1<T>(body: () => Promise<T>): Promise<T> {
  return unattended.run(true, body);
}

/**
 * True while THIS call tree is executing a request relayed from another
 * window, i.e. while no human can answer a dialog raised here.
 */
export function isUnattendedExecutionV1(): boolean {
  return unattended.getStore() === true;
}

/** The refusal a confirmation site reports instead of opening a modal. */
export function unattendedRefusalV1(what: string): string {
  return `${what} needs a confirmation, which cannot be answered on the runner. Nothing was changed — do this from the runner's own screen, or from a window that runs the workflow itself.`;
}
