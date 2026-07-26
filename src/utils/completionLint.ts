import * as vscode from "vscode";
import { spawn, execSync, execFileSync } from "child_process";
import * as crypto from "crypto";
import { patchTaskProgress, readTaskProgress, updateLintPayload } from "./taskProgressUtils";
import * as fs from "fs";
import * as path from "path";
import { STAGE_ARTIFACT_FILENAMES, TaskProgress } from "../types/taskProgress";
import { getCompletionCheckTimeoutMs, getKnownFlakyChecks, getPublishVerificationCommands, KnownFlakyCheck } from "../config/settings";
import { promptAndPersistPublishScope } from "../commands/choosePublishScope";
import { resolveModelForStage } from "./modelSelection";
import { resolveRunnerForModel } from "../runners/runnerRegistry";

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

export interface CompletionLintResult {
  runAt: string;
  passed: boolean;
  summary: string;
  issueCount: number;
  failedChecks: Array<{ command: string; exitCode: number; output: string }>;
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
  /** `scripts` entries (from the conventional `lint`/`test` names) not found
   * in the workspace `package.json`, and therefore skipped rather than run.
   * Reported as `inconclusive` — an undetected toolchain is never a pass. */
  missingScripts: string[];
  /** AI-verified plan-item completion check (report section, not a gate):
   * `passed` only ever comes from AI evidence against the source, never from
   * a checked checkbox alone. */
  planItems?: PlanItemVerification[];
  /** The folder lint/tests actually ran against (the Publish scope). */
  verifiedFolder?: string;
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

const DEFERRED_MARKERS = /\b(deferred|out[ -]of[ -]scope|won'?t (?:do|fix)|skipped)\b/i;

/**
 * Deterministic baseline over the plan-final.md checklist. A checkbox alone
 * is never evidence of implementation, so nothing here produces `passed`:
 * an item marked deferred/out-of-scope is `failed` (deferring is not
 * completing); everything else — checked or not — is `inconclusive` until
 * the AI-assisted verification (below) inspects the actual source and
 * upgrades or contradicts it.
 */
export function verifyPlanItems(planContent: string): PlanItemVerification[] {
  const items: PlanItemVerification[] = [];
  for (const line of planContent.split(/\r?\n/)) {
    const match = /^\s*[-*]\s*\[([ xX])\]\s+(.*\S)\s*$/.exec(line);
    if (!match) {
      continue;
    }
    const checked = match[1]?.toLowerCase() === "x";
    const text = match[2] ?? "";
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

/** Deferred items keep their deterministic failure; everything else records
 * why the AI pass could not corroborate it. */
function markAiVerificationUnavailable(
  items: readonly PlanItemVerification[],
  reason: string
): PlanItemVerification[] {
  return items.map((item) =>
    item.status === "failed"
      ? { ...item }
      : { ...item, note: appendNote(item.note, `AI verification unavailable: ${reason}`) }
  );
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

const PLAN_VERIFICATION_MAX_PLAN_CHARS = 20_000;

function buildPlanVerificationPrompt(
  items: readonly PlanItemVerification[],
  planContent: string,
  scopeFolder: string
): string {
  const numbered = items
    .map((item, index) => `${index + 1}. ${item.text}`)
    .join("\n");
  const plan =
    planContent.length > PLAN_VERIFICATION_MAX_PLAN_CHARS
      ? `${planContent.slice(0, PLAN_VERIFICATION_MAX_PLAN_CHARS)}\n… (truncated)`
      : planContent;
  return [
    "You are verifying whether a development task's plan items were actually implemented in the codebase.",
    "",
    `Verification scope (project folder): ${scopeFolder}`,
    "",
    "Inspect the repository READ-ONLY — do not create, modify, or delete any file. For every numbered plan item below decide:",
    '- "passed": you found concrete evidence in the source code that the item is implemented.',
    '- "failed": the item is not implemented, only partially implemented, or was deferred/descoped.',
    '- "inconclusive": the code does not let you determine it either way.',
    "",
    "A checked checkbox in the plan is NOT evidence — verify against the actual source files.",
    "",
    "Plan items:",
    numbered,
    "",
    "Full plan for context:",
    "",
    plan,
    "",
    "Respond with ONLY a fenced json code block containing an array with exactly one object per numbered item:",
    "```json",
    '[',
    '  { "item": 1, "status": "passed", "note": "one-sentence evidence naming the file/function" }',
    ']',
    "```",
  ].join("\n");
}

interface PlanVerificationCacheEntry {
  /** Scope + plan content — a changed plan or scope invalidates the entry. */
  contentKey: string;
  at: number;
  items: PlanItemVerification[];
}

/** One AI verification per task per plan revision within this window — the
 * publish fix loop re-runs runCompletionLint several times back-to-back and
 * must not spend an AI call (and minutes of latency) on each pass. */
const PLAN_VERIFICATION_CACHE_TTL_MS = 5 * 60 * 1000;
const planVerificationCache = new Map<string, PlanVerificationCacheEntry>();

/** @internal exported for testing */
export function clearPlanVerificationCache(): void {
  planVerificationCache.clear();
}

async function runAiPlanVerification(
  taskFolderUri: vscode.Uri,
  scopeFolder: string,
  baseline: readonly PlanItemVerification[],
  planContent: string
): Promise<PlanItemVerification[]> {
  const model = await resolveModelForStage(taskFolderUri, "publish");
  if (!model.modelId) {
    return markAiVerificationUnavailable(
      baseline,
      "no AI model is configured for the Publish stage"
    );
  }

  let resolved: ReturnType<typeof resolveRunnerForModel>;
  try {
    resolved = resolveRunnerForModel(model.modelId, "publish", taskFolderUri);
  } catch (error) {
    return markAiVerificationUnavailable(
      baseline,
      error instanceof Error ? error.message : String(error)
    );
  }

  const availability = await resolved.runner.isAvailable();
  if (!availability.available) {
    return markAiVerificationUnavailable(
      baseline,
      availability.reason ?? `${resolved.providerLabel} is unavailable`
    );
  }

  const prompt = buildPlanVerificationPrompt(baseline, planContent, scopeFolder);
  const outputFile = vscode.Uri.file(
    path.join(taskFolderUri.fsPath, `.plan-verification.${crypto.randomUUID()}.tmp.md`)
  );
  const tokenSource = new vscode.CancellationTokenSource();
  try {
    const result = await resolved.runner.run(
      {
        taskFolderUri,
        workspaceUri: vscode.Uri.file(scopeFolder),
        stage: "publish",
        prompt,
        outputFile,
        modelId: resolved.nativeModelId,
      },
      tokenSource.token
    );
    if (result.status !== "completed") {
      return markAiVerificationUnavailable(
        baseline,
        result.errorMessage ??
          `the ${resolved.providerLabel} verification run did not complete`
      );
    }
    let output = "";
    try {
      output = new TextDecoder().decode(await vscode.workspace.fs.readFile(outputFile));
    } catch {
      // Missing/unreadable output file → treated as an empty response below.
    }
    const verdicts = parseAiPlanVerdicts(output, baseline.length);
    if (verdicts.size === 0) {
      return markAiVerificationUnavailable(
        baseline,
        "the AI response contained no parseable per-item verdicts"
      );
    }
    return mergeAiPlanVerdicts(baseline, verdicts);
  } finally {
    tokenSource.dispose();
    try {
      await vscode.workspace.fs.delete(outputFile);
    } catch {
      // Already absent (run failed before writing) — nothing to clean up.
    }
  }
}

/**
 * The full Publish plan-item verification: deterministic checklist baseline,
 * then the AI-assisted pass against the verification scope, with per-task
 * caching keyed on the plan content so back-to-back Publish checks don't
 * repeat the AI call. Absent/empty plan → undefined (no section rendered).
 */
export async function collectAiVerifiedPlanItems(
  taskFolderUri: vscode.Uri,
  scopeFolder: string
): Promise<PlanItemVerification[] | undefined> {
  let planContent: string;
  try {
    planContent = fs.readFileSync(
      path.join(taskFolderUri.fsPath, "plan-final.md"),
      "utf8"
    );
  } catch {
    return undefined;
  }
  const baseline = verifyPlanItems(planContent);
  if (baseline.length === 0) {
    return undefined;
  }

  const cacheKey = taskFolderUri.fsPath;
  const contentKey = `${scopeFolder}\n${planContent}`;
  const cached = planVerificationCache.get(cacheKey);
  if (
    cached &&
    cached.contentKey === contentKey &&
    Date.now() - cached.at < PLAN_VERIFICATION_CACHE_TTL_MS
  ) {
    return cached.items.map((item) => ({ ...item }));
  }

  let items: PlanItemVerification[];
  try {
    items = await runAiPlanVerification(taskFolderUri, scopeFolder, baseline, planContent);
  } catch (error) {
    items = markAiVerificationUnavailable(
      baseline,
      error instanceof Error ? error.message : String(error)
    );
  }
  planVerificationCache.set(cacheKey, { contentKey, at: Date.now(), items });
  return items.map((item) => ({ ...item }));
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
 */
function killProcessTree(child: ReturnType<typeof spawn>): void {
  if (process.platform === "win32" && child.pid) {
    const pid = child.pid;
    const attemptKill = (): void => {
      try {
        execFileSync("taskkill", ["/PID", String(pid), "/T", "/F"], { stdio: "ignore", windowsHide: true });
      } catch {
        // Already exited, or taskkill itself failed — a later retry (or,
        // worst case, the caller's own timeoutMs bound) is the fallback.
      }
    };
    attemptKill();
    for (const delayMs of [300, 1000, 2500, 5000, 9000, 15000, 22000, 30000]) {
      setTimeout(attemptKill, delayMs);
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

function runCheck(
  cwd: string,
  args: string[],
  guard?: RunGuardOptions
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
      { cwd, shell: useShell }
    );
    attachRunGuards(child, guard, resolve);
  });
}

function packageManager(folder: string): string {
  if (fs.existsSync(path.join(folder, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(folder, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(folder, "bun.lockb")) || fs.existsSync(path.join(folder, "bun.lock"))) return "bun";
  return "npm";
}

/** Run one user-authored verification command line through the shell. */
function runExplicitCheck(
  cwd: string,
  command: string,
  guard?: RunGuardOptions
): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    attachRunGuards(child, guard, resolve);
  });
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

  let checks: Array<{ command: string; code: number; output: string }>;
  if (explicitCommands.length > 0) {
    // Toolchain resolution order (publish pre-check contract): explicitly
    // configured verification commands win over conventional npm scripts.
    checks = await Promise.all(
      explicitCommands.map(async (command) => ({ command, ...(await runExplicitCheck(folder, command, guard)) }))
    );
  } else {
    const scripts = readPackageScripts(folder);
    const candidateChecks: Array<readonly [string, string[]]> = [
      [`${manager} run lint`, [manager, "run", "lint"]],
      [`${manager} run check-types`, [manager, "run", "check-types"]],
      [`${manager} run test`, [manager, "run", "test"]],
    ];

    // The conventional `lint`/`test` scripts (publish pre-check contract) are
    // skipped rather than run when not present in package.json's `scripts`, so
    // an unconfigured workspace gets clean setup guidance instead of every
    // publish check being misreported as a failure. `check-types` predates
    // that contract and keeps its existing unconditional-run behavior.
    const runnableChecks = candidateChecks.filter(([, args]) => {
      const scriptName = args[2];
      if (scriptName !== "lint" && scriptName !== "test") return true;
      const configured = !!scripts && Object.prototype.hasOwnProperty.call(scripts, scriptName);
      if (!configured) missingScripts.push(scriptName);
      return configured;
    });

    checks = await Promise.all(
      runnableChecks.map(async ([command, args]) => ({ command, ...(await runCheck(folder, [...args], guard)) }))
    );
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
  const issueCount = issues.length + commandFailures.length;
  const baseSummary = commandFailures.length > 0
    ? `${commandFailures.length} completion check(s) failed${issues.length ? `; ${issues.length} editor diagnostic(s) remain` : "."}`
    : issues.length === 0 ? "No linting issues found." : `${issues.length} lint issue(s) remain.`;
  const summary = missingScripts.length > 0
    ? `${baseSummary} (${missingScripts.join("/")} script(s) not configured — add them to package.json's ` +
      `"scripts" to enable publish checks for them. Checks are inconclusive, not passed.)`
    : baseSummary;
  const knownFlakes = getKnownFlakyChecks();
  const knownFlakeFailures = classifyKnownFlakeFailures(commandFailures, knownFlakes);
  const unquarantinedFailureCount = commandFailures.length - knownFlakeFailures.length;
  return {
    runAt: new Date().toISOString(),
    // An undetected toolchain is never a pass: with a required check
    // inconclusive (missing lint/test script), the run cannot report passed
    // even when everything that could run came back clean.
    passed: issueCount === 0 && missingScripts.length === 0,
    passedModuloKnownFlakes:
      issues.length === 0 && unquarantinedFailureCount === 0 && missingScripts.length === 0,
    issueCount,
    summary,
    failedChecks: commandFailures.map(({ command, code, output }) => ({ command, exitCode: code, output })),
    knownFlakeFailures,
    missingScripts,
  };
}

/**
 * Match failed checks against the known-flaky-check allowlist. A failure is
 * quarantined only when BOTH `match` (against the command line) and
 * `failureSignature` (against the combined output) are found — deliberately
 * narrow so the allowlist can't accidentally swallow an unrelated real
 * failure that happens to share a command name.
 *
 * @internal exported for testing
 */
export function classifyKnownFlakeFailures(
  failures: readonly { command: string; code: number; output: string }[],
  knownFlakes: readonly KnownFlakyCheck[]
): Array<{ command: string; exitCode: number; reason: string }> {
  const quarantined: Array<{ command: string; exitCode: number; reason: string }> = [];
  for (const failure of failures) {
    const flake = knownFlakes.find(
      (entry) => failure.command.includes(entry.match) && failure.output.includes(entry.failureSignature)
    );
    if (flake) {
      quarantined.push({ command: failure.command, exitCode: failure.code, reason: flake.reason });
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

function renderCompletionChecksSection(
  result: CompletionLintResult,
  override?: { reason: string }
): string {
  const lines: string[] = [PUBLISH_CHECKS_SECTION_START, "## Completion Checks", ""];
  const status = result.passed
    ? "Passed"
    : result.issueCount > 0
      ? "Failed"
      : "Inconclusive (required checks could not run)";
  lines.push(`- Status: ${status}`);
  lines.push(`- Last run: ${result.runAt}`);
  if (result.verifiedFolder) {
    lines.push(`- Verified against: ${result.verifiedFolder}`);
  }
  lines.push(`- Summary: ${result.summary}`);
  if (result.missingScripts.length > 0) {
    lines.push("", "### Inconclusive checks");
    for (const script of result.missingScripts) {
      lines.push(
        `- \`${script}\`: **inconclusive** — no \`${script}\` script is configured in the verified package.json, so this check could not run (an undetected toolchain is never a pass).`
      );
    }
  }
  if (result.failedChecks.length > 0) {
    lines.push("", "### Failed checks");
    for (const check of result.failedChecks) {
      const flake = (result.knownFlakeFailures ?? []).find((f) => f.command === check.command && f.exitCode === check.exitCode);
      const output = truncateCheckOutput(check.output, PUBLISH_CHECKS_MAX_OUTPUT_CHARS);
      lines.push(
        "",
        `**${check.command}** (exit ${check.exitCode})${flake ? ` — _known flake: ${flake.reason}_` : ""}`,
        "```",
        output,
        "```"
      );
    }
  }
  if (result.planItems && result.planItems.length > 0) {
    const counts = { passed: 0, failed: 0, inconclusive: 0 };
    for (const item of result.planItems) {
      counts[item.status]++;
    }
    lines.push(
      "",
      "### Plan Item Verification",
      "",
      `_AI-assisted completion check of the plan checklist against the implementation (not a completion gate): ${counts.passed} passed, ${counts.failed} failed, ${counts.inconclusive} inconclusive._`,
      ""
    );
    for (const item of result.planItems) {
      const marker = item.status === "passed" ? "✅ passed" : item.status === "failed" ? "❌ failed" : "❓ inconclusive";
      lines.push(`- ${marker} — ${item.text}${item.note ? ` _(${item.note})_` : ""}`);
    }
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
export function buildVerifiedChecksSection(result: CompletionLintResult): string {
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
  const unquarantinedFailures = result.failedChecks.filter(
    (check) => !knownFlakeFailures.some((f) => f.command === check.command && f.exitCode === check.exitCode)
  );
  const overall = unquarantinedFailures.length > 0
    ? "One or more checks failed."
    : result.missingScripts.length > 0
      ? "Required checks could not run (inconclusive)."
      : knownFlakeFailures.length > 0
        ? "All checks passed except quarantined known flakes (see below) — treat as passing for readiness purposes."
        : "All checks passed.";
  lines.push(`- Overall: ${overall}`);
  lines.push(`- Last run: ${result.runAt}`);
  if (result.verifiedFolder) {
    lines.push(`- Verified against: ${result.verifiedFolder}`);
  }
  if (result.missingScripts.length > 0) {
    lines.push(`- Not configured (inconclusive, not passed): ${result.missingScripts.join(", ")}`);
  }
  if (result.failedChecks.length === 0) {
    lines.push("", "No command failures.");
    return lines.join("\n");
  }
  lines.push("", "### Command results");
  for (const check of result.failedChecks) {
    const flake = knownFlakeFailures.find(
      (f) => f.command === check.command && f.exitCode === check.exitCode
    );
    if (flake) {
      lines.push(
        "",
        `- **${check.command}** — exit ${check.exitCode}, **quarantined known flake**: ${flake.reason}. ` +
          "This failure is excluded from the overall verdict above — do not treat it as an outstanding blocker."
      );
      continue;
    }
    const output = truncateCheckOutput(check.output, VERIFIED_CHECKS_PROMPT_MAX_OUTPUT_CHARS);
    lines.push("", `- **${check.command}** — exit ${check.exitCode} (FAILED)`, "```", output, "```");
  }
  return lines.join("\n");
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
 * Upsert a "Completion Checks" section into publish-review.md. Every
 * completion lint run at the Publish stage calls this, so both the "check"
 * and "fix" paths keep this artifact current. Uses plain `node:fs` (like
 * `readPackageScripts` above) rather than `vscode.workspace.fs` — this is
 * always a plain file on disk inside the task folder, never a virtual FS
 * scheme, so there's nothing the VS Code FS abstraction adds here.
 */
export async function upsertCompletionChecksInPublishReview(
  taskFolderUri: vscode.Uri,
  result: CompletionLintResult,
  override?: { reason: string }
): Promise<void> {
  const filename = STAGE_ARTIFACT_FILENAMES.publish;
  if (!filename) {
    return;
  }
  const targetPath = path.join(taskFolderUri.fsPath, filename);

  let existing = "";
  try {
    existing = await fs.promises.readFile(targetPath, "utf8");
  } catch {
    existing = "";
  }

  const section = renderCompletionChecksSection(result, override);
  await fs.promises.writeFile(targetPath, mergeCompletionChecksSection(existing, section), "utf8");
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
  }
): Promise<CompletionLintResult> {
  const allowScopePrompt = options?.allowScopePrompt ?? true;
  const includeAiPlanVerification = options?.includeAiPlanVerification ?? true;
  // Verify against the task's Publish scope (persisted per task; defaults to
  // the workspace folder containing the task), never just the task folder.
  const progress = await readTaskProgress(folderUri);
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
  });
  result.verifiedFolder = scopeFolder;
  if (includeAiPlanVerification) {
    // Plan-item completion is AI-verified against the same scope the
    // lint/test checks ran in — a checked box in plan-final.md alone
    // never passes.
    result.planItems = await collectAiVerifiedPlanItems(folderUri, scopeFolder);
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
  const persisted = await patchTaskProgress(folderUri, (current) => updateLintPayload(current, {
    runAt: result.runAt,
    passed: result.passed,
    summary: result.summary,
    issueCount: result.issueCount,
    failedChecks: result.failedChecks,
  }));
  if (!persisted) {
    throw new Error("Could not persist completion lint result.");
  }
  // Every runCompletionLint call site gates on the task already being at (or
  // advancing into) the Publish stage, so it's always safe to keep
  // publish-review.md's checks section current here rather than at each of
  // the eight call sites individually.
  await upsertCompletionChecksInPublishReview(folderUri, result);
  return result;
}
