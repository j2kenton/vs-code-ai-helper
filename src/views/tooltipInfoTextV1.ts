import * as vscode from "vscode";

/**
 * Hover tooltips are `MarkdownString`s: they cannot read a webview's CSS
 * tokens, and VS Code renders them in the workbench's own (muted) tooltip
 * colours. The informational "What happens next" sentence has to match the
 * webviews' `--ensemble-info-foreground` (black on light themes, white on
 * dark), so the one span this module emits is the only way to colour it.
 *
 * Requires the receiving `MarkdownString` to have `supportHtml = true`; VS
 * Code's sanitiser keeps `<span style="color:#rrggbb;">` and drops
 * everything else, and `isTrusted` is deliberately never needed.
 */

/** Escapes the four characters that could open or close markup once `supportHtml` is on. */
export function escapeTooltipHtmlV1(text: string): string {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/**
 * Render dynamic text (a model id, an artifact or folder name) as literal
 * text inside a `supportHtml` tooltip: markdown syntax characters are
 * backslash-escaped, line breaks are collapsed so the value cannot end the
 * paragraph, and the HTML metacharacters are entity-escaped so it can never
 * open a tag.
 */
export function tooltipLiteralTextV1(text: string): string {
  const markdownSafe = text.replace(/[\\`*_[\]~]/g, (ch) => `\\${ch}`).replace(/\s+/g, " ");
  return escapeTooltipHtmlV1(markdownSafe);
}

/**
 * Wrap informational tooltip text in the theme's full-contrast foreground.
 * High-contrast themes get the escaped text with no span: their own palette
 * already guarantees contrast and forcing black/white would fight it.
 */
export function renderTooltipInfoTextV1(text: string, themeKind: vscode.ColorThemeKind): string {
  const escaped = escapeTooltipHtmlV1(text);
  switch (themeKind) {
    case vscode.ColorThemeKind.Light:
      return `<span style="color:#000000;">${escaped}</span>`;
    case vscode.ColorThemeKind.Dark:
      return `<span style="color:#ffffff;">${escaped}</span>`;
    default:
      return escaped;
  }
}
