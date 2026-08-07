# Disclaimer & Terms of Use

**Version: 2**

> **Read this before using any AI-powered feature of this extension.**
> This document is the single canonical source of the extension's disclaimer.
> It is also packaged inside the extension and accessible via the Command Palette
> (`Ensemble: View Disclaimer`) so you can review it inside VS Code at any time.

---

## 1. Provided As-Is — No Warranty

This extension is **open-source software provided "as is", without warranty of any kind**, express or implied, including but not limited to warranties of merchantability, fitness for a particular purpose, and non-infringement.

To the maximum extent permitted by applicable law, the authors and contributors shall not be liable for any claim, damages, or other liability — whether in an action of contract, tort, or otherwise — arising from, out of, or in connection with the software or the use or other dealings in the software.

The MIT License governs the legal terms. This disclaimer supplements that license with plain-language risk disclosures.

*This document is informational only. It is not legal advice and does not create any legal obligation on anyone. The extension's authors are not lawyers, and this disclaimer has not been reviewed by qualified legal counsel. If you have legal questions about using this extension, consult a qualified legal professional.*

---

## 2. You Are Responsible — Use It Supervised

**This extension is a personal developer tool, not production or compliance software.** It is intended to be used by developers who:

- Have read and understood the source code (or at least this disclaimer).
- Actively supervise every AI action before, during, and after it runs.
- Verify results before committing, pushing, or relying on them.

**Never use this extension unsupervised.** The extension can:

- Send your file contents to third-party AI providers.
- Let an AI model edit or delete files in your workspace.
- Stage and push changes to a remote git repository.

If any of that is not acceptable in your context (corporate policy, client agreements, confidentiality requirements, regulated environments), **do not use this extension** until you have evaluated whether it is appropriate.

---

## 3. Token, Quota, and API Cost Risk

Every "with AI" command consumes quota or usage from the AI subscription you have configured:

| Provider | Billing mechanism |
|---|---|
| GitHub Copilot | Your active Copilot subscription (Individual, Business, or Enterprise) |
| Claude (Anthropic) | Your Anthropic Pro/Max subscription or API credits |
| OpenAI Codex | Your ChatGPT Plus/Pro subscription or OpenAI API credits |
| Gemini CLI | Your Google account Gemini subscription or API quota |
| Antigravity CLI | Your Google account Gemini/Antigravity subscription or API quota |
| Kiro CLI | Your Kiro subscription, plus a `KIRO_API_KEY` for headless use |
| opencode | Whichever model provider(s) you sign into through `opencode providers login` (or configure via that provider's API key env var) — opencode itself does not bill you directly |
| Cline CLI | Your ClinePass subscription ($9.99/mo) |
| Kimi Code CLI | Your Moonshot AI / Kimi Code account subscription or API quota |
| devpass-code | Your LLM Gateway DevPass credential |

**Real money or subscription usage is consumed every time an AI command runs.**

- A single implementation run can run for up to 30 minutes.
- There is no built-in token estimate or cost ceiling.
- Repeated runs (e.g. regenerating a plan or re-running an implementation) multiply usage.
- Running AI commands on large workspaces with many open editors increases prompt size and therefore cost.

**The extension authors accept zero liability for any token, quota, subscription, or API costs you incur.**

Review your provider's pricing and set your own spending limits / alerts before use.

A **first-use consent dialog** is shown in each workspace before any AI action runs. This is a software control only — it does not cap costs or prevent you from running AI commands after consenting.

---

## 4. File Modification, Deletion, and Push Risk

### AI implementation runs

When you run an AI implementation command, the selected AI model is given permission to **read, create, modify, and delete files inside your workspace**:

- Copilot uses VS Code's Language Model API with file-tool access.
- Claude CLI uses `--permission-mode acceptEdits`.
- Codex CLI uses `--sandbox workspace-write`.
- Gemini CLI uses `--approval-mode auto_edit`.
- Kiro CLI uses `--trust-all-tools`.
- opencode uses `--agent build`.
- devpass-code uses `--agent build`.
- **Antigravity CLI uses `--dangerously-skip-permissions` — in every mode, not just implementation.** Its headless CLI has no scoped-permission flag at all, so plan and review runs carry the same full bypass as implementation runs. See the Antigravity note in the README before enabling it.
- **Cline CLI uses `--auto-approve true` for implementation, and carries the same full-bypass risk outside it.** Its text-mode (plan/review) runs pass `--plan` instead, but that only changes the model's own system-prompt instructions — its shell-command tool stays available and auto-approved regardless, so a plan/review run can still create, change, or delete files if a prompt causes it to do so. See the Cline note in the README before enabling it.
- **Kimi Code CLI passes no permission flag at all, in any mode.** Unlike every other CLI here, `--plan`, `--yolo`, and `--auto` are all rejected outright alongside its one-shot prompt flag — implementation and plan/review runs use identical arguments and carry identical full-bypass risk. See the Kimi note in the README before enabling it.

The model can overwrite any file inside the workspace, including files unrelated to the task. There is no internal sandbox beyond the workspace boundary and the vendor's own permission flags. **Always commit or back up your workspace before running an implementation.**

### Commit & Push

The `Commit and Push Task` command stages changes and pushes to your remote repository. This is an **outward-facing, effectively irreversible action** once changes reach a shared remote.

**Default staging scope:** by default, only the task folder's changes are staged. Run artifacts (`runs/`, `context-pack.md`) are **excluded from the default staged set** because they contain AI prompts and may include file contents. Opting into "include all repository changes" stages the entire repo and shows run artifacts with an explicit warning marker.

**Chat transcripts are never staged by this command, under any option.** `chat-v1.json` (a task's Chat With AI transcript — see §5 "Extension state storage") is excluded in every mode, including "include all repository changes" and "Include Run Artifacts" — there is no in-command way to stage it. If you want a transcript committed, add it manually outside this command.

Before using this command:

- Review which files will be staged (use the preview dialog and "View Full List" if needed).
- Ensure your working tree contains only the changes you intend to commit.
- Check that no secrets, credentials, or sensitive files are present.
- Note that run artifacts excluded by default still exist on disk and may reach your remote if you later commit them manually.

**The extension authors accept zero liability for any files damaged, deleted, overwritten, corrupted, or unintentionally committed and pushed.**

---

## 5. Data Transmission to Third-Party AI Providers

When you use any "with AI" command, the extension assembles a **context pack** and sends it to the AI provider you have configured. The inclusion rule is:

> **All eligible open editors are included in the context pack; for documents with unsaved changes, the unsaved buffer content is sent in place of the on-disk content (including new unsaved file-backed documents under the workspace) — `untitled:` documents are never sent.**

**What this means:**

- File contents leave your machine and are transmitted to the third-party AI provider.
- If an open editor contains secrets, credentials, PII, proprietary code, or any other sensitive content, that content may be included in the prompt.
- All eligible editors are included, not just dirty ones. Dirtiness changes *which bytes* are sent, not *whether* the file is sent.
- Out-of-workspace editors are excluded from context packs by default.
- Virtual/notebook/diff editor documents and `untitled:` documents are excluded.

### Secret-filename denylist

A **best-effort** basename denylist excludes files matching well-known secret-file naming conventions:

`.env`, `.env.*`, `*.pem`, `*.key`, `id_rsa*`, `id_ed25519*`, `*.p12`, `*.pfx`, `.npmrc`, `.netrc`, `credentials.json`, `credentials`, `*.keystore`, `*.jks`, `.htpasswd`, `*.tfstate`, `*.tfstate.backup`

**This is a courtesy filter based on filename conventions only — it is NOT secret detection.** A secret pasted into `notes.txt`, or any file with a name not in the denylist, will not be caught. The real controls are: excluding out-of-workspace editors, supervising what is open in your editor, and checking what the context pack contains before acting on its results.

### Context-pack size limits

To limit accidental over-transmission:

- Per-file cap: 100 KB per file (larger files are truncated with an explicit marker).
- File count cap: at most 20 open-editor files per pack.
- Total pack cap: 400 KB total (further files are omitted with a count in the pack).

These caps reduce — but do not eliminate — accidental transmission of large content.

### Run logs

Every AI run writes a log to `runs/` inside your task folder. These logs contain:

- The full prompt sent to the AI provider, including the context pack and therefore any file contents included in it.
- The AI's response.

Run logs are **plain files on disk** inside your workspace. They are never encrypted or automatically deleted. If you push your task folder to a remote repository, run logs go with it unless excluded.

The `Commit and Push` command excludes `runs/` and `context-pack.md` from its **default** staged set precisely because they contain prompt content. This default is explained in the preview dialog.

### Extension state storage

The extension persists these categories of data locally:

- **Benign extension state** — consent timestamp and version, model preferences — stored in VS Code `workspaceState` and workspace configuration. This is metadata only; no file contents are stored here. **Exception during migration:** a task's Chat With AI transcript may still be present here as a legacy entry once it has been migrated to `chat-v1.json` (see below) — that legacy entry is plaintext prompt/response content, not metadata. Migration never deletes it: the entry is copied into `chat-v1.json` and left in place indefinitely (the new file records a migration marker instead, so it is not re-copied on every read), so it may remain in workspace state for as long as the task exists.
- **Sensitive run content** — full AI prompts and responses — stored in `runs/` log files and `context-pack.md` inside your task folder, as plain files on disk. These are created only after you confirm an AI action.
- **Chat transcripts** — each task's Chat With AI conversation is stored as **plaintext prompt/response content** in `chat-v1.json` inside the task folder (with `chat-v1.corrupt.json` as an occasional quarantine copy of an unreadable file — see below). It travels with the task folder and is excluded from Commit and Push in every mode (see §4). If you have used the Meta Files visibility commands, the extension also keeps transcript-specific `.gitignore` rules in its managed block so "Show Meta Files" does not expose transcripts to git; if no managed block has ever been installed, that extra protection is absent and manual Git commands can still stage the files even though Commit and Push will not. If an older workspace-state transcript for a task hasn't been opened yet under this version, it is migrated into `chat-v1.json` the first time that task's chat is read or written — the legacy workspace-state entry is left untouched (never deleted) by that migration, as noted above. A `chat-v1.json` that fails to parse is preserved as `chat-v1.corrupt.json` (only the most recent quarantine copy is kept) rather than being silently discarded.
- **Chat transcript concurrency limitation:** transcript writes are serialized only within a single VS Code window. If you have the same task open in two windows and chat with it in both at once, the last write wins and a message from the other window can be lost. This is a deliberate, weaker guarantee than task progress gets (task progress uses a cross-process lease); simultaneous multi-window chat on one task is not a supported workflow.

### AI providers' own privacy policies

Data you send to third-party providers is governed by **their** privacy and data-use policies, not by this extension. Review the policies for the provider(s) you use:

- [GitHub Copilot Privacy](https://docs.github.com/en/site-policy/privacy-policies/github-general-privacy-statement)
- [Anthropic Privacy](https://www.anthropic.com/privacy)
- [OpenAI Privacy](https://openai.com/privacy/)
- [Google Privacy](https://policies.google.com/privacy) — covers both Gemini CLI and Antigravity CLI (Google accounts)
- [AWS Privacy](https://aws.amazon.com/privacy/) — covers Kiro CLI
- [Cline Privacy Notice](https://cline.bot/privacy) — covers Cline CLI / ClinePass
- [Moonshot AI Privacy Policy](https://www.moonshot.ai/privacy) — covers Kimi Code CLI

---

## 6. Not Production or Compliance Tooling

This extension is a personal productivity tool built for individual developers who want to incorporate AI into their own planning and development workflow. It is **not designed, tested, or certified for**:

- Production environments
- Regulated industries (finance, healthcare, legal, government, etc.)
- Environments subject to data-residency requirements
- Environments subject to data-processing agreements (GDPR processors, HIPAA business associates, etc.)
- Multi-user or enterprise deployments

If your organisation requires production-grade tooling, AI governance controls, audit trails, or compliance certifications, this extension is not the right tool. Fork it, customise it, and have it evaluated by qualified security and legal professionals before deploying it in such contexts.

---

## 7. Open Source — Fork, Evaluate, and Customise

The extension is fully open source under the MIT License. You can:

- Read every line of code before using it.
- Fork it and customise it for your own needs.
- Submit bug reports and feature requests.
- Modify the permission flags, context-pack assembly, staging logic, consent text, and any other behaviour that concerns you.

**You should evaluate the source code and this disclaimer yourself** — or have them evaluated by qualified technical and legal professionals — before deciding whether to use the extension. The authors make no representation about the extension's suitability for any particular purpose.

**Forks and customisations are also at the user's risk.** The MIT License and this disclaimer apply to the original; forks are the responsibility of their maintainers.

---

## 8. Not Legal Advice

This document is informational only. It is not legal advice and does not create any legal obligation on anyone. The extension's authors are not lawyers, and this disclaimer has not been reviewed by qualified legal counsel.

If you have legal questions about using this extension (data protection, IP, compliance, liability), consult a qualified legal professional.

Documentation and disclosures are not a substitute for legal review. No guarantee of legal enforceability is made.

---

## 9. Summary — Your Checklist Before Using AI Features

- [ ] I have read this disclaimer and understand the risks.
- [ ] I understand that AI runs consume real quota/money from my subscription.
- [ ] I understand that AI implementation runs — and, for providers without a scoped permission mode (see §4), any run including plan and review — can modify or delete files in my workspace.
- [ ] I will supervise every AI action and review results before acting on them.
- [ ] I have committed or backed up my workspace before running AI implementation commands.
- [ ] I understand that all eligible open-editor file contents (including unsaved buffers) may be sent to the AI provider.
- [ ] I have checked that no secrets or sensitive files are open in my editor or present in my workspace root.
- [ ] I understand that the secret-filename denylist is a courtesy filter, not secret detection.
- [ ] I understand that commit-and-push is outward-facing and largely irreversible.
- [ ] I understand that run logs in `runs/` contain full prompt content and may be pushed with my task folder.
- [ ] I accept that the extension is provided as-is and the authors bear no liability.

---

*Ensemble is an open-source project. Contributions, forks, and feedback are welcome.*
