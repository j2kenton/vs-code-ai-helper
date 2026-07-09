# plan-final.md

This stage polished the task status surfaces and notification routing, sending routine non-blocking notifications to a bounded status surface while keeping destructive validations as popups, and ensuring that the status bar actions are always context-sensitive and useful.

## Files Changed

- [src/views/taskStatusBar.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/views/taskStatusBar.ts): Updated `showMenu` to check if a task exists and offer `Resume shown task` if it is paused, or `Open shown task` otherwise (including completed states).
- [src/commands/generatePlanWithAI.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/generatePlanWithAI.ts): Integrated `NotificationRouter` for routine notifications and emitted progress summaries to the status view.
- [src/commands/draftTaskWithAI.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/draftTaskWithAI.ts): Integrated `NotificationRouter` for routine notifications and emitted progress summaries to the status view.
- [src/commands/runLintingFixes.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/runLintingFixes.ts): Integrated `NotificationRouter` for routine notifications and emitted progress summaries to the status view.
- [src/commands/commitAndPushTask.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/commitAndPushTask.ts): Integrated `NotificationRouter` for routine notifications and emitted progress summaries to the status view.
- [src/commands/reviewActions.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/commands/reviewActions.ts): Integrated `NotificationRouter` for routine notifications and emitted progress summaries to the status view.
- [src/test/stage5StatusNotification.test.ts](file:///c:/dev/PERSONAL/vs-code-ai-helper/src/test/stage5StatusNotification.test.ts): Added unit tests for `TaskStatusBar` quick pick menu actions under paused, active, and completed task states.

## Verification

- [ ] Run `pnpm run test:unit` to verify that all 367 unit tests pass successfully.
- [ ] Verify that routine warnings and informational messages appear in the "Recent Status" sidebar view.
- [ ] Confirm that destructive confirmations (like git push confirmations) still appear as modal/standard popups.
- [ ] Confirm that clicking the status bar when a shown task exists offers "Resume shown task" if paused, and "Open shown task" otherwise.
