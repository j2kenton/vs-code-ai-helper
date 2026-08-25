/**
 * `review.v1` registry row (plan §6.5, "Migrate remaining text actions").
 *
 * Target artifact: review artifact (e.g. `<task-folder>/plan-high-review.md`).
 * Completed-content type: `markdown-artifact.v1`.
 * Provider mode: `text`.
 */
import * as vscode from "vscode";
import {
  ProviderTaskActionRowV1,
  TaskActionCompletedContentValidationResultV1,
  TaskActionExecutionContextV1,
  TaskActionInputValidationResultV1,
  TaskActionPromotionCodeV1,
} from "../taskActionRegistryV1";
import { maxResponseBytesCeilingForModeV1 } from "../../types/agentExecutionV1";
import { CompletedContentV1 } from "../../types/aiResultEnvelope";
import { getWorkflowFileStoreV1 } from "../../services/workflowRuntimeServicesV1";
import { WorkflowFileRevisionV1 } from "../../services/workflowFileStoreV1";
import { parseReadiness, withVisibleReviewedCommitLineV1 } from "../../utils/reviewReadiness";
import { attributionModelLabel, withAttribution } from "../../utils/fileUtils";
import { checkPublishChecksFreshnessV1 } from "../../utils/publishChecksFreshness";
import { extractCompletionChecksSectionV1, mergeCompletionChecksSection } from "../../utils/completionLint";
import { extractScopeCheckSectionV1, mergeScopeCheckSection } from "../../utils/publishScopeCheck";
import {
  extractPublishChecksFreshnessStampSectionV1,
  mergePublishChecksFreshnessStamp,
} from "../../utils/publishChecksFreshness";
import { resolveHeadCommitSha } from "../../utils/gitRepoInfo";

export const REVIEW_ACTION_KEY_V1 = "review.v1";

/**
 * Publish-only promotion-time freshness guard (plan PART 2, step 7's
 * "immediately before promotion, re-read the stamp and current HEAD"
 * requirement). Captured once by the caller at the SAME moment the
 * entry-point freshness gate accepted a stamp — before the provider call
 * that can run for minutes — and re-checked in `promoteReviewContentV1`
 * right before the CAS write, so a Publish Checks re-run or a new commit
 * landing while the model was executing cannot let a review promote against
 * evidence that has since been superseded. `runId` (not just the commit SHA)
 * is compared so a NEW Publish Checks run against the SAME commit still
 * invalidates the guard.
 */
export interface PublishReviewFreshnessGuardV1 {
  readonly taskFolderPath: string;
  readonly scopeFolderPath: string;
  readonly runId: string;
  readonly verifiedCommitSha: string;
}

export interface ReviewActionInputV1 {
  readonly prompt: string;
  readonly targetLocator: { readonly rootId: string; readonly relativePath: string };
  readonly baselineRevision?: WorkflowFileRevisionV1;
  readonly publishFreshnessGuard?: PublishReviewFreshnessGuardV1;
}

const MAX_PROMPT_LENGTH_V1 = 8 * 1024 * 1024;

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

/** @internal exported for testing */
export function validateReviewInputV1(
  rawInput: unknown
): TaskActionInputValidationResultV1 {
  if (typeof rawInput !== "object" || rawInput === null) {
    return { ok: false, reason: "input is not an object" };
  }
  const raw = rawInput as Record<string, unknown>;
  if (!isNonEmptyString(raw.prompt)) {
    return { ok: false, reason: "input is missing a non-empty \"prompt\" string" };
  }
  if (Buffer.byteLength(raw.prompt, "utf8") > MAX_PROMPT_LENGTH_V1) {
    return { ok: false, reason: "input \"prompt\" exceeds the maximum length" };
  }
  const locator = raw.targetLocator;
  if (
    typeof locator !== "object" ||
    locator === null ||
    !isNonEmptyString((locator as Record<string, unknown>).rootId) ||
    !isNonEmptyString((locator as Record<string, unknown>).relativePath)
  ) {
    return {
      ok: false,
      reason: "input \"targetLocator\" must be { rootId: non-empty string, relativePath: non-empty string }",
    };
  }
  if (raw.baselineRevision !== undefined && !isNonEmptyString(raw.baselineRevision)) {
    return { ok: false, reason: "input \"baselineRevision\" must be a non-empty string when present" };
  }
  if (raw.publishFreshnessGuard !== undefined) {
    const guard = raw.publishFreshnessGuard;
    if (
      typeof guard !== "object" ||
      guard === null ||
      !isNonEmptyString((guard as Record<string, unknown>).taskFolderPath) ||
      !isNonEmptyString((guard as Record<string, unknown>).scopeFolderPath) ||
      !isNonEmptyString((guard as Record<string, unknown>).runId) ||
      !isNonEmptyString((guard as Record<string, unknown>).verifiedCommitSha)
    ) {
      return {
        ok: false,
        reason:
          'input "publishFreshnessGuard" must be { taskFolderPath, scopeFolderPath, runId, verifiedCommitSha: non-empty strings }',
      };
    }
  }
  const allowedKeys = new Set(["prompt", "targetLocator", "baselineRevision", "publishFreshnessGuard"]);
  for (const key of Object.keys(raw)) {
    if (!allowedKeys.has(key)) {
      return { ok: false, reason: `input has an unknown field: ${key}` };
    }
  }
  const validated: ReviewActionInputV1 = {
    prompt: raw.prompt,
    targetLocator: {
      rootId: (locator as { rootId: string }).rootId,
      relativePath: (locator as { relativePath: string }).relativePath,
    },
    ...(raw.baselineRevision !== undefined ? { baselineRevision: raw.baselineRevision } : {}),
    ...(raw.publishFreshnessGuard !== undefined
      ? { publishFreshnessGuard: raw.publishFreshnessGuard as PublishReviewFreshnessGuardV1 }
      : {}),
  };
  return { ok: true, input: validated };
}

function isMarkdownArtifactV1(
  content: CompletedContentV1
): content is Extract<CompletedContentV1, { contentType: "markdown-artifact.v1" }> {
  return content.contentType === "markdown-artifact.v1";
}

class ReviewPromotionErrorV1 extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReviewPromotionErrorV1";
  }
}

/**
 * Every review prompt requires a leading `Readiness: N/10` line (see
 * reviewActions.ts's validateReviewOutput, the same rule this mirrors). A
 * response missing it is a strong signal the provider didn't actually
 * perform the review (e.g. it asked a clarifying question instead) — and
 * this is a fault of THIS candidate's response, not of the target artifact,
 * so it is checked as `validateCompletedContent` (before the coordinator
 * commits to the "completed" attempt outcome) rather than inside
 * `promoteCompletedContent`, letting the coordinator advance to the next
 * ranked candidate instead of settling a terminal `promotionFailed`
 * (2026-08-16 field report, fourth item: three identical `grok-4.6` failures
 * exhausted the whole chain while a working `sonnet@high` backup sat idle).
 */
function validateReviewCompletedContentV1(
  content: CompletedContentV1
): TaskActionCompletedContentValidationResultV1 {
  if (!isMarkdownArtifactV1(content)) {
    return { ok: false, reason: "review.v1 received a non-markdown-artifact completed content" };
  }
  if (parseReadiness(content.markdown).score === null) {
    return { ok: false, reason: 'review.v1 response has no "Readiness: N/10" line' };
  }
  return { ok: true };
}

/**
 * Re-check Publish Checks freshness immediately before the artifact write
 * (plan PART 2, step 7). Requires not merely the same commit but the same
 * `runId` the entry-point gate accepted, so a Publish Checks run that
 * started and finished against the SAME commit while this review's provider
 * call was in flight — evidence the reviewer never actually consumed — still
 * blocks promotion rather than silently passing a coincidental SHA match.
 */
async function revalidatePublishFreshnessOrThrowV1(
  guard: PublishReviewFreshnessGuardV1
): Promise<void> {
  const taskFolderUri = vscode.Uri.file(guard.taskFolderPath);
  const currentCommitSha = await resolveHeadCommitSha(guard.scopeFolderPath);
  const check = await checkPublishChecksFreshnessV1(
    taskFolderUri,
    guard.scopeFolderPath,
    currentCommitSha
  );
  const stillValid =
    check.status === "valid" &&
    check.stamp.runId === guard.runId &&
    check.stamp.verifiedCommitSha === guard.verifiedCommitSha;
  if (!stillValid) {
    throw new ReviewPromotionErrorV1(
      "Publish Checks changed (a new run or a new commit) while this review was being generated, so " +
        "the review was not saved. Run Publish Checks again and retry the review."
    );
  }
}

/** Generous enough for any realistic publish-review.md; a read this size
 * failing is treated as "nothing to preserve", same as a missing file. */
const PUBLISH_REVIEW_READ_BOUND_BYTES = 4 * 1024 * 1024;

/**
 * Re-inject the Publish ground-truth sections (Completion Checks, Scope
 * Check, freshness stamp) that a Publish review write would otherwise
 * clobber (plan item 17, step 20): `promoteReviewContentV1` writes the AI's
 * ENTIRE response as the new file content, and those sections live in
 * `publish-review.md` too now that the split with `publish-checks.md` is
 * reversed. Reads whatever is currently on disk at promotion time (not an
 * earlier snapshot) and appends each managed section back onto the fresh
 * markdown via the same merge helpers `runCompletionLint`/
 * `runPublishScopeCheck` use, so the result is byte-identical to what a
 * subsequent checks run would produce. A missing file, an unreadable file, or
 * a file with no managed sections yet all degrade to "nothing to preserve" —
 * this never blocks or fails the review write.
 */
async function reinjectPublishGroundTruthSectionsV1(
  fileStore: ReturnType<typeof getWorkflowFileStoreV1>,
  targetLocator: { readonly rootId: string; readonly relativePath: string },
  markdown: string
): Promise<string> {
  const existingRead = await fileStore.readFileBounded(targetLocator, PUBLISH_REVIEW_READ_BOUND_BYTES);
  if (existingRead.kind !== "ok") {
    return markdown;
  }
  const existingContent = existingRead.value.bytes.toString("utf8");
  let merged = markdown;
  const completionChecks = extractCompletionChecksSectionV1(existingContent);
  if (completionChecks) {
    merged = mergeCompletionChecksSection(merged, completionChecks);
  }
  const scopeCheck = extractScopeCheckSectionV1(existingContent);
  if (scopeCheck) {
    merged = mergeScopeCheckSection(merged, scopeCheck);
  }
  const freshnessStamp = extractPublishChecksFreshnessStampSectionV1(existingContent);
  if (freshnessStamp) {
    merged = mergePublishChecksFreshnessStamp(merged, freshnessStamp);
  }
  return merged;
}

async function promoteReviewContentV1(
  content: CompletedContentV1,
  context: TaskActionExecutionContextV1
): Promise<TaskActionPromotionCodeV1> {
  if (!isMarkdownArtifactV1(content)) {
    throw new ReviewPromotionErrorV1("review.v1 received a non-markdown-artifact completed content");
  }
  const input = context.validatedInput as ReviewActionInputV1;
  if (context.stage === "publish") {
    if (!input.publishFreshnessGuard) {
      throw new ReviewPromotionErrorV1(
        "publish review promotion is missing its freshness guard"
      );
    }
    await revalidatePublishFreshnessOrThrowV1(input.publishFreshnessGuard);
  }
  const fileStore = getWorkflowFileStoreV1();
  // Review freshness, write time: a review carrying a reviewed-commit marker
  // gets a VISIBLE `> Reviewed commit: <sha>` line under its Readiness line
  // (the trailing HTML comment stays — parsers read only that form), and any
  // stale banner the model echoed back out of the shown previous review is
  // stripped — a review being written now assesses the current workspace by
  // construction. No-op for plan reviews and marker-less content.
  const freshMarkdown = withVisibleReviewedCommitLineV1(content.markdown);
  // Signed with the reservation actually claimed/invoked (never the row's
  // requested model), so a backup-cascade substitution is reflected here —
  // same helper and header format the legacy CliAgentRunner text path uses,
  // so a review artifact is indistinguishable regardless of which path wrote
  // it (see fileUtils.ts's withAttribution/attributionModelLabel).
  const attributedMarkdown = context.provider
    ? withAttribution(
        freshMarkdown,
        context.provider.providerLabel,
        attributionModelLabel(context.provider.storedModelId)
      )
    : freshMarkdown;
  // Publish-only (step 20): the ground-truth Completion Checks / Scope Check
  // / freshness-stamp sections live in this same file now — re-splice
  // whatever is currently on disk back in, since this write otherwise
  // replaces the whole file with just the reviewer's prose.
  const markdown =
    context.stage === "publish"
      ? await reinjectPublishGroundTruthSectionsV1(fileStore, input.targetLocator, attributedMarkdown)
      : attributedMarkdown;
  const bytes = Buffer.from(markdown, "utf8");
  const result =
    input.baselineRevision === undefined
      ? await fileStore.createFileExclusive(input.targetLocator, bytes)
      : await fileStore.replaceFileExact(input.targetLocator, bytes, input.baselineRevision);
  if (result.kind !== "ok") {
    throw new ReviewPromotionErrorV1(
      `could not write review artifact ${input.targetLocator.relativePath}: ${result.kind}${
        "code" in result ? `.${result.code}` : ""
      }`
    );
  }
  return "completed";
}

export function createReviewRowV1(): ProviderTaskActionRowV1 {
  return {
    kind: "provider",
    actionKey: REVIEW_ACTION_KEY_V1,
    routes: ["vs-code-ai-helper.runReviewWithAI", "vs-code-ai-helper.reviewCurrentTask"],
    eligibility: {
      statuses: ["active"],
      stages: [
        "plan",
        "plan-high-review",
        "plan-low-review",
        "impl",
        "impl-high-review",
        "impl-low-review",
        "publish",
      ],
    },
    requiresTaskOperationLease: true,
    progressLabel: "Running review…",
    validateInput: validateReviewInputV1,
    loggingPolicy: { channel: "action.review", includeResultMetrics: true },
    providerMode: "text",
    // A review must judge FILE CONTENT. On a CLI provider that is free — it
    // opens files itself. On Copilot the text transport has no tools at all,
    // so the reviewer sees only what survived the context pack, and a pack
    // that truncates the file under review turns "I cannot see it" into "it is
    // not there" (jester 2026-08-18: ten rounds reporting committed, present
    // tests as missing). Read-only tools are attached only for providers that
    // need them; CLI reviewers are unaffected.
    readsWorkspaceFiles: true,
    maxResponseBytes: maxResponseBytesCeilingForModeV1("text"),
    permittedResultKinds: ["completed", "questions", "cancelled", "failed"],
    completedContentType: "markdown-artifact.v1",
    resumeSemantics: "sameOperation",
    buildPrompt: (context: TaskActionExecutionContextV1): string =>
      (context.validatedInput as ReviewActionInputV1).prompt,
    validateCompletedContent: validateReviewCompletedContentV1,
    promoteCompletedContent: promoteReviewContentV1,
  };
}
