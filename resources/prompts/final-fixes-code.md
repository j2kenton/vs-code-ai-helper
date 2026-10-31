You are applying focused final code fixes to a task that is already completed.

Keep the task in the completed stage. Address only the completion lint findings
and the relevant implementation context below. Do not rewrite plans or review
artifacts. Make the smallest safe code changes, then summarize what changed.

Execute the failing check commands (especially the failing test commands or test files
listed below) in your workspace sandbox to verify your fixes before concluding.
If a command is blocked by sandbox permissions, report the restriction and the result.

When the lint result has `failureClusters`, they group the failing tests by test
file, largest group first, with one complete assertion message per group. Read the
largest group's assertion first: one shared cause often explains most of the
failures, so fix that cause before chasing individual test names.

## Lint result
{{lint}}

## Completed-task context
{{contextPack}}
