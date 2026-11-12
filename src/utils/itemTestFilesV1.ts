import { extractTestFileTokensV1 } from "./testDependencyStateV1";

/**
 * bugs7 item 1: ONE resolver for "this plan item's test files", used by the claim matcher (a round's own report) and
 * the evidence-gap matcher (Publish Checks output). Two matchers that each accepted only `.test.`/`.spec.` names
 * kept refusing passing reports over wording (bugs6 items 11, 25, review2's fresh-report rule, bare module names).
 *
 * Sources, in order, the first non-empty one wins: (a) the files the item's own text names, (b) the files the claim's
 * evidence names, (c) the test files the rounds that built or claimed the item added or changed, (d) the commands of
 * rejected reports. A name is a path with or without a directory, with or without `.test`/`.spec` and the extension,
 * compiled or source (`out/test/x.test.js` is `src/test/x.test.ts`). It only counts when it matches a known test file;
 * the whole evidence sentence is never a path. A name that fits several known files is ambiguous and settles nothing.
 */

export interface ItemTestFilesContextV1 {
  /** Workspace-relative paths of the known test files, forward slashes. */
  readonly knownTestFiles: readonly string[];
  /** Test files the rounds that built or claimed the item added or changed (workspace-relative). */
  readonly roundChangedTestFiles?: readonly string[];
  /** True when the workspace scan hit its cap: a bare name cannot be trusted to be unique. */
  readonly knownFilesCapped?: boolean;
  /** Per-item historical round files, keyed by the normalized item text (the evidence row's `itemKey`). */
  readonly roundChangedTestFilesByItemKey?: Readonly<Record<string, readonly string[]>>;
}

/** The context narrowed to one item: its own historical round files join the round files the caller already had. */
export function contextForItemV1(context: ItemTestFilesContextV1 | undefined, itemKey: string): ItemTestFilesContextV1 | undefined {
  if (!context) return undefined;
  const own = context.roundChangedTestFilesByItemKey?.[itemKey] ?? [];
  if (own.length === 0) return context;
  return { ...context, roundChangedTestFiles: [...new Set([...(context.roundChangedTestFiles ?? []), ...own])] };
}

export type ItemTestFileSourceV1 = "item" | "evidence" | "round" | "rejected" | "none";

export interface AmbiguousTestNameV1 {
  readonly name: string;
  readonly candidates: readonly string[];
}

export interface ResolvedItemTestFilesV1 {
  readonly files: readonly string[];
  readonly source: ItemTestFileSourceV1;
  readonly ambiguous: readonly AmbiguousTestNameV1[];
}

/** The reason an item with an ambiguous name and no other resolved file stays provisional. */
export function ambiguousTestNameReasonV1(ambiguous: readonly AmbiguousTestNameV1[]): string {
  const first = ambiguous[0];
  if (!first) return "no test file could be identified for this item (name the test file, for example `foo.test.ts`)";
  return `\`${first.name}\` could be more than one test file (${first.candidates.map((c) => `\`${c}\``).join(", ")}); name the path`;
}

const WORD_STOPLIST = new Set(["the", "these", "those", "new", "unit", "all", "its", "our", "and", "for", "that", "this", "test", "tests", "spec", "specs", "integration"]);

function normalizeSlashes(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\.\//, "").replace(/^[([{'"`]+|[)\]}'"`,;:.]+$/g, "");
}

/**
 * Lower-cased path, extension dropped, `.test`/`.spec` dropped, each `out`/`dist` segment read as `src`.
 * `out/test/x.test.js`, `src/test/x.test.ts` and `src/test/x` all give `src/test/x`.
 */
export function testPathKeyV1(file: string): string {
  const segments = normalizeSlashes(file)
    .toLowerCase()
    .split("/")
    .filter((s) => s !== "" && s !== ".")
    .map((s) => (s === "out" || s === "dist" ? "src" : s));
  const last = segments.pop();
  if (last === undefined) return "";
  const stem = last.replace(/\.(?:[cm]?[jt]sx?)$/, "").replace(/\.(?:test|spec)$/, "");
  return [...segments, stem].join("/");
}

function stemOfKey(key: string): string {
  return key.split("/").pop() ?? key;
}

function underDir(file: string, dir: string): boolean {
  const f = normalizeSlashes(file).toLowerCase();
  const d = normalizeSlashes(dir).toLowerCase().replace(/\/+$/, "");
  return d !== "" && (f === d || f.startsWith(`${d}/`));
}

function keyEndsWith(longer: string, shorter: string): boolean {
  return longer === shorter || longer.endsWith(`/${shorter}`);
}

export type TestNameResolutionV1 =
  | { readonly kind: "file"; readonly file: string }
  | { readonly kind: "ambiguous"; readonly candidates: readonly string[] }
  | { readonly kind: "none" };

/**
 * Resolves one name against the known test files. A name with directories matches the files whose path key ends with
 * its path key; a bare name matches by stem. `preferred` (the round-changed files) breaks a tie when exactly one
 * candidate is in it; `baseDir` (a command's working directory) does the same for the files under it.
 */
export function resolveTestNameV1(
  name: string,
  context: ItemTestFilesContextV1,
  options: { readonly baseDir?: string } = {}
): TestNameResolutionV1 {
  // A source file (`foo.ts`) is not a test file; only a test suffix, or no extension at all, names one.
  if (/\.[cm]?[jt]sx?$/i.test(name) && !/\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name)) return { kind: "none" };
  const key = testPathKeyV1(name);
  if (key === "") return { kind: "none" };
  const hasDirs = key.includes("/");
  const keyed = context.knownTestFiles.map((file) => ({ file, key: testPathKeyV1(file) }));
  let candidates = keyed.filter((entry) => (hasDirs ? keyEndsWith(entry.key, key) : stemOfKey(entry.key) === key));
  if (candidates.length === 0) return { kind: "none" };
  if (candidates.length > 1 && options.baseDir) {
    const base = options.baseDir;
    const exact = candidates.filter((entry) => entry.key === `${testPathKeyV1(`${base}/x`).slice(0, -1)}${key}`);
    const narrowed = exact.length > 0 ? exact : candidates.filter((entry) => underDir(entry.file, base));
    if (narrowed.length === 1) candidates = narrowed;
  }
  if (candidates.length === 1) {
    const only = candidates[0]!;
    return !hasDirs && context.knownFilesCapped === true ? { kind: "ambiguous", candidates: [only.file] } : { kind: "file", file: only.file };
  }
  const changed = new Set((context.roundChangedTestFiles ?? []).map((f) => normalizeSlashes(f).toLowerCase()));
  const inRound = candidates.filter((entry) => changed.has(entry.file.toLowerCase()));
  if (inRound.length === 1) return { kind: "file", file: inRound[0]!.file };
  return { kind: "ambiguous", candidates: candidates.map((entry) => entry.file) };
}

/**
 * The names a text gives as test files: `.test.`/`.spec.` tokens, backticked single tokens, a word right before
 * "test(s)", and camelCase identifiers. Whether any of them is a test file is decided by the known files.
 */
export function extractTestNamesV1(text: string | undefined): string[] {
  if (!text) return [];
  const names = new Set<string>();
  for (const token of extractTestFileTokensV1(text)) names.add(token);
  for (const match of text.matchAll(/`([^`\s]+)`/g)) names.add(normalizeSlashes(match[1] ?? ""));
  for (const match of text.matchAll(/(?<![\w@./\\-])([A-Za-z][\w-]*)\s+(?:test|tests|spec|specs)\b/g)) {
    const word = match[1] ?? "";
    if (!WORD_STOPLIST.has(word.toLowerCase())) names.add(word);
  }
  for (const match of text.matchAll(/(?<![\w@./\\-])([a-z][a-z0-9]*[A-Z][\w]*)(?![\w/\\])/g)) names.add(match[1] ?? "");
  return [...names].filter((n) => n !== "");
}

function resolveNames(
  names: readonly string[],
  context: ItemTestFilesContextV1 | undefined
): { files: string[]; ambiguous: AmbiguousTestNameV1[] } {
  const files: string[] = [];
  const ambiguous: AmbiguousTestNameV1[] = [];
  const seen = new Set<string>();
  const add = (file: string): void => {
    const key = testPathKeyV1(file);
    if (!seen.has(key)) {
      seen.add(key);
      files.push(file);
    }
  };
  for (const name of names) {
    const hasTestSuffix = /\.(?:test|spec)\.[cm]?[jt]sx?$/i.test(name);
    if (!context || context.knownTestFiles.length === 0) {
      // No file list to check against: only a name that is a test file by its own suffix counts, as written.
      if (hasTestSuffix) add(normalizeSlashes(name));
      continue;
    }
    const resolved = resolveTestNameV1(name, context);
    if (resolved.kind === "file") add(resolved.file);
    else if (resolved.kind === "ambiguous") ambiguous.push({ name, candidates: resolved.candidates });
  }
  return { files, ambiguous };
}

export interface ResolveItemTestFilesInputV1 {
  readonly itemText: string;
  readonly evidenceText?: string;
  readonly rejectedReportTexts?: readonly string[];
  readonly context?: ItemTestFilesContextV1;
}

/** The item's test files and where they came from. */
export function resolveItemTestFilesV1(input: ResolveItemTestFilesInputV1): ResolvedItemTestFilesV1 {
  const ambiguous: AmbiguousTestNameV1[] = [];
  const attempt = (source: ItemTestFileSourceV1, names: readonly string[]): ResolvedItemTestFilesV1 | undefined => {
    const resolved = resolveNames(names, input.context);
    ambiguous.push(...resolved.ambiguous);
    return resolved.files.length > 0 ? { files: resolved.files, source, ambiguous } : undefined;
  };
  const hit =
    attempt("item", extractTestNamesV1(input.itemText)) ??
    attempt("evidence", extractTestNamesV1(input.evidenceText)) ??
    attempt("round", [...(input.context?.roundChangedTestFiles ?? [])]) ??
    attempt("rejected", extractTestFileTokensV1(...(input.rejectedReportTexts ?? [])));
  return hit ?? { files: [], source: "none", ambiguous };
}

/**
 * Whether a command's (or output's) tokens cover one resolved test file. A token covers the file only when it resolves
 * to that exact file; a directory covers the known files under it; an ambiguous token covers nothing. With no file
 * list, a token covers the file when one path key ends with the other at a segment boundary (so `out/test/x.test.js`
 * covers `src/test/x.test.ts`, and `packages/a/x.test.ts` does not cover `packages/b/x.test.ts`).
 */
export function commandCoversTestFileV1(
  tokens: readonly string[],
  file: string,
  context?: ItemTestFilesContextV1,
  options: { readonly baseDir?: string } = {}
): boolean {
  const wantedKey = testPathKeyV1(file);
  if (wantedKey === "") return false;
  const known = context !== undefined && context.knownTestFiles.length > 0;
  return tokens.some((raw) => {
    const token = normalizeSlashes(raw);
    if (token === "") return false;
    const last = token.split("/").pop() ?? token;
    const fileLike = /\.[a-z0-9]+$/i.test(last);
    if (fileLike && !/\.[cm]?[jt]sx?$/i.test(last)) return false;
    if (!fileLike &&!(known && /^[A-Za-z][\w-]*$/.test(token) && !WORD_STOPLIST.has(token.toLowerCase()))) {
      // A directory the runner was pointed at covers the tests under it; a bare word never covers a directory.
      const dir = testPathKeyV1(`${token}/x`).slice(0, -2);
      if (!token.includes("/") || dir === "") return false;
      return wantedKey.startsWith(`${dir}/`) || wantedKey.includes(`/${dir}/`);
    }
    if (known) {
      const resolved = resolveTestNameV1(token, context, options.baseDir !== undefined ? { baseDir: options.baseDir } : {});
      return resolved.kind === "file" && testPathKeyV1(resolved.file) === wantedKey;
    }
    const tokenKey = testPathKeyV1(token);
    return tokenKey !== "" && (keyEndsWith(wantedKey, tokenKey) || keyEndsWith(tokenKey, wantedKey));
  });
}
