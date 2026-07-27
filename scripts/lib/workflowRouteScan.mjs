/**
 * Mechanical route-surface extraction for the workflow route inventory
 * (plan §1.2). TypeScript-compiler-based, like
 * generateTaskProgressFieldInventory.mjs: everything this module returns is
 * derived from the AST of the production sources plus package.json's
 * contribution manifest — no regexes over source text for anything that
 * carries a command identity, so a computed/dynamic command ID can never be
 * silently absorbed as a concrete route (plan §1.2: "Fail on unresolved
 * computed command IDs, ambiguous callbacks, dynamic provider dispatch").
 *
 * SOURCE-UNIVERSE ANCHORING (plan §1.1: "Route generation consumes this
 * source-universe file and cannot independently expand or filter it"): this
 * module does NOT walk the filesystem. Callers pass the exact production
 * source file list resolved by scripts/resolveProductionSourceUniverse.mjs
 * (live) or frozen in workflow-production-source-pregate-v1.json (pregate),
 * so the route surface can never include a module the shipping bundle does
 * not reach, and can never silently skip one it does.
 *
 * What is extracted:
 *  - commandRegistrations: every `*.registerCommand(<string literal>, …)`
 *    call in production sources, with its compiler-derived span and the
 *    enclosing function/class symbol. A `registerCommand` call whose first
 *    argument is NOT a string literal is returned separately in
 *    `unresolvedRegistrations` and fails verification unconditionally.
 *  - commandEdges: every `*.executeCommand(<string literal starting with
 *    "vs-code-ai-helper.">, …)` call — the internal scheduler / auto-advance
 *    / follow-up / wrapper edges the plan's route table requires. Each edge
 *    becomes a concrete `internalEdge` route row (buildMechanicalRouteRows),
 *    not a live-only side collection.
 *  - dynamicDispatches: every `*.executeCommand(<non-literal>, …)` call.
 *    Each one must be covered by a route annotation with edgeKind
 *    "dynamicCommandDispatch" (workflow-route-annotations-v1.json) or
 *    verification fails closed.
 *  - webviewMessageHandlers: every `*.onDidReceiveMessage(…)` registration —
 *    the webview entrypoint roots.
 *  - gateCalls: every `assertLegacyAiRouteAllowedV0("…")` /
 *    `isLegacyAiRouteDisabledV0("…")` call with its literal route id, so the
 *    inventory can prove per-file gate placement mechanically.
 *  - commandReferences: object-literal `command: "vs-code-ai-helper.…"`
 *    property bindings (tree-item click commands, status-bar menu defaults),
 *    so contributed-but-only-tree-bound commands still show their UI edge.
 *  - providerBoundaryCalls: every call to `resolveRunnerForModel(…)` or
 *    `runImplementationForModel(…)` — the two runnerRegistry.ts paths every
 *    command funnels a provider invocation through (the same boundary
 *    legacyAiActionSafetyGateV0.ts enforces). Each call site becomes a
 *    concrete `providerEdge` route row.
 *  - legacyOutputDestinations: every object-literal `outputFile:` /
 *    `outputFileUri:` property assignment (including shorthand) — the
 *    destinations the legacy runner protocol hands provider output to. Each
 *    site becomes a concrete `writerEdge` route row, so provider-to-writer
 *    coverage is mechanical rather than prose.
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const ts = require("typescript");

export const COMMAND_ID_PREFIX = "vs-code-ai-helper.";

/** The only two provider-invocation entrypoints (see legacyAiActionSafetyGateV0.ts's boundary contract). */
export const PROVIDER_BOUNDARY_CALLEES = new Set(["resolveRunnerForModel", "runImplementationForModel"]);

/** Legacy runner output-destination property names (src/types/agentRunner.ts protocol). */
export const LEGACY_OUTPUT_PROPERTY_NAMES = new Set(["outputFile", "outputFileUri"]);

export function toPosix(p) {
  return p.split(path.sep).join("/");
}

export function sha256OfText(text) {
  return crypto.createHash("sha256").update(text).digest("hex");
}

export function spanOf(sourceFile, node) {
  const start = sourceFile.getLineAndCharacterOfPosition(node.getStart(sourceFile));
  const end = sourceFile.getLineAndCharacterOfPosition(node.getEnd());
  return `L${start.line + 1}-L${end.line + 1}`;
}

export function spanStartLine(span) {
  const match = /^L(\d+)-L\d+$/.exec(span);
  return match ? Number(match[1]) : Number.MAX_SAFE_INTEGER;
}

/** Nearest named enclosing declaration (function, method, class, or variable initializer). */
export function enclosingSymbolOf(sourceFile, node) {
  let current = node.parent;
  while (current) {
    if ((ts.isFunctionDeclaration(current) || ts.isMethodDeclaration(current)) && current.name) {
      return current.name.getText(sourceFile);
    }
    if (ts.isClassDeclaration(current) && current.name) {
      return current.name.getText(sourceFile);
    }
    if (ts.isVariableDeclaration(current) && ts.isIdentifier(current.name)) {
      return current.name.getText(sourceFile);
    }
    current = current.parent;
  }
  return "(module)";
}

function calleePropertyName(callExpression) {
  const callee = callExpression.expression;
  if (ts.isPropertyAccessExpression(callee)) {
    return callee.name.text;
  }
  if (ts.isIdentifier(callee)) {
    return callee.text;
  }
  return null;
}

/**
 * Scans one production source file. Returns the per-file slices of the route
 * surface; `scanWorkflowRouteSurface` aggregates them.
 */
export function scanSourceFileForRoutes(repoRoot, absPath) {
  const relPath = toPosix(path.relative(repoRoot, absPath));
  const text = fs.readFileSync(absPath, "utf8");
  const sourceFile = ts.createSourceFile(absPath, text, ts.ScriptTarget.Latest, true);

  const result = {
    commandRegistrations: [],
    unresolvedRegistrations: [],
    commandEdges: [],
    dynamicDispatches: [],
    webviewMessageHandlers: [],
    gateCalls: [],
    commandReferences: [],
    providerBoundaryCalls: [],
    legacyOutputDestinations: [],
  };

  const visit = (node) => {
    if (ts.isCallExpression(node)) {
      const name = calleePropertyName(node);
      if (name === "registerCommand" && node.arguments.length > 0) {
        const arg0 = node.arguments[0];
        if (ts.isStringLiteralLike(arg0)) {
          result.commandRegistrations.push({
            commandId: arg0.text,
            path: relPath,
            span: spanOf(sourceFile, node),
            registrationSymbol: enclosingSymbolOf(sourceFile, node),
          });
        } else {
          result.unresolvedRegistrations.push({
            path: relPath,
            span: spanOf(sourceFile, node),
            expressionText: arg0.getText(sourceFile).replace(/\s+/g, " "),
          });
        }
      } else if (name === "executeCommand" && node.arguments.length > 0) {
        const arg0 = node.arguments[0];
        if (ts.isStringLiteralLike(arg0)) {
          if (arg0.text.startsWith(COMMAND_ID_PREFIX)) {
            result.commandEdges.push({
              commandId: arg0.text,
              path: relPath,
              span: spanOf(sourceFile, node),
              enclosingSymbol: enclosingSymbolOf(sourceFile, node),
            });
          }
          // Literal non-extension commands (setContext, markdown.showPreview,
          // workbench.*) are host commands, not workflow routes — ignored.
        } else {
          result.dynamicDispatches.push({
            path: relPath,
            span: spanOf(sourceFile, node),
            enclosingSymbol: enclosingSymbolOf(sourceFile, node),
            expressionText: arg0.getText(sourceFile).replace(/\s+/g, " "),
          });
        }
      } else if (name === "onDidReceiveMessage") {
        result.webviewMessageHandlers.push({
          path: relPath,
          span: spanOf(sourceFile, node),
          handlerSymbol: enclosingSymbolOf(sourceFile, node),
        });
      } else if (
        (name === "assertLegacyAiRouteAllowedV0" || name === "isLegacyAiRouteDisabledV0") &&
        node.arguments.length > 0 &&
        ts.isStringLiteralLike(node.arguments[0])
      ) {
        result.gateCalls.push({
          routeId: node.arguments[0].text,
          gateKind: name === "assertLegacyAiRouteAllowedV0" ? "throwing" : "query",
          path: relPath,
          span: spanOf(sourceFile, node),
          enclosingSymbol: enclosingSymbolOf(sourceFile, node),
        });
      } else if (name !== null && PROVIDER_BOUNDARY_CALLEES.has(name)) {
        result.providerBoundaryCalls.push({
          callee: name,
          path: relPath,
          span: spanOf(sourceFile, node),
          enclosingSymbol: enclosingSymbolOf(sourceFile, node),
        });
      }
    } else if (
      ts.isPropertyAssignment(node) &&
      ts.isIdentifier(node.name) &&
      node.name.text === "command" &&
      ts.isStringLiteralLike(node.initializer) &&
      node.initializer.text.startsWith(COMMAND_ID_PREFIX)
    ) {
      result.commandReferences.push({
        commandId: node.initializer.text,
        path: relPath,
        span: spanOf(sourceFile, node),
        enclosingSymbol: enclosingSymbolOf(sourceFile, node),
      });
    } else if (
      (ts.isPropertyAssignment(node) || ts.isShorthandPropertyAssignment(node)) &&
      ts.isIdentifier(node.name) &&
      LEGACY_OUTPUT_PROPERTY_NAMES.has(node.name.text)
    ) {
      // PropertyAssignment and shorthand only: interface/type members are
      // PropertySignatures and never match, so the runner protocol TYPE
      // declaration does not count as a write destination — only value sites
      // that hand a destination to (or echo one from) the legacy protocol.
      result.legacyOutputDestinations.push({
        propertyName: node.name.text,
        path: relPath,
        span: spanOf(sourceFile, node),
        enclosingSymbol: enclosingSymbolOf(sourceFile, node),
      });
    }
    ts.forEachChild(node, visit);
  };
  visit(sourceFile);
  return result;
}

/** package.json contribution surface: contributed commands + menu/keybinding references. */
export function readContributionSurface(packageJson) {
  const contributedCommands = new Set(
    (packageJson.contributes?.commands || []).map((c) => c.command)
  );
  const keyboundCommands = new Set(
    (packageJson.contributes?.keybindings || [])
      .map((k) => k.command)
      .filter((c) => typeof c === "string" && c.startsWith(COMMAND_ID_PREFIX))
  );
  /** commandId -> sorted list of menu locations referencing it */
  const menuReferences = new Map();
  for (const [menuLocation, entries] of Object.entries(packageJson.contributes?.menus || {})) {
    for (const entry of entries || []) {
      if (typeof entry.command !== "string") continue;
      if (!menuReferences.has(entry.command)) menuReferences.set(entry.command, new Set());
      menuReferences.get(entry.command).add(menuLocation);
    }
  }
  return {
    contributedCommands,
    keyboundCommands,
    menuReferences: new Map(
      [...menuReferences.entries()].map(([id, locations]) => [id, [...locations].sort()])
    ),
  };
}

/**
 * Aggregated mechanical route surface for an EXPLICIT production source file
 * list (absolute paths) — the resolved source universe, never a filesystem
 * walk (plan §1.1).
 */
export function scanWorkflowRouteSurface({ repoRoot, files, packageJson }) {
  const aggregate = {
    commandRegistrations: [],
    unresolvedRegistrations: [],
    commandEdges: [],
    dynamicDispatches: [],
    webviewMessageHandlers: [],
    gateCalls: [],
    commandReferences: [],
    providerBoundaryCalls: [],
    legacyOutputDestinations: [],
  };
  for (const file of files) {
    const perFile = scanSourceFileForRoutes(repoRoot, file);
    for (const key of Object.keys(aggregate)) {
      aggregate[key].push(...perFile[key]);
    }
  }
  for (const key of Object.keys(aggregate)) {
    aggregate[key].sort((a, b) =>
      `${a.path}#${a.span}#${a.commandId ?? a.routeId ?? a.callee ?? a.propertyName ?? ""}`.localeCompare(
        `${b.path}#${b.span}#${b.commandId ?? b.routeId ?? b.callee ?? b.propertyName ?? ""}`
      )
    );
  }
  return { ...aggregate, ...readContributionSurface(packageJson) };
}

/**
 * Stable route-row key. Edge-kind keys embed the position-independent
 * identity (path, enclosing symbol, target/callee/property) plus a 1-based
 * occurrence index among identical identities, so keys survive line drift.
 */
export function routeKeyOf(row) {
  switch (row.kind) {
    case "webviewMessage":
      return `webview:${row.path}#${row.handlerSymbol}`;
    case "internalEdge":
      return `edge:${row.path}#${row.enclosingSymbol}->${row.commandId}#${row.occurrence}`;
    case "providerEdge":
      return `provider:${row.path}#${row.enclosingSymbol}->${row.callee}#${row.occurrence}`;
    case "writerEdge":
      return `writer:${row.path}#${row.enclosingSymbol}.${row.propertyName}#${row.occurrence}`;
    default:
      return `command:${row.commandId}`;
  }
}

/** Assigns 1-based occurrence indexes to site rows sharing an identity key, in span order. */
function withOccurrences(sites, identityOf) {
  const groups = new Map();
  for (const site of sites) {
    const identity = identityOf(site);
    if (!groups.has(identity)) groups.set(identity, []);
    groups.get(identity).push(site);
  }
  const out = [];
  for (const group of groups.values()) {
    group.sort((a, b) => spanStartLine(a.span) - spanStartLine(b.span));
    group.forEach((site, index) => out.push({ ...site, occurrence: index + 1 }));
  }
  return out;
}

/**
 * Builds the concrete mechanical route rows from a scan: command roots,
 * webview roots, and — as first-class rows rather than side collections —
 * internal command edges, provider-boundary call sites, and legacy output
 * destinations (plan §1.2: "concrete route rows for commands, aliases,
 * schedulers, auto-advance, tree, webview, and internal edges, including
 * provider/writer edges"). Shared verbatim by the live generator and the
 * pregate snapshot generator so the two row shapes can never diverge.
 */
export function buildMechanicalRouteRows(scan) {
  const rows = [];
  const edgesByFile = new Map();
  for (const edge of scan.commandEdges) {
    if (!edgesByFile.has(edge.path)) edgesByFile.set(edge.path, new Set());
    edgesByFile.get(edge.path).add(edge.commandId);
  }
  const gatesByFile = new Map();
  for (const gate of scan.gateCalls) {
    if (!gatesByFile.has(gate.path)) gatesByFile.set(gate.path, new Set());
    gatesByFile.get(gate.path).add(gate.routeId);
  }
  const referencesByCommand = new Map();
  for (const ref of scan.commandReferences) {
    if (!referencesByCommand.has(ref.commandId)) referencesByCommand.set(ref.commandId, []);
    referencesByCommand.get(ref.commandId).push(`${ref.path}#${ref.span}`);
  }
  for (const registration of scan.commandRegistrations) {
    rows.push({
      kind: "command",
      commandId: registration.commandId,
      path: registration.path,
      span: registration.span,
      registrationSymbol: registration.registrationSymbol,
      contributed: scan.contributedCommands.has(registration.commandId),
      keybound: scan.keyboundCommands.has(registration.commandId),
      menus: scan.menuReferences.get(registration.commandId) ?? [],
      treeBindings: (referencesByCommand.get(registration.commandId) ?? []).sort(),
      fileGateRouteIds: [...(gatesByFile.get(registration.path) ?? [])].sort(),
      fileEdgesOut: [...(edgesByFile.get(registration.path) ?? [])].sort(),
    });
  }
  for (const handler of scan.webviewMessageHandlers) {
    rows.push({
      kind: "webviewMessage",
      path: handler.path,
      span: handler.span,
      handlerSymbol: handler.handlerSymbol,
      fileGateRouteIds: [...(gatesByFile.get(handler.path) ?? [])].sort(),
      fileEdgesOut: [...(edgesByFile.get(handler.path) ?? [])].sort(),
    });
  }
  for (const edge of withOccurrences(scan.commandEdges, (e) => `${e.path}#${e.enclosingSymbol}->${e.commandId}`)) {
    rows.push({
      kind: "internalEdge",
      commandId: edge.commandId,
      path: edge.path,
      span: edge.span,
      enclosingSymbol: edge.enclosingSymbol,
      occurrence: edge.occurrence,
    });
  }
  for (const call of withOccurrences(scan.providerBoundaryCalls, (c) => `${c.path}#${c.enclosingSymbol}->${c.callee}`)) {
    rows.push({
      kind: "providerEdge",
      callee: call.callee,
      path: call.path,
      span: call.span,
      enclosingSymbol: call.enclosingSymbol,
      occurrence: call.occurrence,
    });
  }
  for (const site of withOccurrences(scan.legacyOutputDestinations, (s) => `${s.path}#${s.enclosingSymbol}.${s.propertyName}`)) {
    rows.push({
      kind: "writerEdge",
      propertyName: site.propertyName,
      path: site.path,
      span: site.span,
      enclosingSymbol: site.enclosingSymbol,
      occurrence: site.occurrence,
    });
  }
  rows.sort((a, b) => routeKeyOf(a).localeCompare(routeKeyOf(b)));
  return rows;
}

/**
 * Position-independent projection of a route row, used to diff the live
 * surface against the immutable pre-gate snapshot: spans (and the span
 * component of tree bindings) are excluded, so pure line drift from
 * unrelated edits never counts as route drift, while every semantic
 * mechanical change (gate installed, menu added, edge target changed,
 * registration moved to another file/symbol) does.
 */
export function routeStabilityProjection(row) {
  switch (row.kind) {
    case "command":
      return {
        kind: row.kind,
        commandId: row.commandId,
        path: row.path,
        registrationSymbol: row.registrationSymbol,
        contributed: row.contributed,
        keybound: row.keybound,
        menus: row.menus,
        treeBindingPaths: [...new Set((row.treeBindings ?? []).map((b) => b.split("#")[0]))].sort(),
        fileGateRouteIds: row.fileGateRouteIds,
        fileEdgesOut: row.fileEdgesOut,
      };
    case "webviewMessage":
      return {
        kind: row.kind,
        path: row.path,
        handlerSymbol: row.handlerSymbol,
        fileGateRouteIds: row.fileGateRouteIds,
        fileEdgesOut: row.fileEdgesOut,
      };
    case "internalEdge":
      return { kind: row.kind, path: row.path, enclosingSymbol: row.enclosingSymbol, commandId: row.commandId, occurrence: row.occurrence };
    case "providerEdge":
      return { kind: row.kind, path: row.path, enclosingSymbol: row.enclosingSymbol, callee: row.callee, occurrence: row.occurrence };
    case "writerEdge":
      return { kind: row.kind, path: row.path, enclosingSymbol: row.enclosingSymbol, propertyName: row.propertyName, occurrence: row.occurrence };
    default:
      return { kind: row.kind, path: row.path };
  }
}

export function routeStabilitySha256(row) {
  return sha256OfText(JSON.stringify(routeStabilityProjection(row)));
}
