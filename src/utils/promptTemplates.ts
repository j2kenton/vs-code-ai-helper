import * as vscode from "vscode";
import { readExtensionResourceV1 } from "./extensionResourcesV1";

/**
 * Reserved placeholder: expands to the shared review scoring rubric fragment
 * so every review template gets identical score semantics. Caller-supplied
 * variables cannot override it.
 */
const REVIEW_SCORING_RUBRIC_KEY = "reviewScoringRubric";
const REVIEW_SCORING_RUBRIC_FILE = "review-scoring-rubric.md";

const ROUND_GIT_STATE_POLICY_V1 = `

## Git State Protection

This round runs in the owner's live working tree. Do not change Git state or manipulate saved work: do not run git stash (including push, pop or drop), git checkout, git restore, git reset, git apply, git merge, git rebase, or any commit command. Do not modify the index or Git refs through another command either. Read-only inspection such as git status, git diff, git log and git show is allowed. To inspect committed content or run a check against HEAD, read Git objects directly or use an isolated scratch copy/worktree; do not stash, restore or switch this working tree. Tests against this working tree verify its current edited files, not the committed version.

This is prompt-level protection. The current provider adapters do not enforce this command policy uniformly, so do not assume a provider will block a prohibited command.
`;

const ROUND_PROMPT_FILES_V1 = new Set([
  "run-implementation.md",
  "create-implementation.md",
  "apply-review.md",
  "apply-impl-review-code.md",
  "final-fixes-code.md",
  "review-impl-high.md",
  "review-impl-high-rereview.md",
  "review-impl-low.md",
  "review-impl-low-rereview.md",
  "review-plan-high.md",
  "review-plan-high-rereview.md",
  "review-plan-low.md",
  "review-plan-low-rereview.md",
  "review-publish.md",
  "review-publish-rereview.md",
]);

/** Shared policy injection for prompts that inspect or edit the live task tree. */
export function appendRoundGitStatePolicyV1(templateFileName: string, prompt: string): string {
  return ROUND_PROMPT_FILES_V1.has(templateFileName) ? `${prompt}${ROUND_GIT_STATE_POLICY_V1}` : prompt;
}

/**
 * Load a prompt template from resources/prompts and substitute
 * {{variable}} placeholders with the provided values.
 */
export async function renderPromptTemplate(
  extensionUri: vscode.Uri,
  templateFileName: string,
  variables: Record<string, string>
): Promise<string> {
  const content = await readExtensionResourceV1(extensionUri, ["resources", "prompts", templateFileName]);
  let template = new TextDecoder().decode(content);

  // Expand the reserved rubric placeholder before caller variables so that
  // variable values containing the literal placeholder are never expanded,
  // and only templates that reference it pay for the extra file read.
  if (template.includes(`{{${REVIEW_SCORING_RUBRIC_KEY}}}`)) {
    const rubricBytes = await readExtensionResourceV1(extensionUri, [
      "resources",
      "prompts",
      REVIEW_SCORING_RUBRIC_FILE,
    ]);
    const rubric = new TextDecoder().decode(rubricBytes).trim();
    template = template.split(`{{${REVIEW_SCORING_RUBRIC_KEY}}}`).join(rubric);
  }

  for (const [key, value] of Object.entries(variables)) {
    if (key === REVIEW_SCORING_RUBRIC_KEY) {
      continue;
    }
    template = template.split(`{{${key}}}`).join(value);
  }

  return appendRoundGitStatePolicyV1(templateFileName, template);
}
