# C4 chat-edit mechanism: spike decision

Plan step 17 (Workstream D, `plans/2026-07-16_task_2/plan.md`) called for a
spike into the chat/CLI pipeline before building the C4 markdown-edit
capability, to determine whether the underlying CLI runtimes already expose
a file-write capability that is merely prompt- or permission-suppressed for
chat (in which case the fix is to enable and constrain it) or whether no
write path exists (in which case the smallest workable edit protocol should
be added). This was implemented (`chatWithStage.ts`'s `[[UPDATE_FILE:...]]`
envelope) without the written decision the step called for. This note is
that decision, recorded after inspecting the actual runner code rather than
assumed.

## What exists

`src/runners/providers.ts` defines two `CliRunMode`s per provider,
`"text"` and `"edit"`, and every provider's `buildArgs` genuinely changes
its CLI invocation between them — this is real permission plumbing, not
just a prompt-level instruction:

| Provider | `mode: "edit"` | `mode: "text"` |
|---|---|---|
| Claude Code CLI | `--permission-mode acceptEdits` | (flag omitted — default deny) |
| Codex CLI | `--sandbox workspace-write` | `--sandbox read-only` |
| Gemini CLI | `--approval-mode auto_edit` | (flag omitted) |
| Kiro CLI | `--trust-all-tools` | `--trust-tools fs_read,grep,glob` |
| Antigravity CLI | `--dangerously-skip-permissions` (headless has no other approval surface — pre-existing accepted risk, unrelated to this decision) | same flag, same pre-existing risk |

`chatWithStage.ts` calls `runner.run()`, which (`CliAgentRunner.run` in
`cliAgentRunner.ts:649`) always invokes `execCliAgent` with `mode: "text"`.
`runImplementationWithCli` (used by "Run Implementation") uses `mode:
"edit"`. So a native write capability does exist and is currently
suppressed for chat — confirming half of the spike's premise (option a).

## Why option (a) — enabling native edit mode for chat — was rejected

Every provider's `edit` mode grants write access to the **entire CLI
invocation's working directory** (the open workspace root passed as `cwd`).
None of the five providers expose a flag that scopes tool trust to a single
subfolder, let alone to a single file extension inside it. `--sandbox
workspace-write`, `--permission-mode acceptEdits`, `--approval-mode
auto_edit`, and `--trust-all-tools` are all workspace-wide grants with no
path or glob parameter.

C4's invariant is narrower than any of these primitives can express: writes
must be restricted to `.md` files inside the *one task folder* the chat
session is bound to, with every other file — including `.md` files in
sibling task folders — off limits. Turning on native edit mode for chat
would trade a well-defined extension-side boundary for a CLI-wide grant the
extension cannot narrow, which is a regression relative to the current
text-mode default, not an improvement.

## Decision

Keep chat runs in `mode: "text"` (native write stays suppressed, matching
every other stage's read-only-for-chat behavior) and mediate the one
permitted edit path — a single markdown file inside the active task's own
folder — entirely on the extension side. The model proposes content via the
`[[UPDATE_FILE:relative-filename.md]]...[[/UPDATE_FILE]]` envelope in its
text response; `chatWithStage.ts`'s `resolveMarkdownUpdateTarget` validates
the target (`.md` only, no absolute path, resolves inside the task folder
after `path.resolve`, rejects `..` escapes) before `writeTextFile` is
called. No CLI permission flag is touched by this path.

This is option (b) from the spike's framing, chosen not because option (a)
was unexamined but because the concrete evidence above shows no provider's
native grant can be narrowed to C4's actual boundary — the bespoke,
extension-validated envelope is the smaller-blast-radius mechanism, matching
the plan's general preference for root-cause, minimally-scoped fixes.

## What would change this decision

If a provider later adds path- or glob-scoped tool trust (e.g. "allow
edits, but only under `plans/<task>/*.md`"), re-run this comparison for that
provider specifically — enabling its native mode inside that scope would
let the model iterate without the single-file-per-response limitation the
envelope protocol currently has. No such flag exists in any of the five
providers as of this writing.
