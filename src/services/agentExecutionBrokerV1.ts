/**
 * V1 agent execution broker (plan §3.2, "Replace output-file runners with
 * bounded result capture").
 *
 * The broker — not the runner — creates the bounded output writer, chooses
 * memory or registered spool storage, enforces limits, seals and hashes the
 * result, converts exit state to `RawAgentExecutionResultV1`, and deletes
 * unsealed/overflowed output. Invocation authority comes exclusively from a
 * reservation claimed through `providerSelectionPolicyV1.ts`: the broker
 * validates that the claimed reservation binds the identical correlation
 * tuple, reservation id, and mode as the request, that the supplied
 * transport is the exact runner the reservation was issued for, and
 * consumes the reservation's single invocation before touching the
 * transport.
 *
 * Fail-closed boundary rules enforced here (plan §1.3, mirrored from the
 * legacy boundary in `legacyAiActionSafetyGateV0.ts`):
 *  - V1 invocation requires registry-issued correlation and reservation
 *    data — malformed tuples are rejected before any provider work;
 *  - only migrated action keys are allowed (`MIGRATED_ACTION_KEYS_V0`);
 *  - a request carrying any legacy artifact/result path field is rejected
 *    outright (AC-RUNNER-01: no V1 request contains an artifact/result
 *    path).
 */
import {
  correlationMatchesV1,
  isActionCorrelationV1,
  isHex128IdV1,
} from "../types/actionCorrelationV1";
import {
  AgentExecutionRequestV1,
  AgentTransportExitV1,
  AgentTransportV1,
  BoundedResultWriterV1,
  classifyNetworkFaultV1,
  maxResponseBytesCeilingForModeV1,
  RawAgentExecutionResultV1,
  RoundProcessStateV1,
  SealedResultPayloadV1,
} from "../types/agentExecutionV1";
import type * as vscode from "vscode";
import { createHash } from "crypto";
import { MIGRATED_ACTION_KEYS_V0 } from "./legacyAiActionSafetyGateV0";
import { assertAiExecutionAllowedInThisHostV1 } from "../state/hostRoleV1";
import { classifyRoundProcessStateV1 } from "../state/recordedCliStopV1";
import { BoundedResultStoreV1 } from "./boundedResultStoreV1";
import { ClaimedReservationV1 } from "./providerSelectionPolicyV1";

export class AgentExecutionBrokerErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "AgentExecutionBrokerErrorV1";
  }
}

/** Sealed responses larger than this go to the spool store (when one is configured). */
export const DEFAULT_SPOOL_THRESHOLD_BYTES_V1 = 256 * 1024;

/**
 * Hard upper bound for a brokered provider invocation. Individual transports
 * may finish sooner, but no unresolved transport may hold a task operation
 * and its admission indefinitely.
 *
 * 60 minutes, the same wall clock a CLI round gets (`cliAgentRunner.ts`
 * `RUN_TIMEOUT_MS`). It was 15 minutes, which only ever bit Copilot: a Copilot
 * round or plan runs as one brokered tool session of up to `MAX_TOOL_ROUNDS_V1`
 * sequential model calls, and a Copilot plan generation on a large task was
 * cut off at exactly 15:00 per model (observed 2026-09-25, wt-b, two models,
 * 30:00 total, then `candidatesExhausted`). The bound exists to stop a hung
 * transport from holding the task for ever, not to budget a working session.
 */
export const DEFAULT_INVOCATION_WALL_CLOCK_MS_V1 = 60 * 60_000;

/**
 * Bounded grace a process-owning transport gets, after the broker cancels the
 * derived token it handed that transport (wall-clock deadline or a relayed
 * caller cancellation), to confirm its process is actually gone and settle
 * `transport.invoke` itself.
 *
 * Before this existed, `awaitProcessOwningTransportExitV1` cancelled the
 * derived token and then awaited `transport.invoke` with no bound at all: a
 * transport whose process ignored termination (or a transport bug that never
 * resolved) held the operation — and the task's admission, which renews for
 * as long as this promise is pending — forever. Once the grace elapses
 * without the transport settling, the broker gives up waiting and reports the
 * trigger it already knows (the deadline, or the caller's cancellation)
 * instead of continuing to block on an unresponsive transport.
 */
export const PROCESS_EXIT_GRACE_AFTER_DEADLINE_MS_V1 = 3 * 60_000;

/**
 * Legacy output-destination field names that must never appear on a V1
 * request object. The V1 type has no such fields; this runtime check stops a
 * legacy `AgentRunRequest`-shaped object from being smuggled across the
 * boundary through a cast.
 */
const FORBIDDEN_LEGACY_PATH_FIELDS_V1 = [
  "outputFile",
  "outputPath",
  "resultPath",
  "resultFile",
  "logFile",
  "taskFolderUri",
  "workspaceUri",
] as const;

interface BoundedWriterInternalV1 extends BoundedResultWriterV1 {
  collect(): Buffer;
  /**
   * Stop accepting bytes and discard anything buffered so far. Used only when
   * the broker has given up waiting on a transport (grace elapsed after
   * cancellation, item 2 / Step 54): the transport's own `invoke` promise is
   * left running in the background, and whatever it still writes afterwards
   * must never be folded into a result the broker already returned.
   */
  seal(): void;
  /**
   * Record that the transport's own `invoke` promise settled (successfully
   * or with an error) after the broker had already given up on it and
   * returned a terminal outcome — even though it made no further write, so
   * `write()`'s own late-arrival log never fired (item 2 / Step 56). Logged
   * at most once per writer, sharing the same guard as a late write, so a
   * late settlement that also carries a late write does not double-log.
   */
  noteLateSettlement(kind: "resolved" | "rejected"): void;
}

/**
 * Create the broker-owned bounded writer. Once the byte limit is exceeded
 * the writer discards everything it buffered (overflowed output is never
 * retained), reports `overflowed`, and refuses further bytes.
 */
export function createBoundedResultWriterV1(maxBytes: number): BoundedResultWriterV1 {
  return createInternalWriter(maxBytes);
}

/**
 * Item 2 / Step 56 (late-result fence): once `seal()` has run — the broker
 * gave up on this invocation (deadline, caller cancellation or provider
 * cancellation; see `awaitProcessOwningTransportExitV1`/
 * `awaitTransportExitV1`) and already returned a terminal outcome for it — a
 * transport that goes on writing anyway must have that write dropped
 * silently at the byte level (unchanged) but NOT silently at the log level:
 * without a trace, a late write that lands after the round has already been
 * reported `failed`/`cancelled` is indistinguishable from a transport that
 * simply stopped, which is exactly the kind of unexplained gap item 2 exists
 * to close. Logged at most once per writer (a transport still streaming can
 * call `write` many times after seal; one line is enough to diagnose it,
 * repeating it per chunk would just be noise) and includes `logContext` so
 * the line can be tied back to the operation/attempt it belongs to.
 */
function createInternalWriter(maxBytes: number, logContext?: string): BoundedWriterInternalV1 {
  let buffers: Buffer[] = [];
  let bytesWritten = 0;
  let overflowed = false;
  let sealed = false;
  let lateActivityLogged = false;
  const logLateActivity = (detail: string): void => {
    if (lateActivityLogged) {
      return;
    }
    lateActivityLogged = true;
    console.warn(
      `agentExecutionBrokerV1: ${detail} after this invocation was already terminalized` +
        `${logContext ? ` (${logContext})` : ""}; no artifact or progress was written from it.`
    );
  };
  return {
    get overflowed(): boolean {
      return overflowed;
    },
    get bytesWritten(): number {
      return bytesWritten;
    },
    write(chunk: Uint8Array | string): boolean {
      if (sealed) {
        logLateActivity("a transport write arrived");
        return false;
      }
      if (overflowed) {
        return false;
      }
      const bytes = typeof chunk === "string" ? Buffer.from(chunk, "utf8") : Buffer.from(chunk);
      bytesWritten += bytes.length;
      if (bytesWritten > maxBytes) {
        overflowed = true;
        buffers = [];
        return false;
      }
      buffers.push(bytes);
      return true;
    },
    collect(): Buffer {
      return Buffer.concat(buffers);
    },
    seal(): void {
      sealed = true;
      buffers = [];
    },
    noteLateSettlement(kind: "resolved" | "rejected"): void {
      logLateActivity(`a transport invocation ${kind}`);
    },
  };
}

export interface AgentExecutionBrokerOptionsV1 {
  /** Private spool store for large sealed responses. Without one, everything seals in memory. */
  readonly spoolStore?: BoundedResultStoreV1;
  /** Byte size above which a sealed response is spooled instead of held in memory. */
  readonly spoolThresholdBytes?: number;
  /** Wall-clock limit for one transport invocation; defaults to 60 minutes. */
  readonly invocationTimeoutMs?: number;
  /**
   * Grace a process-owning transport gets, after cancellation, to confirm its
   * process is gone; defaults to `PROCESS_EXIT_GRACE_AFTER_DEADLINE_MS_V1`
   * (3 minutes). Overridable so tests (and a dev build's lowered watchdog,
   * plan gate G4) do not have to wait the real 3 minutes.
   */
  readonly processExitGraceMs?: number;
  /**
   * Identity of the reservation actually invoked, stamped onto a spooled
   * response's metadata so a later claim (or an unclaimed recovery read) can
   * attribute the content without re-deriving it from configuration.
   */
  readonly provider?: {
    readonly providerLabel: string;
    readonly storedModelId: string;
  };
}

function validateRequest(
  request: AgentExecutionRequestV1,
  claimedReservation: ClaimedReservationV1,
  transport: AgentTransportV1
): void {
  const rawRequest = request as unknown as Record<string, unknown>;
  for (const forbidden of FORBIDDEN_LEGACY_PATH_FIELDS_V1) {
    if (Object.prototype.hasOwnProperty.call(rawRequest, forbidden)) {
      throw new AgentExecutionBrokerErrorV1(
        `Rejected a V1 execution request carrying legacy field "${forbidden}": a V1 request never ` +
          "contains an artifact or result destination — the broker owns all result capture."
      );
    }
  }
  if (!isActionCorrelationV1(request.correlation)) {
    throw new AgentExecutionBrokerErrorV1(
      "Rejected a V1 execution request without a complete, well-formed correlation tuple."
    );
  }
  if (!isHex128IdV1(request.reservationId)) {
    throw new AgentExecutionBrokerErrorV1(
      "Rejected a V1 execution request without a well-formed 128-bit reservation id."
    );
  }
  if (!MIGRATED_ACTION_KEYS_V0.has(request.correlation.actionKey)) {
    throw new AgentExecutionBrokerErrorV1(
      `Rejected a V1 execution request for actionKey=${JSON.stringify(request.correlation.actionKey)}: ` +
        "only actions migrated to the coordinator (MIGRATED_ACTION_KEYS_V0 in legacyAiActionSafetyGateV0.ts) " +
        "may invoke a provider through the V1 broker."
    );
  }
  const handle = claimedReservation.handle;
  if (handle.reservationId !== request.reservationId) {
    throw new AgentExecutionBrokerErrorV1(
      "Rejected a V1 execution request whose reservation id does not match its claimed reservation."
    );
  }
  if (!correlationMatchesV1(handle.correlation, request.correlation)) {
    throw new AgentExecutionBrokerErrorV1(
      "Rejected a V1 execution request whose correlation tuple does not match its claimed reservation."
    );
  }
  if (handle.mode !== request.mode) {
    throw new AgentExecutionBrokerErrorV1(
      `Rejected a V1 execution request whose mode ("${request.mode}") does not match its ` +
        `claimed reservation ("${handle.mode}").`
    );
  }
  if (transport.runnerId !== handle.runnerId) {
    // A reservation authorizes exactly the runner the selection policy
    // reserved — a transport for any other runner cannot borrow it.
    throw new AgentExecutionBrokerErrorV1(
      `Rejected a V1 execution request whose transport (runnerId="${transport.runnerId}") does not match ` +
        `its claimed reservation's runner (runnerId="${handle.runnerId}"); a reservation authorizes only ` +
        "the runner it was issued for."
    );
  }
  const ceiling = maxResponseBytesCeilingForModeV1(request.mode);
  if (
    typeof request.maxResponseBytes !== "number" ||
    !Number.isInteger(request.maxResponseBytes) ||
    request.maxResponseBytes <= 0 ||
    request.maxResponseBytes > ceiling
  ) {
    throw new AgentExecutionBrokerErrorV1(
      `Rejected a V1 execution request with maxResponseBytes=${String(request.maxResponseBytes)}: ` +
        `the "${request.mode}" mode requires an integer between 1 and ${ceiling}.`
    );
  }
}

function sealInMemory(utf8Text: string, rawBytes: Buffer): RawAgentExecutionResultV1 {
  const payload: SealedResultPayloadV1 = {
    storage: "memory",
    utf8Text,
    byteLength: rawBytes.length,
    sha256: createHash("sha256").update(rawBytes).digest("hex"),
  };
  return { kind: "response", payload };
}

async function sealCompletedResponse(
  request: AgentExecutionRequestV1,
  rawBytes: Buffer,
  options: AgentExecutionBrokerOptionsV1
): Promise<RawAgentExecutionResultV1> {
  const utf8Text = rawBytes.toString("utf8");
  if (!Buffer.from(utf8Text, "utf8").equals(rawBytes)) {
    // Invalid UTF-8 cannot be sealed losslessly; decoding it would silently
    // substitute replacement characters and detach the text from its hash.
    return { kind: "transportFailure", code: "invalidUtf8Output", responseStarted: true };
  }
  const threshold = options.spoolThresholdBytes ?? DEFAULT_SPOOL_THRESHOLD_BYTES_V1;
  if (options.spoolStore && rawBytes.length > threshold) {
    try {
      const spoolRef = await options.spoolStore.writeSpool(
        request.correlation,
        request.reservationId,
        rawBytes,
        options.provider ? { provider: options.provider } : undefined
      );
      return { kind: "response", payload: { storage: "spool", spoolRef } };
    } catch {
      // Spooling is a size-management optimization, not a correctness
      // requirement: rawBytes are already held in memory at this point, so a
      // disk-write failure falls back to sealing them in memory (exactly the
      // path below, and exactly what every response took before a spool
      // store was ever wired into production) instead of discarding a
      // fully-received, paid-for response as a terminal, non-retryable
      // failure.
      return sealInMemory(utf8Text, rawBytes);
    }
  }
  return sealInMemory(utf8Text, rawBytes);
}

/**
 * The two phases of one brokered provider invocation (plan §3.2/§3.3).
 *
 * `prepareAgentInvocationV1` performs EVERYTHING that can fail before the
 * transport is ever touched — request/reservation/transport validation,
 * consumption of the reservation's single invocation, the pre-requested
 * cancellation check, and bounded-writer creation — and returns either a
 * ready `invoke` closure or the pre-invocation outcome (a token that was
 * already cancelled before any provider work). The action coordinator's
 * Resume path runs this preparation BEFORE taking its durable
 * invocation-once claim, so a throw anywhere in setup leaves no claim at
 * all and the interaction stays fully retryable; the only work after the
 * claim is `invoke` itself (plan §3.1 / AC-RUNNER-03).
 */
export type PreparedAgentInvocationV1 =
  | {
      readonly kind: "prepared";
      readonly invoke: (
        options?: AgentExecutionBrokerOptionsV1
      ) => Promise<RawAgentExecutionResultV1>;
    }
  | {
      readonly kind: "preInvocationOutcome";
      readonly outcome: RawAgentExecutionResultV1;
    };

/**
 * Validate and arm one claimed provider reservation without touching the
 * transport. Throws (never returns a failure object) on a malformed
 * request, a reservation/correlation/mode/transport mismatch, or a second
 * invocation of the same reservation — exactly the fail-closed boundary
 * rules `executeAgentRequestV1` enforced at its head.
 */
export function prepareAgentInvocationV1(
  request: AgentExecutionRequestV1,
  claimedReservation: ClaimedReservationV1,
  transport: AgentTransportV1
): PreparedAgentInvocationV1 {
  // Provider-boundary backstop for the cloud viewer/runner split: a viewer
  // host never reaches a provider, whatever path led here (hostRoleV1.ts).
  assertAiExecutionAllowedInThisHostV1();
  validateRequest(request, claimedReservation, transport);
  // Consume the reservation's single invocation before any provider work; a
  // second execution with the same claimed reservation throws here.
  claimedReservation.beginInvocation();

  if (request.cancellationToken.isCancellationRequested) {
    return { kind: "preInvocationOutcome", outcome: { kind: "callerCancelled" } };
  }

  const writer = createInternalWriter(
    request.maxResponseBytes,
    `operationId=${request.correlation.operationId} attemptId=${request.correlation.attemptId}`
  );
  return {
    kind: "prepared",
    invoke: (options: AgentExecutionBrokerOptionsV1 = {}): Promise<RawAgentExecutionResultV1> =>
      finishInvocation(request, transport, writer, options),
  };
}

/**
 * Attach a {@link RoundProcessStateV1} to an outcome that reports a timeout
 * or a cancellation (item 2 / Step 54) — the only outcomes where the broker
 * gave up waiting on, or is reporting the end of, an invocation without a
 * transport-confirmed settle, so whether a process it may own is still
 * running is otherwise unknown to the caller. A request with no
 * `processIdentity` gets the outcome back unchanged, exactly as before this
 * field existed.
 */
async function attachProcessStateV1(
  outcome: RawAgentExecutionResultV1,
  processIdentity: AgentExecutionRequestV1["processIdentity"]
): Promise<RawAgentExecutionResultV1> {
  if (!processIdentity) {
    return outcome;
  }
  const eligible =
    outcome.kind === "providerCancelled" ||
    outcome.kind === "callerCancelled" ||
    (outcome.kind === "transportFailure" && outcome.code === "invocationDeadlineExceeded");
  if (!eligible) {
    return outcome;
  }
  const processState: RoundProcessStateV1 = await classifyRoundProcessStateV1(
    processIdentity.taskFolderPath,
    processIdentity.claimId
  );
  return { ...outcome, processState };
}

async function finishInvocation(
  request: AgentExecutionRequestV1,
  transport: AgentTransportV1,
  writer: BoundedWriterInternalV1,
  options: AgentExecutionBrokerOptionsV1
): Promise<RawAgentExecutionResultV1> {
  const outcome = await computeInvocationOutcomeV1(request, transport, writer, options);
  return attachProcessStateV1(outcome, request.processIdentity);
}

async function computeInvocationOutcomeV1(
  request: AgentExecutionRequestV1,
  transport: AgentTransportV1,
  writer: BoundedWriterInternalV1,
  options: AgentExecutionBrokerOptionsV1
): Promise<RawAgentExecutionResultV1> {
  let exit: AgentTransportExitV1;
  try {
    const invocationTimeoutMs = options.invocationTimeoutMs ?? DEFAULT_INVOCATION_WALL_CLOCK_MS_V1;
    const graceMs = options.processExitGraceMs ?? PROCESS_EXIT_GRACE_AFTER_DEADLINE_MS_V1;
    const deadline = await awaitTransportExitV1(transport, request, writer, invocationTimeoutMs, graceMs);
    if (deadline.kind === "timedOut") {
      return {
        kind: "transportFailure",
        code: "invocationDeadlineExceeded",
        responseStarted: writer.bytesWritten > 0,
        detail: `provider invocation exceeded ${invocationTimeoutMs}ms`,
      };
    }
    exit = deadline.exit;
  } catch (error) {
    // A transport that throws directly (rather than resolving a
    // `transportFailure` exit) never gets a chance to classify its own
    // fault — classify defensively here too, so a raw network error thrown
    // out of `invoke` gets the same item-14 treatment as one a transport
    // catches and reports itself.
    const networkFault = classifyNetworkFaultV1(error);
    return {
      kind: "transportFailure",
      code:
        error instanceof Error && error.name.length > 0 && error.name !== "Error"
          ? `transportException.${error.name}`
          : "transportException",
      responseStarted: networkFault ? false : writer.bytesWritten > 0,
      ...(networkFault ? { networkFault: true } : {}),
    };
  }

  if (writer.overflowed) {
    // The writer already discarded its buffers; the response is unusable and
    // overflow is terminal for fallback (plan §3.3).
    return { kind: "overflow" };
  }

  switch (exit.kind) {
    case "completed":
      return sealCompletedResponse(request, writer.collect(), options);
    case "providerCancelled":
      return { kind: "providerCancelled" };
    case "callerCancelled":
      return { kind: "callerCancelled" };
    case "transportFailure":
      return {
        kind: "transportFailure",
        code: exit.code,
        // Item 14: a transport-flagged network fault forces `responseStarted`
        // false regardless of how many bytes the writer buffered — those
        // bytes are a truncated fragment of a frame that will never
        // complete, not partial model output, so they must not make this
        // failure terminal for fallback purposes. Every other transport
        // failure keeps the existing byte-count heuristic unchanged.
        responseStarted: exit.networkFault === true ? false : writer.bytesWritten > 0,
        // Pass the transport's sanitized cause through verbatim. Dropping it
        // here would defeat the point of capturing it: the code alone is what
        // made `copilotRequestFailed` undiagnosable.
        ...(exit.detail !== undefined ? { detail: exit.detail } : {}),
        ...(exit.networkFault === true ? { networkFault: true } : {}),
      };
  }
}

/**
 * A cancellation token the broker controls, fed by the caller's token. Handed
 * to a process-owning transport in place of the caller's so the broker can also
 * ask it to stop when the wall-clock deadline passes.
 */
function createDerivedCancellationV1(parent: vscode.CancellationToken): {
  readonly token: vscode.CancellationToken;
  cancel(): void;
  dispose(): void;
} {
  const listeners = new Set<(e: unknown) => unknown>();
  let requested = parent.isCancellationRequested;
  const cancel = (): void => {
    if (requested && listeners.size === 0) {
      return;
    }
    requested = true;
    for (const listener of [...listeners]) {
      try {
        listener(undefined);
      } catch {
        // A throwing listener must not stop the others from stopping the process.
      }
    }
    listeners.clear();
  };
  const parentSubscription = parent.onCancellationRequested(cancel);
  const token = {
    get isCancellationRequested(): boolean {
      return requested;
    },
    onCancellationRequested: (listener: (e: unknown) => unknown): vscode.Disposable => {
      if (requested) {
        // Like vscode's own tokens, a listener added after cancellation still hears it.
        queueMicrotask(() => listener(undefined));
        return { dispose: () => undefined };
      }
      listeners.add(listener);
      return { dispose: () => void listeners.delete(listener) };
    },
  } as unknown as vscode.CancellationToken;
  return {
    token,
    cancel,
    dispose: (): void => {
      parentSubscription.dispose();
      listeners.clear();
    },
  };
}

/**
 * Invoke a transport that owns an OS process. Cancel and the wall-clock
 * deadline are delivered to it through a broker-controlled token and the
 * broker waits for the transport's own result, which arrives only once its
 * process is confirmed gone — the caller releases the task's admission lock as
 * soon as this settles, so settling ahead of the transport would let the next
 * action start over a still-running provider CLI.
 *
 * That wait is bounded (item 2 / Step 54): once cancellation fires — from the
 * wall-clock deadline above, or from the caller's own token relayed through
 * `derived` — the transport's kill escalation gets `graceMs` to confirm the
 * process is gone and settle `transport.invoke` itself. If it has not settled
 * once the grace elapses, the broker stops waiting and reports the trigger it
 * already knows (`timedOut` for the deadline, `callerCancelled` otherwise)
 * rather than blocking on an unresponsive transport indefinitely. The
 * transport's promise is left running in the background (never left
 * unhandled), and the writer is sealed so any bytes it still emits afterwards
 * are dropped rather than folded into a result the broker already returned.
 */
async function awaitProcessOwningTransportExitV1(
  transport: AgentTransportV1,
  request: AgentExecutionRequestV1,
  writer: BoundedWriterInternalV1,
  timeoutMs: number,
  graceMs: number
): Promise<{ readonly kind: "completed"; readonly exit: AgentTransportExitV1 } | { readonly kind: "timedOut" }> {
  const derived = createDerivedCancellationV1(request.cancellationToken);
  let deadlineHit = false;
  const timeout = setTimeout(() => {
    deadlineHit = true;
    derived.cancel();
  }, timeoutMs);
  let graceTimer: ReturnType<typeof setTimeout> | undefined;
  try {
    const invokePromise = transport.invoke({ ...request, cancellationToken: derived.token }, writer);
    // Once we give up below, this promise keeps running unobserved; a later
    // rejection must not surface as an unhandled rejection.
    invokePromise.catch(() => undefined);

    const settledOutcome = invokePromise.then(
      (exit): { readonly kind: "settled"; readonly exit: AgentTransportExitV1 } => ({ kind: "settled", exit })
    );
    const gaveUpOutcome = new Promise<{ readonly kind: "gaveUp" }>((resolve) => {
      derived.token.onCancellationRequested(() => {
        graceTimer = setTimeout(() => resolve({ kind: "gaveUp" }), graceMs);
      });
    });

    const winner = await Promise.race([settledOutcome, gaveUpOutcome]);
    if (winner.kind === "gaveUp") {
      writer.seal();
      // The transport's own `invoke` promise is still running (see the
      // comment at its creation above). If it later settles — even with no
      // further write, so `write()`'s own late-arrival log never fires —
      // that is exactly the unexplained gap item 2 / Step 56 exists to
      // close, so it gets the same log line, once.
      invokePromise.then(
        () => writer.noteLateSettlement("resolved"),
        () => writer.noteLateSettlement("rejected")
      );
      return deadlineHit ? { kind: "timedOut" } : { kind: "completed", exit: { kind: "callerCancelled" } };
    }
    const transportExit = winner.exit;
    // The wall-clock deadline is a hard cap on the invocation, not merely a
    // slower path to the same success: once it has fired, the transport's own
    // eventual exit can no longer turn into a completed response, even one
    // that settles with `kind: "completed"` before the grace elapses. Without
    // this, a transport that ignored its cancellation signal and finished the
    // work anyway could turn a watchdog-triggered invocation into a false
    // success — exactly the outcome item 2's terminal settlement (Step 55)
    // depends on never happening. The response's bytes are discarded, same as
    // the grace-elapsed path above.
    if (deadlineHit) {
      writer.seal();
      return { kind: "timedOut" };
    }
    // The transport has settled, so its process (if any) is confirmed gone.
    // If the CALLER cancelled at any point during this invocation, that
    // cancellation supersedes whatever the transport went on to settle with
    // — including a `completed` response it produced anyway after ignoring
    // its cancellation signal. Without discarding that response too, a
    // caller cancellation could turn into the exact same false success the
    // deadline override above exists to prevent, just triggered by Cancel
    // instead of the watchdog. The response's bytes are discarded (sealed)
    // the same way; a non-completed exit reports as a cancel regardless of
    // whatever failure code the stopped transport used.
    if (request.cancellationToken.isCancellationRequested) {
      if (transportExit.kind === "completed") {
        writer.seal();
      }
      return { kind: "completed", exit: { kind: "callerCancelled" } };
    }
    return { kind: "completed", exit: transportExit };
  } finally {
    clearTimeout(timeout);
    if (graceTimer !== undefined) {
      clearTimeout(graceTimer);
    }
    derived.dispose();
  }
}

async function awaitTransportExitV1(
  transport: AgentTransportV1,
  request: AgentExecutionRequestV1,
  writer: BoundedWriterInternalV1,
  timeoutMs: number,
  graceMs: number
): Promise<{ readonly kind: "completed"; readonly exit: AgentTransportExitV1 } | { readonly kind: "timedOut" }> {
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    throw new AgentExecutionBrokerErrorV1(`invocationTimeoutMs must be a positive finite number; received ${String(timeoutMs)}`);
  }

  if (transport.confirmsProcessExitBeforeSettling === true) {
    return awaitProcessOwningTransportExitV1(transport, request, writer, timeoutMs, graceMs);
  }

  return new Promise((resolve, reject) => {
    let settled = false;
    let cancelHit = false;
    let graceTimer: ReturnType<typeof setTimeout> | undefined;

    // The wall-clock deadline gives up on this transport's own settlement
    // immediately: there is no OS process here to kill-escalate the way
    // `awaitProcessOwningTransportExitV1`'s grace exists for, so waiting any
    // longer than the deadline itself buys nothing. `transport.invoke`'s
    // promise is left running in the background regardless, and item 2
    // requires that whatever it still writes afterwards is dropped rather
    // than folded into a result the broker already returned — sealed
    // immediately, before any such write can land.
    const timeout = setTimeout(() => {
      writer.seal();
      finish({ kind: "timedOut" });
    }, timeoutMs);

    // A caller cancellation is different: it is a request to stop, not proof
    // the transport is unresponsive, so — mirroring
    // `awaitProcessOwningTransportExitV1`'s grace — it gets `graceMs` to let
    // `transport.invoke` settle on its own (a cooperative in-host transport
    // may honour the token promptly) before the broker gives up and reports
    // the cancellation itself. Whatever the transport settles with once
    // cancelled — including a `completed` result it produced anyway — is
    // superseded by the cancellation and never becomes a success; see the
    // identical reasoning in `awaitProcessOwningTransportExitV1`.
    const cancellation = request.cancellationToken.onCancellationRequested(() => {
      cancelHit = true;
      if (graceTimer === undefined && !settled) {
        graceTimer = setTimeout(() => {
          writer.seal();
          finish({ kind: "completed", exit: { kind: "callerCancelled" } });
        }, graceMs);
      }
    });

    function finish(
      result: { readonly kind: "completed"; readonly exit: AgentTransportExitV1 } | { readonly kind: "timedOut" }
    ): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      cancellation.dispose();
      resolve(result);
    }

    function fail(error: unknown): void {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timeout);
      if (graceTimer !== undefined) {
        clearTimeout(graceTimer);
      }
      cancellation.dispose();
      reject(error);
    }

    try {
      Promise.resolve(transport.invoke(request, writer)).then(
        (transportExit) => {
          // `finish` already ran once, for the timeout or the cancellation
          // grace — this is `transport.invoke` itself settling afterwards.
          // Even with no further write (so `write()`'s own late-arrival log
          // never fires), that settlement is exactly the unexplained gap
          // item 2 / Step 56 exists to close.
          if (settled) {
            writer.noteLateSettlement("resolved");
            return;
          }
          if (cancelHit) {
            if (transportExit.kind === "completed") {
              writer.seal();
            }
            finish({ kind: "completed", exit: { kind: "callerCancelled" } });
            return;
          }
          finish({ kind: "completed", exit: transportExit });
        },
        (error) => {
          if (settled) {
            writer.noteLateSettlement("rejected");
            return;
          }
          fail(error);
        }
      );
    } catch (error) {
      fail(error);
    }
  });
}

/**
 * Execute one claimed provider reservation through a transport, with
 * broker-owned bounded result capture. The transport is handed only the
 * request and the bounded writer — never a path. Every exit maps onto
 * `RawAgentExecutionResultV1`; unsealed and overflowed output is discarded.
 *
 * Equivalent to `prepareAgentInvocationV1` followed immediately by `invoke`
 * (or the pre-invocation outcome); callers that need setup to complete
 * before a durability boundary — the coordinator's Resume invocation claim —
 * use the split form directly.
 */
export async function executeAgentRequestV1(
  request: AgentExecutionRequestV1,
  claimedReservation: ClaimedReservationV1,
  transport: AgentTransportV1,
  options: AgentExecutionBrokerOptionsV1 = {}
): Promise<RawAgentExecutionResultV1> {
  const prepared = prepareAgentInvocationV1(request, claimedReservation, transport);
  if (prepared.kind === "preInvocationOutcome") {
    return prepared.outcome;
  }
  return prepared.invoke(options);
}
