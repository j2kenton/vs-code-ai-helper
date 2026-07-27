/**
 * Negative fixture for the route-scan extractor: a registerCommand call whose
 * command ID is computed. The self-test in scripts/generateWorkflowRoutes.mjs
 * asserts this is reported as an UNRESOLVED registration (the fail-closed
 * "unresolved computed command IDs" rule from plan §1.2), never as a concrete
 * route. Not compiled by any tsconfig — parsed only by the extractor.
 */
declare const vscode: {
  commands: { registerCommand(id: string, cb: () => void): unknown };
};

export function registerComputedFixture(prefix: string): void {
  vscode.commands.registerCommand(prefix + ".computed", () => undefined);
}
