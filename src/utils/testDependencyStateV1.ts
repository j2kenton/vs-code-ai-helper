import * as crypto from "crypto";
import * as fs from "fs";
import * as path from "path";

/**
 * review1 Step 15: what a passing test report depends on, so it can be carried forward across rounds.
 *
 * A report used to be thrown out by ANY later edit to a file the round had changed, so a polish edit to an
 * unrelated file sent every test-dependent item back to provisional (review1 item 1: three rounds re-running the
 * same passing tests). The report now records a content hash of its test files, of the files those test files
 * import directly (relative imports, one level), and of the project files that change what a test run means
 * (`package.json`, the lockfile, `tsconfig*.json`, a test-runner config). The report stays valid while all of
 * those hashes are unchanged. Publish Checks still run every test before Commit & Push; a carried report only
 * counts toward the stage gate during the review loop.
 */
export interface TestDependencyStateV1 {
  /** Workspace-relative path, forward slashes. */
  readonly path: string;
  readonly sha256: string;
}

export const MAX_TEST_DEPENDENCY_STATES_V1 = 100;

const TEST_FILE_TOKEN_RE = /[\w@.\-/\\]+?\.(?:test|spec)\.(?:[cm]?[jt]sx?)(?![\w-])/gi;
const IMPORT_RE =
  /(?:import|export)\s[^'"`;]*?from\s*['"](\.{1,2}\/[^'"]+)['"]|(?:import|require)\(\s*['"](\.{1,2}\/[^'"]+)['"]\s*\)|import\s+['"](\.{1,2}\/[^'"]+)['"]/g;
const RESOLVE_SUFFIXES = ["", ".ts", ".tsx", ".mts", ".cts", ".js", ".jsx", ".mjs", ".cjs", ".json", "/index.ts", "/index.tsx", "/index.js"];

/** Project files whose change alters what a test run means. */
const CONFIG_FILE_RES: readonly RegExp[] = [
  /^package\.json$/,
  /^(?:pnpm-lock\.yaml|package-lock\.json|yarn\.lock|bun\.lockb?|npm-shrinkwrap\.json)$/,
  /^tsconfig[\w.-]*\.json$/,
  /^(?:vitest|vite|jest|playwright|mocha)[\w.-]*\.config\.[cm]?[jt]s$/,
  /^\.mocharc(?:\.[\w]+)?$/,
  /^jest\.config\.json$/,
];

/** True for a project file whose change drops every carried report (package.json, lockfile, tsconfig, runner config). */
export function isTestRunConfigFileV1(relativePath: string): boolean {
  const normalized = relativePath.replace(/\\/g, "/").replace(/^\.\//, "");
  return !normalized.includes("/") && CONFIG_FILE_RES.some((re) => re.test(normalized));
}

function toWorkspaceRelative(workspaceRoot: string, absolute: string): string | undefined {
  const relative = path.relative(workspaceRoot, absolute);
  if (relative === "" || relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) {
    return undefined;
  }
  return relative.replace(/\\/g, "/");
}

async function hashFile(absolute: string): Promise<string | undefined> {
  try {
    return crypto.createHash("sha256").update(await fs.promises.readFile(absolute)).digest("hex");
  } catch {
    return undefined;
  }
}

async function fileExists(absolute: string): Promise<boolean> {
  try {
    return (await fs.promises.stat(absolute)).isFile();
  } catch {
    return false;
  }
}

/** The test files a command or test identity names (source or compiled), as written. */
export function extractTestFileTokensV1(...texts: readonly (string | undefined)[]): string[] {
  const found = new Set<string>();
  for (const text of texts) {
    for (const match of (text ?? "").matchAll(TEST_FILE_TOKEN_RE)) {
      found.add(match[0].replace(/\\/g, "/").replace(/^\.\//, "").replace(/^[([{'"`]+/, ""));
    }
  }
  return [...found];
}

async function resolveTestFile(workspaceRoot: string, token: string): Promise<string | undefined> {
  const asSource = token.replace(/\.js$/i, ".ts").replace(/^out\//, "src/");
  const base = path.basename(token);
  const candidates = [
    token,
    asSource,
    `src/test/${base}`,
    `src/test/${base.replace(/\.js$/i, ".ts")}`,
    `test/${base}`,
    `tests/${base}`,
  ];
  for (const candidate of candidates) {
    const absolute = path.resolve(workspaceRoot, candidate);
    if (toWorkspaceRelative(workspaceRoot, absolute) && (await fileExists(absolute))) return absolute;
  }
  return undefined;
}

/**
 * Every file a relative import may resolve to. `./x.js` in a TypeScript source names `./x.ts` (TypeScript prefers
 * the source), but a literal `./x.js` may also exist, so both are returned: tracking an extra file only makes the
 * report drop sooner, while tracking the wrong one would let a stale report count.
 */
async function resolveRelativeImport(fromFile: string, specifier: string): Promise<string[]> {
  const base = path.resolve(path.dirname(fromFile), specifier);
  const withoutJs = base.replace(/\.[cm]?js$/i, "");
  const found: string[] = [];
  const candidateBases = withoutJs === base ? [base] : [withoutJs, base];
  for (const candidateBase of candidateBases) {
    for (const suffix of RESOLVE_SUFFIXES) {
      const candidate = `${candidateBase}${suffix}`;
      if (!found.includes(candidate) && (await fileExists(candidate))) found.push(candidate);
    }
    // A specifier without a `.js` extension has only one base to try.
    if (withoutJs === base && found.length > 0) break;
  }
  return found;
}

/**
 * Content hashes for the test files a report names, the files those test files import directly, and the project's
 * config files. Returns an empty list when no named test file can be found (such a report cannot be carried and
 * keeps the older, stricter rule).
 */
export async function computeTestDependencyStatesV1(
  workspaceRoot: string,
  texts: readonly (string | undefined)[]
): Promise<TestDependencyStateV1[]> {
  const testFiles: string[] = [];
  for (const token of extractTestFileTokensV1(...texts)) {
    const resolved = await resolveTestFile(workspaceRoot, token);
    if (resolved && !testFiles.includes(resolved)) testFiles.push(resolved);
  }
  if (testFiles.length === 0) return [];
  // Config files go first so the state cap can never drop one: a missing config entry would be read as "added".
  const absolutePaths = new Set<string>();
  for (const name of await fs.promises.readdir(workspaceRoot).catch(() => [] as string[])) {
    if (isTestRunConfigFileV1(name)) absolutePaths.add(path.join(workspaceRoot, name));
  }
  for (const testFile of testFiles) absolutePaths.add(testFile);
  for (const testFile of testFiles) {
    let source: string;
    try {
      source = await fs.promises.readFile(testFile, "utf8");
    } catch {
      // Its imports cannot be listed, so the dependency set is incomplete: fail closed.
      return [];
    }
    for (const match of source.matchAll(IMPORT_RE)) {
      const specifier = match[1] ?? match[2] ?? match[3];
      if (!specifier) continue;
      for (const resolved of await resolveRelativeImport(testFile, specifier)) absolutePaths.add(resolved);
    }
  }
  // A truncated or partially hashed snapshot would let an omitted dependency change without invalidating the
  // report, so an incomplete set is never returned: the report then cannot be carried (older, stricter rule).
  if (absolutePaths.size > MAX_TEST_DEPENDENCY_STATES_V1) return [];
  const states: TestDependencyStateV1[] = [];
  for (const absolute of absolutePaths) {
    const relative = toWorkspaceRelative(workspaceRoot, absolute);
    const sha256 = await hashFile(absolute);
    if (!relative || !sha256) return [];
    states.push({ path: relative, sha256 });
  }
  return states;
}

/**
 * True when every recorded dependency still exists with the same content, and no test-run config file (a runner
 * config, tsconfig, manifest or lockfile) has been added at the workspace root since the report was recorded.
 * `computeTestDependencyStatesV1` returns an empty list (so this returns false) when the full set can't be recorded.
 */
export async function testDependencyStatesStillCurrentV1(
  states: readonly TestDependencyStateV1[],
  workspaceRoot: string | undefined
): Promise<boolean> {
  if (!workspaceRoot || states.length === 0) return false;
  for (const state of states) {
    const absolute = path.resolve(workspaceRoot, state.path);
    if (!toWorkspaceRelative(workspaceRoot, absolute) || !/^[a-f0-9]{64}$/i.test(state.sha256)) return false;
    if ((await hashFile(absolute)) !== state.sha256) return false;
  }
  const recorded = new Set(states.map((state) => state.path.replace(/\\/g, "/").replace(/^\.\//, "")));
  for (const name of await fs.promises.readdir(workspaceRoot).catch(() => [] as string[])) {
    if (isTestRunConfigFileV1(name) && !recorded.has(name)) return false;
  }
  return true;
}
