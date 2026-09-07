import * as vscode from "vscode";
import { spawn, execSync, execFileSync } from "child_process";
import { readTaskProgressStrictV1 } from "../services/taskProgressReaderV1";
import { patchTaskProgressStrictV1 } from "../services/taskProgressWriterV1";
import { updateLintPayload } from "./taskProgressTransforms";
import * as fs from "fs";
import * as path from "path";
import {
  PUBLISH_CHECKS_FILENAME,
  STAGE_ARTIFACT_FILENAMES,
  TaskProgress,
} from "../types/taskProgress";
import { getCompletionCheckTimeoutMs, getKnownFlakyChecks, getPublishVerificationCommands, KnownFlakyCheck } from "../config/settings";
import { promptAndPersistPublishScope } from "../commands/choosePublishScope";
import { isWorkflowPrivatePathV1 } from "../services/workflowPrivacyClassifierV1";
import { ReviewBlocker } from "./reviewReadiness";
import { scopeToLatestChecklistV1, unescapeChecklistItemTextV1 } from "./implementationChecklist";
import {
  computePublishStatusLineTextV1,
  ensureVerificationHeadingV1,
  importLegacyPublishChecksIfAbsentV1,
  invalidatePublishChecksFreshnessStamp,
  mergePublishStatusLineSection,
  withPublishChecksReportLockV1,
  writeFileAtomicV1,
} from "./publishChecksFreshness";

/**
 * Resolve a package manager executable to an absolute path, preferring a
 * .cmd/.bat/.exe shim on Windows. `where.exe` also matches extension-less
 * POSIX shim scripts that npm installs alongside the real Windows shim (e.g.
 * a bare `pnpm` file next to `pnpm.CMD`), and can list them first — spawning
 * that extension-less file directly fails with ENOENT. Falls back to the
 * bare executable name (relying on PATH resolution via shell:true) if
 * `where`/`which` can't resolve it.
 */
function resolveManagerExecutable(cwd: string, manager: string): string {
  try {
    const locator = process.platform === "win32" ? "where.exe" : "which";
    const candidates = execFileSync(locator, [manager], { cwd, windowsHide: true })
      .toString("utf8").split(/\r?\n/).map(value => value.trim()).filter(Boolean);
    const preferred = process.platform === "win32"
      ? candidates.find(value => /\.(cmd|bat|exe)$/i.test(value)) ?? candidates[0]
      : candidates[0];
    if (preferred) return preferred;
  } catch {
    // Fall through to the PATH-relative name below.
  }
  return process.platform === "win32" ? `${manager}.cmd` : manager;
}

export interface PlanItemVerification {
  text: string;
  /** Never "passed" for anything that could not actually be verified. */
  status: "passed" | "failed" | "inconclusive";
  note?: string;
}

/**
 * The known-flake quarantine decision for one failed check, computed exactly
 * once (in `collectCompletionLint`, via `classifyKnownFlakeFailures`) and
 * stamped directly onto that check's `failedChecks` entry. Every consumer
 * that needs to know "was this quarantined?" — the two Verified/Completion
 * Checks renderers and `synthesizeMechanicalBlockers` — reads this stamp via
 * {@link isQuarantinedCheckV1} instead of independently re-deriving the
 * answer by cross-referencing `knownFlakeFailures` against `command`/
 * `exitCode`. A single stamped decision is what makes it structurally
 * impossible for the display and the mechanical-blocker generator to
 * disagree about the same failure (wf10 continuation item 12).
 */
export interface QuarantineStampV1 {
  /** The `reason` of the known-flaky-check allowlist entry that matched. */
  reason: string;
  /** The `match` value of the allowlist entry that matched, for evidence. */
  ruleMatch: string;
}

/** True when a failed check carries a quarantine stamp — the single source
 * of truth every quarantine-aware renderer/generator must consult instead of
 * re-deriving the decision. See {@link QuarantineStampV1}.
 *
 * Falls back to matching `check` against `result.knownFlakeFailures` by
 * command+exitCode when no stamp is present — a persisted `lintPayload`
 * written before the per-check stamp existed only carries the legacy flat
 * `knownFlakeFailures` list, and without this fallback a strict re-read of
 * that older payload would treat its known flakes as unquarantined again,
 * reintroducing the exact phantom-blocker defect this stamp exists to fix
 * (wf10 continuation item 12). */
export function isQuarantinedCheckV1(
  result: { knownFlakeFailures?: readonly { command: string; exitCode: number }[] },
  check: { command: string; exitCode: number; quarantine?: QuarantineStampV1 }
): boolean {
  if (check.quarantine !== undefined) {
    return true;
  }
  return (result.knownFlakeFailures ?? []).some(
    (flake) => flake.command === check.command && flake.exitCode === check.exitCode
  );
}

/** Resolve the quarantine reason text for a failed check, preferring its own
 * stamp and falling back to the legacy `knownFlakeFailures` list by
 * command+exitCode — same precedence as {@link isQuarantinedCheckV1}, so a
 * check quarantined only via a pre-stamp persisted payload still renders
 * with its reason instead of silently reading as an unexplained failure. */
function resolveQuarantineReasonV1(
  result: { knownFlakeFailures?: readonly { command: string; exitCode: number; reason: string }[] },
  check: { command: string; exitCode: number; quarantine?: QuarantineStampV1 }
): string | undefined {
  if (check.quarantine) {
    return check.quarantine.reason;
  }
  return (result.knownFlakeFailures ?? []).find(
    (flake) => flake.command === check.command && flake.exitCode === check.exitCode
  )?.reason;
}

/**
 * Annotation shown next to an unquarantined failure that would have been
 * quarantined under `scope: "any-package"` — computed fresh from the current
 * known-flaky-check allowlist (never persisted; both renderers call this
 * directly so they can never disagree). See {@link findExactScopeMismatchV1}
 * and plan item 12, step 3.
 */
function describeScopeMismatchAnnotationV1(
  check: { command: string; output: string },
  knownFlakes: readonly KnownFlakyCheck[]
): string | undefined {
  const mismatch = findExactScopeMismatchV1(check, knownFlakes);
  return mismatch
    ? `not quarantined — rule \`${mismatch.match}\` is scope: exact; set scope: "any-package" or add \`[pkg] ${mismatch.match}\``
    : undefined;
}

export interface CompletionLintResult {
  runAt: string;
  passed: boolean;
  summary: string;
  issueCount: number;
  failedChecks: Array<{
    command: string;
    exitCode: number;
    output: string;
    retryCount?: number;
    /** Set once, at collection time, when this failure matched a configured
     * known-flaky-check allowlist entry. See {@link QuarantineStampV1} and
     * {@link isQuarantinedCheckV1}. */
    quarantine?: QuarantineStampV1;
  }>;
  /** Entries of `failedChecks` that also matched a configured known-flaky-
   * check allowlist entry (see settings.ts's `getKnownFlakyChecks`). `passed`
   * above is never adjusted for these — this is a separate, additive signal
   * consumed by `passedModuloKnownFlakes` and the verified-checks section
   * shown to reviewers, so a quarantined failure stays visible and
   * explainable rather than silently vanishing from the raw result. Optional
   * (like `planItems`/`verifiedFolder` below) so callers that construct a
   * result without running the real check — error fallbacks, test fixtures —
   * aren't forced to populate it; treat absent as empty. */
  knownFlakeFailures?: Array<{ command: string; exitCode: number; reason: string }>;
  /** `passed`, but treating quarantined known-flake failures as non-blocking.
   * This — not `passed` — is the readiness-relevant verdict shown to
   * reviewers: a pre-existing environmental flake must not permanently cap
   * a task's score the way it did before known-flake quarantine existed.
   * Optional for the same reason as `knownFlakeFailures`; treat absent as
   * equal to `passed`. */
  passedModuloKnownFlakes?: boolean;
  /** Checks that failed at least once but passed on a same-round,
   * cache-bypassed retry (see runWithRetry / CHECK_ATTEMPTS_MAX). Counted as
   * passing in `passed`/`passedModuloKnownFlakes` — the check's FINAL exit
   * code was 0 — but never rendered as silently clean: the retry count stays
   * visible in both the Completion Checks and Verified Checks sections, so a
   * "passed on retry 2" result is distinguishable from a check that was
   * clean on the first try. Distinct from `knownFlakeFailures`, which
   * quarantines a check that never passed against a configured allowlist.
   * Optional for the same reason as `knownFlakeFailures` above. */
  retriedPasses?: Array<{ command: string; retryCount: number }>;
  /** `scripts` entries (from the conventional `lint`/`test`/`build` names)
   * not found in the workspace `package.json`, and therefore skipped rather
   * than run. Reported as `inconclusive` — an undetected toolchain is never
   * a pass. */
  missingScripts: string[];
  /** AI-verified plan-item completion check (report section, not a gate):
   * `passed` only ever comes from AI evidence against the source, never from
   * a checked checkbox alone. */
  planItems?: PlanItemVerification[];
  /** The folder lint/tests actually ran against (the Publish scope). */
  verifiedFolder?: string;
  /**
   * The environment these checks actually ran in (1d) — the fix for a real
   * stall (jester 2026-07-30_task_1) where a check was genuinely red in the
   * extension host and genuinely green in a plain shell because the two had
   * different environment variables (DATABASE_URL, in that case), and
   * nothing in either party's evidence hinted the environments differed.
   *
   * Env var VALUES are never disclosed — only NAMES, and only the resolved
   * cwd / package manager version as narrow, structurally-safe exceptions.
   * Verified Checks artifacts land in task folders (frequently committed)
   * and go verbatim into third-party AI prompts, so a credential-bearing
   * value (a DB connection string, an API token) must never be able to
   * reach either surface — disclosing names only means there is no pattern
   * to get wrong: nothing is ever shown that could be a secret, regardless
   * of what any individual variable happens to be named.
   */
  verificationEnvironment?: {
    /** The resolved cwd checks ran in, or a redacted placeholder if it
     * classifies as a private workflow path (see safeCwdForDisclosure). */
    cwd: string;
    /** e.g. "npm 10.8.2" — falls back to the bare manager name if a
     * `--version` lookup fails or times out. */
    packageManager: string;
    /** Sorted env var NAMES present in the process the checks were spawned
     * from. Never values — see the field doc above. */
    envVarNames: string[];
  };
  /**
   * Every command line actually executed for this run, root conventional/
   * verify/explicit commands AND (when the workspace is a monorepo) every
   * per-package command from the recursive pass below — in the order they
   * were spawned. Exists so a "green" Verified Checks result is never read
   * as broader than what actually ran: a monorepo whose `packages/*`
   * suites were never invoked must never be indistinguishable from one
   * where they were and passed. Optional for the same reason as
   * `knownFlakeFailures`/`retriedPasses` above — callers that construct a
   * result without running the real check (error fallbacks, test fixtures)
   * aren't forced to populate it.
   */
  commandsRun?: string[];
  /**
   * True when the verified workspace root was detected as a monorepo (a
   * `workspaces` field in the root package.json, or a pnpm-workspace.yaml
   * file present) — regardless of whether any member package actually had
   * a matching script to run. Lets a reviewer distinguish "not a monorepo"
   * from "a monorepo where the recursive pass found nothing to run".
   */
  monorepoDetected?: boolean;
  /**
   * One entry per member-package command from the recursive monorepo pass
   * (step 21 of the workflow-resilience backlog) — additive to, never a
   * replacement for, the root commands above (including any explicitly
   * configured ones, which always still run and win as before). Each
   * member package's pass/fail is reported HERE separately rather than
   * folded into a single aggregate verdict, so a reviewer can see exactly
   * which package failed. A failing entry also has a matching row in
   * `failedChecks` (with full output) via the same `command` string — this
   * array is the compact per-package roll-up, not a duplicate of the full
   * failure output.
   */
  monorepoChecks?: Array<{
    /** Workspace-root-relative path of the member package, e.g. "packages/ensemble-core". */
    packageDir: string;
    command: string;
    exitCode: number;
    passed: boolean;
    retryCount?: number;
  }>;
}

/** True when the path exists on disk and is a directory. */
function isExistingDirectory(candidate: string): boolean {
  try {
    return fs.statSync(candidate).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Resolve the folder the Publish stage verifies (lint/tests) against: the
 * task's persisted `publishScopePath` when set and still present on disk;
 * otherwise the task's durable `ownership.projectRoot` binding when one is
 * recorded — persisted ownership takes precedence over task-folder
 * containment (mirroring resolveReleaseWorkspace in reviewActions.ts),
 * because a task can live in an external metadata root that happens to sit
 * inside an unrelated open workspace, and that parent workspace is not the
 * project. Only a legacy task with no recorded binding falls back to the
 * workspace folder containing it, then to its own folder (pre-ownership
 * layouts where the task folder was the project). Relative persisted paths
 * resolve against that same default, so the picker (choosePublishScope.ts)
 * and this resolver round-trip identically. `stale: true` means no valid
 * scope could be resolved and interactive callers must re-prompt (or
 * abort) — that covers both a persisted path that no longer exists and a
 * recorded `ownership.projectRoot` that has vanished: a
 * configured-but-missing binding must never silently degrade to verifying
 * the metadata folder or whatever workspace happens to contain it.
 */
export function resolvePublishScopeFolder(
  taskFolderUri: vscode.Uri,
  progress: Pick<TaskProgress, "publishScopePath" | "ownership"> | undefined
): { folder: string; stale: boolean } {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  const ownershipRoot = progress?.ownership?.projectRoot?.trim();
  // Ownership is persisted as an absolute project-root binding.  Do not let
  // malformed legacy data such as `.` resolve against the extension host's
  // current working directory: that would make Publish verify an unrelated
  // project rather than asking the user to re-bind the task.
  const ownershipRootValid = !!ownershipRoot &&
    path.isAbsolute(ownershipRoot) && isExistingDirectory(ownershipRoot);
  // A recorded-but-missing project binding is authoritative staleness: the
  // binding declares the project lives elsewhere, so neither a containing
  // workspace nor the metadata folder may substitute for it.
  const defaultUnresolvable = !!ownershipRoot && !ownershipRootValid;
  const defaultFolder =
    (ownershipRootValid ? ownershipRoot : undefined) ??
    workspaceFolder?.uri.fsPath ??
    taskFolderUri.fsPath;
  const persisted = progress?.publishScopePath?.trim();
  if (!persisted) {
    return { folder: defaultFolder, stale: defaultUnresolvable };
  }
  if (path.isAbsolute(persisted)) {
    return isExistingDirectory(persisted)
      ? { folder: persisted, stale: false }
      : { folder: defaultFolder, stale: true };
  }
  // A relative scope is only meaningful against a resolvable base — never
  // resolve it against the metadata-folder fallback, where a coincidental
  // directory match would silently verify task metadata.
  if (!defaultUnresolvable) {
    const absolute = path.join(defaultFolder, persisted);
    if (isExistingDirectory(absolute)) {
      return { folder: absolute, stale: false };
    }
  }
  return { folder: defaultFolder, stale: true };
}

/**
 * Text that marks a plan checklist item as not-done-on-purpose. Matching it
 * makes the item `failed` below: deferring is not completing.
 *
 * This pattern used to carry a latent contradiction: `run-implementation.md`
 * and `apply-impl-review-code.md` sanctioned reporting an unbuilt item as
 * `deferred — "out of this task's scope" per the plan's own division`, which
 * matches here and scores `failed`, so a task that "correctly" scoped itself
 * was penalised for it. The note reasoned that this stayed inert as long as
 * plans were not divided across tasks.
 *
 * They were divided the next day. A plan-high-review blocker told a plan to
 * "split the nine unrelated workstreams into independently implementable
 * tasks"; the implementation built one of five, and the impl reviewer — told
 * to count only the portion "this task" owned — emitted `<!-- progress: 5/5 -->`
 * instead of `5/47`. `N == M` reads as done, so the review-then-implement
 * cycle that carries a large plan to completion never fired again and the
 * task walked to Publish with four fifths unbuilt (task "1.8", 2026-08-10).
 *
 * Resolved by removing the exception rather than by loosening this regex: one
 * plan is one task, a plan is delivered in ordered PARTS across rounds within
 * that task, and the denominator is always the plan's full step count. A plan
 * that cannot be delivered that way escalates to a human scope decision — it
 * is never divided across tasks by the workflow itself. So nothing is ever
 * legitimately out of scope, and `failed` is the correct verdict for any
 * deferral. An item simply not built yet is reported as "not yet reached in
 * the executable order", which deliberately does NOT match here: remaining
 * work in a staged plan scores `inconclusive`, not `failed`.
 */
const DEFERRED_MARKERS = /\b(deferred|out[ -]of[ -]scope|won'?t (?:do|fix)|skipped)\b/i;

/**
 * Deterministic baseline over the plan-final.md checklist. A checkbox alone
 * is never evidence of implementation, so nothing here produces `passed`:
 * an item marked deferred/out-of-scope is `failed` (deferring is not
 * completing); everything else — checked or not — is `inconclusive` until
 * the AI-assisted verification (below) inspects the actual source and
 * upgrades or contradicts it.
 *
 * Deduplicated by item text (case/whitespace-insensitive), keeping the LAST
 * occurrence in the file. The round-progress-tracking convention reproduces
 * an `<!-- ensemble:implementation-checklist -->` checklist verbatim across
 * a plan document's own sections (once where the plan states it, again in
 * later "Implementation Notes" progress updates as boxes get checked off) —
 * without dedup every one of those items renders twice in the Plan Item
 * Verification section (observed: 8 entries, 4 unique), and the earlier
 * copy's checkbox state is the stale one.
 */
export function verifyPlanItems(planContent: string): PlanItemVerification[] {
  const items: PlanItemVerification[] = [];
  // Scoped to the latest rendering, which is what removes the duplication
  // described above — every rendering opens with its own standalone marker
  // line, so the last one is the freshest copy. Within that single rendering
  // one line is one item, with no collapsing by text: two genuinely distinct
  // steps that happen to share wording stay two steps here, exactly as they do
  // in countChecklistProgressV1's denominator.
  for (const line of scopeToLatestChecklistV1(planContent).region.split(/\r?\n/)) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s+(.*\S)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const checked = match[1]?.toLowerCase() === "x";
    // Unescaped via the same shared helper `normalizeChecklistItemTextV1` uses
    // for its merge key, so a plan item corrupted with literal `\"` on disk
    // (see implementationChecklist.ts) reads clean here too, instead of
    // showing backslashes to the reviewer/AI verifier.
    const text = unescapeChecklistItemTextV1(match[2] ?? "");
    const deferred = DEFERRED_MARKERS.test(text);
    if (deferred) {
      items.push({
        text,
        status: "failed",
        note: "marked deferred/out-of-scope — not counted as complete",
      });
    } else if (checked) {
      items.push({
        text,
        status: "inconclusive",
        note: "checked in the plan — a checkbox is not evidence; awaiting AI verification against the implementation",
      });
    } else {
      items.push({
        text,
        status: "inconclusive",
        note: "unchecked — completion could not be verified automatically",
      });
    }
  }
  return items;
}

// ---------------------------------------------------------------------------
// AI-assisted plan-item verification: a checked box in plan-final.md is not
// proof that source changes exist, so the Publish check asks the configured
// Publish-stage model to inspect the verification scope (read-only) and
// return a per-item verdict. The deterministic baseline above is only ever
// *upgraded* by real AI evidence — when the AI pass cannot run (no model,
// provider unavailable, unparseable response), every non-deferred item stays
// `inconclusive` with the reason recorded, never `passed`.
// ---------------------------------------------------------------------------

/** A single per-item verdict extracted from the AI verification response. */
export interface AiPlanVerdict {
  status: PlanItemVerification["status"];
  note?: string;
}

function appendNote(existing: string | undefined, addition: string): string {
  return existing ? `${existing}; ${addition}` : addition;
}

/**
 * Extract per-item verdicts from an AI response: a fenced ```json block, a
 * bare JSON array/object, or JSON-object lines — any mix is accepted, and
 * anything unparseable is ignored. Item numbers are 1-based and clamped to
 * the actual item count. Exported for testing.
 */
export function parseAiPlanVerdicts(
  output: string,
  itemCount: number
): Map<number, AiPlanVerdict> {
  const verdicts = new Map<number, AiPlanVerdict>();
  const accept = (value: unknown): void => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        accept(entry);
      }
      return;
    }
    if (!value || typeof value !== "object") {
      return;
    }
    const record = value as { item?: unknown; status?: unknown; note?: unknown };
    const item = typeof record.item === "number" ? record.item : Number(record.item);
    const status = record.status;
    if (!Number.isInteger(item) || item < 1 || item > itemCount) {
      return;
    }
    if (status !== "passed" && status !== "failed" && status !== "inconclusive") {
      return;
    }
    const note =
      typeof record.note === "string" && record.note.trim().length > 0
        ? record.note.trim()
        : undefined;
    verdicts.set(item, { status, note });
  };
  const tryParse = (candidate: string): void => {
    try {
      accept(JSON.parse(candidate));
    } catch {
      // Not JSON — ignore; other extraction passes may still match.
    }
  };

  for (const match of output.matchAll(/```(?:json)?\s*([\s\S]*?)```/g)) {
    tryParse(match[1] ?? "");
  }
  tryParse(output.trim());
  for (const line of output.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
      tryParse(trimmed);
    }
  }
  return verdicts;
}

/**
 * Merge AI verdicts into the deterministic baseline. Deterministic failures
 * (deferred/out-of-scope items) are authoritative — an AI "passed" cannot
 * launder a deferral into completion. Items the AI skipped stay at their
 * baseline status with that gap recorded. Exported for testing.
 */
export function mergeAiPlanVerdicts(
  items: readonly PlanItemVerification[],
  verdicts: ReadonlyMap<number, AiPlanVerdict>
): PlanItemVerification[] {
  return items.map((item, index) => {
    if (item.status === "failed") {
      return { ...item };
    }
    const verdict = verdicts.get(index + 1);
    if (!verdict) {
      return {
        ...item,
        note: appendNote(item.note, "no AI verdict was returned for this item"),
      };
    }
    return {
      text: item.text,
      status: verdict.status,
      note: verdict.note
        ? `AI verification: ${verdict.note}`
        : "AI-verified against the implementation",
    };
  });
}

/**
 * The full Publish plan-item verification: deterministic checklist baseline,
 * then (previously) an AI-assisted pass against the verification scope.
 *
 * Gated off entirely (always returns undefined). The AI-assisted pass was
 * retired during the Cleanup cohort's disposition of the three supplementary
 * legacy AI routes discovered outside the plan's baseline route table (plan
 * §8, legacyAiActionSafetyGateV0.ts's file header) — its only invocation
 * path, the legacy `resolveRunnerForModel`/`AgentRunner.run()` boundary, is
 * now permanently and unconditionally rejected for every uncorrelated caller
 * (`LEGACY_UNCORRELATED_RUNNER_INVOCATION_REJECTED_V0`) — and has no V1
 * coordinator replacement. With no AI pass, this can never produce a
 * `passed` verdict: every non-deferred item would stay permanently
 * `inconclusive` and every deferred/`ensemble:excluded` item would be
 * reported as `failed`, which in turn made buildPlanItemVerificationSection
 * emit a blocking-sounding instruction ("N plan item(s) failed
 * verification... your verdict must never state 'no blockers'") demanding
 * justification for items the rest of the workflow already treats as
 * deliberately out of scope (observed 2026-08-23: "0 passed, 3 failed, 44
 * inconclusive" on a task with no real outstanding work). Restoring this
 * requires a new implementation decision for a working AI verification path
 * (see `parseAiPlanVerdicts`/`mergeAiPlanVerdicts` below, kept and still
 * independently tested as the reusable building blocks for that path) —
 * until then this returns undefined so neither the Publish checks artifact
 * nor the Publish review prompt renders the dead section at all, rather than
 * rendering it in a state that can never resolve.
 */
export function collectAiVerifiedPlanItems(
  _taskFolderUri: vscode.Uri,
  _scopeFolder: string
): PlanItemVerification[] | undefined {
  return undefined;
}

/**
 * Read the workspace `package.json`'s `scripts` map, or `undefined` if the
 * file is missing/unreadable. Used to skip conventional `lint`/`test`
 * checks that aren't configured instead of misreporting a package-manager
 * "missing script" error as a real check failure.
 */
export function readPackageScripts(folder: string): Record<string, string> | undefined {
  try {
    const raw = fs.readFileSync(path.join(folder, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as { scripts?: Record<string, string> };
    return parsed.scripts;
  } catch {
    return undefined;
  }
}

/** Shape of the root `package.json` fields this file cares about for
 * monorepo detection (npm/yarn's `workspaces`, either the bare-array form
 * or the `{ packages: [...] }` object form). */
interface RootPackageJsonWorkspaces {
  workspaces?: string[] | { packages?: string[] };
}

/** Read the root `package.json`'s `workspaces` field only, or `undefined`
 * if the file is missing/unreadable/malformed. Separate from
 * `readPackageScripts` because callers here only ever need this one field. */
function readRootWorkspacesField(folder: string): RootPackageJsonWorkspaces["workspaces"] | undefined {
  try {
    const raw = fs.readFileSync(path.join(folder, "package.json"), "utf8");
    const parsed = JSON.parse(raw) as RootPackageJsonWorkspaces;
    return parsed.workspaces;
  } catch {
    return undefined;
  }
}

/**
 * Parse the `packages:` list out of a pnpm-workspace.yaml file with a
 * deliberately narrow, hand-rolled reader rather than pulling in a full
 * YAML dependency for one list of quoted globs — this repo has no `yaml`/
 * `js-yaml` dependency today, and pnpm-workspace.yaml's `packages:` block
 * is always a flat list of `- 'glob'` entries in practice. Returns an empty
 * array (not an error) for anything that doesn't parse cleanly — a
 * malformed/unsupported layout degrades to "no member packages discovered"
 * rather than throwing and losing the root checks entirely.
 *
 * @internal exported for testing
 */
export function parsePnpmWorkspacePackages(folder: string): string[] {
  let raw: string;
  try {
    raw = fs.readFileSync(path.join(folder, "pnpm-workspace.yaml"), "utf8");
  } catch {
    return [];
  }
  const patterns: string[] = [];
  let inPackagesList = false;
  for (const line of raw.split(/\r?\n/)) {
    if (/^packages\s*:\s*$/.test(line)) {
      inPackagesList = true;
      continue;
    }
    if (inPackagesList) {
      const item = line.match(/^\s*-\s*['"]?([^'"#]+?)['"]?\s*(#.*)?$/);
      const pattern = item?.[1];
      if (pattern !== undefined) {
        patterns.push(pattern.trim());
        continue;
      }
      // Any other non-blank, non-comment line ends the `packages:` block —
      // either a new top-level key or a nested mapping we don't parse.
      if (/\S/.test(line) && !/^\s*#/.test(line)) {
        inPackagesList = false;
      }
    }
  }
  return patterns;
}

/**
 * True when the workspace root is a monorepo: the root `package.json` has a
 * non-empty `workspaces` field (npm/yarn convention), OR a
 * pnpm-workspace.yaml file is present at the root. Detection is deliberately
 * OR'd across both conventions — a workspace can use either (this repo uses
 * pnpm-workspace.yaml with no `workspaces` field in package.json).
 *
 * @internal exported for testing
 */
export function isMonorepoWorkspace(folder: string): boolean {
  const workspacesField = readRootWorkspacesField(folder);
  const hasWorkspacesField = Array.isArray(workspacesField)
    ? workspacesField.length > 0
    : Array.isArray(workspacesField?.packages) && workspacesField.packages.length > 0;
  return hasWorkspacesField || fs.existsSync(path.join(folder, "pnpm-workspace.yaml"));
}

/** The workspace member glob patterns for the root folder: the
 * package.json `workspaces` field when present (either array or
 * `{ packages }` form), otherwise pnpm-workspace.yaml's `packages:` list.
 * Empty when neither is configured. */
function getWorkspacePackagePatterns(folder: string): string[] {
  const workspacesField = readRootWorkspacesField(folder);
  if (Array.isArray(workspacesField)) {
    return workspacesField;
  }
  if (Array.isArray(workspacesField?.packages)) {
    return workspacesField.packages;
  }
  return parsePnpmWorkspacePackages(folder);
}

/** Convert one workspace glob pattern segment-by-segment into a RegExp
 * matched against a POSIX-style relative path. Supports `*` (any run of
 * non-slash characters) and `**` (any run of characters, including `/`) —
 * the two wildcard forms actually used in workspace `packages:`/`workspaces`
 * lists in practice. */
function globPatternToRegExp(pattern: string): RegExp {
  // Constructed via String.fromCharCode, never written as a literal byte: a
  // raw NUL embedded in the source made Git and search tools classify this
  // file as binary, obscuring diffs. The runtime value is unchanged — a NUL
  // can never appear in a real workspaces/pnpm-workspace glob pattern, which
  // is what makes it a safe placeholder.
  const DOUBLE_STAR_PLACEHOLDER = String.fromCharCode(0);
  const withPlaceholders = pattern
    .replace(/\\/g, "/")
    .replace(/\*\*/g, DOUBLE_STAR_PLACEHOLDER)
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, "[^/]*")
    .replace(new RegExp(DOUBLE_STAR_PLACEHOLDER, "g"), ".*");
  return new RegExp(`^${withPlaceholders}$`);
}

/** Depth-bounded walk collecting every directory under `root` that contains
 * its own package.json, skipping `node_modules` and dotfolders. Bounded to
 * a shallow depth because real workspace layouts (`packages/*`, `apps/*`)
 * are one or two levels deep — this is a candidate list for glob matching
 * below, not a general-purpose recursive search. */
function collectPackageJsonDirectories(root: string, maxDepth = 4): string[] {
  const results: string[] = [];
  const walk = (dir: string, depth: number): void => {
    if (depth > maxDepth) { return; }
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!entry.isDirectory() || entry.name === "node_modules" || entry.name.startsWith(".")) { continue; }
      const full = path.join(dir, entry.name);
      if (fs.existsSync(path.join(full, "package.json"))) {
        results.push(full);
      }
      walk(full, depth + 1);
    }
  };
  walk(root, 0);
  return results;
}

/**
 * Resolve the workspace member package glob patterns to actual on-disk
 * package folders (each containing its own package.json), relative to
 * `folder`. Patterns starting with `!` exclude rather than include —
 * pnpm-workspace.yaml commonly negates a sub-pattern (e.g.
 * `!packages/*\/test-fixtures`).
 *
 * @internal exported for testing
 */
export function discoverWorkspaceMemberFolders(folder: string): string[] {
  const patterns = getWorkspacePackagePatterns(folder);
  if (patterns.length === 0) { return []; }
  const includePatterns = patterns.filter((p) => !p.startsWith("!")).map(globPatternToRegExp);
  const excludePatterns = patterns.filter((p) => p.startsWith("!")).map((p) => globPatternToRegExp(p.slice(1)));
  if (includePatterns.length === 0) { return []; }
  return collectPackageJsonDirectories(folder).filter((dir) => {
    const relative = path.relative(folder, dir).replace(/\\/g, "/");
    return includePatterns.some((re) => re.test(relative)) && !excludePatterns.some((re) => re.test(relative));
  });
}

function isInFolder(uri: vscode.Uri, folder: string): boolean {
  const file = uri.fsPath.replace(/\\/g, "/");
  const root = folder.replace(/\\/g, "/").replace(/\/$/, "");
  return file === root || file.startsWith(`${root}/`);
}

function getGitModifiedFiles(folder: string): string[] {
  try {
    const stdout = execSync("git status --porcelain", { cwd: folder, stdio: "pipe", windowsHide: true }).toString("utf8");
    const files: string[] = [];
    for (const line of stdout.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      const filePath = trimmed.slice(3).trim();
      if (filePath) {
        files.push(filePath);
      }
    }
    return files;
  } catch {
    return [];
  }
}

function getOpenWorkspaceFiles(folder: string): string[] {
  const files: string[] = [];
  try {
    for (const doc of vscode.workspace.textDocuments) {
      if (doc.uri && isInFolder(doc.uri, folder)) {
        files.push(path.relative(folder, doc.uri.fsPath));
      }
    }
  } catch {
    // Ignore
  }
  return files;
}

/** Options threaded through to the actual spawn, shared by runCheck and
 * runExplicitCheck. Both `token` and `timeoutMs` are optional: omitting
 * both preserves the previous "run to completion, no way to stop it"
 * behavior for any caller that doesn't pass them. */
interface RunGuardOptions {
  token?: vscode.CancellationToken;
  timeoutMs?: number;
}

/**
 * Test seam for killProcessTree: disables exactly one of the two
 * deliberately redundant PID-reuse guards so a test can prove the OTHER
 * is independently present (see the killProcessTree doc comment for why
 * no black-box test can distinguish them). Production callers must never
 * pass this — with no seam both guards are always active.
 *
 * @internal exported for testing only
 */
export interface KillProcessTreeGuardSeam {
  /**
   * Skip attemptKill's fire-time hasExited() re-check, proving the
   * exit-time timer cleanup alone stops post-exit retries.
   */
  omitFireTimeExitCheck?: boolean;
  /**
   * Skip the 'exit' listener that clears queued retry timers, proving the
   * fire-time re-check alone suppresses post-exit retries.
   */
  omitExitTimeTimerCleanup?: boolean;
}

/**
 * Kill a spawned check process. `child.kill()` alone only signals the
 * immediate process — with shell:true (runCheck's Windows .cmd/.bat path,
 * and runExplicitCheck always) that immediate process is a cmd.exe/shell
 * wrapper, and its actual npm/node descendants are untouched by that
 * signal: a "killed" hung check keeps running to completion in the
 * background while the caller believes it was stopped (confirmed directly —
 * an earlier version of this function that only called child.kill() left a
 * 500ms-timeout test waiting the full 60s for an unrelated sleep to finish,
 * with the orphaned node.exe still visible in Task Manager afterward). On
 * Windows, `taskkill /T` kills the whole process tree; POSIX shells
 * generally do forward signals to their children, so plain kill() is kept
 * there.
 *
 * This is a BEST-EFFORT mitigation, not an airtight guarantee. Direct
 * diagnostic runs against this exact code path showed Windows itself
 * intermittently refuses to terminate the deepest descendant in a nested
 * cmd.exe -> npm.cmd -> node.exe chain ("The operation attempted is not
 * supported") even while it successfully kills the root process we actually
 * spawned. Retrying at increasing delays substantially narrows the window
 * for a merely transient/slow taskkill failure (most attempts succeed on the
 * first or second try) without pretending to close the "operation not
 * supported" case completely — that specific descendant may never respond
 * to any number of retries once the root pid it was scoped to is already
 * gone. attachRunGuards (below) is what actually stops the caller from
 * waiting on that unreachable descendant: it resolves as soon as the
 * process we spawned exits, rather than waiting for every descendant to
 * release the inherited stdio pipe.
 *
 * Every retry stops the moment the tracked child exits. Windows reuses
 * freed PIDs aggressively, so a taskkill retry aimed at a PID whose process
 * is already gone can land on a completely unrelated process that was
 * assigned the same number in the meantime — up to 30s later with the
 * retry schedule below. Once the root we spawned has exited, a retry can
 * only ever hit a reused PID or fail ("not found"): `/T` scopes the tree
 * walk to that root, so it cannot reach a surviving orphaned descendant
 * either way. (Observed as a real kill of a sibling test's freshly spawned
 * npm chain while the full suite ran concurrently.)
 *
 * Two deliberately redundant guards enforce that stop, and BOTH must
 * survive any refactor: attemptKill re-checks hasExited() at fire time
 * (covering a timer that fires in the window before Node emits 'exit'),
 * and the 'exit' listener clears every queued retry timer (covering
 * everything after). The observable behavior — no taskkill after exit —
 * is identical with either guard alone, so an end-to-end test cannot
 * tell them apart; KillProcessTreeGuardSeam exists so the seam tests in
 * completionLintKillPidReuse.test.ts (Windows-only) can disable one
 * guard at a time and fail if the other has been removed.
 *
 * @internal exported for testing
 */
export function killProcessTree(
  child: ReturnType<typeof spawn>,
  guardSeam?: KillProcessTreeGuardSeam
): void {
  if (process.platform === "win32" && child.pid) {
    const pid = child.pid;
    const hasExited = (): boolean => child.exitCode !== null || child.signalCode !== null;
    const attemptKill = (): void => {
      if (!guardSeam?.omitFireTimeExitCheck && hasExited()) { return; }
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // Still running but taskkill itself failed — a later retry (or,
        // worst case, the caller's own timeoutMs bound) is the fallback.
      }
    };
    attemptKill();
    const retries: NodeJS.Timeout[] = [];
    for (const delayMs of [300, 1000, 2500, 5000, 9000, 15000, 22000, 30000]) {
      const timer = setTimeout(attemptKill, delayMs);
      // Never hold the process open just for a pending kill retry — if the
      // child outlives every other piece of work, the caller's timeoutMs
      // bound is the backstop, not this schedule.
      timer.unref?.();
      retries.push(timer);
    }
    if (!guardSeam?.omitExitTimeTimerCleanup) {
      child.once("exit", () => {
        for (const timer of retries) { clearTimeout(timer); }
      });
    }
    return;
  }
  child.kill();
}

/**
 * Wire cancellation and a wall-clock timeout onto an already-spawned check
 * process, resolving exactly once regardless of which of "exited normally",
 * "cancelled", or "timed out" happens first. Shared by runCheck and
 * runExplicitCheck so a hung lint/test/type-check command — or an explicit
 * verification command — can always be stopped from the UI (cancelling the
 * review/Fast Forward operation) or by the configured
 * ensemble.completionCheckTimeoutMs cap, instead of blocking the calling
 * review round indefinitely with no recourse.
 */
function attachRunGuards(
  child: ReturnType<typeof spawn>,
  guard: RunGuardOptions | undefined,
  resolve: (result: { code: number; output: string }) => void
): void {
  let output = "";
  let settled = false;
  let killed = false;
  child.stdout?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
  child.stderr?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });

  // A token cancelled BEFORE this process even started must still kill it —
  // onCancellationRequested is an event subscription, not a state check, so
  // subscribing after the fact is not guaranteed to retroactively fire (the
  // same gotcha taskOperations.ts's linkCancellationTokens already guards
  // against for exactly this reason). Check the current state directly
  // first, and only fall back to the subscription for a cancellation that
  // happens later.
  if (guard?.token?.isCancellationRequested) {
    output += "\n[check cancelled]";
    killed = true;
    killProcessTree(child);
  }
  const tokenSub = guard?.token?.onCancellationRequested(() => {
    if (settled) { return; }
    output += "\n[check cancelled]";
    killed = true;
    killProcessTree(child);
  });
  const timer = guard?.timeoutMs !== undefined ? setTimeout(() => {
    if (settled) { return; }
    output += `\n[check timed out after ${guard.timeoutMs}ms and was terminated]`;
    killed = true;
    killProcessTree(child);
  }, guard.timeoutMs) : undefined;

  const finish = (result: { code: number; output: string }): void => {
    if (settled) { return; }
    settled = true;
    tokenSub?.dispose();
    if (timer) { clearTimeout(timer); }
    resolve(result);
  };

  child.on("error", (error) => finish({ code: 1, output: output + error.message }));
  child.on("close", (code) => finish({ code: code ?? 1, output }));
  // 'close' waits for every process still holding the spawned child's stdio
  // pipes to release them — with shell:true that pipe is inherited down the
  // whole cmd.exe -> npm.cmd -> node.exe chain, and `taskkill /T` can force-
  // kill the root we spawned while genuinely failing (Windows: "The operation
  // attempted is not supported") on a deeper descendant that still holds the
  // pipe open. That leaves 'close' waiting on an orphan we can never actually
  // reach, for as long as that orphan keeps running (confirmed directly: the
  // root process's own 'exit' fires almost immediately after the kill, while
  // 'close' then blocks for the orphan's full remaining lifetime). Once we've
  // deliberately killed this process, the tracked process itself exiting is
  // sufficient to finish — an unreachable grandchild orphan is the same
  // already-documented best-effort limitation as taskkill missing it in the
  // first place, not a reason to keep waiting.
  child.on("exit", (code) => { if (killed) { finish({ code: code ?? 1, output }); } });
}

/**
 * Uppercase a Windows drive letter in a spawn `cwd`.
 *
 * VS Code hands extensions workspace paths with a LOWERCASE drive letter
 * (`c:\dev\...`), and this module passes that straight to `spawn`. A terminal
 * never does — cmd.exe and PowerShell both normalize the drive letter to
 * uppercase — so the difference is invisible to a human running the same
 * command by hand, which is exactly what made the failure below look
 * environmental for days.
 *
 * Vite resolves module ids from the process cwd, and on Windows `c:/x` and
 * `C:/x` produce two DIFFERENT module graphs. Under a lowercase drive letter
 * a Vitest run dies during collection with
 * `TypeError: Cannot read properties of undefined (reading 'config')`,
 * collecting zero tests — every suite, every workspace, before any test runs.
 *
 * Reproduced deterministically on 2026-08-28 against jester's `apps/server`
 * (78 files, 1097 tests), spawning the same command three ways:
 *   cwd `c:/dev/PERSONAL/jester/apps/server`  -> fails (undefined.config)
 *   cwd `C:/dev/PERSONAL/jester/apps/server`  -> passes
 *   cwd `C:\dev\PERSONAL\jester\apps\server`  -> passes
 * The drive letter is the only variable. Environment inheritance,
 * ELECTRON_RUN_AS_NODE, DEBUG and the workspace's own vitest config were each
 * eliminated by experiment first.
 *
 * That failure surfaced to the user as an `environmental` review blocker on a
 * task that was otherwise complete, with a suite that passed cleanly in any
 * terminal — unfixable from inside the task, and not actually the task's
 * fault. Normalizing here fixes it for every repo Ensemble runs checks in.
 *
 * Non-Windows paths and paths without a drive letter are returned unchanged.
 */
/** @internal exported for testing */
export function normalizeSpawnCwdV1(cwd: string): string {
  return /^[a-z]:/.test(cwd) ? cwd.charAt(0).toUpperCase() + cwd.slice(1) : cwd;
}

function runCheck(
  cwd: string,
  args: string[],
  guard?: RunGuardOptions,
  extraEnv?: NodeJS.ProcessEnv
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const executable = args[0] ?? "npm";
    const resolved = resolveManagerExecutable(cwd, executable);
    // shell:true on Windows so a .cmd/.bat shim (an npm/pnpm global-install
    // shim, not a real executable) can be exec'd at all — spawning a .cmd
    // file directly with shell:false fails with EINVAL. See cliAgentRunner.ts
    // for the same pattern applied to the CLI provider runners.
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
    // With shell:true, Node builds `cmd.exe /d /s /c "<command> <args...>"`
    // without quoting `command` itself — an unquoted path containing spaces
    // (e.g. the default Windows Node.js install, "C:\Program Files\nodejs\
    // npm.cmd") gets split at the first space and misreported as
    // "'C:\Program' is not recognized...", silently failing every lint/
    // check-types/test check. Quote both the resolved executable and any
    // argument containing spaces, mirroring cliAgentRunner.ts's existing
    // argument-quoting for the same shell:true-on-Windows situation.
    const quote = (value: string): string => (value.includes(" ") ? `"${value}"` : value);
    const child = spawn(
      useShell ? quote(resolved) : resolved,
      useShell ? args.slice(1).map(quote) : args.slice(1),
      { cwd: normalizeSpawnCwdV1(cwd), shell: useShell, env: extraEnv ? { ...process.env, ...extraEnv } : undefined }
    );
    attachRunGuards(child, guard, resolve);
  });
}

/** Total check attempts (1 initial + up to this-1 retries) before a failure
 * is reported red — bounded per the backlog's own guidance (N ≤ 3): retries
 * exist for genuine intermittent failures, not as a way to brute-force an
 * environment-determined red into green. */
const CHECK_ATTEMPTS_MAX = 3;

/** Applied only to a RETRY attempt, never the first — so a cached red from
 * the first attempt cannot simply replay itself on every retry and "confirm"
 * a defect that does not exist (Turbo: "cache hit, replaying logs"). Turbo's
 * own documented cache-bypass is the TURBO_FORCE env var; setting it
 * unconditionally is safe because it's a no-op for any command that isn't a
 * Turbo pipeline. */
const CACHE_BYPASS_RETRY_ENV: NodeJS.ProcessEnv = { TURBO_FORCE: "1" };

/**
 * Run one check attempt via `attempt`; on failure, retry up to
 * `CHECK_ATTEMPTS_MAX - 1` more times with the build cache disabled
 * (CACHE_BYPASS_RETRY_ENV), stopping as soon as an attempt succeeds. Reports
 * a failure red only when every attempt failed. `retryCount` — the number of
 * retries actually taken (0 for a check that passed or failed on the first
 * try) — is always returned so the caller can surface a "passed on retry N"
 * result rather than rendering it as silently clean; composes with (does not
 * shadow) the existing known-flake quarantine, which only ever sees a check
 * that still fails after every retry.
 *
 * `token`, when supplied, stops further retries once cancellation has been
 * requested — a user-cancelled check is not a "failure" needing reproduction,
 * and retrying it would burn up to two more spawn/kill cycles for no reason.
 * A check that genuinely times out (not cancelled) still retries: that is
 * one of the actual motivating flakes this exists to catch.
 *
 * @internal exported for testing
 */
export async function runWithRetry(
  attempt: (extraEnv?: NodeJS.ProcessEnv) => Promise<{ code: number; output: string }>,
  token?: vscode.CancellationToken
): Promise<{ code: number; output: string; retryCount: number }> {
  let result = await attempt();
  if (result.code === 0) {
    return { ...result, retryCount: 0 };
  }
  let retryCount = 0;
  while (retryCount < CHECK_ATTEMPTS_MAX - 1 && !token?.isCancellationRequested) {
    retryCount++;
    result = await attempt(CACHE_BYPASS_RETRY_ENV);
    if (result.code === 0) {
      return { ...result, retryCount };
    }
  }
  return { ...result, retryCount };
}

function packageManager(folder: string): string {
  if (fs.existsSync(path.join(folder, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(folder, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(folder, "bun.lockb")) || fs.existsSync(path.join(folder, "bun.lock"))) return "bun";
  return "npm";
}

/** "npm 10.8.2" (or just the bare name if the `--version` lookup fails or
 * takes too long — this is diagnostic best-effort, never a gate). */
function describePackageManagerVersion(cwd: string, manager: string): string {
  try {
    const resolved = resolveManagerExecutable(cwd, manager);
    const useShell = process.platform === "win32" && /\.(cmd|bat)$/i.test(resolved);
    const version = execFileSync(resolved, ["--version"], {
      cwd,
      windowsHide: true,
      shell: useShell,
      timeout: 5_000,
    }).toString("utf8").trim();
    return version ? `${manager} ${version}` : manager;
  } catch {
    return manager;
  }
}

/**
 * 1d: route the one allowlisted disclosure value that is actually a
 * filesystem path (the resolved cwd) through the existing workflow-privacy
 * classifier rather than assuming it's always safe to show. A Publish
 * verification scope is essentially never a private workflow path, so this
 * almost always no-ops — but it costs nothing and closes the gap for the
 * one value here the classifier can actually reason about (it classifies
 * path SHAPE, not arbitrary env var values — see the module doc comment for
 * why it isn't used for the env var names/values below).
 */
function safeCwdForDisclosure(cwd: string): string {
  return isWorkflowPrivatePathV1(cwd) ? "(redacted — resolves to a private workflow path)" : cwd;
}

/** Run one user-authored verification command line through the shell. */
function runExplicitCheck(
  cwd: string,
  command: string,
  guard?: RunGuardOptions,
  extraEnv?: NodeJS.ProcessEnv
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd: normalizeSpawnCwdV1(cwd), shell: true, env: extraEnv ? { ...process.env, ...extraEnv } : undefined });
    attachRunGuards(child, guard, resolve);
  });
}

/** Command text that looks like it chains a deploy/publish/release/migration
 * step rather than a safe, read-only verification step. A `verify` script
 * matching this must never be treated as the default Publish check — see
 * selectVerifyScriptCandidate. */
const DEPLOY_LIKE_SCRIPT_RE = /\b(deploy|publish|release|migrat\w*)\b/i;

/**
 * Prefer a repo's own aggregate `verify` script (1b) as the sole candidate
 * check, replacing the conventional lint/check-types/test/build detection —
 * the same effect linkedin-linker gets today from a per-repo
 * `ensemble.publishVerificationCommands` override, now as default behavior.
 * Guarded: a `verify` script whose command text looks like it chains a
 * deploy/publish/release/migration step is never treated as safe; the
 * default candidate list (with `build` added) is used instead.
 *
 * @internal exported for testing
 */
export function selectVerifyScriptCandidate(
  scripts: Record<string, string> | undefined,
  manager: string
): readonly [string, string[]] | undefined {
  const verifyScript = scripts?.verify;
  if (!verifyScript || DEPLOY_LIKE_SCRIPT_RE.test(verifyScript)) {
    return undefined;
  }
  return [`${manager} run verify`, [manager, "run", "verify"]] as const;
}

/**
 * One completion check's display identity, as passed to
 * {@link CollectCompletionLintOptions.onCheckEvent}. `command` is the same
 * string later reported in `CompletionLintResult.commandsRun` — already
 * carrying a monorepo member's `[packageDir] ` prefix when applicable (see
 * the recursive pass in `collectCompletionLint`), so no separate
 * `packageDir` field is needed to build a display label.
 */
export interface CompletionCheckDescriptor {
  readonly command: string;
}

export interface CollectCompletionLintOptions {
  /**
   * Explicitly configured verification command lines. When non-empty these
   * take precedence over the conventional package.json `lint`/`test`/
   * `check-types` script detection: exactly these commands run, and the
   * missing-script (inconclusive) reporting does not apply.
   */
  explicitCommands?: readonly string[];
  /**
   * Cancellation token linked to the enclosing operation (a review round,
   * Fast Forward, a Publish attempt). When cancelled, every still-running
   * check process is killed rather than left running orphaned.
   */
  token?: vscode.CancellationToken;
  /**
   * Wall-clock cap in milliseconds applied to EACH check independently (not
   * to the whole batch). Defaults to getCompletionCheckTimeoutMs() when
   * omitted — pass an explicit value only to override that default, e.g.
   * in tests. A hung command is killed and reported as a failure with a
   * "[check timed out ...]" marker in its output rather than blocking the
   * caller indefinitely.
   */
  timeoutMs?: number;
  /**
   * Opt-in, purely observational per-check lifecycle hooks (Notifications
   * in-flight visibility, plan Part III). `started` fires just before a
   * check's process is spawned; `settled` fires once it has resolved
   * (success, failure, or timeout) via a `finally`, so it always pairs with
   * a prior `started` even when the check throws. Invoked from inside both
   * concurrent `Promise.all` batches this function already runs (the root
   * pass — explicit or conventional — and the monorepo member pass); never
   * changes scheduling, concurrency, retry behavior, failure handling,
   * result ordering, or `commandsRun`. Only the workflow completion-stage
   * caller in reviewActions.ts passes this; `checkPublishPreflight` and the
   * commit/push caller pass none, so they publish no activity.
   */
  onCheckEvent?: {
    started(descriptor: CompletionCheckDescriptor): void;
    settled(descriptor: CompletionCheckDescriptor): void;
    /**
     * Fires exactly once, synchronously, before the root/explicit batch's
     * `Promise.all` is kicked off — i.e. before any `started` call — with
     * the TRUE grand total of checks that will run across every batch this
     * call will make (root/explicit count plus, when applicable, the
     * monorepo member-package count, both already known synchronously at
     * this point from package.json/workspace inspection). An observer uses
     * this as the fixed denominator for the whole pass so a completed-
     * looking "N/N" state is never rendered for the root batch alone and
     * then silently grown once a monorepo member batch is discovered — the
     * total is correct from the very first `started` report onward and
     * never changes again.
     */
    planned?(total: number): void;
    /**
     * Fires exactly once, synchronously, immediately before the monorepo
     * member-package batch's `Promise.all` is kicked off — and ONLY when
     * that batch is non-empty, i.e. a further batch is genuinely about to
     * run. Carries no payload: the true total was already delivered via
     * `planned` before the root batch even started, so this call exists
     * purely to mark the real transition point in time — an observer uses
     * it to render a "starting next batch" hint at the moment that is
     * actually true, distinguishing "a batch boundary, more work is
     * (imminently) starting" from "the whole pass is done", never by
     * inferring either from the active-check set emptying out.
     */
    batchBoundary?(): void;
  };
}

/** Collect diagnostics after fresh lint/type/test checks have completed. */
export async function collectCompletionLint(
  folder: string,
  relevantFiles?: readonly string[],
  options?: CollectCompletionLintOptions
): Promise<CompletionLintResult> {
  const manager = packageManager(folder);
  const missingScripts: string[] = [];
  const explicitCommands = (options?.explicitCommands ?? [])
    .map((command) => command.trim())
    .filter((command) => command.length > 0);
  const guard: { token?: vscode.CancellationToken; timeoutMs?: number } = {
    token: options?.token,
    timeoutMs: options?.timeoutMs ?? getCompletionCheckTimeoutMs(),
  };

  let checks: Array<{ command: string; code: number; output: string; retryCount: number }>;
  let monorepoDetected = false;
  let monorepoChecks: NonNullable<CompletionLintResult["monorepoChecks"]> = [];

  // Monorepo member-command discovery (packageDir/command/memberFolder/args)
  // is pure filesystem inspection — it never depends on any check's result —
  // so, like the root command list resolved just below, it is determined
  // synchronously before any check runs. This is what lets the TRUE grand
  // total (root count plus member count) be reported via `planned` before
  // the first `started` call, so an observer's denominator is correct from
  // the very start and never has to grow after appearing to reach a
  // completed-looking "N/N".
  const memberCommands: Array<{ packageDir: string; command: string; memberFolder: string; args: string[] }> = [];
  monorepoDetected = isMonorepoWorkspace(folder);
  if (monorepoDetected && explicitCommands.length === 0) {
    const memberFolders = discoverWorkspaceMemberFolders(folder);
    const scriptNames = ["lint", "check-types", "test", "build"] as const;
    for (const memberFolder of memberFolders) {
      const memberScripts = readPackageScripts(memberFolder);
      if (!memberScripts) { continue; }
      const packageDir = path.relative(folder, memberFolder).replace(/\\/g, "/");
      for (const scriptName of scriptNames) {
        // `--if-present` equivalent: only invoke a script that is actually
        // configured for this member package, so one package missing e.g.
        // `build` never fails (or is even attempted for) the whole pass.
        if (!Object.prototype.hasOwnProperty.call(memberScripts, scriptName)) { continue; }
        memberCommands.push({
          packageDir,
          command: `[${packageDir}] ${manager} run ${scriptName}`,
          memberFolder,
          args: [manager, "run", scriptName],
        });
      }
    }
  }

  // Root/explicit command list is likewise resolved synchronously up front
  // (unchanged selection logic, just hoisted ahead of execution) so its
  // length is known before `planned` fires below, without altering which
  // commands actually run or how `missingScripts` is computed.
  let runnableChecks: Array<readonly [string, string[]]> = [];
  if (explicitCommands.length === 0) {
    const scripts = readPackageScripts(folder);
    // 1b: a repo's own aggregate `verify` script, when safe, replaces the
    // conventional candidate list outright (see selectVerifyScriptCandidate).
    const verifyCandidate = selectVerifyScriptCandidate(scripts, manager);
    const candidateChecks: Array<readonly [string, string[]]> = verifyCandidate
      ? [verifyCandidate]
      : [
          [`${manager} run lint`, [manager, "run", "lint"]],
          [`${manager} run check-types`, [manager, "run", "check-types"]],
          [`${manager} run test`, [manager, "run", "test"]],
          [`${manager} run build`, [manager, "run", "build"]],
        ];

    // The conventional `lint`/`test`/`build` scripts (publish pre-check
    // contract, extended by 1b to include `build`) are skipped rather than
    // run when not present in package.json's `scripts`, so an unconfigured
    // workspace gets clean setup guidance instead of every publish check
    // being misreported as a failure. `check-types` predates that contract
    // and keeps its existing unconditional-run behavior. A selected `verify`
    // script is always configured (it was only selected because it exists),
    // so it skips this filter entirely.
    runnableChecks = verifyCandidate
      ? candidateChecks
      : candidateChecks.filter(([, args]) => {
          const scriptName = args[2];
          if (scriptName !== "lint" && scriptName !== "test" && scriptName !== "build") return true;
          const configured = !!scripts && Object.prototype.hasOwnProperty.call(scripts, scriptName);
          if (!configured) missingScripts.push(scriptName);
          return configured;
        });
  }

  const rootCount = explicitCommands.length > 0 ? explicitCommands.length : runnableChecks.length;
  // Fires exactly once, before any `started` call — see the option's doc
  // comment: this is the fixed denominator for the whole pass, correct from
  // the first report onward.
  options?.onCheckEvent?.planned?.(rootCount + memberCommands.length);

  if (explicitCommands.length > 0) {
    // Toolchain resolution order (publish pre-check contract): explicitly
    // configured verification commands win over conventional npm scripts.
    checks = await Promise.all(
      explicitCommands.map(async (command) => {
        const descriptor: CompletionCheckDescriptor = { command };
        options?.onCheckEvent?.started(descriptor);
        try {
          return {
            command,
            ...(await runWithRetry((extraEnv) => runExplicitCheck(folder, command, guard, extraEnv), guard.token)),
          };
        } finally {
          options?.onCheckEvent?.settled(descriptor);
        }
      })
    );
  } else {
    checks = await Promise.all(
      runnableChecks.map(async ([command, args]) => {
        const descriptor: CompletionCheckDescriptor = { command };
        options?.onCheckEvent?.started(descriptor);
        try {
          return {
            command,
            ...(await runWithRetry((extraEnv) => runCheck(folder, [...args], guard, extraEnv), guard.token)),
          };
        } finally {
          options?.onCheckEvent?.settled(descriptor);
        }
      })
    );
  }

  // Monorepo recursive pass (step 21, workflow-resilience backlog): additive
  // to the conventional fallback path above, never a replacement for it —
  // the root commands (including any selected `verify` script) still run
  // and win exactly as before. Detection itself (`monorepoDetected`) is
  // reported regardless of whether the pass actually runs, so a reviewer
  // can tell "not a monorepo" apart from "a monorepo whose recursive pass
  // didn't run this time". The pass only actually executes in the
  // conventional-fallback branch: explicitly configured verification
  // commands (explicitCommands above) already say precisely what should
  // run, and stay authoritative with nothing added underneath them. A
  // root-level `lint`/`test`/`build` (or `verify`) command frequently never
  // touches `packages/*`/`apps/*` at all, so without this pass a member
  // package's real, currently-failing suite is invisible to a reviewer who
  // is told the Verified Checks result is ground truth.
  //
  // `memberCommands` was already resolved above, before the root batch even
  // started; `planned` already reported the true combined total. This
  // `batchBoundary` call — still fired here, at the real transition point,
  // only when a member batch is genuinely about to run — exists purely to
  // mark the moment in time so an observer can render a "starting next
  // batch" hint that is actually true, not to correct any count.
  if (monorepoDetected && explicitCommands.length === 0 && memberCommands.length > 0) {
    options?.onCheckEvent?.batchBoundary?.();
    const memberResults = await Promise.all(
      memberCommands.map(async ({ packageDir, command, memberFolder, args }) => {
        const descriptor: CompletionCheckDescriptor = { command };
        options?.onCheckEvent?.started(descriptor);
        try {
          return {
            packageDir,
            command,
            ...(await runWithRetry((extraEnv) => runCheck(memberFolder, args, guard, extraEnv), guard.token)),
          };
        } finally {
          options?.onCheckEvent?.settled(descriptor);
        }
      })
    );
    monorepoChecks = memberResults.map(({ packageDir, command, code, retryCount }) => ({
      packageDir,
      command,
      exitCode: code,
      passed: code === 0,
      ...(retryCount > 0 ? { retryCount } : {}),
    }));
    // Merged into the same `checks` array the root commands use, so every
    // existing downstream mechanism (commandFailures, retriedPasses, known-
    // flake quarantine, failedChecks output rendering) already applies to
    // member-package failures with no separate code path to keep in sync.
    checks = [...checks, ...memberResults.map(({ packageDir: _packageDir, ...rest }) => rest)];
  }

  let filesToCheck = relevantFiles ? [...relevantFiles] : [];
  if (filesToCheck.length === 0) {
    const gitFiles = getGitModifiedFiles(folder);
    const openFiles = getOpenWorkspaceFiles(folder);
    const union = new Set([...gitFiles, ...openFiles]);
    filesToCheck = [...union];
  }

  const issues = vscode.languages.getDiagnostics().flatMap(([uri, diagnostics]) =>
    isInFolder(uri, folder) && filesToCheck.length > 0 && filesToCheck.some(file => path.resolve(folder, file) === path.resolve(uri.fsPath))
      ? diagnostics.filter((d) => d.source === "eslint" || d.source === "ts" || d.source === "typescript")
      : []
  );
  // A configured publish check is a workspace-level gate. Its exit status is
  // authoritative: runner/configuration failures frequently name no source
  // file at all, and filtering those by task-file attribution previously
  // converted a real non-zero exit into a passing publish result. Keep every
  // failed configured check so publish-review.md and the Publish Anyway / Fix
  // / Cancel prompt always reflect the actual command outcome.
  const commandFailures = checks.filter((check) => check.code !== 0);
  // A check that failed at least once but passed on a cache-bypassed retry
  // (see runWithRetry) — not a "real" failure (its final exit code was 0),
  // but never rendered as silently clean either: the retry itself is the
  // signal that the first attempt could not be trusted.
  const retriedPasses = checks
    .filter((check) => check.code === 0 && check.retryCount > 0)
    .map((check) => ({ command: check.command, retryCount: check.retryCount }));
  const issueCount = issues.length + commandFailures.length;
  const baseSummary = commandFailures.length > 0
    ? `${commandFailures.length} completion check(s) failed${issues.length ? `; ${issues.length} editor diagnostic(s) remain` : "."}`
    : issues.length === 0 ? "No linting issues found." : `${issues.length} lint issue(s) remain.`;
  const retriedNote = retriedPasses.length > 0
    ? ` (${retriedPasses.length} check(s) required a retry to pass — see Verified Checks for details)`
    : "";
  const summary = missingScripts.length > 0
    ? `${baseSummary} (${missingScripts.join("/")} script(s) not configured — add them to package.json's ` +
      `"scripts" to enable publish checks for them. Checks are inconclusive, not passed.)${retriedNote}`
    : `${baseSummary}${retriedNote}`;
  const knownFlakes = getKnownFlakyChecks();
  // Computed exactly once per failure, right here — `findQuarantineMatchV1`
  // is called a single time per entry of `commandFailures`, and both
  // `knownFlakeFailures` below and each `failedChecks` entry's `quarantine`
  // stamp are derived from that same array of matches. A previous revision
  // called `findQuarantineMatchV1` again, separately, while building
  // `failedChecks` — functionally consistent (the function is deterministic)
  // but two call sites computing "the same" decision is exactly the shape
  // wf10 continuation item 12 exists to eliminate.
  const quarantineMatches = commandFailures.map((failure) => ({
    failure,
    match: findQuarantineMatchV1(failure, knownFlakes),
  }));
  const knownFlakeFailures = quarantineMatches
    .filter((entry) => entry.match !== undefined)
    .map(({ failure, match }) => ({ command: failure.command, exitCode: failure.code, reason: match!.reason }));
  const unquarantinedFailureCount = commandFailures.length - knownFlakeFailures.length;
  return {
    runAt: new Date().toISOString(),
    // An undetected toolchain is never a pass: with a required check
    // inconclusive (missing lint/test/build script), the run cannot report
    // passed even when everything that could run came back clean.
    passed: issueCount === 0 && missingScripts.length === 0,
    passedModuloKnownFlakes:
      issues.length === 0 && unquarantinedFailureCount === 0 && missingScripts.length === 0,
    issueCount,
    summary,
    failedChecks: quarantineMatches.map(({ failure: { command, code, output, retryCount }, match: flake }) => {
      return {
        command,
        exitCode: code,
        // Truncated at the PERSIST boundary, not just the display ones. This
        // payload is written into task-progress.json, which is re-read and
        // rewritten on every stage transition, so an untruncated failure makes
        // a hot ~2.5 KB file enormous: one `pnpm run verify` failure carrying
        // all 422 eslint warnings produced a 384 KB progress file
        // (.ensemble/2026-07-24_task_1, 2026-08-08). truncateCheckOutput was
        // already applied where output feeds prompts (PUBLISH_CHECKS_ and
        // VERIFIED_CHECKS_PROMPT_MAX_OUTPUT_CHARS) but never where it feeds
        // storage. Head+tail is kept, so the fail-fast opening and the
        // summarizing end both survive for runLintingFixes.
        output: truncateCheckOutput(output, PERSISTED_CHECK_OUTPUT_MAX_CHARS),
        ...(retryCount > 0 ? { retryCount } : {}),
        ...(flake ? { quarantine: { reason: flake.reason, ruleMatch: flake.match } } : {}),
      };
    }),
    knownFlakeFailures,
    retriedPasses,
    missingScripts,
    verificationEnvironment: {
      // Normalized, because this field's contract (see its doc comment) is
      // "the resolved cwd checks ran in" — and since normalizeSpawnCwdV1 the
      // spawned cwd is not necessarily the `folder` this function received.
      // Disclosing the un-normalized one would be wrong in exactly the case
      // this whole disclosure block exists to diagnose: an extension-host run
      // behaving differently from a terminal run of the same command.
      cwd: safeCwdForDisclosure(normalizeSpawnCwdV1(folder)),
      packageManager: describePackageManagerVersion(folder, manager),
      envVarNames: Object.keys(process.env).sort(),
    },
    commandsRun: checks.map((check) => check.command),
    monorepoDetected,
    ...(monorepoDetected ? { monorepoChecks } : {}),
  };
}

/** The `[packageDir] ` prefix the monorepo recursive pass (above) prepends
 * to a member package's command line, e.g. `[apps/server] npm run test`. */
const MONOREPO_PACKAGE_PREFIX_RE = /^\[[^\]]+\]\s*/;

/** Strip a monorepo member's `[packageDir] ` prefix, if present, so an
 * `any-package`-scoped allowlist entry can match the bare command underneath
 * regardless of which package produced it. A root-level command (no prefix)
 * passes through unchanged. */
function stripMonorepoPackagePrefixV1(command: string): string {
  return command.replace(MONOREPO_PACKAGE_PREFIX_RE, "").trim();
}

/**
 * Find the known-flaky-check allowlist entry that quarantines one failed
 * check, or `undefined` if none matches. A failure is quarantined only when
 * BOTH `match` and `failureSignature` are found — deliberately narrow so the
 * allowlist can't accidentally swallow an unrelated real failure that
 * happens to share a command name.
 *
 * `match` is compared against the failed command's line according to the
 * entry's `scope` (default `"exact"`):
 *  - `"exact"`: the command line must equal `match` exactly, not a substring
 *    `includes` — a monorepo's per-package commands are already
 *    disambiguated by their `[packageDir]` prefix (see the recursive pass
 *    above), so a broad entry like `match: "npm run test"` (intended for one
 *    package's cron suite) previously also swallowed every other package's
 *    `[apps/server] npm run test`, `[apps/web] npm run test`, etc. — anything
 *    whose command line merely contained that substring.
 *  - `"any-package"`: `match` is compared against the command line with any
 *    leading `[packageDir] ` prefix stripped, so one entry can deliberately
 *    quarantine the same failure signature across every monorepo member
 *    package (and the root command) without needing one entry per package.
 *
 * Private to this module — {@link classifyKnownFlakeFailures} and
 * `collectCompletionLint`'s `failedChecks` stamping both call this exact
 * function, which is what keeps their quarantine decisions in sync.
 */
function findQuarantineMatchV1(
  failure: { command: string; output: string },
  knownFlakes: readonly KnownFlakyCheck[]
): KnownFlakyCheck | undefined {
  const trimmedCommand = failure.command.trim();
  const unscopedCommand = stripMonorepoPackagePrefixV1(failure.command);
  return knownFlakes.find((entry) => {
    if (!failure.output.includes(entry.failureSignature)) {
      return false;
    }
    const trimmedMatch = entry.match.trim();
    return entry.scope === "any-package"
      ? unscopedCommand === trimmedMatch
      : trimmedCommand === trimmedMatch;
  });
}

/**
 * Find the `scope: "exact"` (default) allowlist entry that would have
 * quarantined this failure had it been `scope: "any-package"` instead — i.e.
 * the failure's `[packageDir] `-prefixed command strips down to exactly
 * `entry.match` and the failure signature matches, but the entry's exact
 * scope requires the full, unstripped command line to equal `match`, which
 * it does not. Returns `undefined` for a command with no monorepo prefix,
 * or when {@link findQuarantineMatchV1} already quarantined the failure.
 *
 * Exists so both display renderers can tell a user WHY a failure that looks
 * like a known flake was not quarantined, instead of leaving them to
 * discover the exact/any-package distinction by reading source (plan item
 * 12, step 3: "not quarantined — rule `X` is scope: exact; set scope:
 * any-package or add `[pkg] X`").
 */
function findExactScopeMismatchV1(
  failure: { command: string; output: string },
  knownFlakes: readonly KnownFlakyCheck[]
): KnownFlakyCheck | undefined {
  const unscopedCommand = stripMonorepoPackagePrefixV1(failure.command);
  if (unscopedCommand === failure.command.trim()) {
    // No monorepo prefix on this command at all — an exact-scope entry
    // either already matched it (handled by findQuarantineMatchV1) or is
    // genuinely unrelated, not merely scope-mismatched.
    return undefined;
  }
  return knownFlakes.find((entry) => {
    if (entry.scope === "any-package") {
      return false;
    }
    if (!failure.output.includes(entry.failureSignature)) {
      return false;
    }
    return unscopedCommand === entry.match.trim();
  });
}

/**
 * Match failed checks against the known-flaky-check allowlist, returning one
 * entry per quarantined failure with both the legacy flat shape
 * (`command`/`exitCode`/`reason`) and the stamp {@link collectCompletionLint}
 * attaches to that failure's `failedChecks` entry — the two are always in
 * sync because both are derived from the same match, computed once here.
 *
 * @internal exported for testing
 */
export function classifyKnownFlakeFailures(
  failures: readonly { command: string; code: number; output: string }[],
  knownFlakes: readonly KnownFlakyCheck[]
): Array<{ command: string; exitCode: number; reason: string; quarantine: QuarantineStampV1 }> {
  const quarantined: Array<{ command: string; exitCode: number; reason: string; quarantine: QuarantineStampV1 }> = [];
  for (const failure of failures) {
    const flake = findQuarantineMatchV1(failure, knownFlakes);
    if (flake) {
      quarantined.push({
        command: failure.command,
        exitCode: failure.code,
        reason: flake.reason,
        quarantine: { reason: flake.reason, ruleMatch: flake.match },
      });
    }
  }
  return quarantined;
}

const PUBLISH_CHECKS_SECTION_START = "<!-- completion-checks:start -->";
const PUBLISH_CHECKS_SECTION_END = "<!-- completion-checks:end -->";
/** Cap per-failed-check output embedded in publish-review.md — this is a
 * human-facing artifact, not an AI prompt, so it only needs enough of the
 * output to identify the failure, not the full log. */
const PUBLISH_CHECKS_MAX_OUTPUT_CHARS = 4000;

/** Cap per-failed-check output PERSISTED into task-progress.json. Deliberately
 * larger than the two display caps — runLintingFixes.ts reads this payload back
 * to drive fixes, so it wants more context than a human skimming the artifact —
 * but still bounded, because this file is re-read and rewritten on every stage
 * transition. The decoder's own MAX_CHECK_OUTPUT_LENGTH (256 KB) is a ceiling
 * against corruption, not a target: a single failing `verify` run legitimately
 * emits hundreds of KB. */
const PERSISTED_CHECK_OUTPUT_MAX_CHARS = 8000;

/** Room reserved for the elision marker itself so the rendered output still
 * respects the caller's cap. */
const CHECK_OUTPUT_MARKER_ALLOWANCE = 64;

/**
 * Truncate a failed check's captured output to roughly `maxChars`, keeping
 * BOTH ends of the log.
 *
 * A plain `slice(0, max)` keeps only the head, which is exactly the wrong
 * half for the most important check: `node --test` streams its passing
 * tests first and prints the failing test name, its error, and the trailing
 * `fail N` summary at the very END. Head-only truncation therefore handed
 * the reader a wall of ✔ passes and dropped the one thing that identifies
 * the failure. That is not merely cosmetic — reviewers are instructed to
 * treat Verified Checks as ground truth (see the rubric), so an
 * unattributable failure becomes an *unfixable* blocker: the reviewer must
 * report the red run, while the implementer is never told which test to
 * look at, cannot reproduce it, changes nothing, and the round fails as
 * "did not modify any workspace files" — a loop observed live on
 * 2026-07-26, where a `pnpm run test` exit 1 could not be reproduced across
 * seven subsequent full runs.
 *
 * Compilers fail the other way round (tsc reports its errors first), so
 * keep both ends rather than simply swapping to a tail-only slice: a
 * smaller head for tools that fail fast, the larger remainder for test
 * runners that summarize last.
 *
 * @internal exported for testing
 */
export function truncateCheckOutput(output: string, maxChars: number): string {
  if (output.length <= maxChars) {
    return output;
  }
  const budget = Math.max(0, maxChars - CHECK_OUTPUT_MARKER_ALLOWANCE);
  const headChars = Math.floor(budget * 0.4);
  const tailChars = budget - headChars;
  const omitted = output.length - headChars - tailChars;
  const marker = `\n… (truncated ${omitted} characters) …\n`;
  return `${output.slice(0, headChars)}${marker}${output.slice(output.length - tailChars)}`;
}

/**
 * Render the Plan Item Verification block shared by two surfaces: the
 * "Completion Checks" section written into publish-review.md
 * (renderCompletionChecksSection, `heading: "###"`, an artifact appended
 * AFTER the review is written) and the `{{planItemVerification}}` variable
 * injected into the publish review PROMPT itself (reviewActions.ts's
 * buildVerifiedChecksVariable, default `heading: "##"`) — the 1c fix. Before
 * this, a failed plan item only ever reached publish-review.md after the AI
 * verdict was already written, so nothing reconciled "❌ failed" against a
 * simultaneous "no blockers" verdict. Feeding the same block into the prompt
 * as an input, with an explicit reconciliation instruction when any item
 * failed, is what closes that gap.
 *
 * @internal exported for testing
 */
export function buildPlanItemVerificationSection(
  planItems: readonly PlanItemVerification[] | undefined,
  options?: { heading?: string }
): string {
  const heading = options?.heading ?? "##";
  if (!planItems || planItems.length === 0) {
    return `${heading} Plan Item Verification\n\nNo plan checklist items were found in plan-final.md (nothing to verify).`;
  }
  const counts = { passed: 0, failed: 0, inconclusive: 0 };
  for (const item of planItems) {
    counts[item.status]++;
  }
  const lines: string[] = [
    `${heading} Plan Item Verification`,
    "",
    `_Deterministic completion check of the plan checklist against the implementation (not a completion gate; AI-assisted verdicts are unavailable in this build — see the per-item notes below): ${counts.passed} passed, ${counts.failed} failed, ${counts.inconclusive} inconclusive._`,
    "",
  ];
  for (const item of planItems) {
    const marker = item.status === "passed" ? "✅ passed" : item.status === "failed" ? "❌ failed" : "❓ inconclusive";
    lines.push(`- ${marker} — ${item.text}${item.note ? ` _(${item.note})_` : ""}`);
  }
  if (counts.failed > 0) {
    lines.push(
      "",
      `**${counts.failed} plan item(s) failed verification.** Address every ❌ item explicitly in your verdict — ` +
        "either as a shipping blocker, or with an explicit recorded reason it is not one. Your verdict must never " +
        "state \"no blockers\" while a failed item here goes unaddressed — a publish verdict must never contradict " +
        "a check embedded in its own artifact."
    );
  }
  return lines.join("\n");
}

/**
 * Render the environment disclosure shared by both surfaces that show
 * Verified Checks (the "Completion Checks" artifact section and the
 * `{{verifiedChecks}}` prompt block) — 1d. Names only, never values, plus the
 * two narrow allowlisted exceptions (cwd, package manager) already redacted
 * upstream in collectCompletionLint. Both of these artifacts land in task
 * folders (frequently committed) and go verbatim into third-party AI
 * prompts, so this must never be able to leak a credential-bearing value —
 * see the CompletionLintResult.verificationEnvironment doc comment.
 */
function renderVerificationEnvironmentLines(
  env: NonNullable<CompletionLintResult["verificationEnvironment"]>
): string[] {
  return [
    `- Resolved cwd: ${env.cwd}`,
    `- Package manager: ${env.packageManager}`,
    `- Environment variable names present (values redacted — names only, so a variable that differs between environments can be spotted without ever disclosing what it holds): ${env.envVarNames.map((name) => `\`${name}\``).join(", ")}`,
  ];
}

/**
 * Render the "which commands actually ran" disclosure (step 21) shared by
 * both Verified Checks surfaces — root commands (conventional/verify/
 * explicit) AND, when the workspace is a monorepo, every per-package
 * command from the recursive pass. Exists so a green/clean result is never
 * read as broader than what was executed: without this, "All checks
 * passed." on a monorepo whose `packages/*` suites were never invoked reads
 * identically to one where they were invoked and passed.
 */
function renderCommandsRunLines(result: CompletionLintResult): string[] {
  const lines: string[] = [];
  if (result.commandsRun && result.commandsRun.length > 0) {
    lines.push("", "### Commands that ran", ...result.commandsRun.map((command) => `- \`${command}\``));
  }
  if (result.monorepoDetected) {
    lines.push("", "### Monorepo packages checked");
    if (!result.monorepoChecks || result.monorepoChecks.length === 0) {
      lines.push(
        "- Monorepo workspace detected (workspaces field or pnpm-workspace.yaml present), " +
          "but the recursive per-package pass ran no commands this time — either explicit " +
          "verification commands were configured (which always win, per the toolchain " +
          "resolution order above) or no member package had a matching lint/check-types/" +
          "test/build script."
      );
    } else {
      for (const check of result.monorepoChecks) {
        const status = check.passed ? "passed" : "**FAILED**";
        const retryNote = check.retryCount ? ` (passed on retry ${check.retryCount})` : "";
        lines.push(`- **${check.packageDir}** — \`${check.command}\`: ${status}${retryNote}`);
      }
    }
  }
  return lines;
}

function renderCompletionChecksSection(
  result: CompletionLintResult,
  override?: { reason: string }
): string {
  // "###", not "##": this section is spliced under the "## Verification
  // (ground truth)" wrapper heading (publishChecksFreshness.ts) and must
  // nest as its child, not read as a sibling top-level section (plan item
  // 17, step 20 — the review flagged the two headings as false siblings).
  const lines: string[] = [PUBLISH_CHECKS_SECTION_START, "### Completion Checks", ""];
  // The headline is derived from passedModuloKnownFlakes, NOT result.passed —
  // its own doc comment states it, not `passed`, is the readiness-relevant
  // verdict shown to reviewers. Falls back to `passed` for an older/mocked
  // result that predates the field (see the "degrades gracefully" test).
  // A run where every failure is a quarantined known flake must read
  // "Passed" here; the quarantined failures stay fully visible in the
  // "Failed checks" section below, each labelled with its flake reason, so
  // nothing is hidden — only the headline stops over-claiming a real failure.
  const effectivePassed = result.passedModuloKnownFlakes ?? result.passed;
  const knownFlakeCount = result.knownFlakeFailures?.length ?? 0;
  const status = effectivePassed
    ? knownFlakeCount > 0
      ? `Passed (${knownFlakeCount} quarantined known flake(s) — see Failed checks below)`
      : "Passed"
    : result.issueCount > 0
      ? "Failed"
      : "Inconclusive (required checks could not run)";
  lines.push(`- Status: ${status}`);
  lines.push(`- Last run: ${result.runAt}`);
  if (result.verifiedFolder) {
    lines.push(`- Verified against: ${result.verifiedFolder}`);
  }
  lines.push(`- Summary: ${result.summary}`);
  if (result.verificationEnvironment) {
    lines.push("", "#### Environment these checks ran in", ...renderVerificationEnvironmentLines(result.verificationEnvironment));
  }
  lines.push(...renderCommandsRunLines(result));
  if (result.missingScripts.length > 0) {
    lines.push("", "#### Inconclusive checks");
    for (const script of result.missingScripts) {
      lines.push(
        `- \`${script}\`: **inconclusive** — no \`${script}\` script is configured in the verified package.json, so this check could not run (an undetected toolchain is never a pass).`
      );
    }
  }
  if (result.failedChecks.length > 0) {
    const knownFlakesForMismatch = getKnownFlakyChecks();
    lines.push("", "#### Failed checks");
    for (const check of result.failedChecks) {
      const flakeReason = resolveQuarantineReasonV1(result, check);
      const output = truncateCheckOutput(check.output, PUBLISH_CHECKS_MAX_OUTPUT_CHARS);
      // Omitted once the failure is a known, quarantined flake: for those the
      // retry count is not diagnostic evidence, it is noise that can actively
      // contradict the recorded flake reason (e.g. "reproduces only in the
      // extension host, a cache-bypassed retry proves nothing" — the retry
      // ran anyway and "failed consistently" then reads as counter-evidence
      // to the very reason quarantining it).
      const retryNote = check.retryCount && !flakeReason ? ` — failed consistently across ${check.retryCount + 1} attempts (${check.retryCount} cache-bypassed retries)` : "";
      const scopeMismatchNote = !flakeReason
        ? describeScopeMismatchAnnotationV1(check, knownFlakesForMismatch)
        : undefined;
      lines.push(
        "",
        `**${check.command}** (exit ${check.exitCode})${retryNote}` +
          `${flakeReason ? ` — _known flake: ${flakeReason}_` : ""}` +
          `${scopeMismatchNote ? ` — _${scopeMismatchNote}_` : ""}`,
        "```",
        output,
        "```"
      );
    }
  }
  if (result.retriedPasses && result.retriedPasses.length > 0) {
    lines.push("", "#### Checks that required a retry to pass");
    for (const retried of result.retriedPasses) {
      lines.push(
        `- \`${retried.command}\`: failed on the first attempt, passed on retry ${retried.retryCount} (cache disabled) — flaky, not clean.`
      );
    }
  }
  if (result.planItems && result.planItems.length > 0) {
    lines.push("", buildPlanItemVerificationSection(result.planItems, { heading: "####" }));
  }
  if (override) {
    lines.push("", `_Published anyway despite failing checks — ${override.reason}._`);
  }
  lines.push(PUBLISH_CHECKS_SECTION_END);
  return lines.join("\n");
}

/** Cap per-failed-check output embedded in an AI prompt — generous enough to
 * diagnose a failure, far short of flooding the reviewer's context with a
 * full CI log. */
const VERIFIED_CHECKS_PROMPT_MAX_OUTPUT_CHARS = 1500;

/**
 * Render the `{{verifiedChecks}}` block injected into impl-high, impl-low,
 * and publish review prompts (see reviewActions.ts). This is the fix for
 * the actual failure mode that motivated it: a reviewer with no way to
 * confirm "all tests pass" either had to trust the implementer's prose or
 * try to run the suite itself — and when its own sandbox couldn't run
 * anything (e.g. a read-only review environment), it had no way to ever
 * mark that criterion satisfied, capping the score indefinitely regardless
 * of the actual state of the code.
 *
 * These results are produced by the extension host via `collectCompletionLint`
 * (a real `child_process.spawn` of the project's own lint/type-check/test
 * commands), not generated or claimed by any AI — the block says so
 * explicitly so the reviewer treats it as ground truth rather than another
 * claim to be skeptical of.
 */
export function buildVerifiedChecksSection(
  result: CompletionLintResult,
  reviewedCommitSha?: string
): string {
  const lines: string[] = [
    "## Verified Checks (ground truth)",
    "",
    "These results were produced by the extension host actually running the project's " +
      "lint/type-check/test commands — they are not generated, claimed, or verifiable-only-by-you. " +
      "Treat them as ground truth. Do not lower the score, and do not raise a review-confidence " +
      "blocker, merely because you cannot independently reproduce a test run yourself.",
    "",
  ];
  const knownFlakeFailures = result.knownFlakeFailures ?? [];
  // Deliberately derived only from what this function actually lists below
  // (failedChecks / knownFlakeFailures / missingScripts) — NOT from
  // result.passed/result.issueCount, which also fold in live editor
  // diagnostics (vscode.languages.getDiagnostics()) that can come from any
  // open tab, unrelated to this review and to any command this block claims
  // to have run. Using those here previously let an unrelated open file
  // produce "Overall: One or more checks failed." immediately followed by
  // "No command failures." with nothing named — an unfalsifiable failure
  // signal, exactly what this block exists to eliminate.
  //
  // Filtered via the per-check `quarantine` stamp (isQuarantinedCheckV1),
  // not by cross-referencing `knownFlakeFailures` by command/exitCode — the
  // stamp is the single quarantine decision every consumer reads, so this
  // list can never disagree with synthesizeMechanicalBlockers's.
  const unquarantinedFailures = result.failedChecks.filter((check) => !isQuarantinedCheckV1(result, check));
  const retriedPasses = result.retriedPasses ?? [];
  const overall = unquarantinedFailures.length > 0
    ? "One or more checks failed."
    : result.missingScripts.length > 0
      ? "Required checks could not run (inconclusive)."
      : knownFlakeFailures.length > 0
        ? "All checks passed except quarantined known flakes (see below) — treat as passing for readiness purposes."
        : retriedPasses.length > 0
          ? "All checks passed, but only after a retry (see below) — not clean on the first attempt."
          : "All checks passed.";
  lines.push(`- Overall: ${overall}`);
  lines.push(`- Last run: ${result.runAt}`);
  if (result.verifiedFolder) {
    lines.push(`- Verified against: ${result.verifiedFolder}`);
  }
  // Workflow-robustness Part 6 item 6: these checks ran against the
  // filesystem (the working tree) at check time, never a checkout of the
  // `<!-- reviewed-commit: SHA -->` marker this same prompt asks you to
  // record — the two can disagree (a later commit, or uncommitted edits,
  // since this run) and previously nothing said so, so a review artifact
  // could name a passing commit while quoting a failure that was never in
  // it (or vice versa). Recorded explicitly rather than silently mixing the
  // two identities.
  if (reviewedCommitSha) {
    lines.push(
      `- These results describe the current WORKING TREE at check time, not a git checkout of the ` +
        `reviewed commit (${reviewedCommitSha}) recorded below — if the tree changed since that commit ` +
        "(a later commit, or uncommitted edits), the two can disagree. Both identities are recorded so they " +
        "can be compared rather than conflated."
    );
  }
  if (result.missingScripts.length > 0) {
    lines.push(`- Not configured (inconclusive, not passed): ${result.missingScripts.join(", ")}`);
  }
  // Rendered unconditionally (not gated behind the "no command failures"
  // early return below) — the environment disclosure is useful evidence
  // whether or not anything failed; see the field doc comment on
  // CompletionLintResult.verificationEnvironment for why this exists.
  if (result.verificationEnvironment) {
    lines.push("", "### Environment these checks ran in", ...renderVerificationEnvironmentLines(result.verificationEnvironment));
  }
  // Rendered unconditionally for the same reason as the environment block
  // above — which commands ran is evidence a reviewer needs whether or not
  // anything failed, so "All checks passed." can never be misread as
  // broader coverage than what actually executed (step 21).
  lines.push(...renderCommandsRunLines(result));
  // Rendered even when failedChecks is empty — a check that failed on its
  // first attempt and only passed on a cache-bypassed retry has NO entry in
  // failedChecks (its final exit code was 0), so this must not sit behind
  // the "no command failures" early return below or it silently disappears
  // exactly where the backlog says it must stay visible.
  if (retriedPasses.length > 0) {
    lines.push("", "### Checks that required a retry to pass");
    for (const retried of retriedPasses) {
      lines.push(
        `- **${retried.command}** — failed on the first attempt, passed on retry ${retried.retryCount} ` +
          "with the build cache disabled. Flaky, not clean — do not treat as a fully clean run."
      );
    }
  }
  if (result.failedChecks.length === 0) {
    lines.push("", "No command failures.");
    return lines.join("\n");
  }
  lines.push("", "### Command results");
  const knownFlakesForMismatch = getKnownFlakyChecks();
  for (const check of result.failedChecks) {
    const flakeReason = resolveQuarantineReasonV1(result, check);
    if (flakeReason) {
      // No retry-count note here (see the sibling omission in
      // renderCompletionChecksSection above) — for a quarantined flake the
      // retry count is not diagnostic evidence, and can read as
      // counter-evidence to the recorded flake reason.
      lines.push(
        "",
        `- **${check.command}** — exit ${check.exitCode}, **quarantined known flake**: ${flakeReason}. ` +
          "This failure is excluded from the overall verdict above — do not treat it as an outstanding blocker."
      );
      continue;
    }
    const retryNote = check.retryCount
      ? ` (failed consistently across ${check.retryCount + 1} attempts, ${check.retryCount} with the cache disabled)`
      : "";
    const scopeMismatchNote = describeScopeMismatchAnnotationV1(check, knownFlakesForMismatch);
    const output = truncateCheckOutput(check.output, VERIFIED_CHECKS_PROMPT_MAX_OUTPUT_CHARS);
    lines.push(
      "",
      `- **${check.command}** — exit ${check.exitCode} (FAILED)${retryNote}` +
        `${scopeMismatchNote ? ` — _${scopeMismatchNote}_` : ""}`,
      "```",
      output,
      "```"
    );
  }
  return lines.join("\n");
}

/**
 * Turn failed Verified Checks directly into blockers, bypassing the model
 * entirely for facts the extension host already holds firsthand. See
 * reviewReadiness.ts's `BLOCKER_LINE_RE` doc comment for the incident this
 * exists to make impossible: a since-retired `verify:workflow-production-sources`
 * check had already failed with a non-zero exit code before any reviewer saw it, and
 * the round trip through the reviewer's prose (describe the failure, format
 * it as a blocker line) is exactly where the blocker was lost. A
 * deterministic check that fails now files its own blocker directly,
 * independent of whether the reviewer's free-text summary of it happens to
 * parse.
 *
 * Quarantined known-flake failures are excluded via the same
 * {@link isQuarantinedCheckV1} stamp `buildVerifiedChecksSection` and
 * `renderCompletionChecksSection` read — a quarantined flake must not
 * synthesize a blocker any more than it counts toward `passed`, and it can
 * never disagree with those renderers about which failures are quarantined
 * (wf10 continuation item 12: a review that reported zero blockers
 * previously still had three mechanical `task-fixable` blockers land in
 * `reviewScoreHistory` because a monorepo-scoped failure quarantined for
 * DISPLAY was not recognized as quarantined here).
 *
 * category/resolver are fixed at "completion"/"task-fixable": a failing repo
 * check is, by construction, something an implementation round can address
 * (fix what the command reports, then it passes), the same bucket a human
 * reviewer would file it under. `origin: "mechanical"` distinguishes this
 * from a blocker a reviewer actually raised in prose, in the durable record
 * (`ReviewBlockerIdentity.origin`).
 *
 * 1.0.0 gate, Part 4 / Step 14 (B4), review finding 2026-09-06: the
 * description used to carry only the command and exit code — "which file,
 * which assertion, and the provider's own output" were on `check.output` all
 * along but never made it into the blocker text itself, so every downstream
 * consumer that only has `ReviewBlocker.description` to work with (the
 * escalation cards in reviewEscalation.ts) could not show them no matter how
 * the card was built. A short, bounded excerpt of the check's own output
 * (the file/assertion/failure detail a reader actually needs) is appended
 * here so the evidence travels with the blocker instead of being dropped at
 * the point of synthesis.
 */
const MECHANICAL_BLOCKER_OUTPUT_EXCERPT_MAX_CHARS = 400;

export function synthesizeMechanicalBlockers(result: CompletionLintResult): ReviewBlocker[] {
  const unquarantinedFailures = result.failedChecks.filter((check) => !isQuarantinedCheckV1(result, check));
  return unquarantinedFailures.map((check) => {
    const excerpt = truncateCheckOutput(
      check.output.trim(),
      MECHANICAL_BLOCKER_OUTPUT_EXCERPT_MAX_CHARS
    ).trim();
    const evidenceSuffix = excerpt.length > 0 ? ` — output:\n\`\`\`\n${excerpt}\n\`\`\`` : "";
    return {
      category: "completion",
      resolver: "task-fixable",
      description:
        `\`${check.command}\` failed (exit ${check.exitCode}) — generated mechanically from Verified Checks${evidenceSuffix}`,
      origin: "mechanical",
    };
  });
}

/**
 * Merge a rendered "Completion Checks" section into whatever publish-review.md
 * content already exists, replacing a previous run of the managed section in
 * place so the AI-authored publish-readiness review (generated separately by
 * the review-publish.md prompt) around it is preserved.
 *
 * @internal exported for testing
 */
export function mergeCompletionChecksSection(existing: string, section: string): string {
  const startIdx = existing.indexOf(PUBLISH_CHECKS_SECTION_START);
  const endIdx = existing.indexOf(PUBLISH_CHECKS_SECTION_END);
  return startIdx !== -1 && endIdx !== -1 && endIdx > startIdx
    ? existing.slice(0, startIdx) + section + existing.slice(endIdx + PUBLISH_CHECKS_SECTION_END.length)
    : existing.trim().length > 0
      ? `${existing.trimEnd()}\n\n${section}\n`
      : `${section}\n`;
}

/**
 * Extract this module's managed Completion Checks section (markers included)
 * from existing `publish-review.md` content, if present. Used by
 * `reviewRowV1.ts`'s `promoteReviewContentV1` to re-inject the section after
 * an AI review write, which replaces the whole file — ground truth must
 * survive a reviewer's prose the same way it survives a `runCompletionLint`
 * refresh.
 *
 * @internal exported for testing and reuse by reviewRowV1.ts
 */
export function extractCompletionChecksSectionV1(content: string): string | undefined {
  const startIdx = content.indexOf(PUBLISH_CHECKS_SECTION_START);
  const endIdx = content.indexOf(PUBLISH_CHECKS_SECTION_END);
  if (startIdx === -1 || endIdx === -1 || endIdx < startIdx) {
    return undefined;
  }
  return content.slice(startIdx, endIdx + PUBLISH_CHECKS_SECTION_END.length);
}

/**
 * Upsert a "Completion Checks" section into `publish-review.md` — the single
 * Publish-stage artifact (plan item 17, step 20; see the module doc comment
 * on `publishChecksFreshness.ts`'s `publishChecksPath` for why this used to
 * be a separate `publish-checks.md`). Every completion lint run at the
 * Publish stage calls this, so both the "check" and "fix" paths keep this
 * artifact current. Uses plain `node:fs` (like `readPackageScripts` above)
 * rather than `vscode.workspace.fs` — this is always a plain file on disk
 * inside the task folder, never a virtual FS scheme, so there's nothing the
 * VS Code FS abstraction adds here.
 */
export async function upsertCompletionChecksReportV1(
  taskFolderUri: vscode.Uri,
  result: CompletionLintResult,
  override?: { reason: string }
): Promise<void> {
  const targetPath = path.join(taskFolderUri.fsPath, STAGE_ARTIFACT_FILENAMES.publish ?? PUBLISH_CHECKS_FILENAME);

  // Single locked read-modify-write: merging the section and invalidating
  // any freshness stamp happen against the same in-memory snapshot and land
  // in one atomic write, so a concurrent reader of publish-review.md can
  // never observe this section updated with a stamp that still looks
  // current (or a half-written file). See withPublishChecksReportLockV1's
  // doc comment for why this is a per-report lock rather than nesting calls
  // that would each try to acquire it.
  await withPublishChecksReportLockV1(taskFolderUri, async () => {
    let existing = "";
    try {
      existing = await fs.promises.readFile(targetPath, "utf8");
    } catch {
      existing = "";
    }
    // One-time bounded import (step 20(c)): pulls in a legacy
    // publish-checks.md's sections when this file doesn't have its own yet,
    // so a task that upgraded mid-Publish doesn't lose its most recent
    // Scope Check (or other section this call doesn't itself produce).
    existing = await importLegacyPublishChecksIfAbsentV1(taskFolderUri, existing);
    existing = ensureVerificationHeadingV1(existing);
    // 1.0.0 gate C1: the top-of-file status line must track what actually
    // happened, not stay frozen at "Not yet reviewed" underneath passing
    // results. A no-op once a real AI review has landed — see
    // mergePublishStatusLineSection's doc comment.
    existing = mergePublishStatusLineSection(existing, computePublishStatusLineTextV1(result));

    const section = renderCompletionChecksSection(result, override);
    const merged = mergeCompletionChecksSection(existing, section);
    // A refresh of only this section (e.g. runLintingFixes re-running the
    // lint alone) must not leave a previous freshness stamp looking current
    // — the stamp asserts both this section AND the Scope Check ran together
    // against one commit. runPublishChecks.ts (the only path that runs both)
    // writes a fresh valid stamp itself after both complete; every other
    // path invalidates here and leaves the report correctly stale until
    // Publish Checks runs again.
    await writeFileAtomicV1(targetPath, invalidatePublishChecksFreshnessStamp(merged));
  });
}

/**
 * Compute the completion lint result (verification commands + AI-verified
 * plan items) without persisting anything to task-progress.json or
 * publish-review.md. This is the side-effect-free half of
 * `runCompletionLint`, used by `checkPublishPreflight` (publishPreflight.ts)
 * for scheduling decisions — "should we schedule auto-publish?" — that must
 * not mutate task state merely by asking the question.
 *
 * By default (`allowScopePrompt: true`), a stale persisted Publish scope
 * still prompts the user to (re-)pick one via `promptAndPersistPublishScope`
 * and persists that choice — this is what `runCompletionLint` (the
 * execution-time, `persist: true` path) uses, where a blocking prompt and a
 * scope write are expected as part of actually running a Publish attempt.
 * Pass `allowScopePrompt: false` for pure scheduling decisions (the default
 * `checkPublishPreflight` path): a stale scope there is reported as a
 * structured failure instead of opening a QuickPick or writing
 * `publishScopePath`, so deciding *whether* to schedule `auto-publish` never
 * shows UI or mutates task state on its own.
 */
export async function collectCompletionLintPreview(
  folderUri: vscode.Uri,
  relevantFiles?: readonly string[],
  options?: {
    allowScopePrompt?: boolean;
    /**
     * Skip the AI-assisted plan-item verification pass (a real model call,
     * separate from and in addition to the deterministic lint/type/test
     * commands). Defaults to true (run it) to preserve existing behavior
     * for callers that show `planItems` to the user (checkPublishPreflight,
     * runCompletionLint). Pass false for callers that only use the
     * deterministic command results and never render `planItems` — e.g.
     * the `{{verifiedChecks}}` block injected into impl-high/impl-low/
     * publish review prompts, which would otherwise fire a full extra AI
     * call (using the Publish-stage model, regardless of which stage is
     * actually being reviewed) on every single review round for output
     * that section never displays.
     */
    includeAiPlanVerification?: boolean;
    /** See CollectCompletionLintOptions.token — forwarded to the underlying
     * collectCompletionLint call so cancelling the enclosing operation kills
     * any still-running check process. */
    token?: vscode.CancellationToken;
    /** See CollectCompletionLintOptions.timeoutMs. */
    timeoutMs?: number;
    /** See CollectCompletionLintOptions.onCheckEvent — forwarded unchanged. */
    onCheckEvent?: CollectCompletionLintOptions["onCheckEvent"];
  }
): Promise<CompletionLintResult> {
  const allowScopePrompt = options?.allowScopePrompt ?? true;
  const includeAiPlanVerification = options?.includeAiPlanVerification ?? true;
  // Verify against the task's Publish scope (persisted per task; defaults to
  // the workspace folder containing the task), never just the task folder.
  const readResult = await readTaskProgressStrictV1(folderUri);
  const progress = readResult.ok ? readResult.decoded.progress : undefined;
  const scope = resolvePublishScopeFolder(folderUri, progress);
  let scopeFolder = scope.folder;
  if (scope.stale) {
    // No valid scope resolved: either the persisted scope no longer exists
    // on disk, or the task's recorded project binding has vanished (which
    // also invalidates any relative persisted scope — it has no base left).
    // Silently verifying the fallback folder instead would report results
    // for the wrong project (or for task metadata), so re-prompt for a
    // valid scope (when allowed) — cancelling, having no project root left
    // to offer, or being disallowed from prompting at all aborts the check
    // outright. No command may run in the metadata folder or in a
    // workspace that merely contains it.
    const savedScope = progress?.publishScopePath?.trim();
    const bindingRoot = progress?.ownership?.projectRoot?.trim();
    const bindingVanished = !!bindingRoot && !isExistingDirectory(bindingRoot);
    const staleReason = !bindingVanished && savedScope
      ? `The saved Publish verification scope ("${savedScope}") no longer exists. ` +
        "Choose a valid scope to run the Publish checks against."
      : "No valid Publish verification scope could be resolved for this task — " +
        "its recorded project-root binding no longer exists. Choose a valid " +
        "scope to run the Publish checks against.";
    if (!allowScopePrompt) {
      throw new Error(staleReason);
    }
    const repicked = await promptAndPersistPublishScope(folderUri, {
      title: bindingVanished
        ? "The task's project-root binding no longer exists — choose a Publish verification scope"
        : "The saved Publish verification scope no longer exists — choose a new one",
      currentRelPath: progress?.publishScopePath,
    });
    if (!repicked) {
      throw new Error(staleReason);
    }
    scopeFolder = repicked;
  }
  const result = await collectCompletionLint(scopeFolder, relevantFiles, {
    explicitCommands: getPublishVerificationCommands(),
    token: options?.token,
    timeoutMs: options?.timeoutMs,
    onCheckEvent: options?.onCheckEvent,
  });
  result.verifiedFolder = scopeFolder;
  if (includeAiPlanVerification) {
    // Plan-item completion is AI-verified against the same scope the
    // lint/test checks ran in — a checked box in plan-final.md alone
    // never passes.
    result.planItems = collectAiVerifiedPlanItems(folderUri, scopeFolder);
  }
  return result;
}

/**
 * Compute the completion lint result and persist it into task-progress.json
 * and publish-review.md's managed Completion Checks section. This is the
 * only entry point that writes lint state to disk — call it when a Publish
 * attempt is actually executing (commitAndPushTask's pre-commit checks),
 * never merely to decide whether to schedule one. Scheduling decisions
 * should use `collectCompletionLintPreview` instead (see
 * `checkPublishPreflight` in publishPreflight.ts).
 */
export async function runCompletionLint(folderUri: vscode.Uri, relevantFiles?: readonly string[]): Promise<CompletionLintResult> {
  const result = await collectCompletionLintPreview(folderUri, relevantFiles, { allowScopePrompt: true });
  const persisted = await patchTaskProgressStrictV1(folderUri, (current) => updateLintPayload(current, {
    runAt: result.runAt,
    passed: result.passed,
    summary: result.summary,
    issueCount: result.issueCount,
    failedChecks: result.failedChecks,
    source: "publish",
  }));
  if (!persisted) {
    throw new Error("Could not persist completion lint result.");
  }
  // Every runCompletionLint call site gates on the task already being at (or
  // advancing into) the Publish stage, so it's always safe to keep
  // publish-review.md's checks section current here rather than at each of
  // the eight call sites individually.
  await upsertCompletionChecksReportV1(folderUri, result);
  return result;
}
