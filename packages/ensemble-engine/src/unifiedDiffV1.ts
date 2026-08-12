/**
 * Unified-diff generation for gate review (plan Part 4c: "diff generation
 * for review is wired into 4a's event streams").
 *
 * A pure, dependency-free line diff (LCS-based) producing standard unified
 * diff text: the artifact a pending gate carries for review. The Part 3
 * contract serves it read-only from the gate record, and Part 10's diff
 * viewer renders it; nothing here touches a filesystem — callers supply the
 * before/after text (Part 4d reads them through the sandbox provider APIs
 * under the SandboxBinding root).
 */

/** One proposed file change under gate review. */
export interface EngineFileChangeV1 {
  readonly path: string;
  /** `null` when the file is being added. */
  readonly oldText: string | null;
  /** `null` when the file is being deleted. */
  readonly newText: string | null;
}

const CONTEXT_LINES = 3;
/** LCS table guard: beyond this, fall back to a whole-file replace hunk. */
const MAX_LCS_CELLS = 25_000_000;
/**
 * Sentinel marking "this is the file's last line and the file has no
 * trailing newline" so the LCS treats a trailing-newline change as a real
 * change; stripped on output and rendered as the standard
 * `\ No newline at end of file` marker. (A NUL cannot appear in text a line
 * diff is meaningful for.)
 */
const NO_NEWLINE_SENTINEL = String.fromCharCode(0);

interface SplitText {
  readonly lines: readonly string[];
  readonly trailingNewline: boolean;
}

function splitLines(text: string): SplitText {
  if (text.length === 0) {
    return { lines: [], trailingNewline: true };
  }
  const trailingNewline = text.endsWith("\n");
  const lines = text.split("\n");
  if (trailingNewline) {
    lines.pop();
  }
  return { lines, trailingNewline };
}

function keyedLines(split: SplitText): string[] {
  const keyed = [...split.lines];
  if (!split.trailingNewline && keyed.length > 0) {
    keyed[keyed.length - 1] = `${keyed[keyed.length - 1]}${NO_NEWLINE_SENTINEL}`;
  }
  return keyed;
}

type DiffOp =
  | { readonly kind: "context"; readonly text: string; readonly oldLine: number; readonly newLine: number }
  | { readonly kind: "del"; readonly text: string; readonly oldLine: number }
  | { readonly kind: "add"; readonly text: string; readonly newLine: number };

function diffOps(oldLines: readonly string[], newLines: readonly string[]): DiffOp[] {
  const n = oldLines.length;
  const m = newLines.length;
  const ops: DiffOp[] = [];
  if (n * m > MAX_LCS_CELLS) {
    for (let i = 0; i < n; i++) {
      ops.push({ kind: "del", text: oldLines[i]!, oldLine: i + 1 });
    }
    for (let j = 0; j < m; j++) {
      ops.push({ kind: "add", text: newLines[j]!, newLine: j + 1 });
    }
    return ops;
  }
  // lengths[i * (m + 1) + j] = LCS length of oldLines[i..] vs newLines[j..].
  const width = m + 1;
  const lengths = new Uint32Array((n + 1) * width);
  for (let i = n - 1; i >= 0; i--) {
    for (let j = m - 1; j >= 0; j--) {
      lengths[i * width + j] =
        oldLines[i] === newLines[j]
          ? lengths[(i + 1) * width + j + 1]! + 1
          : Math.max(lengths[(i + 1) * width + j]!, lengths[i * width + j + 1]!);
    }
  }
  let i = 0;
  let j = 0;
  while (i < n && j < m) {
    if (oldLines[i] === newLines[j]) {
      ops.push({ kind: "context", text: oldLines[i]!, oldLine: i + 1, newLine: j + 1 });
      i++;
      j++;
    } else if (lengths[(i + 1) * width + j]! >= lengths[i * width + j + 1]!) {
      ops.push({ kind: "del", text: oldLines[i]!, oldLine: i + 1 });
      i++;
    } else {
      ops.push({ kind: "add", text: newLines[j]!, newLine: j + 1 });
      j++;
    }
  }
  while (i < n) {
    ops.push({ kind: "del", text: oldLines[i]!, oldLine: i + 1 });
    i++;
  }
  while (j < m) {
    ops.push({ kind: "add", text: newLines[j]!, newLine: j + 1 });
    j++;
  }
  return ops;
}

interface Hunk {
  readonly ops: readonly DiffOp[];
  readonly oldStart: number;
  readonly oldCount: number;
  readonly newStart: number;
  readonly newCount: number;
}

function buildHunks(ops: readonly DiffOp[]): Hunk[] {
  const changeIndices: number[] = [];
  for (let idx = 0; idx < ops.length; idx++) {
    if (ops[idx]!.kind !== "context") {
      changeIndices.push(idx);
    }
  }
  if (changeIndices.length === 0) {
    return [];
  }
  const hunks: Hunk[] = [];
  let groupStart = changeIndices[0]!;
  let groupEnd = groupStart;
  const flush = (): void => {
    const from = Math.max(0, groupStart - CONTEXT_LINES);
    const to = Math.min(ops.length - 1, groupEnd + CONTEXT_LINES);
    const slice = ops.slice(from, to + 1);
    let oldCount = 0;
    let newCount = 0;
    let firstOldLine: number | undefined;
    let firstNewLine: number | undefined;
    for (const op of slice) {
      if (op.kind !== "add") {
        oldCount++;
        firstOldLine ??= op.oldLine;
      }
      if (op.kind !== "del") {
        newCount++;
        firstNewLine ??= op.newLine;
      }
    }
    // A zero-count side anchors to the line BEFORE the hunk (0 at file start).
    let lastOldBefore = 0;
    let lastNewBefore = 0;
    for (let idx = from - 1; idx >= 0; idx--) {
      const op = ops[idx]!;
      if (lastOldBefore === 0 && op.kind !== "add") {
        lastOldBefore = op.oldLine;
      }
      if (lastNewBefore === 0 && op.kind !== "del") {
        lastNewBefore = op.newLine;
      }
      if (lastOldBefore !== 0 && lastNewBefore !== 0) {
        break;
      }
    }
    hunks.push({
      ops: slice,
      oldStart: oldCount > 0 ? firstOldLine! : lastOldBefore,
      oldCount,
      newStart: newCount > 0 ? firstNewLine! : lastNewBefore,
      newCount,
    });
  };
  for (let k = 1; k < changeIndices.length; k++) {
    const idx = changeIndices[k]!;
    // Merge when the context gap between change runs is within 2×CONTEXT.
    if (idx - groupEnd - 1 <= 2 * CONTEXT_LINES) {
      groupEnd = idx;
    } else {
      flush();
      groupStart = idx;
      groupEnd = idx;
    }
  }
  flush();
  return hunks;
}

function renderOpLine(prefix: string, text: string, out: string[]): void {
  if (text.endsWith(NO_NEWLINE_SENTINEL)) {
    out.push(`${prefix}${text.slice(0, -1)}`);
    out.push("\\ No newline at end of file");
  } else {
    out.push(`${prefix}${text}`);
  }
}

/**
 * Build one unified diff document over the proposed changes. Files whose
 * before/after text is byte-identical are omitted; an added file diffs from
 * `/dev/null`, a deleted file diffs to `/dev/null`.
 */
export function buildUnifiedDiffV1(changes: readonly EngineFileChangeV1[]): string {
  const out: string[] = [];
  for (const change of changes) {
    const oldText = change.oldText;
    const newText = change.newText;
    if (oldText === newText) {
      continue;
    }
    const oldSplit = splitLines(oldText ?? "");
    const newSplit = splitLines(newText ?? "");
    const ops = diffOps(keyedLines(oldSplit), keyedLines(newSplit));
    const hunks = buildHunks(ops);
    if (hunks.length === 0 && oldText !== null && newText !== null) {
      continue;
    }
    out.push(oldText === null ? "--- /dev/null" : `--- a/${change.path}`);
    out.push(newText === null ? "+++ /dev/null" : `+++ b/${change.path}`);
    for (const hunk of hunks) {
      out.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
      for (const op of hunk.ops) {
        renderOpLine(op.kind === "context" ? " " : op.kind === "del" ? "-" : "+", op.text, out);
      }
    }
  }
  return out.length === 0 ? "" : `${out.join("\n")}\n`;
}
