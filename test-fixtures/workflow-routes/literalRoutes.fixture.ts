/**
 * Positive fixture for the route-scan extractor (scripts/lib/workflowRouteScan.mjs).
 * The self-test in scripts/generateWorkflowRoutes.mjs scans this file on every
 * run and asserts that exactly these constructs are extracted:
 *  - one literal command registration (fixture.alpha);
 *  - one internal literal executeCommand edge (vs-code-ai-helper.beta);
 *  - one dynamic executeCommand dispatch (someCommand);
 *  - one webview onDidReceiveMessage handler root;
 *  - one throwing gate call (draft.v1);
 *  - one literal object-property command binding (vs-code-ai-helper.gamma);
 *  - one provider-boundary call (resolveRunnerForModel; the type-position
 *    `typeof resolveRunnerForModel` reference must NOT count);
 *  - exactly two legacy output destinations (one `outputFile:` property
 *    assignment plus one `{ outputFile }` shorthand; the interface member
 *    and the differently named `outputFilePath` must NOT count).
 * Not compiled by any tsconfig — parsed only by the extractor's TS AST walk.
 */
declare const vscode: {
  commands: {
    registerCommand(id: string, cb: (...args: unknown[]) => unknown): unknown;
    executeCommand(id: string, ...args: unknown[]): Thenable<unknown>;
  };
};
declare const webview: { onDidReceiveMessage(cb: (m: unknown) => void): void };
declare function assertLegacyAiRouteAllowedV0(routeId: string): void;
declare function resolveRunnerForModel(modelId: string): { runner: unknown };

interface FixtureRunRequest {
  outputFile: string; // PropertySignature — must NOT be extracted as a destination
}

export function registerFixtureCommand(someCommand: string): void {
  vscode.commands.registerCommand("vs-code-ai-helper.fixture.alpha", () => {
    assertLegacyAiRouteAllowedV0("draft.v1");
    void vscode.commands.executeCommand("vs-code-ai-helper.beta");
    void vscode.commands.executeCommand(someCommand);
    void vscode.commands.executeCommand("setContext", "fixture", true);
  });
  webview.onDidReceiveMessage(() => undefined);
}

export function runFixtureProvider(): FixtureRunRequest {
  const resolved: ReturnType<typeof resolveRunnerForModel> = resolveRunnerForModel("fixture-model");
  void resolved;
  const outputFile = "staged.tmp";
  const request = { outputFile, outputFilePath: "not-a-destination" };
  void request;
  return { outputFile: "assigned.md" };
}

export const fixtureItem = {
  command: "vs-code-ai-helper.gamma",
  title: "Fixture",
};
