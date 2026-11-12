/**
 * bugs8 item 2: the Chat With AI envelope that records an owner decision where rounds and reviews read it.
 *
 *   [[RECORD_OWNER_DECISION:<blockerId>]]
 *   Decision: <the owner's decision, in the owner's words>
 *   Blocker: <optional: what the decision answers>
 *   Plan-old: <optional: the existing wording of ONE plain sub-bullet in plan-final.md>
 *   Plan-new: <optional: its replacement wording>
 *   [[/RECORD_OWNER_DECISION]]
 *
 * Confirmed, it writes three things: the entry in task.md `## Owner decisions` (an earlier entry for the same
 * blocker is marked superseded, not deleted), the replacement wording in plan-final.md, and the same replacement
 * in plan.md when that text is there. The plan edit changes plain sub-bullet wording only: a checklist line
 * (`- [ ]` / `- [x]`), a missing target, or a target that matches more than once is refused, so a frozen
 * checklist line or its tick can never change from chat. plan.md is never redrafted.
 *
 * Pure parsing and string edits plus one recorder that takes its file writer, so it runs without a VS Code host.
 */
import * as fs from "fs/promises";
import * as path from "path";
import { recordReplacingOwnerDecisionV1 } from "./ownerEvidenceV1";

export interface OwnerDecisionEnvelopeV1 {
  readonly blockerId: string;
  readonly decision: string;
  readonly blockerText?: string;
  readonly planOld?: string;
  readonly planNew?: string;
}

const ENVELOPE_RE_V1 = /\[\[RECORD_OWNER_DECISION:([^\]\r\n]+)\]\]([\s\S]*?)\[\[\/RECORD_OWNER_DECISION\]\]/gi;
const KEY_RE_V1 = /^(decision|blocker|plan-old|plan-new)[ \t]*:[ \t]*(.*)$/i;

function parseEnvelopeBodyV1(blockerId: string, body: string): OwnerDecisionEnvelopeV1 {
  const values = new Map<string, string[]>();
  let current: string[] | undefined;
  for (const line of body.split(/\r?\n/)) {
    const key = KEY_RE_V1.exec(line);
    if (key) {
      current = [key[2] ?? ""];
      values.set((key[1] ?? "").toLowerCase(), current);
    } else if (current) {
      current.push(line);
    }
  }
  const value = (name: string): string | undefined => {
    const lines = values.get(name);
    const text = lines?.join(" ").replace(/\s+/g, " ").trim();
    return text === undefined || text === "" ? undefined : text;
  };
  const blockerText = value("blocker");
  const planOld = value("plan-old");
  const planNew = value("plan-new");
  return {
    blockerId: blockerId.trim(),
    decision: value("decision") ?? body.replace(/\s+/g, " ").trim(),
    ...(blockerText !== undefined ? { blockerText } : {}),
    ...(planOld !== undefined ? { planOld } : {}),
    ...(planNew !== undefined ? { planNew } : {}),
  };
}

/** Extracts every owner-decision envelope and returns the text with all of them removed. */
export function splitOwnerDecisionEnvelopesV1(text: string): { text: string; decisions: OwnerDecisionEnvelopeV1[] } {
  const decisions: OwnerDecisionEnvelopeV1[] = [];
  const remaining = text
    .replace(ENVELOPE_RE_V1, (_whole, blockerId: string, body: string) => {
      decisions.push(parseEnvelopeBodyV1(blockerId, body));
      return "";
    })
    .trim();
  return { text: remaining, decisions };
}

const CHECKLIST_LINE_RE_V1 = /^\s*[-*]\s+\[[ xX]\]/;
const SUB_BULLET_RE_V1 = /^\s+[-*]\s+\S/;

export type SubBulletReplacementV1 = { readonly ok: true; readonly content: string } | { readonly ok: false; readonly reason: string };

/**
 * Replaces `oldText` with `newText` inside one indented plain bullet line. Refuses (with the reason) when the text
 * is missing, matches more than once, sits on a checklist line, is not in an indented bullet, or spans lines.
 */
export function replacePlainSubBulletTextV1(content: string, oldText: string, newText: string): SubBulletReplacementV1 {
  const before = oldText.trim();
  const after = newText.trim();
  if (before === "") return { ok: false, reason: "no existing wording to replace was given" };
  if (after === "") return { ok: false, reason: "no replacement wording was given" };
  if (/[\r\n]/.test(before) || /[\r\n]/.test(after)) return { ok: false, reason: "the wording spans more than one line" };
  const matches = content.split(before).length - 1;
  if (matches === 0) return { ok: false, reason: "the existing wording was not found" };
  if (matches > 1) return { ok: false, reason: `the existing wording matched ${matches} places` };
  const index = content.indexOf(before);
  const lineStart = index === 0 ? 0 : content.lastIndexOf("\n", index - 1) + 1;
  const lineEndAt = content.indexOf("\n", index);
  const line = content.slice(lineStart, lineEndAt < 0 ? content.length : lineEndAt);
  if (CHECKLIST_LINE_RE_V1.test(line)) {
    return { ok: false, reason: "the text matched a checklist line (- [ ] / - [x]), which chat never changes" };
  }
  if (!SUB_BULLET_RE_V1.test(line)) return { ok: false, reason: "the text is not in an indented sub-bullet" };
  if (CHECKLIST_LINE_RE_V1.test(after) || /^\[[ xX]\]/.test(after)) {
    return { ok: false, reason: "the replacement looks like a checklist line" };
  }
  return { ok: true, content: `${content.slice(0, index)}${after}${content.slice(index + before.length)}` };
}

export interface OwnerDecisionNotWrittenV1 {
  readonly file: string;
  readonly reason: string;
  /** The edit or click that finishes the job, in plain words. */
  readonly finish: string;
}

export interface OwnerDecisionRecordResultV1 {
  readonly blockerId: string;
  readonly written: readonly string[];
  readonly notWritten: readonly OwnerDecisionNotWrittenV1[];
}

/** Writes one file's new content; returns an error text, or undefined when it was written. */
export type OwnerDecisionFileWriterV1 = (relPath: string, content: string) => Promise<string | undefined>;

/** The default writer: a plain write that refuses when the file changed since it was read. */
export function createPlainOwnerDecisionWriterV1(taskFolderPath: string, readFrom: Map<string, string>): OwnerDecisionFileWriterV1 {
  return async (relPath, content) => {
    const target = path.join(taskFolderPath, relPath);
    try {
      const current = await fs.readFile(target, "utf8");
      if (current !== readFrom.get(relPath)) return "the file changed while the decision was being recorded";
      await fs.writeFile(target, content);
      return undefined;
    } catch (error) {
      return error instanceof Error ? error.message : String(error);
    }
  };
}

async function readIfExistsV1(file: string): Promise<string | undefined> {
  try {
    return await fs.readFile(file, "utf8");
  } catch {
    return undefined;
  }
}

/**
 * Records one envelope: task.md "## Owner decisions" (replacing an earlier entry for the blocker), the plan-final.md
 * sub-bullet, and the same sub-bullet in plan.md when it is there. Each part is independent; what could not be
 * written is returned with the reason and the way to finish it.
 */
export async function recordOwnerDecisionFromChatV1(
  taskFolderPath: string,
  envelope: OwnerDecisionEnvelopeV1,
  writer?: OwnerDecisionFileWriterV1,
  date: string = new Date().toISOString().slice(0, 10)
): Promise<OwnerDecisionRecordResultV1> {
  const written: string[] = [];
  const notWritten: OwnerDecisionNotWrittenV1[] = [];

  const recordedInTask = await recordReplacingOwnerDecisionV1(
    taskFolderPath,
    {
      blockerId: envelope.blockerId,
      blockerText: envelope.blockerText ?? `${envelope.blockerId} (decided in Chat With AI)`,
      answer: envelope.decision,
    },
    date
  ).catch(() => false);
  if (recordedInTask) {
    written.push("task.md");
  } else {
    notWritten.push({
      file: "task.md",
      reason: "the Owner decisions entry could not be written, or this exact decision is already recorded there",
      finish: `Check the Owner decisions section of task.md; if the entry is missing, add "${envelope.decision}" under it by hand.`,
    });
  }

  const planEdits: { readonly file: string; readonly required: boolean }[] = [
    { file: "plan-final.md", required: true },
    { file: "plan.md", required: false },
  ];
  const originals = new Map<string, string>();
  const write = writer ?? createPlainOwnerDecisionWriterV1(taskFolderPath, originals);
  for (const { file, required } of planEdits) {
    const text = await readIfExistsV1(path.join(taskFolderPath, file));
    if (envelope.planOld === undefined || envelope.planNew === undefined) {
      if (required) {
        notWritten.push({
          file,
          reason: "the reply gave no old and new wording for a sub-bullet",
          finish: `Edit the matching sub-bullet in ${file} by hand, or ask again with the old wording and the new wording.`,
        });
      }
      continue;
    }
    if (text === undefined) {
      if (required) {
        notWritten.push({ file, reason: "the file does not exist", finish: `Create or restore ${file}, then ask again.` });
      }
      continue;
    }
    originals.set(file, text);
    const replaced = replacePlainSubBulletTextV1(text, envelope.planOld, envelope.planNew);
    if (!replaced.ok) {
      // plan.md only needs the change when it carries the same text; a plain "not found" there is not a problem.
      if (!required && replaced.reason === "the existing wording was not found") continue;
      notWritten.push({
        file,
        reason: replaced.reason,
        finish: `Edit the matching sub-bullet in ${file} by hand; no checklist line is changed from chat.`,
      });
      continue;
    }
    const failure = await write(file, replaced.content);
    if (failure === undefined) {
      written.push(file);
    } else {
      notWritten.push({ file, reason: failure, finish: `Edit the matching sub-bullet in ${file} by hand.` });
    }
  }
  return { blockerId: envelope.blockerId, written, notWritten };
}

/** The reply lines for one result: what was written (only that), then one plain line per file not written. */
export function describeOwnerDecisionRecordResultV1(result: OwnerDecisionRecordResultV1): string {
  const lines: string[] = [];
  if (result.written.length > 0) {
    lines.push(`_Updated ${result.written.map((file) => `\`${file}\``).join(", ")} for ${result.blockerId}._`);
  }
  for (const miss of result.notWritten) {
    lines.push(`${miss.file} was not changed: ${miss.reason}. ${miss.finish}`);
  }
  return lines.join("\n\n");
}
