import { AsyncLocalStorage } from "node:async_hooks";

/**
 * Marks a call tree that runs on behalf of automation (an automation-chain
 * dispatch, or Fast Forward driven by one) rather than a person.
 *
 * `ReviewCommandArg.automationDispatch` is the explicit flag, but a review or
 * implementation round composes many helpers (prompt-size gate, pre-run git
 * safety prompts, unchanged-tree guard) that never see the command's arg. A
 * modal raised in any of them awaits a click nobody can give and hangs the
 * chain — on the headless runner and, less often, locally. So the command
 * entry opens this scoped context and each confirmation site asks
 * `isAutomationDispatchContextV1()`: when true it takes its non-destructive
 * default, logs the choice, and never opens a dialog.
 *
 * `AsyncLocalStorage`, not a module flag, for the reason documented in
 * `unattendedExecutionV1.ts`: concurrent human-driven work must keep its
 * dialogs.
 */
const automation = new AsyncLocalStorage<true>();

/** Run `body` as automation-driven work. Nestable; scoped to this call tree. */
export function runAsAutomationDispatchV1<T>(body: () => T): T {
  return automation.run(true, body);
}

/** True while THIS call tree was started by automation, i.e. no human can answer a dialog raised here. */
export function isAutomationDispatchContextV1(): boolean {
  return automation.getStore() === true;
}

/**
 * RC9 item 3: a second, separate scope marking a call tree as started by
 * automation (an automation-chain dispatch or a scheduler timer fire), used
 * ONLY to decide whether a refusal message needs to reach a person.
 * Deliberately not `isAutomationDispatchContextV1()`, which changes what work
 * does (it suppresses dialogs); this one must never gate work.
 */
const automaticOrigin = new AsyncLocalStorage<true>();

/** Run `body` as work started automatically. Nestable; scoped to this call tree. */
export function runWithAutomaticOriginV1<T>(body: () => T): T {
  return automaticOrigin.run(true, body);
}

/**
 * True when the owner did not click this: inside `runWithAutomaticOriginV1` or
 * an automation dispatch. Answers only "should a refusal message be shown?" —
 * it must not gate work.
 */
export function hasAutomaticOriginV1(): boolean {
  return automaticOrigin.getStore() === true || isAutomationDispatchContextV1();
}

/**
 * Wrap a command handler so an invocation carrying the exact literal
 * `automationDispatch: true` marker runs inside the automation context. Any
 * other argument (including every UI-supplied one) leaves the handler untouched.
 */
export function withAutomationDispatchContextV1<A, R>(
  handler: (arg?: A) => R
): (arg?: A) => R {
  return (arg?: A): R =>
    typeof arg === "object" &&
    arg !== null &&
    (arg as { automationDispatch?: unknown }).automationDispatch === true
      ? runAsAutomationDispatchV1(() => handler(arg))
      : handler(arg);
}

/** The line every automation-default site logs, so the choice is auditable. */
export function describeAutomationDefaultV1(what: string, chosen: string): string {
  return `[automation] ${what}: no human attached, took the non-destructive default (${chosen}).`;
}

/**
 * review1 Step 24: marks a call tree whose automatic dispatch already passed the "is this working?" gate
 * (`admitAutomaticDispatchV1`). The work-admission layer reads it to refuse an automatic claim that skipped the gate.
 */
const automaticGatePassed = new AsyncLocalStorage<true>();

/** Run `body` as automatic work that has passed the progress gate. Implies automatic origin. */
export function runWithAdmittedAutomaticDispatchV1<T>(body: () => T): T {
  return runWithAutomaticOriginV1(() => automaticGatePassed.run(true, body));
}

/** True inside {@link runWithAdmittedAutomaticDispatchV1}. */
export function hasPassedAutomaticGateV1(): boolean {
  return automaticGatePassed.getStore() === true;
}

/**
 * review1 Step 24 (shared boundary): marks a call tree as started by the owner (a command they ran, a button they
 * clicked in a webview). The work-admission layer records a claim as the owner's only inside this scope and only
 * when no automatic origin applies; anything else, including a path nobody marked, counts as automatic.
 */
const ownerOrigin = new AsyncLocalStorage<true>();

/** Run `body` as owner-started work. Nestable; scoped to this call tree. Automatic origin still wins inside it. */
export function runWithOwnerOriginV1<T>(body: () => T): T {
  return ownerOrigin.run(true, body);
}

/** True inside {@link runWithOwnerOriginV1}. */
export function hasOwnerOriginV1(): boolean {
  return ownerOrigin.getStore() === true;
}

/** Wrap an owner-facing entry point (command handler, webview message handler) so its call tree is owner-started. */
export function asOwnerEntryPointV1<A extends unknown[], R>(handler: (...args: A) => R): (...args: A) => R {
  return (...args: A): R => runWithOwnerOriginV1(() => handler(...args));
}
