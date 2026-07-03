import * as vscode from "vscode";

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

  for (const [key, value] of Object.entries(variables)) {
    template = template.split(`{{${key}}}`).join(value);
  }

  return template;
}
