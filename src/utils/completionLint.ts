import * as vscode from "vscode";
import { spawn, execSync, execFileSync } from "child_process";
import * as crypto from "crypto";
import { patchTaskProgress, readTaskProgress, updateLintPayload } from "./taskProgressUtils";
import * as fs from "fs";
import * as path from "path";
import { STAGE_ARTIFACT_FILENAMES, TaskProgress } from "../types/taskProgress";
import { getPublishVerificationCommands } from "../config/settings";
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

/**
 * Resolve the folder the Publish stage verifies (lint/tests) against: the
 * task's persisted, workspace-folder-relative `publishScopePath` when set
 * and still present on disk; otherwise the workspace folder containing the
 * task. A persisted path that no longer exists is reported `stale` so
 * interactive callers can re-prompt (see choosePublishScope.ts).
 */
export function resolvePublishScopeFolder(
  taskFolderUri: vscode.Uri,
  progress: Pick<TaskProgress, "publishScopePath"> | undefined
): { folder: string; stale: boolean } {
  const workspaceFolder = vscode.workspace.getWorkspaceFolder(taskFolderUri);
  const defaultFolder = workspaceFolder?.uri.fsPath ?? taskFolderUri.fsPath;
  const persisted = progress?.publishScopePath?.trim();
  if (!persisted) {
    return { folder: defaultFolder, stale: false };
  }
  const absolute = path.isAbsolute(persisted)
    ? persisted
    : path.join(defaultFolder, persisted);
  try {
    if (fs.statSync(absolute).isDirectory()) {
      return { folder: absolute, stale: false };
    }
  } catch {
    // Fall through: the persisted path no longer exists.
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

function runCheck(cwd: string, args: string[]): Promise<{ code: number; output: string }> {
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
    let output = "";
    child.stdout?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.stderr?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
  });
}

function packageManager(folder: string): string {
  if (fs.existsSync(path.join(folder, "pnpm-lock.yaml"))) return "pnpm";
  if (fs.existsSync(path.join(folder, "yarn.lock"))) return "yarn";
  if (fs.existsSync(path.join(folder, "bun.lockb")) || fs.existsSync(path.join(folder, "bun.lock"))) return "bun";
  return "npm";
}

/** Run one user-authored verification command line through the shell. */
function runExplicitCheck(cwd: string, command: string): Promise<{ code: number; output: string }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true });
    let output = "";
    child.stdout?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.stderr?.on("data", (data: Buffer | string) => { output += typeof data === "string" ? data : data.toString("utf8"); });
    child.on("error", (error) => resolve({ code: 1, output: error.message }));
    child.on("close", (code) => resolve({ code: code ?? 1, output }));
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

  let checks: Array<{ command: string; code: number; output: string }>;
  if (explicitCommands.length > 0) {
    // Toolchain resolution order (publish pre-check contract): explicitly
    // configured verification commands win over conventional npm scripts.
    checks = await Promise.all(
      explicitCommands.map(async (command) => ({ command, ...(await runExplicitCheck(folder, command)) }))
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
      runnableChecks.map(async ([command, args]) => ({ command, ...(await runCheck(folder, [...args])) }))
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
  return {
    runAt: new Date().toISOString(),
    // An undetected toolchain is never a pass: with a required check
    // inconclusive (missing lint/test script), the run cannot report passed
    // even when everything that could run came back clean.
    passed: issueCount === 0 && missingScripts.length === 0,
    issueCount,
    summary,
    failedChecks: commandFailures.map(({ command, code, output }) => ({ command, exitCode: code, output })),
    missingScripts,
  };
}

const PUBLISH_CHECKS_SECTION_START = "<!-- completion-checks:start -->";
const PUBLISH_CHECKS_SECTION_END = "<!-- completion-checks:end -->";
/** Cap per-failed-check output embedded in publish-review.md — this is a
 * human-facing artifact, not an AI prompt, so it only needs enough of the
 * output to identify the failure, not the full log. */
const PUBLISH_CHECKS_MAX_OUTPUT_CHARS = 4000;

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
      const output = check.output.length > PUBLISH_CHECKS_MAX_OUTPUT_CHARS
        ? `${check.output.slice(0, PUBLISH_CHECKS_MAX_OUTPUT_CHARS)}\n… (truncated)`
        : check.output;
      lines.push("", `**${check.command}** (exit ${check.exitCode})`, "```", output, "```");
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

/** Persist the latest completion lint result without changing the task stage. */
export async function runCompletionLint(folderUri: vscode.Uri, relevantFiles?: readonly string[]): Promise<CompletionLintResult> {
  // Verify against the task's Publish scope (persisted per task; defaults to
  // the workspace folder containing the task), never just the task folder.
  const progress = await readTaskProgress(folderUri);
  const scope = resolvePublishScopeFolder(folderUri, progress);
  let scopeFolder = scope.folder;
  if (scope.stale) {
    // The persisted scope no longer exists on disk. Silently verifying the
    // workspace root instead would report results for the wrong project, so
    // re-prompt for a valid scope; cancelling aborts the check outright.
    const repicked = await promptAndPersistPublishScope(folderUri, {
      title: "The saved Publish verification scope no longer exists — choose a new one",
      currentRelPath: progress?.publishScopePath,
    });
    if (!repicked) {
      throw new Error(
        `The saved Publish verification scope ("${progress?.publishScopePath ?? ""}") no longer exists. ` +
          "Choose a valid scope to run the Publish checks against."
      );
    }
    scopeFolder = repicked;
  }
  const result = await collectCompletionLint(scopeFolder, relevantFiles, {
    explicitCommands: getPublishVerificationCommands(),
  });
  result.verifiedFolder = scopeFolder;
  // Plan-item completion is AI-verified against the same scope the lint/test
  // checks ran in — a checked box in plan-final.md alone never passes.
  result.planItems = await collectAiVerifiedPlanItems(folderUri, scopeFolder);
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
