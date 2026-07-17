import * as vscode from "vscode";

/**
 * Reserved placeholder: expands to the shared review scoring rubric fragment
 * so every review template gets identical score semantics. Caller-supplied
 * variables cannot override it.
 */
const REVIEW_SCORING_RUBRIC_KEY = "reviewScoringRubric";
const REVIEW_SCORING_RUBRIC_FILE = "review-scoring-rubric.md";

/**
 * Load a prompt template from resources/prompts and substitute
 * {{variable}} placeholders with the provided values.
 */
export async function renderPromptTemplate(
  extensionUri: vscode.Uri,
  templateFileName: string,
  variables: Record<string, string>
): Promise<string> {
  const templateUri = vscode.Uri.joinPath(
    extensionUri,
    "resources",
    "prompts",
    templateFileName
  );
  const content = await vscode.workspace.fs.readFile(templateUri);
  let template = new TextDecoder().decode(content);

  // Expand the reserved rubric placeholder before caller variables so that
  // variable values containing the literal placeholder are never expanded,
  // and only templates that reference it pay for the extra file read.
  if (template.includes(`{{${REVIEW_SCORING_RUBRIC_KEY}}}`)) {
    const rubricUri = vscode.Uri.joinPath(
      extensionUri,
      "resources",
      "prompts",
      REVIEW_SCORING_RUBRIC_FILE
    );
    const rubricBytes = await vscode.workspace.fs.readFile(rubricUri);
    const rubric = new TextDecoder().decode(rubricBytes).trim();
    template = template.split(`{{${REVIEW_SCORING_RUBRIC_KEY}}}`).join(rubric);
  }

  for (const [key, value] of Object.entries(variables)) {
    if (key === REVIEW_SCORING_RUBRIC_KEY) {
      continue;
    }
    template = template.split(`{{${key}}}`).join(value);
  }

  return template;
}
