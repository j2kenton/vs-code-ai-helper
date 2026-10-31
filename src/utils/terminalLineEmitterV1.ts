/**
 * bugs3 Step 3: the one place that decides whether an operation's terminal
 * "Ended …" chat line may be posted.
 *
 * Two writers can speak for the same operation: the round ledger
 * (`terminalizeRoundV1`, which appends the durable `kind: "outcome"` message)
 * and the operation observer in the chat view (`OperationEndedLineTrackerV1`).
 * Neither decides on its own any more. Each asks this registry, keyed by the
 * operation id, and exactly one line is posted per key:
 *
 *  - the round ledger is the authority for a round: its claim succeeds once,
 *    and only when the observer has not already spoken for the key. A
 *    reservation made by the code that knows the ledger will speak
 *    (`reserveLedgerTerminalLineV1`) keeps the observer silent even though the
 *    ledger has not written yet;
 *  - the observer may speak only when the ledger neither reserved nor claimed
 *    the key, and only once;
 *  - a second claim by the same authority is refused, so duplicate delivery of
 *    an operation's end (or a repeated ledger pass) cannot post twice.
 */

export type TerminalLineAuthorityV1 = "ledger" | "operation";

interface TerminalLineStateV1 {
  reservedForLedger: boolean;
  claimedBy?: TerminalLineAuthorityV1;
}

const MAX_KEYS_V1 = 500;
const statesV1 = new Map<string, TerminalLineStateV1>();

function stateFor(key: string): TerminalLineStateV1 {
  let state = statesV1.get(key);
  if (!state) {
    state = { reservedForLedger: false };
    statesV1.set(key, state);
    // Bounded: an operation that never ends must not grow this without limit.
    if (statesV1.size > MAX_KEYS_V1) {
      const oldest = statesV1.keys().next().value;
      if (oldest !== undefined && oldest !== key) {
        statesV1.delete(oldest);
      }
    }
  }
  return state;
}

/**
 * The registry key under which a ledger row's terminal line is arbitrated: the
 * row's operation id when it has one (so the operation observer is arbitrated
 * against it too), else a round-scoped key. Terminalization and reconciliation
 * repair both use it, so they cannot each post the same row's line.
 */
export function terminalLineKeyForRoundV1(
  row: { readonly roundId: string; readonly operationId?: string },
  taskFolderPath: string
): string {
  return row.operationId ?? `round:${taskFolderPath}:${row.roundId}`;
}

/** The round ledger will post this operation's terminal line; the observer must stay silent. */
export function reserveLedgerTerminalLineV1(key: string): void {
  stateFor(key).reservedForLedger = true;
}

/**
 * Ask to post the terminal line for `key`. Returns true at most once per key
 * and authority, and never to the observer when the ledger reserved or already
 * claimed the key.
 */
export function claimTerminalLineV1(key: string, authority: TerminalLineAuthorityV1): boolean {
  const state = stateFor(key);
  if (authority === "ledger") {
    // The observer already posted this operation's line (the command returned
    // before the round was terminalized): a second line would be a duplicate.
    if (state.claimedBy !== undefined) {
      return false;
    }
    state.claimedBy = "ledger";
    return true;
  }
  if (state.reservedForLedger || state.claimedBy !== undefined) {
    return false;
  }
  state.claimedBy = "operation";
  return true;
}

/** Has the ledger reserved or claimed this operation's terminal line? */
export function ledgerOwnsTerminalLineV1(key: string): boolean {
  const state = statesV1.get(key);
  return state !== undefined && (state.reservedForLedger || state.claimedBy === "ledger");
}

/** The operation observer already posted this operation's terminal line. */
export function operationSpokeTerminalLineV1(key: string): boolean {
  return statesV1.get(key)?.claimedBy === "operation";
}

/**
 * The ledger claimed the line but its durable message did not land: give the
 * claim back so reconciliation can repair the message and the line is not lost.
 */
export function releaseLedgerTerminalLineV1(key: string): void {
  const state = statesV1.get(key);
  if (state?.claimedBy === "ledger") {
    state.claimedBy = undefined;
  }
}

/**
 * The operation observer claimed the line but its chat message was not saved:
 * give the claim back so the round ledger (terminalization or reconciliation
 * repair) can still post the line once storage recovers.
 */
export function releaseOperationTerminalLineV1(key: string): void {
  const state = statesV1.get(key);
  if (state?.claimedBy === "operation") {
    state.claimedBy = undefined;
  }
}

/** Drop a key (tests, and an operation whose line has been fully settled). */
export function forgetTerminalLineV1(key: string): void {
  statesV1.delete(key);
}

/** Drop every key (tests that reuse operation ids across cases). */
export function resetTerminalLinesV1(): void {
  statesV1.clear();
}
