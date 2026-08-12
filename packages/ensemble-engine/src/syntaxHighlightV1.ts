/**
 * Server-side syntax highlighting (plan Part 10).
 *
 * The engine/control plane tokenizes file text into the shared token-span
 * schema (`@ensemble/contract`'s `TokenSpanV1`) and relays the spans to
 * clients: native renders them in virtualized text, and a web client that
 * highlights locally must emit the same shape. This tokenizer is deliberately
 * dependency-free and deterministic — a small character scanner per language
 * family rather than a grammar engine — because the client contract only
 * needs stable, non-overlapping spans in the closed scope vocabulary, never
 * theme-grade fidelity. Guarantees (pinned by tests):
 *
 * - spans are sorted by start, non-overlapping, and in bounds
 *   (`areTokenSpansWellFormedV1`), so renderers can slice text linearly;
 * - the same input always produces the same spans;
 * - an unknown language or an oversized file produces NO spans (the client
 *   falls back to plain text) — highlighting never fails a file read.
 */
import type { TokenSpanV1 } from "../../ensemble-contract/src/tokenSpanV1";

/** Files above this size are served without spans (plain-text fallback). */
export const HIGHLIGHT_MAX_CHARS_V1 = 512 * 1024;

const JS_KEYWORDS = new Set([
  "abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class",
  "const", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
  "export", "extends", "false", "finally", "for", "from", "function", "if", "implements",
  "import", "in", "instanceof", "interface", "is", "keyof", "let", "namespace", "never",
  "new", "null", "number", "object", "of", "override", "private", "protected", "public",
  "readonly", "return", "satisfies", "static", "string", "super", "switch", "symbol",
  "this", "throw", "true", "try", "type", "typeof", "undefined", "unknown", "var", "void",
  "while", "with", "yield",
]);

const PYTHON_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break", "class",
  "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global",
  "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise",
  "return", "try", "while", "with", "yield",
]);

function isIdentifierStart(ch: string): boolean {
  return /[A-Za-z_$]/.test(ch);
}

function isIdentifierPart(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

function isDigit(ch: string): boolean {
  return ch >= "0" && ch <= "9";
}

/** Scan a numeric literal starting at `index`; returns the end offset. */
function scanNumber(text: string, index: number): number {
  let end = index;
  while (end < text.length && /[0-9a-fA-FxXoObB_.eE+-]/.test(text.charAt(end))) {
    // `+`/`-` continue a number only directly after an exponent marker.
    const ch = text.charAt(end);
    if ((ch === "+" || ch === "-") && !/[eE]/.test(text.charAt(end - 1))) {
      break;
    }
    end += 1;
  }
  return end;
}

/** Scan a quoted string from the opening quote; handles `\` escapes. */
function scanString(text: string, index: number, quote: string): number {
  let end = index + quote.length;
  while (end < text.length) {
    if (text.charAt(end) === "\\") {
      end += 2;
      continue;
    }
    if (text.startsWith(quote, end)) {
      return end + quote.length;
    }
    // Single-line quotes stop at the newline (unterminated string).
    if (quote.length === 1 && quote !== "`" && text.charAt(end) === "\n") {
      return end;
    }
    end += 1;
  }
  return text.length;
}

interface ScanRulesV1 {
  readonly keywords: ReadonlySet<string>;
  readonly lineComment?: string;
  readonly blockComment?: readonly [string, string];
  /** Quotes tried in order; multi-char quotes (`'''`) must come first. */
  readonly quotes: readonly string[];
  /** Bare words highlighted as literals (JSON's true/false/null). */
  readonly literals?: ReadonlySet<string>;
  /** Emit `property` for a string immediately followed by `:` (JSON keys). */
  readonly stringPropertyBeforeColon?: boolean;
}

/** Generic scanner covering the C-like / Python / JSON families. */
function scanWithRules(text: string, rules: ScanRulesV1): TokenSpanV1[] {
  const spans: TokenSpanV1[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text.charAt(index);

    if (rules.lineComment !== undefined && text.startsWith(rules.lineComment, index)) {
      let end = text.indexOf("\n", index);
      if (end === -1) {
        end = text.length;
      }
      spans.push({ start: index, end, scope: "comment" });
      index = end;
      continue;
    }

    if (rules.blockComment !== undefined && text.startsWith(rules.blockComment[0], index)) {
      const close = text.indexOf(rules.blockComment[1], index + rules.blockComment[0].length);
      const end = close === -1 ? text.length : close + rules.blockComment[1].length;
      spans.push({ start: index, end, scope: "comment" });
      index = end;
      continue;
    }

    const quote = rules.quotes.find((candidate) => text.startsWith(candidate, index));
    if (quote !== undefined) {
      const end = scanString(text, index, quote);
      let scope: TokenSpanV1["scope"] = "string";
      if (rules.stringPropertyBeforeColon === true) {
        let after = end;
        while (after < text.length && (text.charAt(after) === " " || text.charAt(after) === "\t")) {
          after += 1;
        }
        if (text.charAt(after) === ":") {
          scope = "property";
        }
      }
      spans.push({ start: index, end, scope });
      index = end;
      continue;
    }

    if (isDigit(ch) || (ch === "." && isDigit(text.charAt(index + 1)))) {
      const end = scanNumber(text, index);
      spans.push({ start: index, end, scope: "number" });
      index = end;
      continue;
    }

    if (isIdentifierStart(ch)) {
      let end = index + 1;
      while (end < text.length && isIdentifierPart(text.charAt(end))) {
        end += 1;
      }
      const word = text.slice(index, end);
      if (rules.keywords.has(word)) {
        spans.push({ start: index, end, scope: "keyword" });
      } else if (rules.literals?.has(word) === true) {
        spans.push({ start: index, end, scope: "literal" });
      }
      index = end;
      continue;
    }

    index += 1;
  }
  return spans;
}

/** CSS: comments, strings, numbers (with units), and `property:` names. */
function scanCss(text: string): TokenSpanV1[] {
  const spans: TokenSpanV1[] = [];
  let index = 0;
  while (index < text.length) {
    const ch = text.charAt(index);
    if (text.startsWith("/*", index)) {
      const close = text.indexOf("*/", index + 2);
      const end = close === -1 ? text.length : close + 2;
      spans.push({ start: index, end, scope: "comment" });
      index = end;
      continue;
    }
    if (ch === '"' || ch === "'") {
      const end = scanString(text, index, ch);
      spans.push({ start: index, end, scope: "string" });
      index = end;
      continue;
    }
    if (isDigit(ch)) {
      let end = index + 1;
      while (end < text.length && /[0-9.%a-z]/.test(text.charAt(end))) {
        end += 1;
      }
      spans.push({ start: index, end, scope: "number" });
      index = end;
      continue;
    }
    if (/[a-zA-Z-]/.test(ch)) {
      let end = index + 1;
      while (end < text.length && /[a-zA-Z0-9-]/.test(text.charAt(end))) {
        end += 1;
      }
      if (text.charAt(end) === ":") {
        spans.push({ start: index, end, scope: "property" });
      }
      index = end;
      continue;
    }
    index += 1;
  }
  return spans;
}

/** HTML: comments, tag names, attribute strings. */
function scanHtml(text: string): TokenSpanV1[] {
  const spans: TokenSpanV1[] = [];
  let index = 0;
  while (index < text.length) {
    if (text.startsWith("<!--", index)) {
      const close = text.indexOf("-->", index + 4);
      const end = close === -1 ? text.length : close + 3;
      spans.push({ start: index, end, scope: "comment" });
      index = end;
      continue;
    }
    if (text.charAt(index) === "<") {
      const nameStart = text.charAt(index + 1) === "/" ? index + 2 : index + 1;
      let nameEnd = nameStart;
      while (nameEnd < text.length && /[a-zA-Z0-9-]/.test(text.charAt(nameEnd))) {
        nameEnd += 1;
      }
      if (nameEnd > nameStart) {
        spans.push({ start: index, end: nameEnd, scope: "tag" });
      }
      // Attribute strings until the closing `>`.
      let cursor = nameEnd;
      while (cursor < text.length && text.charAt(cursor) !== ">") {
        const ch = text.charAt(cursor);
        if (ch === '"' || ch === "'") {
          const end = scanString(text, cursor, ch);
          spans.push({ start: cursor, end, scope: "string" });
          cursor = end;
          continue;
        }
        cursor += 1;
      }
      index = cursor + 1;
      continue;
    }
    index += 1;
  }
  return spans;
}

/** Markdown: heading lines, fenced code blocks, inline code. */
function scanMarkdown(text: string): TokenSpanV1[] {
  const spans: TokenSpanV1[] = [];
  let lineStart = 0;
  let inFence = false;
  while (lineStart <= text.length) {
    let lineEnd = text.indexOf("\n", lineStart);
    if (lineEnd === -1) {
      lineEnd = text.length;
    }
    const line = text.slice(lineStart, lineEnd);
    if (/^\s*(```|~~~)/.test(line)) {
      spans.push({ start: lineStart, end: lineEnd, scope: "literal" });
      inFence = !inFence;
    } else if (inFence) {
      if (lineEnd > lineStart) {
        spans.push({ start: lineStart, end: lineEnd, scope: "literal" });
      }
    } else if (/^#{1,6}\s/.test(line)) {
      spans.push({ start: lineStart, end: lineEnd, scope: "heading" });
    } else {
      // Inline code spans on ordinary lines.
      const inlineCode = /`[^`\n]+`/g;
      for (let match = inlineCode.exec(line); match !== null; match = inlineCode.exec(line)) {
        spans.push({
          start: lineStart + match.index,
          end: lineStart + match.index + match[0].length,
          scope: "string",
        });
      }
    }
    if (lineEnd === text.length) {
      break;
    }
    lineStart = lineEnd + 1;
  }
  return spans;
}

/**
 * Tokenize file text into shared token spans. Language ids are the ones the
 * control plane resolves from file extensions (`typescript`, `javascript`,
 * `json`, `markdown`, `python`, `css`, `html`); anything else — or an
 * oversized file — yields no spans, and the client renders plain text.
 */
export function highlightTokenSpansV1(
  text: string,
  language: string | undefined
): TokenSpanV1[] {
  if (language === undefined || text.length === 0 || text.length > HIGHLIGHT_MAX_CHARS_V1) {
    return [];
  }
  switch (language) {
    case "typescript":
    case "javascript":
      return scanWithRules(text, {
        keywords: JS_KEYWORDS,
        lineComment: "//",
        blockComment: ["/*", "*/"],
        quotes: ['"', "'", "`"],
      });
    case "json":
      return scanWithRules(text, {
        keywords: new Set(),
        quotes: ['"'],
        literals: new Set(["true", "false", "null"]),
        stringPropertyBeforeColon: true,
      });
    case "python":
      return scanWithRules(text, {
        keywords: PYTHON_KEYWORDS,
        lineComment: "#",
        quotes: ['"""', "'''", '"', "'"],
      });
    case "css":
      return scanCss(text);
    case "html":
      return scanHtml(text);
    case "markdown":
      return scanMarkdown(text);
    default:
      return [];
  }
}
