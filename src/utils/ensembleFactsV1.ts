/**
 * review1 Step 44: facts Ensemble already knows about itself and this window, written into the context pack so a
 * review uses them instead of filing "owner evidence needed" for them (the effective
 * `ensemble.publishVerificationCommands` value, the Publish Checks command auto-detection would run, whether the
 * window is single-folder or multi-root, the Ensemble version, the provider CLI majors last read on this machine).
 *
 * The formatter is pure; `gatherEnsembleFactsV1` reads the live values and every read is best effort.
 */
import * as vscode from "vscode";
import * as nodeFs from "fs";
import * as nodePath from "path";
import { getExtensionContextV1 } from "./extensionContextV1";
import { lastKnownCliMajorV1 } from "./cliMajorVersionV1";
import { resolveCurrentPublishCommandPlanV1 } from "./completionLint";

export const ENSEMBLE_FACTS_HEADING_V1 = "## Ensemble facts";

/** Provider CLI commands whose last-read major version is worth stating. */
export const KNOWN_PROVIDER_CLI_COMMANDS_V1: readonly string[] = ["claude", "codex", "gemini", "copilot", "opencode", "agy", "kimi"];

export interface EnsembleFactsV1 {
  /** The explicitly configured commands (empty when none), and the settings scope they came from. */
  readonly publishCommands: { readonly values: readonly string[]; readonly source: string };
  /** The commands Publish Checks would auto-detect for the workspace root, or undefined when unknown. */
  readonly autoDetectedPublishCommands: readonly string[] | undefined;
  readonly windowKind: "single-folder" | "multi-root" | "no folder";
  readonly folderCount: number;
  readonly ensembleVersion: string | undefined;
  /** Provider CLI command -> major version last read on this machine (only those that were read). */
  readonly providerCliMajors: Readonly<Record<string, number>>;
}

/** The section's lines (heading first, blank line after), ready to push into a context pack. */
export function formatEnsembleFactsSectionV1(facts: EnsembleFactsV1): string[] {
  const lines: string[] = [ENSEMBLE_FACTS_HEADING_V1, ""];
  lines.push(
    "_Ensemble measured these itself. Do not file an owner-evidence or owner-decision blocker for anything listed here._"
  );
  lines.push("");
  if (facts.publishCommands.values.length > 0) {
    lines.push(
      `- \`ensemble.publishVerificationCommands\` (effective, from ${facts.publishCommands.source}): ${facts.publishCommands.values
        .map((value) => `\`${value}\``)
        .join(", ")}`
    );
  } else {
    lines.push(
      `- \`ensemble.publishVerificationCommands\` (effective): not set (${facts.publishCommands.source}), so Publish Checks auto-detect their commands.`
    );
  }
  if (facts.autoDetectedPublishCommands === undefined) {
    lines.push("- Publish Checks command auto-detection would select: unknown for this workspace.");
  } else if (facts.autoDetectedPublishCommands.length === 0) {
    lines.push("- Publish Checks command auto-detection would select: nothing (no lint, check-types, test or build script found).");
  } else {
    lines.push(
      `- Publish Checks command auto-detection would select: ${facts.autoDetectedPublishCommands
        .map((value) => `\`${value}\``)
        .join(", ")}` +
        (facts.publishCommands.values.length > 0 ? " (the configured commands above take precedence)." : ".")
    );
  }
  lines.push(
    facts.windowKind === "multi-root"
      ? `- Window: multi-root (${facts.folderCount} folders).`
      : facts.windowKind === "single-folder"
        ? "- Window: single folder."
        : "- Window: no folder open."
  );
  lines.push(`- Ensemble version: ${facts.ensembleVersion ?? "unknown"}.`);
  const clis = Object.entries(facts.providerCliMajors);
  lines.push(
    clis.length > 0
      ? `- Provider CLI major versions last read on this machine: ${clis.map(([command, major]) => `${command} ${major}`).join(", ")}.`
      : "- Provider CLI versions: none read yet on this machine."
  );
  lines.push("");
  return lines;
}

function describeSettingSourceV1(inspected: ReturnType<vscode.WorkspaceConfiguration["inspect"]> | undefined): {
  values: string[];
  source: string;
} {
  const pick = (value: unknown): string[] | undefined =>
    Array.isArray(value) ? value.filter((v): v is string => typeof v === "string" && v.trim().length > 0).map((v) => v.trim()) : undefined;
  const candidates: ReadonlyArray<readonly [string, unknown]> = [
    ["the workspace folder settings", inspected?.workspaceFolderValue],
    ["the workspace settings", inspected?.workspaceValue],
    ["the user settings", inspected?.globalValue],
  ];
  for (const [source, value] of candidates) {
    const values = pick(value);
    if (values !== undefined && values.length > 0) {
      return { values, source };
    }
  }
  return { values: [], source: "no value in the workspace-folder, workspace or user settings" };
}

function readEnsembleVersionV1(): string | undefined {
  try {
    const root = getExtensionContextV1()?.extensionUri.fsPath;
    if (root === undefined) return undefined;
    const parsed = JSON.parse(nodeFs.readFileSync(nodePath.join(root, "package.json"), "utf8")) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

/** Read the live facts for `workspaceUri`. Every source is optional: an unreadable one is reported as unknown. */
export function gatherEnsembleFactsV1(workspaceUri: vscode.Uri): EnsembleFactsV1 {
  let publishCommands: EnsembleFactsV1["publishCommands"] = { values: [], source: "unreadable" };
  try {
    publishCommands = describeSettingSourceV1(
      vscode.workspace.getConfiguration("ensemble", workspaceUri).inspect("publishVerificationCommands")
    );
  } catch {
    // keep the "unreadable" placeholder
  }
  let autoDetected: readonly string[] | undefined;
  try {
    const plan = resolveCurrentPublishCommandPlanV1(workspaceUri.fsPath);
    autoDetected = plan === null ? undefined : plan;
  } catch {
    autoDetected = undefined;
  }
  const folderCount = vscode.workspace.workspaceFolders?.length ?? 0;
  const providerCliMajors: Record<string, number> = {};
  for (const command of KNOWN_PROVIDER_CLI_COMMANDS_V1) {
    const major = lastKnownCliMajorV1(command);
    if (major !== undefined) providerCliMajors[command] = major;
  }
  return {
    publishCommands,
    autoDetectedPublishCommands: autoDetected,
    windowKind: folderCount > 1 ? "multi-root" : folderCount === 1 ? "single-folder" : "no folder",
    folderCount,
    ensembleVersion: readEnsembleVersionV1(),
    providerCliMajors,
  };
}

/** The section for `workspaceUri`, never throwing: a context pack must still build when a fact cannot be read. */
export function buildEnsembleFactsSectionV1(workspaceUri: vscode.Uri): string[] {
  try {
    return formatEnsembleFactsSectionV1(gatherEnsembleFactsV1(workspaceUri));
  } catch {
    return [];
  }
}
