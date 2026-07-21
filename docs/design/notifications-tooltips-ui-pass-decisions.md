# Notifications/Tooltips/Stage-Progression UI Pass — Closed Decisions

This task's context pack (tooltips & shortcuts, internal-notification routing,
Enter-to-send, backup models, stage auto-progression, AI commit messages,
release gate, models-tab spacing, task-list loading state, sidebar shortcut,
view icon) raised four open questions during planning. All four were resolved
during implementation; recorded here since the task record they were
originally attached to belongs to an unrelated (now-archived) task.

## Sidebar activity-bar shortcut

The task description suggested `Ctrl+Shift+E`, mirroring VS Code's own
Explorer shortcut — but that key is already taken by Explorer, so binding it
to Ensemble would conflict. Resolved as `ctrl+shift+alt+e` /
`cmd+shift+alt+e` instead, consistent with this extension's other
`ctrl+shift+alt+<letter>` bindings (`...+i` apply current stage action,
`...+r` review, `...+f` fast-forward, `...+p` commit & push, `...+n` next
stage). See `package.json` → `contributes.keybindings` →
`workbench.view.extension.ai-helper`.

## Release gate (`ensemble:release` indirection loophole)

Revised approach, a hybrid of (a) and (b): the gate resolves a single hop of
`"ensemble:release": "npm run <script>"` / `"pnpm run <script>"` /
`"yarn <script>"` so the confirmation dialog and hash always cover the
script that actually runs, not just the pass-through call to it — but the
*resolved* target is validated more leniently than the top-level
`ensemble:release` script: it is allowed to chain multiple steps with `&&`
(e.g. `"release": "npm run type-check && npm run lint && npm run test:all &&
npm run build"`), since that is the accepted, working way to express a
multi-step release pipeline (per the task author's own stated preference —
"worst case scenario would just tell the user that's how they can do it").
Every other shell metacharacter is still rejected in each `&&`-separated
segment (pipes, backgrounding, redirects, command substitution, quotes,
newlines), and a self-reference back to `ensemble:release` or an
unresolvable target is still treated as unsafe. Only one hop is ever
followed (no cycle risk). An earlier pass in this same task closed the
loophole outright by validating the resolved target against the same strict
`isSafeReleaseScript` used for the top-level script — that broke exactly the
chained-script setup described in the task, so it was reverted in favor of
this narrower allowance. See `src/commands/reviewActions.ts` →
`resolveReleaseScript`, `isSafeReleaseScript`,
`isSafeReleaseIndirectionTarget`, `RELEASE_UNSAFE_SCRIPT_MESSAGE`.

## View container icon ("two arrows" overlay)

The two-arrow overlay on the Ensemble activity-bar icon read as a
sync/refresh glyph rather than "in progress." Replaced with a single
forward-pointing arrow (`images/tasks-view.svg`), which is unambiguous and
matches the "current stage" arrow-right icon already used elsewhere in the
tree view (`StageNode`'s "current" status icon).

## DSA-practice paragraph in the task description

The paragraph describing a "data structures & algorithms practice" feature
(code-template insertion via context menu, AI coaching side panel) does not
match Ensemble's actual feature set and was treated as unrelated text pasted
into the task description by mistake. It was excluded from scope, per the
plan's explicit note; no DSA-related feature was implemented or should be
inferred from this task.
