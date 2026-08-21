# `~/.claude/plans` leak probe — 2026-08-21

Captured evidence for `workflow 8` item 5 / Part 6 item 5: whether
`CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT` (`src/runners/providers.ts`)
still prevents the Claude Code CLI from writing its plan to a scratch file
when run headless under `--permission-mode plan`.

**Verdict: PASS.** No scratch file was written, and the response carried the
real answer directly.

**But see "What this does not establish" — the failing case was not
reproduced, so this is not sufficient grounds to declare the 2026-08-20
regression closed.**

## How it was run

`node scripts/probe-plans-leak.mjs`, which invokes the installed CLI exactly
as `providers.ts`'s claude-cli definition does for text-mode rounds
(`-p --permission-mode plan --append-system-prompt "<mitigation>"`), snapshots
`~/.claude/plans` before and after, and judges both the directory and the
response shape.

## Result

```
claudeVersion         2.1.233 (Claude Code)
startedAt             2026-08-21T13:13:56.802Z
finishedAt            2026-08-21T13:14:11.285Z
plansDir              C:\Users\jjk61\.claude\plans
filesLeakedOrChanged  []
verdict               PASS — no scratch file written, and the response
                      carries the real answer directly
```

The response was a complete four-step plan with assumptions and verification
notes inline — not a stub, not a pointer to a file.

## What this does not establish

The probe passes on an **easy** case. The 2026-08-20 failure happened on a
hard one, and the difference is not controlled for:

| | 2026-08-20 (leaked) | 2026-08-21 probe (PASS) |
|---|---|---|
| Round | real `summary-only` continuation for `workflow 6` | synthetic one-line prompt |
| Prompt | full task/plan/summary context | ~40 words |
| Workspace | large, real | none material |
| Outcome | wrote `~/.claude/plans/you-are-implementing-a-lucky-eich.md`, returned a plan instead of the required report | no file, correct response shape |

That leaked file is still present on disk and appears in this probe's
`filesBefore` list — direct evidence the leak did occur, on this machine, with
this mitigation in place.

**So the behaviour is intermittent, not a clean regression.** The mitigation is
present and demonstrably effective under light load. Whatever caused it to be
ignored on 2026-08-20 is not captured here.

Note also the CLI version has moved: the original mitigation was verified
against **2.1.216** on 2026-08-21 (sic — 2026-07-21); this probe ran against
**2.1.233**. The 08-20 failure sits somewhere between those two, and the
version in use at that moment was not recorded.

## Consequence for `providers.ts`

The dated comment at `src/runners/providers.ts:920-937` should record:

- re-verified PASS against claude **2.1.233** on 2026-08-21
- with the caveat that a real `summary-only` continuation leaked on 2026-08-20
  despite the same mitigation, so the instruction is **not** a guarantee

The stronger conclusion — that `summary-only` should not be selected for
claude-cli at all — is already handled by `workflow 7`, which split the
capability probe so a provider must both withhold edits **and** honour a
response contract. That change does not depend on this probe's verdict.

## To reproduce the failing case

Run a genuine `summary-only` continuation for a real task through
`claude-cli` text mode, with a full context pack, and check
`~/.claude/plans` afterwards. A synthetic prompt does not exercise it.
