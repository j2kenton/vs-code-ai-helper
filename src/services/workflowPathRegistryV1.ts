/**
 * Workflow path registry (plan §2.1, Privacy cohort / executable-order
 * step 7).
 *
 * The single allocation authority for every V1 workflow path family:
 *
 *   <task-folder>/chat-v1.json
 *   <task-folder>/.ensemble-creation-sentinel-v1.json
 *   <private-storage>/workflow-runtime-v1/chat-transactions/<operation-id>/
 *   <private-storage>/workflow-runtime-v1/chat-transactions/<operation-id>/transaction-v1.json
 *   <private-storage>/workflow-runtime-v1/chat-recovery/<document-id>/<reset-id>/
 *   <private-storage>/workflow-runtime-v1/provider-results/<operation-id>/<attempt-id>/<reservation-id>/
 *   <private-storage>/workflow-runtime-v1/edit-runs/<execution-id>/
 *   <private-storage>/workflow-runtime-v1/leases/
 *   <meta-root>/creation-intents-v1/
 *
 * plus the two fixed parents family stores need for nonrecursive
 * provisioning and retention sweeps: `workflow-runtime-v1` itself and
 * `workflow-runtime-v1/chat-transactions`.
 *
 * Allocation is deliberately narrow: every method vends one exact
 * root-relative locator built from fixed literals plus strictly validated
 * 128-bit hex identities. There is no API that accepts a caller-supplied
 * relative path, no wildcard or directory-wide authority, and no absolute
 * paths in any result (plan §2.1: "Wildcard write authority, arbitrary
 * absolute paths, and directory-wide deletion authority are prohibited").
 * Locators feed workflowFileStoreV1, whose operations are themselves exact
 * and nonrecursive (plan §1.8).
 *
 * Roots are registered with an explicit kind (task folder, dedicated non-task
 * storage, private storage, meta root) and validated through
 * workflowPathSafetyV1; each allocator refuses a root of the wrong kind, so
 * e.g. a provider-result spool can never be allocated inside a task folder.
 * Every allocation cross-checks its
 * own result against the privacy classifier (plan §2.2) and refuses to
 * return a path whose classification drifted from the family's declared
 * class — binding the registry's literals and the classifier's patterns
 * together at runtime.
 *
 * Adoption is cohort-staged (plan §8): the Chat cohort routes chat-v1.json
 * and transaction/recovery storage through this registry, the Runner V1
 * spool store adopts provider-result allocation, and the Creation cohort
 * adopts intent/sentinel allocation. Until each cohort lands, its family is
 * allocated here only by tests.
 */
import { isHex128IdV1 } from "../types/actionCorrelationV1";
import {
  CHAT_TRANSACTION_FILENAME_V1,
  CHAT_TRANSACTION_RESUME_INVOCATION_CLAIM_FILENAME_V1,
} from "../types/chatInteractionTransactionV1";
import { creationIntentFileNameV1, creationJournalFileNameV1 } from "../types/taskCreationIntentV1";
import { adoptionIntentFileNameV1, adoptionJournalFileNameV1 } from "../types/taskAdoptionIntentV1";
import { CHAT_HISTORY_FILENAME, CHAT_RECOVERY_SNAPSHOT_FILENAME } from "../utils/chatHistoryConstants";
import { WorkflowFileLocatorV1 } from "./workflowFileStoreV1";
import {
  classifyWorkflowRootV1,
  validateWorkflowRelativePathV1,
  WorkflowRootV1,
} from "./workflowPathSafetyV1";
import {
  CHAT_RECOVERY_DIRNAME_V1,
  CHAT_TRANSACTIONS_DIRNAME_V1,
  classifyWorkflowPathV1,
  CREATION_INTENTS_DIRNAME_V1,
  CREATION_SENTINEL_FILENAME_V1,
  EDIT_RUNS_DIRNAME_V1,
  LEASES_DIRNAME_V1,
  PROVIDER_RESULTS_DIRNAME_V1,
  WORKFLOW_RUNTIME_DIRNAME_V1,
  WorkflowPathClassV1,
} from "./workflowPrivacyClassifierV1";

/**
 * Root kinds:
 *  - `taskFolder`: a real task folder. Registered ONLY through
 *    `ensureWorkflowTaskFolderRootV1`, which requires the folder's own
 *    strictly-decoded `task-progress.json` to carry a validated, derivable
 *    persisted `ownership` binding (plan §3.9) before any mutation trust is
 *    granted.
 *  - `nonTaskStorage`: a dedicated, non-task storage folder (today: exactly
 *    the Global Assistant's own chat folder). Registered through
 *    `ensureWorkflowNonTaskStorageRootV1` under shape+containment trust; it
 *    can never allocate task-only families (creation sentinel) and a folder
 *    carrying `task-progress.json` can never be registered under it.
 *  - `privateStorage`: the `<context.storageUri>` runtime root (plan §2.1).
 *  - `metaRoot`: a meta root for creation-intent allocation (plan §4.2).
 */
export type WorkflowRootKindV1 = "taskFolder" | "nonTaskStorage" | "privateStorage" | "metaRoot";

export interface WorkflowRootRegistrationV1 {
  readonly rootId: string;
  /** Absolute local filesystem path (workflowPathSafetyV1 root rules). */
  readonly fsPath: string;
  readonly kind: WorkflowRootKindV1;
  readonly trustedForMutation: boolean;
  /** See `WorkflowRootV1.isCurrentlyTrustedForMutation` (workflowPathSafetyV1). */
  readonly isCurrentlyTrustedForMutation?: () => boolean;
}

/** An exact registered locator plus its §2.2 privacy classification. */
export interface WorkflowAllocatedPathV1 {
  readonly locator: WorkflowFileLocatorV1;
  readonly classification: WorkflowPathClassV1;
}

export class WorkflowPathRegistryErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorkflowPathRegistryErrorV1";
  }
}

export interface WorkflowPathRegistryV1 {
  /**
   * Register a root for allocation. Throws on a duplicate root id or a root
   * path that fails the §1.8 shape rules — misregistration is a programmer
   * error, not a runtime condition.
   */
  registerRoot(registration: WorkflowRootRegistrationV1): WorkflowRootV1;
  /** All registered roots, for constructing a workflowFileStoreV1 over them. */
  registeredRoots(): readonly WorkflowRootV1[];
  /** The declared kind of a registered root, if registered. */
  rootKind(rootId: string): WorkflowRootKindV1 | undefined;

  /** `<task-folder>/chat-v1.json` — Chat-private (plan §5.1). */
  taskChatFile(taskRootId: string): WorkflowAllocatedPathV1;
  /** `<task-folder>/.ensemble-creation-sentinel-v1.json` — workflow-control (plan §4.2). */
  creationSentinelFile(taskRootId: string): WorkflowAllocatedPathV1;
  /**
   * `workflow-runtime-v1` — the shared parent of every private runtime
   * family (workflow-control). Vended so family stores can provision their
   * parents with nonrecursive mkdir (plan §1.8) instead of mkdir -p.
   */
  workflowRuntimeDir(privateRootId: string): WorkflowAllocatedPathV1;
  /**
   * `workflow-runtime-v1/chat-transactions` — the Chat-private transaction
   * family parent (plan §5.5), for provisioning and retention-sweep
   * enumeration.
   */
  chatTransactionsFamilyDir(privateRootId: string): WorkflowAllocatedPathV1;
  /** `workflow-runtime-v1/chat-transactions/<operation-id>` — Chat-private (plan §5.5). */
  chatTransactionDir(privateRootId: string, operationId: string): WorkflowAllocatedPathV1;
  /** `workflow-runtime-v1/chat-transactions/<operation-id>/transaction-v1.json` — Chat-private (plan §5.5). */
  chatTransactionFile(privateRootId: string, operationId: string): WorkflowAllocatedPathV1;
  /**
   * `workflow-runtime-v1/chat-transactions/<operation-id>/resume-invocation-claim-v1.json`
   * — Chat-private (plan §3.1 / AC-RUNNER-03): the exclusive-create,
   * true-atomic gate for the interaction's invocation-once Resume claim.
   * Sibling to `chatTransactionFile` within the same operation directory.
   */
  chatTransactionResumeInvocationClaimFile(
    privateRootId: string,
    operationId: string
  ): WorkflowAllocatedPathV1;
  /**
   * `workflow-runtime-v1/chat-recovery` — the Chat-private recovery-snapshot
   * family parent (plan §5.1), for nonrecursive provisioning.
   */
  chatRecoveryFamilyDir(privateRootId: string): WorkflowAllocatedPathV1;
  /**
   * `workflow-runtime-v1/chat-recovery/<document-id>` — Chat-private (plan
   * §5.1), for nonrecursive provisioning of the per-document parent.
   */
  chatRecoveryDocumentDir(privateRootId: string, documentId: string): WorkflowAllocatedPathV1;
  /** `workflow-runtime-v1/chat-recovery/<document-id>/<reset-id>` — Chat-private (plan §5.1). */
  chatRecoveryDir(privateRootId: string, documentId: string, resetId: string): WorkflowAllocatedPathV1;
  /**
   * `workflow-runtime-v1/chat-recovery/<document-id>/<reset-id>/snapshot-v1.json`
   * — Chat-private (plan §5.1): the verified pre-reset document snapshot
   * Reset Chat History writes before clearing any unresolved interaction.
   */
  chatRecoverySnapshotFile(
    privateRootId: string,
    documentId: string,
    resetId: string
  ): WorkflowAllocatedPathV1;
  /** `workflow-runtime-v1/provider-results/<op>/<attempt>/<reservation>` — transient provider data (plan §3.2). */
  providerResultSpoolDir(
    privateRootId: string,
    operationId: string,
    attemptId: string,
    reservationId: string
  ): WorkflowAllocatedPathV1;
  /** `workflow-runtime-v1/edit-runs/<execution-id>` — workflow-control (plan §7). */
  editRunDir(privateRootId: string, executionId: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/leases` — workflow-control (plan §2.1). */
  leasesDir(privateRootId: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/creation-intents-v1/work-<digest>` — workflow-control (plan §4.2). */
  creationWorkDir(metaRootId: string, digest: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/creation-intents-v1` — workflow-control (plan §4.2). */
  creationIntentsDir(metaRootId: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/creation-intents-v1/intent-<digest>.json` — workflow-control (plan §4.2). */
  creationIntentFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/creation-intents-v1/journal-<digest>.json` — workflow-control (plan §4.2). */
  creationJournalFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/creation-intents-v1/adoption-<digest>.json` — workflow-control (plan §4.4). */
  adoptionIntentFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1;
  /** `<meta-root>/creation-intents-v1/adoption-journal-<digest>.json` — workflow-control (plan §4.4). */
  adoptionJournalFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1;
}

class WorkflowPathRegistryImplV1 implements WorkflowPathRegistryV1 {
  private readonly rootsById = new Map<string, WorkflowRootV1>();
  private readonly kindsById = new Map<string, WorkflowRootKindV1>();

  registerRoot(registration: WorkflowRootRegistrationV1): WorkflowRootV1 {
    if (typeof registration.rootId !== "string" || registration.rootId.length === 0) {
      throw new WorkflowPathRegistryErrorV1("A workflow root id must be a non-empty string.");
    }
    if (this.rootsById.has(registration.rootId)) {
      throw new WorkflowPathRegistryErrorV1(
        `Duplicate workflow root id: ${JSON.stringify(registration.rootId)}.`
      );
    }
    const classification = classifyWorkflowRootV1(registration.fsPath);
    if (!classification.ok) {
      throw new WorkflowPathRegistryErrorV1(
        `Refused to register workflow root ${JSON.stringify(registration.rootId)}: ${classification.reason}.`
      );
    }
    const root: WorkflowRootV1 = {
      rootId: registration.rootId,
      fsPath: registration.fsPath,
      trustedForMutation: registration.trustedForMutation,
      ...(registration.isCurrentlyTrustedForMutation !== undefined
        ? { isCurrentlyTrustedForMutation: registration.isCurrentlyTrustedForMutation }
        : {}),
    };
    this.rootsById.set(registration.rootId, root);
    this.kindsById.set(registration.rootId, registration.kind);
    return root;
  }

  registeredRoots(): readonly WorkflowRootV1[] {
    return [...this.rootsById.values()];
  }

  rootKind(rootId: string): WorkflowRootKindV1 | undefined {
    return this.kindsById.get(rootId);
  }

  private requireRootOfKind(rootId: string, kind: WorkflowRootKindV1): void {
    this.requireRootOfAnyKind(rootId, [kind]);
  }

  private requireRootOfAnyKind(rootId: string, kinds: readonly WorkflowRootKindV1[]): void {
    const actual = this.kindsById.get(rootId);
    if (actual === undefined) {
      throw new WorkflowPathRegistryErrorV1(`Unknown workflow root id: ${JSON.stringify(rootId)}.`);
    }
    if (!kinds.includes(actual)) {
      throw new WorkflowPathRegistryErrorV1(
        `Workflow root ${JSON.stringify(rootId)} is a ${actual} root; this family allocates only under ` +
          `${kinds.length === 1 ? `a ${kinds[0]}` : `one of ${kinds.join(", ")}`} root(s).`
      );
    }
  }

  private static requireHex128(label: string, value: string): void {
    if (!isHex128IdV1(value)) {
      throw new WorkflowPathRegistryErrorV1(
        `${label} must be a 128-bit lowercase 32-hex identity (plan §3.1); refused a malformed value.`
      );
    }
  }

  private static requireSha256Digest(label: string, value: string): void {
    if (!/^[0-9a-f]{64}$/.test(value)) {
      throw new WorkflowPathRegistryErrorV1(
        `${label} must be a lowercase 64-hex SHA-256 digest (plan §4.2); refused a malformed value.`
      );
    }
  }

  /**
   * Final shared gate for every allocation: the assembled locator must pass
   * the §1.8 relative-path rules and must classify (plan §2.2) exactly as
   * the family declares. A mismatch means the registry's literals and the
   * classifier's patterns drifted apart — fail loudly, never hand out the
   * path.
   */
  private sealed(
    rootId: string,
    relativePath: string,
    expected: WorkflowPathClassV1
  ): WorkflowAllocatedPathV1 {
    const validated = validateWorkflowRelativePathV1(relativePath);
    if (!validated.ok) {
      throw new WorkflowPathRegistryErrorV1(
        `Internal allocation produced an invalid locator: ${validated.reason}.`
      );
    }
    const classification = classifyWorkflowPathV1(relativePath);
    if (classification !== expected) {
      throw new WorkflowPathRegistryErrorV1(
        `Allocation for ${JSON.stringify(relativePath)} classified as ${classification}, expected ${expected} — ` +
          `registry literals and workflowPrivacyClassifierV1 patterns have drifted.`
      );
    }
    return { locator: { rootId, relativePath }, classification };
  }

  taskChatFile(taskRootId: string): WorkflowAllocatedPathV1 {
    // chat-v1.json lives in two legitimate root kinds: a task folder (the
    // task's own Chat) and a dedicated non-task storage folder (the Global
    // Assistant's own Chat). Every other family stays single-kind.
    this.requireRootOfAnyKind(taskRootId, ["taskFolder", "nonTaskStorage"]);
    return this.sealed(taskRootId, CHAT_HISTORY_FILENAME, "chatPrivate");
  }

  creationSentinelFile(taskRootId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(taskRootId, "taskFolder");
    return this.sealed(taskRootId, CREATION_SENTINEL_FILENAME_V1, "workflowControl");
  }

  workflowRuntimeDir(privateRootId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    return this.sealed(privateRootId, WORKFLOW_RUNTIME_DIRNAME_V1, "workflowControl");
  }

  chatTransactionsFamilyDir(privateRootId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_TRANSACTIONS_DIRNAME_V1}`,
      "chatPrivate"
    );
  }

  chatTransactionDir(privateRootId: string, operationId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("operationId", operationId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_TRANSACTIONS_DIRNAME_V1}/${operationId}`,
      "chatPrivate"
    );
  }

  chatTransactionFile(privateRootId: string, operationId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("operationId", operationId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_TRANSACTIONS_DIRNAME_V1}/${operationId}/${CHAT_TRANSACTION_FILENAME_V1}`,
      "chatPrivate"
    );
  }

  chatTransactionResumeInvocationClaimFile(
    privateRootId: string,
    operationId: string
  ): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("operationId", operationId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_TRANSACTIONS_DIRNAME_V1}/${operationId}/` +
        `${CHAT_TRANSACTION_RESUME_INVOCATION_CLAIM_FILENAME_V1}`,
      "chatPrivate"
    );
  }

  chatRecoveryFamilyDir(privateRootId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_RECOVERY_DIRNAME_V1}`,
      "chatPrivate"
    );
  }

  chatRecoveryDocumentDir(privateRootId: string, documentId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("documentId", documentId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_RECOVERY_DIRNAME_V1}/${documentId}`,
      "chatPrivate"
    );
  }

  chatRecoveryDir(privateRootId: string, documentId: string, resetId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("documentId", documentId);
    WorkflowPathRegistryImplV1.requireHex128("resetId", resetId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_RECOVERY_DIRNAME_V1}/${documentId}/${resetId}`,
      "chatPrivate"
    );
  }

  chatRecoverySnapshotFile(
    privateRootId: string,
    documentId: string,
    resetId: string
  ): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("documentId", documentId);
    WorkflowPathRegistryImplV1.requireHex128("resetId", resetId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${CHAT_RECOVERY_DIRNAME_V1}/${documentId}/${resetId}/${CHAT_RECOVERY_SNAPSHOT_FILENAME}`,
      "chatPrivate"
    );
  }

  providerResultSpoolDir(
    privateRootId: string,
    operationId: string,
    attemptId: string,
    reservationId: string
  ): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("operationId", operationId);
    WorkflowPathRegistryImplV1.requireHex128("attemptId", attemptId);
    WorkflowPathRegistryImplV1.requireHex128("reservationId", reservationId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${PROVIDER_RESULTS_DIRNAME_V1}/${operationId}/${attemptId}/${reservationId}`,
      "transientProviderData"
    );
  }

  editRunDir(privateRootId: string, executionId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    WorkflowPathRegistryImplV1.requireHex128("executionId", executionId);
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${EDIT_RUNS_DIRNAME_V1}/${executionId}`,
      "workflowControl"
    );
  }

  leasesDir(privateRootId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(privateRootId, "privateStorage");
    return this.sealed(
      privateRootId,
      `${WORKFLOW_RUNTIME_DIRNAME_V1}/${LEASES_DIRNAME_V1}`,
      "workflowControl"
    );
  }

  creationWorkDir(metaRootId: string, digest: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(metaRootId, "metaRoot");
    WorkflowPathRegistryImplV1.requireSha256Digest("digest", digest);
    return this.sealed(
      metaRootId,
      `${CREATION_INTENTS_DIRNAME_V1}/work-${digest}`,
      "workflowControl"
    );
  }

  creationIntentsDir(metaRootId: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(metaRootId, "metaRoot");
    return this.sealed(metaRootId, CREATION_INTENTS_DIRNAME_V1, "workflowControl");
  }

  creationIntentFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(metaRootId, "metaRoot");
    WorkflowPathRegistryImplV1.requireSha256Digest("digest", digest);
    return this.sealed(
      metaRootId,
      `${CREATION_INTENTS_DIRNAME_V1}/${creationIntentFileNameV1(digest)}`,
      "workflowControl"
    );
  }

  creationJournalFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(metaRootId, "metaRoot");
    WorkflowPathRegistryImplV1.requireSha256Digest("digest", digest);
    return this.sealed(
      metaRootId,
      `${CREATION_INTENTS_DIRNAME_V1}/${creationJournalFileNameV1(digest)}`,
      "workflowControl"
    );
  }

  adoptionIntentFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(metaRootId, "metaRoot");
    WorkflowPathRegistryImplV1.requireSha256Digest("digest", digest);
    return this.sealed(
      metaRootId,
      `${CREATION_INTENTS_DIRNAME_V1}/${adoptionIntentFileNameV1(digest)}`,
      "workflowControl"
    );
  }

  adoptionJournalFile(metaRootId: string, digest: string): WorkflowAllocatedPathV1 {
    this.requireRootOfKind(metaRootId, "metaRoot");
    WorkflowPathRegistryImplV1.requireSha256Digest("digest", digest);
    return this.sealed(
      metaRootId,
      `${CREATION_INTENTS_DIRNAME_V1}/${adoptionJournalFileNameV1(digest)}`,
      "workflowControl"
    );
  }
}

export function createWorkflowPathRegistryV1(): WorkflowPathRegistryV1 {
  return new WorkflowPathRegistryImplV1();
}
