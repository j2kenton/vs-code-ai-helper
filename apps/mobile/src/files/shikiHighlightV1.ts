/**
 * Native/default counterpart of `shikiHighlightV1.web.ts` (plan Part 10).
 *
 * On native, highlighting stays server-side only — Shiki's oniguruma WASM
 * grammar engine is the exact risk the plan calls out under Hermes, so this
 * platform build never loads Shiki. Metro resolves `.web.ts` in place of
 * this file when bundling for web; everywhere else (iOS, Android), this
 * no-op is what `FilesScreen` imports, and `buildCodeLinesV1` falls back to
 * the server's pre-tokenized spans.
 */
import type { TokenSpanDtoV1 } from '../api/controlPlaneClientV1';

export async function highlightWithShikiV1(
  _text: string,
  _language: string | undefined
): Promise<TokenSpanDtoV1[] | undefined> {
  return undefined;
}
