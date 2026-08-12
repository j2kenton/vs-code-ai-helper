/**
 * Sandbox audit accounting (plan Part 11, acceptance criterion 6).
 *
 * The static execution-boundary scan proves the engine cannot execute
 * anything locally; this module proves the complementary runtime property:
 * every command that reached a sandbox is ACCOUNTED FOR by the crash-safe
 * execution-attempt protocol (Part 4c). Auditing a provider's command ledger
 * against the attempt store checks, for every recorded execution:
 *
 * 1. **Accounted** — the command's attempt key resolves to a persisted
 *    `sandboxCommand` execution-attempt record. The protocol persists the
 *    record BEFORE the command is issued, so an execution with no record is
 *    evidence of a pathway around the protocol (or a store that lost a
 *    write) and fails the audit.
 * 2. **Marked** — the command line the provider received starts with the
 *    `ENSEMBLE_ATTEMPT_KEY_V1` marker carrying that same attempt key, so
 *    post-crash reconciliation can identify the attempt in provider audit
 *    state. An unmarked command is invisible to reconciliation and fails
 *    the audit.
 *
 * The reverse direction is deliberately NOT an audit failure: an attempt
 * record with no ledger entry is normal (a crash before the call, an
 * apply-changes-only approval, or an attachExisting verification produce
 * records without commands) and is what recovery reconciles.
 */
import type { EngineExecutionAttemptStoreV1 } from "./executionAttemptStoreV1";
import {
  quotePosixShellArgV1,
  RecordedSandboxCommandV1,
  SANDBOX_ATTEMPT_KEY_MARKER_V1,
} from "./sandboxClientV1";

/** One audit finding: a recorded execution the protocol cannot account for. */
export interface SandboxAuditFindingV1 {
  readonly command: RecordedSandboxCommandV1;
  readonly problem: "noAttemptRecord" | "attemptKindMismatch" | "markerMissing";
}

export interface SandboxAuditReportV1 {
  /** True when every recorded execution is accounted for and marked. */
  readonly ok: boolean;
  readonly commandsAudited: number;
  readonly findings: readonly SandboxAuditFindingV1[];
}

/**
 * Audit a sandbox provider's command ledger against the execution-attempt
 * store. `commands` is the provider's complete record of executed commands
 * (the in-memory client's `executedCommands`; a real provider's process/
 * audit log filtered to the task's sandbox).
 */
export async function auditSandboxCommandAccountingV1(
  commands: readonly RecordedSandboxCommandV1[],
  attemptStore: EngineExecutionAttemptStoreV1
): Promise<SandboxAuditReportV1> {
  const findings: SandboxAuditFindingV1[] = [];
  for (const command of commands) {
    const markerPrefix = `${SANDBOX_ATTEMPT_KEY_MARKER_V1}=${quotePosixShellArgV1(command.attemptKey)} `;
    if (!command.commandText.startsWith(markerPrefix)) {
      findings.push({ command, problem: "markerMissing" });
    }
    const record = await attemptStore.read(command.attemptKey);
    if (record === undefined) {
      findings.push({ command, problem: "noAttemptRecord" });
    } else if (record.effectKind !== "sandboxCommand") {
      findings.push({ command, problem: "attemptKindMismatch" });
    }
  }
  return { ok: findings.length === 0, commandsAudited: commands.length, findings };
}
