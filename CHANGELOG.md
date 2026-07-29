# Changelog

All notable changes to Ensemble (formerly VS Code AI Helper) are documented here.

## [Unreleased] — Add opencode CLI provider

### Added

- **opencode CLI provider (`opencode-cli`)** — a new optional vendor CLI provider, off by default like the others. Text-mode (plan/review) runs use `opencode run --agent plan`, whose permission set denies `edit` on workspace files generally, with a narrower exception for its own `.opencode/plans/*.md` — see the caveat in the Fixed section below on what was and wasn't verified about that exception; implementation runs use `opencode run --agent build`. The prompt is sent via stdin, and the final answer is extracted from the CLI's `--format json` event stream (a JSON-lines transcript, not a single response — see `extractOpencodeFinalOutput` in `cliAgentRunner.ts`). Sign-in is `opencode providers login`, run in a terminal like Codex/Gemini. Model IDs use opencode's own `<upstream-provider>/<model>` namespacing (e.g. `openai/gpt-4o`) and are discovered live via `opencode models --verbose`, which also expands each model's own reasoning-effort variants (e.g. `openai/gpt-5@high`, `opencode/deepseek-v4-flash@max`) into separate selectable entries — opencode has no single shared reasoning-effort ladder the way Codex does, so the valid variant set is read per-model from the CLI rather than hardcoded. Documented in README.md, DISCLAIMER.md, and SECURITY.md alongside the existing providers.
- **Windows CLI model discovery via npm shims** — `runCliModelDiscovery` (used by Antigravity, Kiro, and now opencode) now spawns with `shell: true` on Windows. It previously used `execFile` with no shell, which cannot launch a `.cmd` shim directly (only `.exe`); this silently failed for any npm-globally-installed CLI on Windows and returned an empty model list with no error surfaced. agy and kiro-cli happened to never hit this because both install as native `.exe` binaries — opencode's `opencode.cmd` shim was the first to expose it.
- **Hardcoded opencode model catalog** — `SEEDED_CLI_MODELS["opencode-cli"]` in `modelSelection.ts` carries a compacted raw-text snapshot of `opencode models --verbose` (every model across every upstream provider, plus their `@variant` entries — ~466 entries once expanded) run through the same `parseOpencodeModelsOutput` live discovery uses, rather than a separately hand-maintained expanded array — the two can never structurally diverge. This pre-populates the model picker instantly at extension activation the same way Claude/Codex/Antigravity/Kiro's seeds already do — the picker never blocks on (or depends on) a live `opencode` CLI call; live discovery only refreshes the cache in the background afterward. Regenerate by piping a fresh `opencode models --verbose` through the same id/providerID/name/variants compaction when the catalog changes.
- **opencode "Go" tier models (`opencode-go/*`)** — the live opencode catalog gained a cheaper "Zen Go" model tier under its own `opencode-go` provider ID (distinct pricing/endpoint, same underlying models — e.g. `opencode-go/deepseek-v4-flash`) after this integration's initial seed capture; a `github-copilot` tier also appeared. No code changes were needed for either — `parseOpencodeModelsOutput`/live discovery already read whatever `providerID` the CLI reports generically, and end-to-end execution with an `opencode-go/...@variant` model ID was verified live. The seed was regenerated (now ~572 entries) to include both new tiers so they show up instantly without waiting on a live discovery refresh.

### Fixed (found in review)

- **Antigravity implementation runs repeatedly stopped after useful edits with `Error: timeout waiting for response`** — `agy --print` defaults to a five-minute response timeout, while Ensemble's CLI runner allows an hour, so the provider repeatedly terminated healthy long-running work before the extension's own cap. Antigravity now receives `--print-timeout=55m0s`. If that exact provider timeout still occurs, Ensemble makes up to two bounded retries with `--continue` and a continuation prompt, preserving the expected Antigravity conversation and the edits it already made instead of replaying the original task. The resumable failure deliberately remains `generic`, so a partially edited tree is never handed to a different backup provider. Because agy currently scopes `--continue` to the globally most recent conversation, this is best-effort if another agy process starts during the retry window.
- **Claude Code CLI headless text-mode runs (plan/review/desc) could return a stub note instead of real content** — `--permission-mode plan` repurposes Claude Code's interactive plan-approval mode for a one-shot headless call, but the model still carries its default system prompt's instructions to call `ExitPlanMode` (present the plan for approval) and `AskUserQuestion` (ask clarifying questions); neither tool is offered under `-p` since both need an interactive UI. Reproduced live (claude 2.1.216, `claude -p --permission-mode plan`, no extra flags): the model notices the mismatch, writes its real answer to a scratch file under `~/.claude/plans/` instead of the requested output, and returns only a short "wrote the plan to X — note, those tools aren't available" pointer as its actual response text — which is exactly what this extension captures as the stage's result (e.g. `plan.md`), so the task file ends up with that stub note instead of the plan/review/description content. `buildArgs` now also passes `--append-system-prompt` (new `CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT` in `providers.ts`) telling the model plainly that this is a non-interactive run, those two tools don't exist here, and its complete answer — including any open questions inline — belongs directly in the response text, not in a file. Re-verified live with the flag added: the model stops reaching for those tools and returns the full content directly.
- **opencode: a silent-but-successful run could surface as a false failure, or leak raw JSON as its answer** — `extractOpencodeFinalOutput` (`cliAgentRunner.ts`) previously returned the CLI's entire raw `--format json` transcript whenever no `"text"`-typed event was present. Reproduced live: a build-mode run instructed to act silently (no confirmation text) can legitimately exit 0 having only emitted tool-call events — that raw JSON dump was non-empty, so it slipped past the generic "produced no output" failure guard and got reported as the plan/review artifact or implementation summary. Now returns a clear placeholder ("opencode completed the run without returning any text reply") for that case instead, distinct from a genuinely empty/unparseable result (which still fails as before).
- **opencode model discovery could orphan the CLI process on a hung/slow call** — `runCliModelDiscovery` used `cp.execFile`'s built-in `timeout`, which on Windows (with the `shell: true` fix below) only terminates the interposed `cmd.exe`; the actual CLI process is a grandchild and was left running. Reproduced directly (a `cmd.exe`-wrapped `ping` survived `execFile`'s timeout firing). Rewritten to use `cp.spawn` with a manual timeout and the same `killProcessTree` (`taskkill /T` on Windows) tree-kill the run path already uses — now shared between both via a new `src/utils/cliProcessUtils.ts`, which also fixes discovery spawning with unsanitized `process.env` instead of the `sanitizedCliEnv()` filtering the run path uses (previously latent, since discovery never actually spawned an npm-shim CLI like opencode's on Windows before the `shell: true` fix).
- **opencode's `--verbose` parser only recognized opencode's own pretty-printed JSON shape** — `parseOpencodeVerboseModels` required a block's opening `{` to be alone on its own line, so a compact/minified single-line JSON object (as used by the seeded catalog's raw text, above) silently failed to parse and fell through to a much weaker line-based fallback. Fixed to detect the opening brace anywhere in a line.
- **opencode `--variant` values from a malformed `variants` field could produce bogus picker entries** — `parseOpencodeModelsOutput` now validates that a model's `variants` field is a plain object before iterating its keys; a non-object value (e.g. an array) previously produced meaningless numeric-index entries like `@0`/`@1` via `Object.keys()`.
- **SECURITY.md's opencode plan-mode claim softened to match what was actually verified** — the read-only claim for `--agent plan` didn't account for its permission set carrying a narrower `edit` allow rule for `.opencode/plans/*.md`; direct testing (three different models, including with `--auto`) showed the model always refuses to attempt that write at the prompt level, but did not conclusively prove the underlying permission grant is unreachable. Both the code comment and SECURITY.md now describe this as verified-for-ordinary-files rather than an unconditional guarantee. The CHANGELOG's own "Added" entry above is now consistent with this caveat instead of repeating the un-caveated claim.
- **opencode's `--verbose` parser counted braces inside JSON string values** — `parseOpencodeVerboseModels` counted every `{`/`}` character toward block depth unconditionally, including ones inside a model's `name`/description string. Reproduced directly against opencode's real pretty-printed shape: a model named containing a literal `}` character made depth hit zero mid-object, fed `JSON.parse` a truncated buffer, and silently dropped that model with no error (a stray `{` is worse — it can merge two blocks together and corrupt both). Rewritten as a proper string-aware scan (honoring `\"` escapes) that ignores braces encountered inside a string literal, scanning the whole text rather than per-line.
- **opencode model discovery could hang on the full timeout if the CLI wrote a lot to stderr** — the `cp.execFile`→`cp.spawn` rewrite (above) attached a `data` listener only to `child.stdout`; `child.stderr` was piped but never read. On both Windows and POSIX, once a child writes more than the OS pipe buffer (tens of KB) to an unread stream, its `write()` blocks forever — reproduced directly with a real child process. `stderr` is now drained (content discarded, not used by any caller today) so this can't happen.
- **Duplicated "split model ID on last `@`" scaffold across four providers** — `parseCodexModelSelection`, `parseCopilotModelSelection`, `parseClaudeCliModelSelection`, and `parseOpencodeModelSelection` each reimplemented the same split-and-guard mechanics inline. Extracted into a shared `splitModelAtLastAt` helper in `providers.ts`; each function keeps its own distinct suffix validation (Codex/Copilot/Claude check against a fixed known set, opencode passes the suffix through verbatim since each model declares its own variant set).

### Test coverage added (found in review)

- `securityDocsFlagConsistency.test.ts` now checks SECURITY.md's text-mode permission claims against `buildArgs`, not just README.md's.
- `modelSelection.test.ts`'s opencode "discovery adds to the seed" test was tautological (it primed the cache with the exact result it then asserted); replaced with a direct test of the actual merge-decision function (`resolveRefreshedCliModels`) plus a corrected test of what `getAvailableModels()` itself does (read the cache as-is, no merging).
- `cliModelDiscovery.test.ts`'s discovery tests mocked `cp.execFile`, which the rewrite to `cp.spawn` made dead code providing zero regression coverage for the actual Windows `shell: true` fix; rewritten to mock `spawn` and assert on the `shell` option directly, plus new tests proving a hung discovery call gets tree-killed, stderr is drained, and braces inside string values (including escaped quotes) don't corrupt block detection.

## [Unreleased] — Packaging fix: task run logs no longer shipped in the extension

### Fixed

- **`.vscodeignore`** — Task meta folders are excluded from the published package again. Version 0.53.0 renamed the meta folder from `plans/` to `.ensemble/` and updated `.gitignore`, but not `.vscodeignore`. Because `vsce` ignores `.gitignore` entirely whenever a `.vscodeignore` file exists, that rename silently removed the exclusion, and versions 0.53.0 through 0.56.1 packaged the author's local `.ensemble/` task folders — task run logs, which contain AI prompts and context packs. The package dropped from 1,927 files to 120. Both the current and legacy meta-folder names are now excluded, along with development-only material (`notes/`, `docs/`, `test-stubs/`, `dist/test/`).

### Added

- **`scripts/verify-package-contents.js`** — Publish guard that runs `vsce ls` and fails if the package would contain task meta folders, author notes, test sources, or more files than an explicit ceiling. Folder names are parsed from `DEFAULT_TASK_ROOT` and the legacy roots in `src/utils/taskRoot.ts` rather than duplicated, so renaming a task root trips the guard instead of bypassing it; the check also fails if those constants cannot be found, rather than assuming there is nothing to exclude. Wired into `scripts/release.ps1` between the build and the publish step.

### Changed

- **`README.md`** — Added a **Requirements** section. The minimum setup is VS Code and GitHub Copilot, which needs no additional install and is enabled by default; all CLI providers are optional and opt-in, with install commands and account requirements listed per provider.

## [Unreleased] — Task lifecycle and automation safety

### Changed

- New tasks are created paused and no longer interrupt the task currently in progress.
- Settings now use the `ensemble.*` namespace; existing `vs-code-ai-helper.*` values are copied once and remain available as deprecated compatibility keys.
- Auto Advance no longer starts implementation unless **Ensemble: Automatically implement after review** is explicitly enabled and acknowledged. This setting can make real workspace changes and requires continuous human supervision.

## [Unreleased] — Safety Round 2: Consent Gate, Data Minimization & Commit Scoping

### Added

- **`src/legal/disclaimerVersion.ts`** — Single canonical source for `DISCLAIMER_VERSION = 1`. The consent storage key (`aiHelper.consent.v1`) is derived from this value; bumping it re-prompts users. A unit test should assert this matches the `Version:` line in `DISCLAIMER.md`.
- **`src/utils/aiConsent.ts`** — `ensureAiConsent(context)` helper: shows a modal on first use per workspace per version summarising token cost risk, file-edit risk, and data transmission, with a "View Disclaimer" button. Consent is stored in `workspaceState` as a structured record `{ acceptedAt, version }`. Returns `true` when consent is already given or just given; `false` when the user declines (callers abort the AI action immediately).
- **`src/utils/contextEligibility.ts`** — Canonical constants (`CONTEXT_PER_FILE_MAX_BYTES = 100_000`, `CONTEXT_MAX_FILES = 20`, `CONTEXT_TOTAL_MAX_BYTES = 400_000`, `CONTEXT_CONFIRM_THRESHOLD_BYTES = 150_000`, `PROMPT_TOTAL_MAX_BYTES = 600_000`) and the secret-filename denylist (`isDenylisted`). Consumed by `contextPack.ts` so rules are expressed once.
- **`src/commands/commitAndPushTask.ts`** — "Ensemble: Commit Preview" output channel (lazily-created singleton). `renderPath` helper uses JSON-string-escaping for lossless display of filenames containing spaces, quotes, backslashes, and newlines. "View Full List" button in the confirm dialog opens the channel with the full parsed file list including skipped-artifact markers, then returns (user re-invokes to proceed). Default staging scope is now **task folder only** (not entire repo). Run artifacts (`runs/`, `context-pack.md`) are **excluded from the default staged set** and marked `(run artifact — contains AI prompts)` in the preview. Detached-HEAD and multiple-remotes/no-remote states now abort with a clear message before any dialog. `saveDirtyDocuments` scoped to match the staging scope.

### Changed

- **`src/commands/draftTaskWithAI.ts`** — Added `ensureAiConsent` gate (workspace-folder guard → consent → task resolution). Progress title now includes `(uses your <provider> quota)`. Accepts `vscode.ExtensionContext` parameter to pass to consent helper.
- **`src/commands/generatePlanWithAI.ts`** — Added `ensureAiConsent` gate (workspace-folder guard → consent → task folder selection). Accepts `vscode.ExtensionContext` parameter.
- **`src/commands/reviewActions.ts`** — Added `ensureAiConsent` gate to `runReviewWithAI`, `applyReviewWithAI`, `generateImplementationWithAI`, and `runImplementationWithAI`. Internal auto-triggered review calls (`nextStage` → `runReviewForFolder`, post-run auto-review) bypass the consent gate since consent was already obtained by the triggering user action. All AI entry-point functions now accept `vscode.ExtensionContext`.
- **`src/utils/contextPack.ts`** — Replaced `isInsideWorkspace` lexical-only check with full eligibility check: `file:` scheme required; `untitled:` always excluded; realpath containment for existing files; symlink-escape detection; secret-filename denylist applied to both link basename and resolved-target basename. Caps raised from 8 KB/60 KB to 100 KB/400 KB (from `contextEligibility.ts`). `CONTEXT_MAX_FILES = 20` enforced. Document retention order: active editor → visible editors → rest. Deduplication by URI. Exclusion count reported in context pack header.
- **`src/extension.ts`** — All AI commands that now require `context` receive it. Comments updated to note the consent gate. No other changes.

### Removed

- **`vs-code-ai-helper-0.0.5.vsix`** — Tracked VSIX binary removed from the repository. `*.vsix` is already in `.gitignore` and `.vscodeignore`.

### Security findings addressed (code)

| Finding | Severity | Disposition | This round |
|---|---|---|---|
| No first-use consent for AI features | High | **Fixed** | `ensureAiConsent` wired to all AI entry points |
| Open editor contents sent to AI — no denylist or realpath check | High | **Fixed** | `isDenylisted` + realpath containment in `contextPack.ts` |
| `commitAndPushTask` stages entire repo with no scope limit | Critical | **Partially fixed** | Default scope now task-folder-only; run artifacts excluded; "View Full List" added |
| `commitAndPushTask` no file list in confirm dialog | High | Fixed (prior round) | Confirm dialog with file list was added in round 1 |
| `commitAndPushTask` auto-rolls back local commits | High | Fixed (prior round) | Rollback removed; user given manual undo instructions |
| Untitled buffers and out-of-workspace editors in context packs | High | **Fixed** | Eligibility filter excludes untitled:, out-of-workspace, virtual schemes |

---

## [Unreleased — Round 1] — Safety, Consent & Legal Disclosure Audit

### Added

- **`DISCLAIMER.md`** — New canonical full-text disclaimer covering: as-is / no warranty, token and API cost risk, file modification and push risk, data transmission to AI providers, run-log persistence of prompt content, and user supervision requirements.
- **`SECURITY.md`** — New security policy documenting enforcement boundaries, network activity attribution, and known accepted risks.
- **`CHANGELOG.md`** — This file. Establishes a change history starting with this safety audit release.
- **README disclaimer section** — Prominent `⚠️ Disclaimer & Terms of Use` section added before Quick Start.
- **`package.json` description** — Updated to include as-is / subscription-cost / see-README warning.
- **`vs-code-ai-helper.viewDisclaimer` command** — Opens packaged `DISCLAIMER.md` in markdown preview. Registered in `extension.ts` and contributed in `package.json`.
- **Edit-mode guardrails** (`reviewActions.ts`) — Non-git workspace shows modal warning before implementation runs; git workspace with dirty state shows non-modal warning recommending commit first.
- **Quota warnings in progress titles** — "with AI" progress notifications now include `(uses your <provider> quota)` in the title.
- **Commit confirm dialog** — `commitAndPushTask` shows file list and push destination before staging.
- **No automatic rollback** — Push failure no longer automatically runs `git reset --mixed HEAD~1`; user is told how to undo manually.

### Changed

- README restructured to place the disclaimer section prominently before Quick Start.

---

## Previous Versions

Changes prior to this safety audit release were not tracked in a changelog. See the git history for the full record.
