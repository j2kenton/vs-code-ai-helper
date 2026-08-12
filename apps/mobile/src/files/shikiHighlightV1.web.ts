/**
 * Client-side Shiki highlighting for the web target only (plan Part 10).
 *
 * Metro/webpack resolve the `.web.ts` extension only when bundling for web,
 * so this module never ships to the native bundle — the WASM/Hermes risk the
 * plan calls out for Shiki never applies there; native always renders the
 * server's pre-tokenized spans (`syntaxHighlightV1.ts` in `ensemble-engine`).
 * On web, Shiki tokenizes locally using the pure-JS regex engine (no
 * oniguruma WASM asset to bundle) and its output is mapped into the SAME
 * shared token-span shape (`TokenSpanDtoV1`) the server emits, so
 * `buildCodeLinesV1` and `FilesScreen`'s rendering are unaware which source
 * produced the spans. A highlighter failure (unsupported language, Shiki
 * load error) returns `undefined` and the caller falls back to the server's
 * spans — highlighting is always best-effort, never a hard dependency for
 * viewing a file.
 */
import type { TokenSpanDtoV1 } from '../api/controlPlaneClientV1';

/** Mirrors ensemble-engine's syntaxHighlightV1 limit; keeps client tokenization off huge files. */
export const SHIKI_MAX_CHARS_V1 = 512 * 1024;

const SUPPORTED_LANGUAGES = new Set([
  'typescript',
  'javascript',
  'json',
  'markdown',
  'python',
  'css',
  'html',
]);

/** Longest-prefix-first: more specific TextMate scopes must be tried before their parents. */
const SCOPE_RULES: ReadonlyArray<readonly [string, string]> = [
  ['comment', 'comment'],
  ['constant.numeric', 'number'],
  ['constant.language', 'literal'],
  ['constant.other', 'literal'],
  ['string.regexp', 'string'],
  ['string', 'string'],
  ['keyword', 'keyword'],
  ['storage', 'keyword'],
  ['entity.name.tag', 'tag'],
  ['entity.other.attribute-name', 'property'],
  ['support.type.property-name', 'property'],
  ['meta.object-literal.key', 'property'],
  ['markup.heading', 'heading'],
];

function mapScopesV1(scopeNames: readonly string[]): string | undefined {
  for (const [prefix, scope] of SCOPE_RULES) {
    if (scopeNames.some((name) => name === prefix || name.startsWith(`${prefix}.`))) {
      return scope;
    }
  }
  return undefined;
}

// Lazily created and cached across calls so navigating between files in one
// session doesn't reload Shiki's grammar/theme data per file.
let highlighterPromise: Promise<import('shiki').Highlighter> | null = null;
const loadedLangs = new Set<string>();

async function getHighlighterV1(language: string): Promise<import('shiki').Highlighter | undefined> {
  try {
    const shiki = await import('shiki');
    if (highlighterPromise === null) {
      highlighterPromise = shiki.createHighlighter({
        themes: ['github-dark'],
        langs: [],
        engine: shiki.createJavaScriptRegexEngine(),
      });
    }
    const highlighter = await highlighterPromise;
    if (!loadedLangs.has(language)) {
      await highlighter.loadLanguage(language as import('shiki').BundledLanguage);
      loadedLangs.add(language);
    }
    return highlighter;
  } catch {
    // Network failure, unsupported language bundle, etc. — best-effort only.
    return undefined;
  }
}

/**
 * Tokenize `text` with Shiki and return spans in the shared token-span
 * shape, or `undefined` if highlighting isn't available (unsupported
 * language, oversized file, or a Shiki load failure) — callers fall back to
 * server-provided spans in that case.
 */
export async function highlightWithShikiV1(
  text: string,
  language: string | undefined
): Promise<TokenSpanDtoV1[] | undefined> {
  if (language === undefined || !SUPPORTED_LANGUAGES.has(language)) {
    return undefined;
  }
  if (text.length === 0 || text.length > SHIKI_MAX_CHARS_V1) {
    return undefined;
  }
  const highlighter = await getHighlighterV1(language);
  if (highlighter === undefined) {
    return undefined;
  }
  try {
    const lines = highlighter.codeToTokensBase(text, {
      lang: language as import('shiki').BundledLanguage,
      theme: 'github-dark',
      includeExplanation: true,
    });
    const spans: TokenSpanDtoV1[] = [];
    for (const line of lines) {
      for (const token of line) {
        if (token.explanation === undefined || token.explanation.length === 0) {
          continue;
        }
        let cursor = token.offset;
        for (const piece of token.explanation) {
          const length = piece.content.length;
          if (length > 0) {
            const scope = mapScopesV1(piece.scopes.map((s) => s.scopeName));
            if (scope !== undefined) {
              spans.push({ start: cursor, end: cursor + length, scope });
            }
          }
          cursor += length;
        }
      }
    }
    return spans;
  } catch {
    return undefined;
  }
}
