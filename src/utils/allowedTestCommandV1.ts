import * as fs from "node:fs";
import * as path from "node:path";

/**
 * bugs4 item 16: a Claude Code edit round runs shell commands only when the project's allow rules
 * permit them, and the targeted test form a model reaches for (`node --require … --test out/…`)
 * often matches none. This reads — never writes — the project's `package.json` scripts and
 * `.claude/settings*.json` allow rules, and names a targeted test command those rules allow, so
 * the round can produce the passing test report the gate needs. Ensemble never edits a
 * permission file; adding an allow rule stays the owner's choice.
 */

/** Script names that accept explicit test files, most specific first. */
const TARGETED_TEST_SCRIPTS_V1: readonly string[] = ["test:unit", "test:file", "test:one", "test:single"];

export interface AllowedTestCommandV1 {
  /** The command template, for example `pnpm run test:unit -- <test files>`. */
  readonly template: string;
  /** Whether a project allow rule permits the template's command prefix. */
  readonly allowedByProjectRules: boolean;
}

function readJsonObjectV1(filePath: string): Record<string, unknown> | undefined {
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(filePath, "utf8"));
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed) ? (parsed as Record<string, unknown>) : undefined;
  } catch {
    return undefined;
  }
}

function packageManagerRunnerV1(root: string): string {
  if (fs.existsSync(path.join(root, "pnpm-lock.yaml"))) return "pnpm run";
  if (fs.existsSync(path.join(root, "yarn.lock"))) return "yarn";
  return "npm run";
}

/** The `Bash(...)` allow rules from `.claude/settings.json` and `.claude/settings.local.json`. */
export function readProjectBashAllowRulesV1(root: string): readonly string[] {
  const rules: string[] = [];
  for (const name of ["settings.json", "settings.local.json"]) {
    const settings = readJsonObjectV1(path.join(root, ".claude", name));
    const permissions = settings?.permissions;
    const allow = permissions !== null && typeof permissions === "object" ? (permissions as { allow?: unknown }).allow : undefined;
    if (!Array.isArray(allow)) continue;
    for (const rule of allow) {
      if (typeof rule !== "string") continue;
      const match = /^Bash\((.*)\)$/.exec(rule.trim());
      if (match?.[1]) rules.push(match[1]);
    }
  }
  return rules;
}

/** True when an allow rule such as `pnpm run *` or `pnpm run test:unit` permits the command. */
export function bashRuleAllowsCommandV1(rule: string, command: string): boolean {
  const trimmed = rule.trim();
  if (trimmed.endsWith(":*")) return command.startsWith(trimmed.slice(0, -2));
  if (trimmed.endsWith("*")) return command.startsWith(trimmed.slice(0, -1));
  return command === trimmed;
}

/**
 * The targeted test command for this project, or undefined when its scripts offer none.
 * Prefers a script the project's own allow rules already permit.
 */
export function resolveAllowedTargetedTestCommandV1(root: string): AllowedTestCommandV1 | undefined {
  const manifest = readJsonObjectV1(path.join(root, "package.json"));
  const scripts = manifest?.scripts;
  if (scripts === null || typeof scripts !== "object") return undefined;
  const available = TARGETED_TEST_SCRIPTS_V1.filter((name) => typeof (scripts as Record<string, unknown>)[name] === "string");
  if (available.length === 0) return undefined;
  const runner = packageManagerRunnerV1(root);
  const rules = readProjectBashAllowRulesV1(root);
  const candidates = available.map((name) => {
    const command = `${runner} ${name}`;
    return {
      template: `${command} -- <test files>`,
      allowedByProjectRules: rules.some((rule) => bashRuleAllowsCommandV1(rule, command)),
    };
  });
  return candidates.find((candidate) => candidate.allowedByProjectRules) ?? candidates[0];
}

/**
 * The sentence the editing-round prompts carry. Empty when the project offers no targeted
 * script, so a prompt never names a command that does not exist.
 */
export function formatAllowedTestCommandGuidanceV1(root: string): string {
  const command = resolveAllowedTargetedTestCommandV1(root);
  if (!command) return "";
  const permitted = command.allowedByProjectRules
    ? "This project's allow rules already permit it."
    : "The project's allow rules may not permit it; if it is refused, report it as refused rather than trying another spelling.";
  return (
    `To run specific tests, use \`${command.template}\` (replace \`<test files>\` with the test files you changed or added). ` +
    `${permitted} Report the exact command with its passed and failed counts under \`## Verification\`.`
  );
}
