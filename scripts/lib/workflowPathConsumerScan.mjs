/**
 * Mechanical path-consumer extraction for the non-AI path-consumer inventory
 * (plan §2.3). TypeScript-compiler-based and shared by the live generator
 * (scripts/generateWorkflowPathConsumers.mjs) and the immutable pre-gate
 * snapshot generator, so the two row shapes can never diverge.
 *
 * A production module is a path-consumer CANDIDATE when its AST shows any of
 * these filesystem/process signals, each recorded as a concrete CALL SITE
 * with a compiler-derived span and enclosing symbol (plan §2.3: "Each row
 * records the source span"):
 *   - "import:fs"            — an import/require of node:fs / fs (+ promises);
 *   - "import:child_process" — an import/require of node:child_process /
 *                              child_process (spawned processes can consume
 *                              arbitrary paths — every such consumer also
 *                              requires a dynamicPathConsumption annotation);
 *   - "workspace.fs"         — each `workspace.fs` / `vscode.workspace.fs`
 *                              property access (the VS Code filesystem API).
 *
 * Callers pass the exact production source file list from the §1.1 source
 * universe — never a filesystem walk.
 */
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { spanOf, spanStartLine, enclosingSymbolOf, toPosix, sha256OfText } from "./workflowRouteScan.mjs";

const require = createRequire(import.meta.url);
const ts = require("typescript");

const FS_MODULES = new Set(["fs", "node:fs", "fs/promises", "node:fs/promises"]);
const CHILD_PROCESS_MODULES = new Set(["child_process", "node:child_process"]);

/**
 * Extracts every filesystem/process call site of one source file:
 * `[{ signal, span, enclosingSymbol }]`, sorted by position then signal.
 */
export function extractPathConsumerCallSites(absPath) {
  const text = fs.readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);
  const callSites = [];
  const add = (signal, node) => {
    callSites.push({
      signal,
      span: spanOf(sourceFile, node),
      enclosingSymbol: enclosingSymbolOf(sourceFile, node),
    });
  };
  const visit = (node) => {
    if (ts.isImportDeclaration(node) && ts.isStringLiteralLike(node.moduleSpecifier)) {
      const spec = node.moduleSpecifier.text;
      if (FS_MODULES.has(spec)) add("import:fs", node);
      if (CHILD_PROCESS_MODULES.has(spec)) add("import:child_process", node);
    } else if (
      ts.isCallExpression(node) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === "require" &&
      node.arguments.length === 1 &&
      ts.isStringLiteralLike(node.arguments[0])
    ) {
      const spec = node.arguments[0].text;
      if (FS_MODULES.has(spec)) add("import:fs", node);
      if (CHILD_PROCESS_MODULES.has(spec)) add("import:child_process", node);
    } else if (
      ts.isPropertyAccessExpression(node) &&
      node.name.text === "fs" &&
      ((ts.isIdentifier(node.expression) && node.expression.text === "workspace") ||
        (ts.isPropertyAccessExpression(node.expression) && node.expression.name.text === "workspace"))
    ) {
      // workspace.fs and vscode.workspace.fs
      add("workspace.fs", node);
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  callSites.sort((a, b) => spanStartLine(a.span) - spanStartLine(b.span) || a.signal.localeCompare(b.signal));
  return callSites;
}

/**
 * Scans the explicit production file list (absolute paths) and returns one
 * consumer entry per module showing at least one signal:
 * `{ path, signals, callSites }`, sorted by path. `signals` is the sorted
 * unique signal-kind set; `callSites` carries every concrete occurrence.
 */
export function scanPathConsumers({ repoRoot, files }) {
  const consumers = [];
  for (const file of files) {
    const callSites = extractPathConsumerCallSites(file);
    if (callSites.length > 0) {
      consumers.push({
        path: toPosix(path.relative(repoRoot, file)),
        signals: [...new Set(callSites.map((c) => c.signal))].sort(),
        callSites,
      });
    }
  }
  return consumers.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * Position-independent projection of a consumer entry for pre-gate diffing:
 * per-signal call-site COUNTS, not spans, so pure line drift never counts as
 * consumer drift while a new/removed fs, child_process, or workspace.fs site
 * since the pre-gate snapshot always does.
 */
export function consumerStabilityProjection(consumer) {
  const signalCounts = {};
  for (const site of consumer.callSites) {
    signalCounts[site.signal] = (signalCounts[site.signal] ?? 0) + 1;
  }
  return { path: consumer.path, signalCounts };
}

export function consumerStabilitySha256(consumer) {
  return sha256OfText(JSON.stringify(consumerStabilityProjection(consumer)));
}
