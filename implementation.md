# Implementation

Stage 1 workflow-correctness fixes (this review round): resolved both blocking issues — (1) `normalizeReviewArg` guards `typeof arg !== "object"` before any property access so truthy string/number/boolean primitives return `{}` (safe QuickPick fallback) instead of throwing `TypeError`; (2) `GENERATE_IMPL_ELIGIBLE_STAGES` is now exported from `reviewActions.ts` and suite 16 imports and asserts against the production constant directly, so a regression that re-adds `"plan-low-review"` to the constant will cause the test to fail (the prior implementation re-declared a local array that could never catch a production regression).

## Files Changed

- **`src/commands/reviewActions.ts`** — Exported `GENERATE_IMPL_ELIGIBLE_STAGES` as a named `export const` so tests can import and assert against the production value; updated `generateImplementationWithAI` JSDoc to reference the constant by name; all other logic unchanged.
- **`src/test/commandArgNormalization.test.ts`** — Updated import line to include `GENERATE_IMPL_ELIGIBLE_STAGES` from `reviewActions`; rewrote suite 16 to assert against the imported production constant (instead of a locally re-declared array); expanded suite 16 to three assertions: constant excludes `"plan-low-review"`, constant includes `"implementation"`, and constant equals exactly `["implementation"]`; updated suite 16 header comment to document the production-coupling requirement.
- **`implementation.md`** — Replaced previous-round summary with this round's summary; listed itself in `## Files Changed`; corrected the suite 16 verification item to reflect that the suite now asserts against the production constant.

## Verification

- [ ] Run `pnpm run check-types` — no TypeScript errors; the `// @ts-expect-error` on `normalizeReviewArg({ canonicalId: ... })` in the test file is required (not spurious).
- [ ] Run `pnpm run test:unit` — all suites pass, including suite 13 (primitive assertions), suite 15 (all simulator tests + production string-primitive test), and suite 16 (4 assertions all against the imported production `GENERATE_IMPL_ELIGIBLE_STAGES` constant).
- [ ] Confirm `normalizeReviewArg` in `src/commands/reviewActions.ts` opens with `if (!arg || typeof arg !== "object") { return {}; }` — no `in` operator reachable for a primitive.
- [ ] Confirm `GENERATE_IMPL_ELIGIBLE_STAGES` is exported from `src/commands/reviewActions.ts` as `export const GENERATE_IMPL_ELIGIBLE_STAGES: readonly TaskStage[] = ["implementation"]`.
- [ ] Confirm suite 16 in `src/test/commandArgNormalization.test.ts` imports `GENERATE_IMPL_ELIGIBLE_STAGES` from `"../commands/reviewActions"` and all four assertions reference the imported name, not a local array.
- [ ] Confirm `isMalformedReviewArg` returns `false` for `"x"`, `42`, `true`, `undefined`, `{}` — and `true` for `{ canonicalId: "x" }`, `{ task: {} }`, `{ task: { folderUri: undefined } }`, `{ canonicalId: "x", taskFolderPath: undefined }`.
- [ ] Open a task at `plan-low-review`; invoke **Generate Implementation** from the command palette — confirm "No tasks are at a stage eligible for this action." (not a hard error about missing `plan-final.md`).
- [ ] Confirm `apply-impl-review-code.md` contains no heading "Final Plan"; the implementation artifact section must be headed "Implementation Notes (plan-final.md)".
- [ ] Simulate `vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", "bad-string")` — confirm no `TypeError`, no malformed-arg error; QuickPick or "No task folders found" fires instead.
- [ ] Simulate `vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", { task: {} })` — confirm malformed-arg error fires, no QuickPick.
- [ ] Simulate `vscode.commands.executeCommand("vs-code-ai-helper.runReviewWithAI", { canonicalId: "x", taskFolderPath: undefined })` — confirm malformed-arg error fires.
- [ ] Place a task folder at `impl-high-review` with only `implementation.md`; run Re-review — confirm it proceeds without error and `plan-final.md` is materialized.
