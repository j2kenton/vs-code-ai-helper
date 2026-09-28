# Contributing

## Both CI jobs must stay green

`.github/workflows/ci.yml` runs two jobs on every pull request and every push to `main`. Merge only when both pass.

| Job | Runs on | What it proves |
|---|---|---|
| `linux` — Typecheck, lint, tests, web smoke | Ubuntu | Type-check, lint, `verify:workflow-safety` (including the toast allow-list and the notification task-naming scan), the esbuild bundle, the execution-boundary scan, and the workspace packages' own tests. |
| `windows` — Extension unit tests | Windows | The extension's own unit suite (`pnpm run test:unit`), on the platform users run it on. |

**Why the Windows job is not optional.** The extension is used on Windows, and the unit suite is the only thing that exercises path separators, drive-letter absolute paths, line endings and process handling there. A test that passes on Linux can fail on Windows purely on fixture shape (a `C:/…` path is not absolute on Linux, a `/tmp/…` path is not absolute on Windows). Build fixtures with `path.join` / `path.resolve` or `os.tmpdir()` rather than hard-coded `/` or `C:\` strings, and never compare paths by string equality without normalising separators.

**Why the Linux job is not optional.** It is the only place `verify:workflow-safety`, the bundle and the boundary scans run in CI. Skipping it lets a change ship that type-checks locally but breaks the packaged extension or a safety invariant.

A red job is a real failure on that platform, not flakiness: fix the cause instead of re-running until it passes.

## Notifications must name their task

Every notification about one task has to say which task it is about. Run `pnpm run verify:notification-task-naming` (add `--report` to list every site). A notification is fine when it is raised inside `runTrackedOperation` / `runWithNotificationTaskContextV1`, when its own text interpolates the task's display name (`displayName ?? folderName`), or when it is genuinely global or raised before a task is resolved — the last kind goes in `scripts/notificationTaskNamingAllowlistV1.json` with a reason. Never invent a name for a pre-resolution message.

## Source-scan allow-lists

Allow-lists for the source scans (`scripts/toastAllowlistV1.json`, `scripts/notificationTaskNamingAllowlistV1.json`) are keyed by file plus a snippet of the call's own text, never by line number, so an unrelated edit above a site does not break them.
