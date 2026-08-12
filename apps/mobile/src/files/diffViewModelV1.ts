/**
 * Unified-diff render model (plan Part 10): parse the control plane's
 * read-only `unifiedDiff` text into typed rows for the gate-review diff
 * viewer. Pure line classification — the client never interprets the diff
 * beyond display, and an empty diff renders as an explicit empty state.
 */

export type DiffRowKindV1 = 'file' | 'hunk' | 'add' | 'remove' | 'context' | 'meta';

export interface DiffRowV1 {
  /** Stable render key (row index). */
  readonly key: string;
  readonly kind: DiffRowKindV1;
  readonly text: string;
}

/** Files named in the diff (from `+++ b/...` headers), for the summary row. */
export function diffFileNamesV1(rows: readonly DiffRowV1[]): string[] {
  const names: string[] = [];
  for (const row of rows) {
    if (row.kind === 'file' && row.text.startsWith('+++ ')) {
      const target = row.text.slice(4).trim();
      const name = target.startsWith('b/') ? target.slice(2) : target;
      if (name !== '/dev/null') {
        names.push(name);
      }
    }
  }
  return names;
}

export function buildDiffRowsV1(unifiedDiff: string): DiffRowV1[] {
  if (unifiedDiff.length === 0) {
    return [];
  }
  const lines = unifiedDiff.split('\n');
  // A trailing newline yields one final empty line, not a real diff row.
  if (lines[lines.length - 1] === '') {
    lines.pop();
  }
  return lines.map((text, index) => {
    let kind: DiffRowKindV1;
    if (text.startsWith('--- ') || text.startsWith('+++ ')) {
      kind = 'file';
    } else if (text.startsWith('@@')) {
      kind = 'hunk';
    } else if (text.startsWith('+')) {
      kind = 'add';
    } else if (text.startsWith('-')) {
      kind = 'remove';
    } else if (
      text.startsWith('diff ') ||
      text.startsWith('index ') ||
      text.startsWith('\\ No newline')
    ) {
      kind = 'meta';
    } else {
      kind = 'context';
    }
    return { key: String(index), kind, text };
  });
}
