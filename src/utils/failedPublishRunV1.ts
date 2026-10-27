import * as crypto from "node:crypto";
import * as fs from "node:fs";
import * as path from "node:path";
import type { CompletionLintResult } from "./completionLint";
import { getPublishVerificationCommands } from "../config/settings";

export interface FailedPublishRunSnapshotV1 {
  readonly schemaVersion: 1;
  readonly taskFolder: string;
  readonly repositoryRoot: string;
  readonly verificationScopeId: string;
  readonly headCommit: string | null;
  readonly failedAt: string;
  readonly runner: { readonly platform: string; readonly nodeVersion: string; readonly packageManager: string | null };
  readonly commands: readonly {
    readonly command: string;
    readonly cwd: string;
    readonly phase: string;
    readonly exitCode: number | null;
  }[];
  /** Effective explicit setting, including the empty/default-selection case. */
  readonly configuredCommands?: readonly string[] | null;
  readonly failures: readonly {
    readonly command: string;
    readonly exitCode: number;
    readonly testFiles: readonly string[];
    readonly failureCount: number;
    /** True only when the complete pre-truncation failure index was captured. */
    readonly completeFailureIdentities?: boolean;
    readonly unidentifiedFailureCount: number;
  }[];
  /** Diagnostic hash of the command, runner, environment names, manifests, and lockfiles observed. */
  readonly observedInputFingerprint: string | null;
  /** Why the recorded evidence cannot yet authorize a failed-first rerun. */
  readonly compatibilityUnknownReason: string | null;
  /** Complete eligibility fingerprint; null until every execution input is proven. */
  readonly compatibilityFingerprint: string | null;
}

const INPUT_FILES = [
  "package.json",
  ".eslintrc.json",
  "pnpm-lock.yaml",
  "package-lock.json",
  "yarn.lock",
  "bun.lock",
  "bun.lockb",
  "pnpm-workspace.yaml",
  ".npmrc",
  ".yarnrc.yml",
  ".pnp.cjs",
  "tsconfig.json",
  "tsconfig.test.json",
  "test-stubs/register.js",
  "test-stubs/run-unit-tests.js",
  "test-stubs/repoLeakCheck.js",
  "test-stubs/vscode/index.js",
  "vitest.config.ts",
  "jest.config.js",
  "jest.config.cjs",
  "jest.config.ts",
  "playwright.config.ts",
  "tsconfig.vscode-1.93-compat.json",
] as const;
const PREPARATION_MAPPING_V1 = "root-tsconfig-test-to-out-test-current-source-v1";

function sha256(value: string | Uint8Array): string {
  return crypto.createHash("sha256").update(value).digest("hex");
}

function commandDirectory(repositoryRoot: string, command: string): string {
  const packageDir = /^\[([^\]]+)\]\s*/.exec(command)?.[1];
  return packageDir ? path.resolve(repositoryRoot, packageDir) : repositoryRoot;
}

function commandPhase(command: string): string {
  const normalized = command.toLowerCase();
  if (/\b(?:lint|eslint|prettier)\b/.test(normalized)) return "lint";
  if (/\b(?:check-types|typecheck|tsc)\b/.test(normalized)) return "type-check";
  if (/\b(?:test|verify|jest|vitest|mocha|node --test)\b/.test(normalized)) return "test";
  return "other";
}

function inputFileHashes(directories: readonly string[]): readonly { path: string; sha256: string | null }[] {
  const files = new Set<string>();
  for (const directory of directories) {
    for (const name of INPUT_FILES) files.add(path.join(directory, name));
    // Aggregate scripts frequently delegate to repository scripts and
    // compatibility configs that are not visible in the top-level package
    // script text (for example verify -> verify:workflow-safety -> the VS
    // Code compatibility check). Hash the complete execution-script tree and
    // all root tsconfig variants. This keeps same-HEAD script/config edits
    // from authorizing reuse without making ordinary application source edits
    // invalidate a failed-first run.
    for (const config of listFiles(directory, (name) => /^tsconfig(?:\..+)?\.json$/.test(name))) {
      files.add(config);
    }
    for (const script of listFiles(path.join(directory, "scripts"))) files.add(script);
  }
  return [...files].sort().map((file) => {
    try { return { path: file, sha256: sha256(fs.readFileSync(file)) }; }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return { path: file, sha256: "absent" };
      return { path: file, sha256: null };
    }
  });
}

function listFiles(root: string, include: (name: string) => boolean = () => true): string[] {
  const found: string[] = [];
  const visit = (directory: string): void => {
    let entries: fs.Dirent[];
    try { entries = fs.readdirSync(directory, { withFileTypes: true }); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const absolute = path.join(directory, entry.name);
      if (entry.isDirectory()) visit(absolute);
      else if (entry.isFile() && include(entry.name)) found.push(absolute);
    }
  };
  visit(root);
  return found;
}

function executableForCommand(command: string): { readonly command: string; readonly path: string | null; readonly sha256: string | null } {
  const unprefixed = command.replace(/^\[[^\]]+\]\s*/, "").trim();
  // Publish commands are shell programs, so this deliberately records only
  // an unambiguous first-word resolution. Compound shell expressions remain
  // diagnostic-only and cannot make a run eligible for reuse.
  const firstWord = /^(?:"([^"]+)"|'([^']+)'|(\S+))/.exec(unprefixed);
  const executable = firstWord?.[1] ?? firstWord?.[2] ?? firstWord?.[3];
  if (!executable || /[;&|<>$`()]/.test(executable)) return { command, path: null, sha256: null };
  const candidates = (process.env.PATH ?? "").split(path.delimiter).filter(Boolean)
    .map((directory) => path.resolve(directory, executable));
  const resolved = candidates.find((candidate) => {
    try { return fs.statSync(candidate).isFile(); } catch { return false; }
  });
  if (!resolved) return { command, path: null, sha256: null };
  try { return { command, path: resolved, sha256: sha256(fs.readFileSync(resolved)) }; }
  catch { return { command, path: resolved, sha256: null }; }
}

function hashExecutionEnvironment(): string {
  // Values stay private: only the digest is persisted. Names alone are not
  // sufficient because CI flags, NODE_OPTIONS, PATH and feature switches can
  // change which checks run or how the runner interprets them.
  return sha256(JSON.stringify(Object.entries(process.env).sort(([a], [b]) => a.localeCompare(b))));
}

function hasKnownCurrentSourceTestMapping(root: string, commands: readonly string[]): boolean {
  const packagePath = path.join(root, "package.json");
  try {
    const pkg = JSON.parse(fs.readFileSync(packagePath, "utf8")) as {
      packageManager?: unknown;
      scripts?: Record<string, unknown>;
    };
    const scripts = pkg.scripts ?? {};
    const expectedUnit = 'node -e "require(\'fs\').rmSync(\'out/test\',{recursive:true,force:true})" && tsc --project tsconfig.test.json && node test-stubs/run-unit-tests.js';
    const expectedTest = "npm run test:unit";
    const expectedVerify = "npm-run-all -s check-types lint test verify:workflow-safety";
    if (pkg.packageManager !== "pnpm@10.34.5" || scripts["test:unit"] !== expectedUnit ||
        scripts.test !== expectedTest || scripts.verify !== expectedVerify) return false;
    if (!commands.some((command) => /^(?:pnpm run verify|pnpm run test:unit|pnpm run test)$/.test(command.trim()))) return false;
    return ["tsconfig.test.json", "test-stubs/register.js", "test-stubs/run-unit-tests.js"].every((file) =>
      fs.statSync(path.join(root, file)).isFile()
    );
  } catch {
    return false;
  }
}

export function buildFailedPublishRunSnapshotV1(input: {
  readonly taskFolder: string;
  readonly repositoryRoot: string;
  readonly verificationScopeId: string;
  readonly headCommit?: string;
  readonly result: CompletionLintResult;
}): FailedPublishRunSnapshotV1 {
  const root = path.resolve(input.repositoryRoot);
  const commands = input.result.commandsRun?.map((command) => ({
    command,
    cwd: commandDirectory(root, command),
    phase: commandPhase(command),
    exitCode: input.result.failedChecks.find((failed) => failed.command === command)?.exitCode ?? null,
  })) ?? [];
  const failures = input.result.failedChecks.map((failure) => {
    const extracted = failure.failingTests;
    const testFiles = [...new Set((extracted?.tests ?? []).flatMap((test) => {
      if (!test.file) return [];
      const absolute = path.isAbsolute(test.file) ? path.resolve(test.file) : path.resolve(root, test.file);
      return [path.relative(root, absolute).replace(/\\/g, "/")];
    }))].sort();
    return {
      command: failure.command,
      exitCode: failure.exitCode,
      testFiles,
      failureCount: extracted?.total ?? 0,
      completeFailureIdentities: extracted !== undefined,
      unidentifiedFailureCount: extracted
        ? extracted.tests.filter((test) => !test.file).length + Math.max(0, extracted.total - extracted.tests.length)
        : 0,
    };
  });
  const runner = {
    platform: process.platform,
    nodeVersion: process.version,
    packageManager: input.result.verificationEnvironment?.packageManager ?? null,
  };
  const configuredCommands = getPublishVerificationCommands();
  const directories = [...new Set([root, ...commands.map((command) => command.cwd)])];
  const executableResolutions = commands.map((command) => executableForCommand(command.command));
  let executionInputs: readonly { path: string; sha256: string | null }[];
  try {
    executionInputs = inputFileHashes(directories);
  } catch {
    // Unreadable execution configuration is unknown evidence, not a reason
    // to abort Publish Checks and never authorization to reuse targets.
    executionInputs = [{ path: "<unreadable-execution-inputs>", sha256: null }];
  }
  // Unknown commands, cwd, or package-manager identity are deliberately not
  // reusable. The caller can still retain diagnostics, but a later run must
  // execute the complete selected command set.
  const completeInputsKnown = input.headCommit && input.verificationScopeId && commands.length > 0 &&
    input.result.verificationEnvironment?.cwd && runner.packageManager
    && commands.every(({ cwd }) => fs.existsSync(cwd))
    && executableResolutions.every(({ path: resolved }) => resolved !== null)
    && executableResolutions.every(({ sha256: executableHash }) => executableHash !== null)
    && hasKnownCurrentSourceTestMapping(root, commands.map(({ command }) => command))
    && executionInputs.every(({ sha256: fileHash }) => fileHash !== null);
  const compatibilityFingerprint = completeInputsKnown
    ? sha256(JSON.stringify({
        taskFolder: path.resolve(input.taskFolder),
        repositoryRoot: root,
        verificationScopeId: input.verificationScopeId,
        headCommit: input.headCommit,
        commands: commands.map(({ command, cwd, phase }) => ({ command, cwd, phase })),
        configuredCommands,
        executableResolutions,
        runner,
        preparationMapping: PREPARATION_MAPPING_V1,
        environmentDigest: hashExecutionEnvironment(),
        inputs: executionInputs,
      }))
    : null;
  const observedInputFingerprint = input.headCommit && input.verificationScopeId && commands.length > 0 &&
    input.result.verificationEnvironment?.cwd && runner.packageManager
    ? sha256(JSON.stringify({
        commands: commands.map(({ command, cwd, phase }) => ({ command, cwd, phase })),
        configuredCommands,
        executableResolutions,
        runner,
        environmentDigest: hashExecutionEnvironment(),
        inputs: executionInputs,
      }))
    : null;
  return {
    schemaVersion: 1,
    taskFolder: path.resolve(input.taskFolder),
    repositoryRoot: root,
    verificationScopeId: input.verificationScopeId,
    headCommit: input.headCommit ?? null,
    failedAt: input.result.runAt,
    runner,
    commands,
    configuredCommands,
    failures,
    observedInputFingerprint,
    compatibilityUnknownReason: compatibilityFingerprint
      ? null
      : "The command plan, execution environment, repository binding, or HEAD is incomplete; reruns require the full check set.",
    compatibilityFingerprint,
  };
}

export type FailedPublishFirstTargetV1 =
  | { readonly kind: "test-files"; readonly command: string; readonly cwd: string; readonly testFiles: readonly string[]; readonly prepareCommand: string }
  | { readonly kind: "failed-command"; readonly command: string; readonly executableCommand: string; readonly cwd: string; readonly reason: string };

/** Unknown evidence or any command/toolchain/task binding change forces full verification. */
export function isFailedPublishRunCompatibleV1(
  previous: FailedPublishRunSnapshotV1,
  current: FailedPublishRunSnapshotV1
): boolean {
  return previous.compatibilityFingerprint !== null &&
    current.compatibilityFingerprint !== null &&
    previous.compatibilityFingerprint === current.compatibilityFingerprint &&
    previous.taskFolder === current.taskFolder &&
    previous.repositoryRoot === current.repositoryRoot &&
    previous.verificationScopeId === current.verificationScopeId &&
    previous.headCommit !== null &&
    previous.headCommit === current.headCommit &&
    previous.configuredCommands !== undefined &&
    current.configuredCommands !== undefined &&
    JSON.stringify(previous.configuredCommands) === JSON.stringify(current.configuredCommands);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

/**
 * Build safe first-pass commands from a compatible failed-run snapshot.
 * Only root TypeScript unit tests compiled by this repository's test config
 * have a known current-source preparation path. Other runners, missing files,
 * and ambiguous compiled paths deliberately rerun their complete failed
 * command instead of omitting a failure.
 */
export function buildFailedPublishFirstTargetsV1(
  snapshot: FailedPublishRunSnapshotV1
): readonly FailedPublishFirstTargetV1[] {
  return snapshot.failures.map((failure) => {
    const command = snapshot.commands.find((entry) => entry.command === failure.command);
    const recognizedRootTestCommand = command?.cwd === snapshot.repositoryRoot &&
      hasKnownCurrentSourceTestMapping(snapshot.repositoryRoot, [failure.command]) &&
      /^(?:pnpm run verify|pnpm run test:unit|pnpm run test)$/.test(failure.command.trim());
    const targets = failure.testFiles.map((file) => {
      const normalized = file.replace(/\\/g, "/");
      if (!normalized.startsWith("out/test/") || !normalized.endsWith(".js")) return undefined;
      const source = path.resolve(snapshot.repositoryRoot, normalized.replace(/^out\/test\//, "src/test/").replace(/\.js$/, ".ts"));
      const output = path.resolve(snapshot.repositoryRoot, normalized);
      if (!source.startsWith(`${snapshot.repositoryRoot}${path.sep}`) || !output.startsWith(`${snapshot.repositoryRoot}${path.sep}`)) return undefined;
      return fs.existsSync(source) ? normalized : undefined;
    });
    if (recognizedRootTestCommand && failure.completeFailureIdentities === true && failure.unidentifiedFailureCount === 0 &&
        targets.length > 0 && targets.every((target): target is string => Boolean(target))) {
      const uniqueTargets = [...new Set(targets)];
      return {
        kind: "test-files" as const,
        cwd: snapshot.repositoryRoot,
        testFiles: uniqueTargets,
        prepareCommand: "pnpm exec tsc --project tsconfig.test.json",
        command: `node --require ./test-stubs/register.js --test ${uniqueTargets.map(shellQuote).join(" ")}`,
      };
    }
    return {
      kind: "failed-command" as const,
      command: failure.command,
      executableCommand: failure.command.replace(/^\[[^\]]+\]\s*/, ""),
      cwd: command?.cwd ?? snapshot.repositoryRoot,
      reason: !recognizedRootTestCommand
        ? "The failed command uses an unsupported runner or package scope; rerun the complete failed command first."
        : "One or more failed test identities are unavailable or not safely mapped to current source; rerun the complete failed command first.",
    };
  });
}

export async function writeFailedPublishRunSnapshotV1(
  taskFolder: string,
  snapshot: FailedPublishRunSnapshotV1
): Promise<void> {
  const runsDirectory = path.join(taskFolder, "runs");
  await fs.promises.mkdir(runsDirectory, { recursive: true });
  await fs.promises.writeFile(
    path.join(runsDirectory, "failed-publish-run-v1.json"),
    `${JSON.stringify(snapshot, null, 2)}\n`,
    "utf8"
  );
}

export async function readFailedPublishRunSnapshotV1(taskFolder: string): Promise<FailedPublishRunSnapshotV1 | undefined> {
  try {
    const value = JSON.parse(await fs.promises.readFile(
      path.join(taskFolder, "runs", "failed-publish-run-v1.json"), "utf8"
    )) as FailedPublishRunSnapshotV1;
    if (value.schemaVersion !== 1 || !Array.isArray(value.commands) || !Array.isArray(value.failures)) return undefined;
    return value;
  } catch {
    return undefined;
  }
}

export async function clearFailedPublishRunSnapshotV1(taskFolder: string): Promise<void> {
  try {
    await fs.promises.unlink(path.join(taskFolder, "runs", "failed-publish-run-v1.json"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}
