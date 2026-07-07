# Security Policy

## Overview

VS Code AI Helper is a personal developer tool that orchestrates AI providers (GitHub Copilot, Claude, Codex, Gemini) to assist with task planning and implementation. This document describes what the extension enforces, what it does not enforce, and how to report vulnerabilities.

---

## Supported Versions

Only the latest published version receives security fixes. Because this is a personal open-source tool, older versions are not back-patched.

## Reporting a Vulnerability

If you discover a security issue, please open a GitHub issue on the repository or contact the maintainer directly via the repository's contact information. Do not include exploit details in a public issue — describe the class of issue and request a private channel if needed.

We aim to respond within a reasonable timeframe for a personal open-source project (days to weeks, not guaranteed SLAs).

---

## What the Extension Does and Does Not Enforce

### First-use consent

A modal consent dialog is shown on the first use of any AI feature in a workspace. The dialog summarises: token/quota cost risk, file-edit risk, and data-transmission risk. Consent is stored per workspace per disclaimer version in VS Code `workspaceState`. Bumping the `DISCLAIMER_VERSION` constant in `src/legal/disclaimerVersion.ts` automatically re-prompts users.

This is an in-process software control — it does not prevent a user who has console access from calling commands directly.

### File-system access

**Copilot implementation runs (VS Code Language Model API):**

- The model is given four tools: `read_file`, `write_file`, `list_files`, `delete_file`.
- Every tool call validates the requested path against the workspace root using `sanitizeRelativePath` and a resolved-path boundary check, including symlink/junction detection.
- Paths that resolve outside the workspace are rejected with an error returned to the model.
- This is an **internal software boundary**, not an OS-level sandbox.

**CLI implementation runs (Claude, Codex, Gemini):**

- The CLI process runs with the workspace as its working directory.
- Access is limited by the vendor's own permission flags: Claude `--permission-mode acceptEdits`, Codex `--sandbox workspace-write`, Gemini `--approval-mode auto_edit`.
- These flags are the **vendor CLIs' own enforcement** — the extension does not add an additional sandbox layer on top.
- The model can still read, create, modify, and delete files anywhere within the workspace.

### Context sent to AI providers

Eligibility rules for open editors included in provider-bound context packs:

- Only `file:` scheme documents are eligible; `untitled:`, notebook cells, virtual schemes, and diff editors are excluded.
- Documents must belong to a workspace folder (lexical containment check).
- For documents whose path exists on disk, `realpath` containment against the workspace root is performed; symlink/junction escapes that resolve outside the workspace are excluded.
- A best-effort basename denylist excludes files matching common secret-file naming conventions: `.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`, `.npmrc`, `.netrc`, `credentials.json`, `credentials`, `*.keystore`, `*.jks`, `.htpasswd`, `*.tfstate`. **This is a courtesy filter, not secret detection.** A secret in a file with an innocuous name is not caught.
- A file count cap (`CONTEXT_MAX_FILES = 20`) and per-file / total byte caps are enforced.
- Out-of-workspace editors are excluded by default.
- Run logs (in `runs/`) contain the full prompt, including any file contents included in the context pack.

### Network activity

- The extension itself contains no HTTP client code.
- Network activity occurs through:
  - VS Code's Language Model API (for Copilot), which manages authentication and transmission internally.
  - Vendor CLI processes (`claude`, `codex`, `gemini`) spawned as child processes; their network behaviour is governed by the vendor CLIs.
  - Git, spawned as a child process for the commit-and-push command.
- The extension does not make direct outbound HTTP/HTTPS calls.

### Git operations

- The `Commit and Push Task` command stages and pushes to a remote repository.
- There is a preview-confirm dialog before staging, showing files and push destination.
- By default, **only the task folder's changes are staged**; a separate opt-in includes all repository changes.
- Run artifacts (`runs/`, `context-pack.md`) are excluded from the default staged set and shown with an explicit warning marker if opted into include-all mode.
- Detached HEAD and ambiguous remote states abort before any dialog.
- Push failure keeps the local commit; no automatic `git reset` is performed.
- The extension uses `git` from PATH — it does not bundle git or verify the git binary's integrity.

### Extension state storage

- Consent records (timestamp, version) are stored in VS Code workspace state (`workspaceState`).
- Model preferences are stored in VS Code workspace configuration.
- No file contents or prompt text are stored in VS Code's own storage APIs.

### Temp files

- Some CLI runs (Codex) write a temporary last-message file to `os.tmpdir()`.
- Deletion is best-effort only; the file may persist if cleanup fails.
- On POSIX, the temp directory is created with mode `0700`.

---

## Known Limitations and Accepted Risks

- AI implementation runs can modify or delete **any file inside the workspace**, not just files related to the current task. This is by design — the AI needs broad access to implement code changes.
- The secret-filename denylist catches well-known naming conventions only. A secret pasted into an arbitrarily-named file is not caught.
- CLI sandbox flags (Claude `acceptEdits`, Codex `workspace-write`, Gemini `auto_edit`) do not prevent the model from issuing shell commands that the CLI itself approves; behaviour depends on the vendor CLI's own policy.
- There is no token-spending ceiling or cost estimate. Users are responsible for their own provider costs.
- Run logs in `runs/` contain full prompt content. If pushed to a remote repository, that content becomes remotely accessible.
- The git binary on PATH is trusted implicitly. Ensure your environment's PATH is not compromised.
- The consent gate is a per-workspace software control. It does not prevent misuse by someone with direct access to the VS Code command palette who dismisses or bypasses the modal.

---

## Out of Scope

The following are not considered security vulnerabilities for this project:

- Costs incurred from normal use of AI providers.
- Files modified or deleted by AI implementation runs during normal operation.
- Data transmitted to AI providers as part of normal prompt assembly.
- CLI vendor behaviour beyond the extension's control.

---

*This policy reflects the extension as of the version that introduced it. See `CHANGELOG.md` for the history of security-related changes.*
