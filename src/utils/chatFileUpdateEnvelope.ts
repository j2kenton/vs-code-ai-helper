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

/**
 * `[[RESOLVES_BLOCKER]]`: an explicit, model-authored declaration that the
 * `[[UPDATE_FILE:...]]` draft in the SAME response is intended to resolve the
 * current plan-review stage's recorded blocker — see
 * `buildStageResponsePrompt`'s own instruction for when the model is told to
 * emit it.
 *
 * Review-flagged (2026-08-25, third narrowing of task-fixable blocker
 * `fc82d17d-…-3`): `detectBlockerSupersessionCandidateV1`
 * (`actions/rows/chatSendRowV1.ts`) used to infer "does this edit resolve the
 * blocker" from the edit's own text — keyword overlap with the blocker's
 * description, gated by a denylist of "still open" / "future promise" /
 * single-word negative-state phrasings. Three successive review rounds each
 * produced a new counterexample sharing the blocker's vocabulary while
 * describing it as unresolved ("remains pending", "will be presented
 * tomorrow", "sign-off is outstanding"), because natural language has
 * unboundedly many ways to say "not yet" and no fixed phrase list can
 * enumerate them all — enumerating more is provably whack-a-mole, not a
 * narrowing that converges.
 *
 * This marker replaces that inference with the one signal that is actually
 * reliable: the model's OWN semantic judgement, made machine-readable instead
 * of re-derived from its prose after the fact — the same judgement that, in
 * the original bug report, correctly recognized a resolved blocker and
 * correctly restated the approved rule in full. `detectBlockerSupersessionCandidateV1`
 * now treats an edit as a blocker-supersession CANDIDATE only when this
 * marker is present (plus the existing single-blocker cardinality guard);
 * its absence falls through to the ordinary auto-apply path, exactly as an
 * edit that failed the old lexical check did. The user-facing safety net is
 * unchanged and, unlike a heuristic, cannot be defeated by phrasing: nothing
 * is written to `plan.md` for a candidate edit until the user explicitly
 * confirms it in a dialog naming the blocker text, per
 * `ChatMessage.proposedBlockerSupersessionEdit`.
 */
const RESOLVES_BLOCKER_MARKER_PATTERN = /\[\[RESOLVES_BLOCKER\]\]/gi;

/** Extracts the `[[RESOLVES_BLOCKER]]` marker, if present, and returns the
 * remaining text with every occurrence removed — like every other bracket
 * envelope, it must never survive into the displayed/persisted response. */
export function splitResolvesBlockerMarkerV1(
  text: string
): { text: string; resolvesBlocker: boolean } {
  const resolvesBlocker = RESOLVES_BLOCKER_MARKER_PATTERN.test(text);
  RESOLVES_BLOCKER_MARKER_PATTERN.lastIndex = 0;
  const remaining = text.replace(RESOLVES_BLOCKER_MARKER_PATTERN, "").trim();
  return { text: remaining, resolvesBlocker };
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
