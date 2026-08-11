/**
 * Centralizes all read/write/open paths for the merged Implementation stage.
 * The canonical artifact for new writes is plan-final.md.
 * Legacy implementation.md is only used as a read/materialization fallback.
 */
import * as vscode from "vscode";
import {
  IMPLEMENTATION_FILENAME,
  IMPLEMENTATION_SUMMARY_FILENAME,
  LEGACY_IMPLEMENTATION_FILENAME,
} from "../types/taskProgress";
import { readNonEmptyText, resolveCurrentPlanUri, statIfExists } from "./fileUtils";
import { backupArtifactBeforeWrite } from "./artifactBackups";
import {
  ChecklistProgressV1,
  collectChecklistItemKeysV1,
  countChecklistProgressV1,
  hasImplementationChecklistV1,
  splitSummaryAtEchoV1,
} from "./implementationChecklist";
import { readTextIfExists } from "./fileUtils";
import {
  findLastHeadingV1,
  headingsV1,
  sectionHasContentV1,
} from "./markdownStructure";

export interface ResolvedImplementationArtifact {
  /** The URI to use for reading/opening */
  uri: vscode.Uri;
  /** True when plan-final.md was found */
  isCanonical: boolean;
  /** True when falling back to legacy implementation.md */
  isFallback: boolean;
}

/**
 * True when content matches the shape the implementation-run prompts
 * (run-implementation.md / apply-impl-review-code.md) dictate for the
 * implementation summary: a "## Files Changed" section and a
 * "## Verification" section. Used to tell a misdirected summary write —
 * an agent that wrote its final answer to a `plan-final.md`/`implementation.md`
 * file instead of returning it as text — apart from a same-named file that
 * happens to hold real, unrelated project content. Filename and location
 * alone can't make that distinction: a project may legitimately have its own
 * root-level `implementation.md`, so only a content match is treated as the
 * extension's own artifact.
 */
export function looksLikeGeneratedImplementationSummary(content: string): boolean {
  // Defers to the shape gate rather than keeping a second, weaker definition
  // of "has the summary shape". The substring form this replaces matched prose
  // that merely NAMED the headings and matched them inside fenced examples —
  // the same defect fixed three times over in the gate itself while this copy
  // kept it. Stricter is also the right direction here: a project's own
  // root-level file that happens to mention the headings is no longer mistaken
  // for a misdirected artifact and stripped from filesChanged.
  return describeImplementationSummaryShapeIssue(content) === undefined;
}

/**
 * Human-readable reason a completed run's final text does not match the
 * summary contract both implementation prompts mandate
 * (`resources/prompts/run-implementation.md`, `apply-impl-review-code.md`:
 * "a `## Files Changed` section ... a `## Verification` section"), or
 * `undefined` when it does.
 *
 * The same shape predicate already guarded the summary's *location*
 * (cliAgentRunner / copilotImplementationRunner strip a summary misdirected to
 * a repo-root file). Nothing guarded its *content* at the point it was written
 * into the task folder, so a conversational final message — the observed case
 * was "the full unit-test suite is still running in the background ... I'll
 * report the final summary once it completes", i.e. a promise about work still
 * in flight — passed the only check there was (non-empty) and was handed to
 * the next reviewer as the implementation.
 */
export interface ImplementationSummaryExpectationsV1 {
  /**
   * The plan of record's content, when it carries an
   * `<!-- ensemble:implementation-checklist -->` checklist that both
   * implementation prompts require the response to echo back with updated
   * checkbox state. That echo is the only thing that advances plan progress
   * (mergeChecklistProgressV1), so a response without it leaves the plan
   * permanently reading as untouched — the round has to be rejected rather
   * than silently recorded as progress-free.
   *
   * The PLAN's text is needed, not just a "has a checklist" flag: the echo is
   * verified by matching item text against the plan's own items. Accepting any
   * checkbox line instead would be satisfied by `## Verification`, which the
   * prompts explicitly specify as "a short checklist" — so the common,
   * expected shape of a compliant summary would have passed the gate while
   * the merge still found nothing to tick.
   */
  readonly planChecklist?: string;

  /**
   * True when this round actually edited the workspace. A round that changed
   * files but lists none under `## Files Changed` has produced headings
   * without a summary underneath them — reviewable in shape, empty in
   * substance. Left false when the run reported no changes (or could not
   * determine them), where an empty section is honest rather than evasive.
   */
  readonly roundChangedFiles?: boolean;
}

/**
 * True when `response` echoes at least one item that is actually in the plan's
 * checklist.
 *
 * Overlap — not the `<!-- ensemble:implementation-checklist -->` marker — is
 * the condition that matters, because the merge matches items by text: a
 * response that reproduces the list but drops the HTML comment still records
 * progress correctly, so rejecting it would stall a round that did nothing
 * wrong. One matching item is enough; requiring the full list would reject a
 * round over incidental wording drift, and the merge is already tolerant of a
 * partial echo (unmatched plan items simply keep their state).
 */
function echoesPlanChecklist(response: string, planChecklist: string): boolean {
  const planItems = collectChecklistItemKeysV1(planChecklist);
  if (planItems.size === 0) {
    return true;
  }
  for (const key of collectChecklistItemKeysV1(response)) {
    if (planItems.has(key)) {
      return true;
    }
  }
  return false;
}

export function describeImplementationSummaryShapeIssue(
  content: string,
  expectations: ImplementationSummaryExpectationsV1 = {}
): string | undefined {
  const trimmed = content.trim();
  if (!trimmed) {
    return "the provider returned no final summary text";
  }

  // headingsV1 ignores anything inside a fenced block, so quoted examples are
  // not this response's own sections — and comparing parsed TITLES rejects
  // prose that merely names them ("I could not produce ## Files Changed yet"),
  // which is exactly the shape of the status message this gate exists to catch.
  // When an echo is expected, the response's OWN sections are what must be
  // present — and a checklist may itself contain a phase named `## Files
  // Changed`. Judging the whole response let a reply consisting of nothing but
  // the echoed plan satisfy every heading lookup, promoting exactly the
  // no-summary case this gate exists to reject. Sections are therefore looked
  // up in the run-owned region, which by construction starts at the response's
  // own Files Changed.
  // No fallback to the whole response when an echo is expected. `own` is empty
  // precisely when the response has no summary of its own — either no
  // `## Files Changed` at all, or one that is a plan phase rather than a file
  // list — and falling back put the echoed plan's sections back in view, so an
  // echo-only response satisfied every heading lookup. Empty scope yields no
  // headings, which reports the missing sections: the correct answer.
  const scope =
    expectations.planChecklist !== undefined
      ? splitSummaryAtEchoV1(trimmed).own
      : trimmed;

  // Naming the real cause when the region is empty but the heading is plainly
  // there. `filesChangedIsSummaryBoundary` rejects a `## Files Changed` whose
  // items are checkboxes, because a plan legitimately uses that name as an
  // area heading (create-implementation.md permits "headings by area or
  // phase") and splitting on the name alone promoted echo-only responses. The
  // cost is that a run which checkbox-formats its own file list — against the
  // format run-implementation.md asks for, but an easy habit — gets told its
  // `## Files Changed` is missing while it is right there on screen. That
  // reads as a broken gate rather than a fixable response.
  if (expectations.planChecklist !== undefined && scope.trim().length === 0) {
    if (findLastHeadingV1(headingsV1(trimmed), "Files Changed") !== -1) {
      return (
        "the final response has a `## Files Changed` section, but its entries are " +
        "checkboxes, so it cannot be told apart from a plan phase of the same name — " +
        "list changed files as plain bullets (`- path — what changed`)"
      );
    }
  }

  const all = headingsV1(scope);

  const missing: string[] = [];
  const filesChanged = findLastHeadingV1(all, "Files Changed");
  const verification = findLastHeadingV1(all, "Verification");
  if (filesChanged === -1) {
    missing.push("`## Files Changed`");
  } else if (
    expectations.roundChangedFiles &&
    !sectionHasContentV1(scope, all, filesChanged)
  ) {
    // The round edited the tree, so an empty Files Changed is not a summary of
    // it — this is the "reports on work instead of reporting work" shape,
    // caught structurally rather than by reading the prose.
    missing.push("any files under `## Files Changed`, though this round changed files");
  }
  if (verification === -1) {
    missing.push("`## Verification`");
  } else if (
    expectations.roundChangedFiles &&
    !sectionHasContentV1(scope, all, verification)
  ) {
    // Same rule as Files Changed, and needed for the same reason: a response
    // truncated immediately after its own `## Verification` heading otherwise
    // satisfied every presence check and was promoted for review.
    missing.push("any content under `## Verification`");
  }
  // No ordering check here any more. It existed to tell the summary's own
  // `## Verification` from the echoed plan's copy, by requiring the former to
  // follow `## Files Changed`. Scoping to the run-owned region subsumes it —
  // the echo is no longer in view at all — so keeping it would be a guard for
  // a condition that can no longer arise.
  if (
    expectations.planChecklist !== undefined &&
    // Only the echo region counts. Searching the whole response let a
    // `## Verification` box whose text happened to match a plan item satisfy
    // the echo requirement with no echo present at all.
    !echoesPlanChecklist(splitSummaryAtEchoV1(trimmed).echo, expectations.planChecklist)
  ) {
    missing.push("the plan's implementation checklist, echoed with updated checkbox state");
  }
  if (missing.length === 0) {
    return undefined;
  }
  return `the final response is missing ${missing.join(" and ")}`;
}

/**
 * Marks impl-summary.md as "this round produced no reviewable notes".
 *
 * Refusing to advance is not enough on its own: returning early only suppresses
 * the automated follow-up, while a later manual Review or Fast Forward would
 * still build `{{implementation}}` from whatever was there before — an earlier
 * round's summary describing a tree that no longer exists, or (on a first run)
 * the plan of record via the fallback chain. Stamping the artifact makes every
 * review entry point see the rejection, because they all read it.
 *
 * Mirrors how a superseded review artifact is staled: the previous summary is
 * preserved as the `_prev` backup writeTextFile takes, so nothing is lost.
 */
export const IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1 =
  "<!-- ensemble:implementation-summary-unusable -->";

/**
 * True when impl-summary.md holds the unusable-round stamp above.
 *
 * Anchored to the stamp's own position — the first non-empty line — rather
 * than tested as a substring. A genuine summary can legitimately *mention* the
 * sentinel (a round whose work was adding it would quote it in `## Files
 * Changed`), and a substring test would then reject a summary that had just
 * passed validation, blocking review on the very round that implemented it.
 */
export function isUnusableImplementationSummaryV1(content: string): boolean {
  // Same leading-block rule as the synthetic marker: this stamp is not signed
  // today, but a first-line test would break the instant it were, and the two
  // markers must not drift in how they are recognized.
  return hasLeadingMarker(content, IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1);
}

/**
 * Marks impl-summary.md as written by the RUNNER rather than by a model
 * answering the implementation prompt.
 *
 * The sealed edit pipeline returns `appliedReceiptIds`/`changedPaths` and no
 * free-text channel at all (`TwoPhaseEditResultV1`), so a round on that path
 * cannot echo the plan checklist back no matter what the prompt asks — the
 * information has nowhere to travel. Plan progress is therefore not being
 * maintained while a task implements this way, and the checklist's counts are
 * frozen rather than current.
 *
 * PROVENANCE ONLY — nothing gates on this marker. The gate reads the durable
 * `checklistProgressUnreliable` flag, which is strictly better: it also covers
 * a rejected round, and it survives the next round overwriting this artifact,
 * whereas reading the marker made the gate trust a checklist again the moment
 * a later model-authored summary replaced it. The marker stays because it
 * makes the artifact self-identifying when diagnosing why a task's flag is
 * set; it is not a second source of truth.
 */
export const IMPLEMENTATION_SUMMARY_SYNTHETIC_MARKER_V1 =
  "<!-- ensemble:implementation-summary-synthetic -->";

/**
 * True when `marker` sits on its own line inside the document's LEADING
 * metadata block — the run of blank lines and HTML comments before any
 * substantive content.
 *
 * Not "is the first non-empty line", which is what both marker predicates
 * originally tested. Every persisted summary is signed by `withAttribution`,
 * which prepends `<!-- Generated by ... -->`, so a first-line test silently
 * stopped recognizing its own marker the moment the artifact was signed. That
 * is the same attribution-ordering trap the checklist marker hit; testing the
 * leading comment block instead makes marker order irrelevant while still
 * refusing to match a mention buried in the body.
 */
function hasLeadingMarker(content: string, marker: string): boolean {
  for (const line of content.split(/\r?\n/)) {
    const text = line.trim();
    if (text.length === 0) {
      continue;
    }
    if (text === marker) {
      return true;
    }
    // Other metadata comments (attribution, generator tags) may precede or
    // follow the marker; real content ends the block.
    if (text.startsWith("<!--") && text.endsWith("-->")) {
      continue;
    }
    return false;
  }
  return false;
}


/**
 * Wrap a runner-synthesized summary so both the marker and the reason travel
 * with it — reviewers read this file as `{{implementation}}`, and a bare
 * "Applied N sealed edit step(s)" with no explanation reads like a model that
 * declined to summarize its work.
 */
export function buildSyntheticImplementationSummaryV1(
  summary: string,
  changedFiles: readonly string[]
): string {
  // Reports what the runner verifiably knows — the applied result and the
  // paths its receipts touched — and nothing it does not. It does NOT claim
  // per-file rationale or tick any checklist item: dressing a runner's line up
  // as a model-authored summary is how an artifact starts asserting more than
  // its source can support.
  return [
    IMPLEMENTATION_SUMMARY_SYNTHETIC_MARKER_V1,
    "",
    summary,
    "",
    "## Files Changed",
    "",
    ...(changedFiles.length > 0
      ? changedFiles.map((file) => `- \`${file}\``)
      : ["- (the runner reported no changed paths)"]),
    "",
    "> Written by the edit runner, not by the implementation model. This",
    "> execution path returns verified edit receipts rather than written notes,",
    "> so there is no per-file rationale and no checklist echo — the plan's",
    "> checkbox state is NOT up to date for this round. Treat its counts as",
    "> stale rather than as an accurate record of remaining work.",
  ].join("\n");
}

/** The stamp written in place of a round's unusable summary. */
export function buildUnusableImplementationSummaryV1(
  reason: string,
  runLogName: string
): string {
  return [
    IMPLEMENTATION_SUMMARY_UNUSABLE_MARKER_V1,
    "",
    "# Implementation Summary Unusable",
    "",
    `The last implementation round completed and changed files, but ${reason}.`,
    "",
    "Its edits were kept and recorded for review, but there are no usable",
    "implementation notes to review against, so review is paused until another",
    `round produces them. The provider's full response is in \`${runLogName}\`.`,
    "",
    "The previous summary, if any, is preserved alongside this file as",
    "`impl-summary_prev.md`.",
  ].join("\n");
}

/** The plan of record, resolved once, for every consumer that needs it. */
export interface PlanOfRecordV1 {
  /** Durable content — the bytes on disk, never an unsaved editor buffer. */
  readonly text: string | undefined;
  /** True when it carries a real generated checklist (not a quoted marker). */
  readonly hasChecklist: boolean;
  /** Checklist counts, or `undefined` when there is no checklist. */
  readonly counts: ChecklistProgressV1 | undefined;
}

/**
 * Read this task's plan of record and answer, in one place, everything callers
 * need to know about it.
 *
 * This exists because the two questions it answers were being re-derived at
 * every call site, differently each time:
 *
 *  - *"Does it have a checklist?"* — five sites, four of them using a
 *    substring test that says yes for a plan merely quoting the marker.
 *  - *"What is its content?"* — `readTextIfExists` deliberately returns an
 *    open editor's UNSAVED buffer, so a review could see every box ticked and
 *    auto-advance while the durable file still listed outstanding work.
 *    Discarding that buffer then left the persisted stage inconsistent with
 *    its own plan.
 *
 * Each site being re-derived was a fresh chance to get it wrong, and reviews
 * kept finding new ones. Routing them through one resolver makes the next
 * caller correct by construction rather than by remembering.
 */
export async function readPlanOfRecordV1(
  taskFolderUri: vscode.Uri
): Promise<PlanOfRecordV1> {
  const planUri = getCanonicalImplementationUri(taskFolderUri);

  // Durable bytes only. Saving first (rather than reading past the buffer)
  // keeps the user's ticks — they meant them; they just had not saved.
  const open = vscode.workspace.textDocuments.find(
    (doc) => doc.uri.fsPath === planUri.fsPath
  );
  if (open?.isDirty && !(await open.save())) {
    // The save failed (conflict, permissions, read-only). readTextIfExists
    // would hand back the still-dirty buffer, so a completeness check could
    // advance a stage on checkbox state that was never persisted — and lose it
    // when the buffer is discarded. Report no checklist instead: the gate then
    // stands down rather than acting on state that does not exist on disk.
    return { text: undefined, hasChecklist: false, counts: undefined };
  }

  const text = await readTextIfExists(planUri);
  if (!text || !hasImplementationChecklistV1(text)) {
    return { text, hasChecklist: false, counts: undefined };
  }
  return { text, hasChecklist: true, counts: countChecklistProgressV1(text) };
}

/**
 * Returns the URI for this task's implementation-run summary
 * (impl-summary.md) — the artifact a completed run writes, kept separate from
 * the plan of record in plan-final.md.
 */
export function getImplementationSummaryUri(
  taskFolderUri: vscode.Uri
): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, IMPLEMENTATION_SUMMARY_FILENAME);
}

/**
 * Read the content that should fill `{{implementation}}` for an implementation
 * review, newest-artifact-first:
 *
 *   1. impl-summary.md — this task's most recent run summary (current writes).
 *   2. plan-final.md — tasks implemented before the summary split, whose run
 *      summary was written over the plan of record, plus tasks whose plan of
 *      record is all that exists yet.
 *   3. implementation.md — legacy task folders.
 *
 * Read-only by contract: preparing a review prompt must leave every
 * implementation artifact byte-identical, so a review that is cancelled,
 * fails, or returns questions never materializes anything as a side effect.
 */
export async function readImplementationReviewContent(
  taskFolderUri: vscode.Uri
): Promise<string | undefined> {
  for (const uri of [
    getImplementationSummaryUri(taskFolderUri),
    getCanonicalImplementationUri(taskFolderUri),
    getLegacyImplementationUri(taskFolderUri),
  ]) {
    const content = await readNonEmptyText(uri);
    if (content) {
      return content;
    }
  }
  return undefined;
}

/**
 * Returns the canonical URI (plan-final.md) for new writes.
 * All AI generation must write to this path.
 */
export function getCanonicalImplementationUri(
  taskFolderUri: vscode.Uri
): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, IMPLEMENTATION_FILENAME);
}

/**
 * Returns the legacy URI (implementation.md) for fallback reading.
 */
export function getLegacyImplementationUri(
  taskFolderUri: vscode.Uri
): vscode.Uri {
  return vscode.Uri.joinPath(taskFolderUri, LEGACY_IMPLEMENTATION_FILENAME);
}

/**
 * Resolve the best URI to open/read for the Implementation stage:
 * - plan-final.md when present (canonical)
 * - implementation.md when plan-final.md absent (legacy fallback)
 * - canonical plan-final.md URI when neither file exists (create path)
 */
export async function resolveImplementationArtifact(
  taskFolderUri: vscode.Uri
): Promise<ResolvedImplementationArtifact> {
  const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
  const legacyUri = vscode.Uri.joinPath(
    taskFolderUri,
    LEGACY_IMPLEMENTATION_FILENAME
  );

  const canonicalStat = await statIfExists(canonicalUri);
  if (canonicalStat) {
    return { uri: canonicalUri, isCanonical: true, isFallback: false };
  }

  const legacyStat = await statIfExists(legacyUri);
  if (legacyStat) {
    return { uri: legacyUri, isCanonical: false, isFallback: true };
  }

  // Neither exists; return canonical for create path
  return { uri: canonicalUri, isCanonical: false, isFallback: false };
}

/**
 * When a run-implementation or redo-implementation command is invoked and
 * plan-final.md is missing but implementation.md exists, materialize
 * plan-final.md by copying implementation.md. Returns the canonical URI.
 * Throws a user-visible error if neither file exists.
 */
export async function materializeCanonicalIfNeeded(
  taskFolderUri: vscode.Uri
): Promise<vscode.Uri> {
  const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
  const legacyUri = vscode.Uri.joinPath(
    taskFolderUri,
    LEGACY_IMPLEMENTATION_FILENAME
  );

  const canonicalStat = await statIfExists(canonicalUri);
  if (canonicalStat) {
    return canonicalUri;
  }

  const legacyStat = await statIfExists(legacyUri);
  if (legacyStat) {
    // Copy legacy -> canonical
    const content = await vscode.workspace.fs.readFile(legacyUri);
    await backupArtifactBeforeWrite(canonicalUri);
    await vscode.workspace.fs.writeFile(canonicalUri, content);
    return canonicalUri;
  }

  throw new Error(
    `No ${IMPLEMENTATION_FILENAME} or ${LEGACY_IMPLEMENTATION_FILENAME} found. ` +
      "Generate an implementation plan before running implementation."
  );
}

/** Result of {@link preparePlanPromotion}. */
export type PlanPromotion =
  | { ready: true; publish?: () => Promise<void> }
  | { ready: false };

/**
 * Prepare (but do not perform) seeding plan-final.md from the current
 * plan.md the first time a task enters the Implementation stage.
 *
 * This is the single source of truth for that promotion: every path that can
 * transition a task's stage to "impl" (manual Next Stage, and score-based
 * review auto-advance) must use it, or the task lands on "impl" with no
 * implementation artifact and Generate Checklist/Implement immediately
 * hard-fail via `materializeCanonicalIfNeeded`.
 *
 * Returns `{ ready: false }` when there is no plan content to promote —
 * callers should abort the transition. Returns `{ ready: true }` with no
 * `publish` when a canonical artifact already exists (nothing to do).
 * Otherwise returns `{ ready: true, publish }`, where `publish` performs the
 * actual backup+write.
 *
 * The write is intentionally split out from this read/check step so callers
 * that gate the transition behind a compare-and-swap (e.g. `advanceStage`'s
 * `publishArtifact` hook) can defer `publish` until that CAS has actually
 * succeeded. Writing eagerly, before the CAS runs, would let a review
 * attempt that loses the race still materialize plan-final.md for a stage
 * transition that never happens.
 */
export async function preparePlanPromotion(
  taskFolderUri: vscode.Uri
): Promise<PlanPromotion> {
  const resolved = await resolveImplementationArtifact(taskFolderUri);
  if (resolved.isCanonical) {
    return { ready: true };
  }

  const currentPlanUri = await resolveCurrentPlanUri(taskFolderUri);
  const planContent = await readNonEmptyText(currentPlanUri);
  if (!planContent) {
    return { ready: false };
  }

  return {
    ready: true,
    publish: async () => {
      const canonicalUri = getCanonicalImplementationUri(taskFolderUri);
      await backupArtifactBeforeWrite(canonicalUri);
      await vscode.workspace.fs.writeFile(
        canonicalUri,
        new TextEncoder().encode(planContent)
      );
    },
  };
}
