# Changelog

All notable changes to VS Code AI Helper are documented here.

## [Unreleased] — Safety Round 2: Consent Gate, Data Minimization & Commit Scoping

### Added

- **`src/legal/disclaimerVersion.ts`** — Single canonical source for `DISCLAIMER_VERSION = 1`. The consent storage key (`aiHelper.consent.v1`) is derived from this value; bumping it re-prompts users. A unit test should assert this matches the `Version:` line in `DISCLAIMER.md`.
- **`src/utils/aiConsent.ts`** — `ensureAiConsent(context)` helper: shows a modal on first use per workspace per version summarising token cost risk, file-edit risk, and data transmission, with a "View Disclaimer" button. Consent is stored in `workspaceState` as a structured record `{ acceptedAt, version }`. Returns `true` when consent is already given or just given; `false` when the user declines (callers abort the AI action immediately).
- **`src/utils/contextEligibility.ts`** — Canonical constants (`CONTEXT_PER_FILE_MAX_BYTES = 100_000`, `CONTEXT_MAX_FILES = 20`, `CONTEXT_TOTAL_MAX_BYTES = 400_000`, `CONTEXT_CONFIRM_THRESHOLD_BYTES = 150_000`, `PROMPT_TOTAL_MAX_BYTES = 600_000`) and the secret-filename denylist (`isDenylisted`). Consumed by `contextPack.ts` so rules are expressed once.
- **`src/commands/commitAndPushTask.ts`** — "AI Helper: Commit Preview" output channel (lazily-created singleton). `renderPath` helper uses JSON-string-escaping for lossless display of filenames containing spaces, quotes, backslashes, and newlines. "View Full List" button in the confirm dialog opens the channel with the full parsed file list including skipped-artifact markers, then returns (user re-invokes to proceed). Default staging scope is now **task folder only** (not entire repo). Run artifacts (`runs/`, `context-pack.md`) are **excluded from the default staged set** and marked `(run artifact — contains AI prompts)` in the preview. Detached-HEAD and multiple-remotes/no-remote states now abort with a clear message before any dialog. `saveDirtyDocuments` scoped to match the staging scope.

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
