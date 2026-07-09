# plan-final.md

This stage polished the task user interface by resolving model selection visibility, enforcing consistent command tooltips/titles across different surfaces, ensuring action icons match their intent, and replacing ad hoc row-context logic with validated context tokens.

## Files Changed

- [package.json](file:///c:/dev/PERSONAL/vs-code-ai-helper/package.json): Updated the task-row context menu to use `configureTaskStepModels` for proper task scope, and renamed the title of `setStageModel` to "Set Model for This Step" for clearer tooltips.
- [src/types/taskProgress.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/types/taskProgress.ts): Extended `TaskProgress` interface with `scheduledResumeTime` and `pendingNotes` fields to support context token calculation.
- [src/commands/configureStepModels.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/configureStepModels.ts): Annotated selectable model quick pick items with their active status (`Active task override`, `Workspace default`, or `Active workspace default`).
- [src/views/taskTreeProvider.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/views/taskTreeProvider.ts): Imported `path`, implemented asynchronous gitignore checking, and passed `isScheduled`, `hasPendingNote`, and `isMetaManaged` states to the `TaskNode` and `StageNode` constructors to drive centralized context token building.
- [src/test/taskTreeProvider.test.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/test/taskTreeProvider.test.ts): Removed the global mock of `buildStageContextValue` and updated context token assertions to reflect the real centralized implementation.
- [src/test/modelSelection.test.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/test/modelSelection.test.ts): Added test assertions for resolved model display strings when a model is currently unavailable.

## Verification

- [ ] Run `pnpm run test:unit` to verify that all 351 unit tests pass successfully.
- [ ] Confirm that model pick items clearly annotate task overrides, workspace defaults, and automatic selections.
- [ ] Verify that right-clicking a task row displays "Configure Models for This Task" instead of "Configure Workspace Default Models".
- [ ] Verify that hovering over a modelable stage row's set model button displays the tooltip "Set Model for This Step".
- [ ] Confirm that row-context tokens correctly adapt to scheduling, pending-note, and git-managed/meta-managed states.
