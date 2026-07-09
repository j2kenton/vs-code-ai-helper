# plan-final.md

This stage normalizes stage actions, auto-review triggers, and completion flows to ensure consistent and deterministic task finalization. It fixes the helper bypass in [setTaskStage](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/setTaskStage.ts), registers the combined [completeCommitAndPushTask](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/commitAndPushTask.ts) command, and gates it based on the task's lint state.

## Files Changed

- [package.json](file:///c:/dev/PERSONAL/vs-code-ai-helper/package.json): Registered the combined `completeCommitAndPushTask` command and added `-paused` and `-lint-known` menu context gating to stage row actions.
- [src/commands/commitAndPushTask.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/commitAndPushTask.ts): Implemented the combined [completeCommitAndPushTask](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/commitAndPushTask.ts) flow and added a backfill path to record the lint state when the user bypasses checks.
- [src/commands/runLintingFixes.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/runLintingFixes.ts): Updated [runLintingFixes](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/runLintingFixes.ts) to permit running lint validation while at the final review stage ([impl-low-review](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/types/taskProgress.ts)).
- [src/commands/setTaskStage.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/setTaskStage.ts): Refactored the stage transition code to delegate stage persistence and auto-review computation entirely to the shared [advanceStage](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/utils/stageTransition.ts) helper.
- [src/views/taskTreeProvider.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/views/taskTreeProvider.ts): Passed task paused state and lint payload status into [getStageNodeContextValue](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/views/taskTreeProvider.ts) to append appropriate suffixes.
- [src/test/taskTreeProvider.test.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/test/taskTreeProvider.test.ts): Added unit test coverage for context value suffix appending when the task is paused or the lint state is known.

## Verification

- [ ] Run `pnpm run test:unit` to verify that all 338 unit tests pass successfully.
- [ ] Confirm that paused tasks do not display inline stage-advance buttons in the tree.
- [ ] Confirm that `vs-code-ai-helper.completeCommitAndPushTask` appears on the final review stage row (`impl-low-review`) only when the lint payload is present.
- [ ] Verify that selecting "Proceed Without Lint" in the commit dialog successfully backfills and writes the lint payload to the task progress file.
