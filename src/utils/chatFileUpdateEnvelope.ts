/**
 * The C4 chat-edit envelope (`[[UPDATE_FILE:path]]...[[/UPDATE_FILE]]`): a
 * stage-chat response may propose the full replacement content of exactly one
 * markdown file inside the active task's own folder (its description, plan,
 * or a review artifact). Extraction, the all-or-nothing update plan, and the
 * path-containment check are pure and VS-Code-free so they are unit-testable
 * without a host — see chatFileUpdateEnvelope.test.ts.
 *
 * Split out of commands/chatWithStage.ts (which re-exports these for
 * backward compatibility with existing imports) so the production write path
 * in actions/rows/chatSendRowV1.ts can depend on these functions without a
 * commands -> actions -> commands import cycle.
 */
import * as path from "path";

export interface FileUpdateEnvelope {
  relPath: string;
  content: string;
}

/** Extracts every `[[UPDATE_FILE:path]]...[[/UPDATE_FILE]]` envelope and
 * returns the remaining text with all envelopes removed — no envelope may
 * survive into the displayed response, whether or not it is applied. */
export function splitFileUpdateEnvelopes(
  text: string
): { text: string; updates: FileUpdateEnvelope[] } {
  const updates: FileUpdateEnvelope[] = [];
  const remaining = text
    .replace(
      /\[\[UPDATE_FILE:([^\]\r\n]+)\]\]([\s\S]*?)\[\[\/UPDATE_FILE\]\]/gi,
      (_whole, relPath: string, content: string) => {
        updates.push({
          relPath: relPath.trim(),
          content: content.replace(/^\r?\n/, "").replace(/\r?\n$/, ""),
        });
        return "";
      }
    )
    .trim();
  return { text: remaining, updates };
}

export type ChatFileUpdatePlan =
  | { action: "none" }
  | { action: "reject"; note: string }
  | { action: "write"; relPath: string; targetPath: string; content: string };

/**
 * All-or-nothing validation of the chat-edit envelopes in one response.
 * The chat-edit contract allows exactly one markdown file per response, so a
 * response carrying several envelopes is rejected whole — zero writes — and
 * a single envelope is written only when its target passes
 * `resolveMarkdownUpdateTarget`. Pure so the zero-write policy is directly
 * unit-testable.
 */
export function planFileUpdate(
  taskFolderPath: string,
  updates: readonly FileUpdateEnvelope[]
): ChatFileUpdatePlan {
  if (updates.length === 0) return { action: "none" };
  if (updates.length > 1) {
    return {
      action: "reject",
      note:
        `_The response proposed updating ${updates.length} files at once; ` +
        `chat may update only one markdown file per response, so none were written. ` +
        `Ask for one file at a time._`,
    };
  }
  const update = updates[0];
  if (!update) return { action: "none" };
  const targetPath = resolveMarkdownUpdateTarget(taskFolderPath, update.relPath);
  if (!targetPath) {
    return {
      action: "reject",
      note: `_Could not update \`${update.relPath}\`: only markdown files inside this task's folder can be edited from chat._`,
    };
  }
  return { action: "write", relPath: update.relPath, targetPath, content: update.content };
}

/**
 * Resolve a chat-proposed relative path to an absolute file path, but only
 * when it is a `.md` file that stays inside `taskFolderPath` — this is the
 * entire enforcement boundary for the C4 chat-edit capability (no code
 * files, no escaping the active task's own folder via `..` or an absolute
 * path). Returns `undefined` for anything that fails that check.
 */
export function resolveMarkdownUpdateTarget(
  taskFolderPath: string,
  relPath: string
): string | undefined {
  const trimmed = relPath.trim().replace(/\\/g, "/");
  if (!trimmed || path.isAbsolute(trimmed) || !/\.md$/i.test(trimmed)) {
    return undefined;
  }
  const resolved = path.resolve(taskFolderPath, trimmed);
  const rel = path.relative(taskFolderPath, resolved);
  if (rel.startsWith("..") || path.isAbsolute(rel)) {
    return undefined;
  }
  return resolved;
}
