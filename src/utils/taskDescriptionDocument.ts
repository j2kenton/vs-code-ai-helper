/**
 * Utilities for normalizing and rewriting task.md documents.
 */

export const INTRO_TEXT = `Describe the work you want to do here in as much detail as is useful. When\nyou're ready, use **Draft with AI** to turn these notes into a structured task\ndescription. Questions from the stage AI appear in the **Chat With AI** panel.`;
export const LEGACY_INTRO_TEXT = `Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.`;
export const SHORTCUT_NOTE = `Shortcut: Apply Current Stage Action (Ctrl+Shift+Alt+I).`;

/**
 * Bracketed hint rendered under `## Draft with AI` while the draft body is
 * empty, pointing at the button and the same shortcut SHORTCUT_NOTE names.
 * Stripped on parse exactly like INTRO_TEXT/SHORTCUT_NOTE so it never leaks
 * into taskDescription or the draft body.
 */
export const DRAFT_WITH_AI_HINT = `[Click the Draft with AI button, or press Ctrl+Shift+Alt+I]`;

/**
 * Blank lines emitted between `## Task Description` and `## Draft with AI`
 * while the description is empty: an obvious typing area in the raw editor
 * (Markdown collapses them on render — that is accepted).
 */
export const EMPTY_DESCRIPTION_GAP_LINES = 15;

export interface ParsedTaskDocument {
  introText: string;
  shortcutNote?: string;
  taskDescription: string;
  draftWithAI: string;
  openQuestions: string;
  /** Original EOL style detected */
  eol?: "\r\n" | "\n";
}

/**
 * Detect the line ending style of a string.
 */
export function detectEOL(content: string): "\r\n" | "\n" {
  if (content.includes("\r\n")) {
    return "\r\n";
  }
  return "\n";
}

/**
 * Parse and normalize a task.md document into canonical sections.
 * Only exact top-level `## ` headers at line start, outside fenced code blocks,
 * are treated as canonical section delimiters.
 */
export function parseTaskDocument(content: string): ParsedTaskDocument {
  const eol = detectEOL(content);
  const lines = content.split(/\r?\n/);
  let inFencedBlock = false;

  interface Section {
    header: string | null; // null = pre-header content
    body: string[];
  }

  const sections: Section[] = [{ header: null, body: [] }];
  let currentSection = sections[0]!;

  for (const line of lines) {
    // Track fenced code blocks
    if (/^```/.test(line)) {
      inFencedBlock = !inFencedBlock;
      currentSection.body.push(line);
      continue;
    }

    if (!inFencedBlock && (/^## /.test(line) || /^# Task\b/.test(line))) {
      const header = line.trim();
      currentSection = { header, body: [] };
      sections.push(currentSection);
    } else {
      currentSection.body.push(line);
    }
  }

  // Collect bodies for each canonical section (merging duplicates)
  const taskDescBodies: string[] = [];
  const draftBodies: string[] = [];
  const questionsBodies: string[] = [];

  for (const section of sections) {
    const bodyText = section.body.join("\n").trim();
    if (!bodyText) continue;

    if (section.header === null || section.header === "# Task") {
      let withoutIntro = bodyText
        .replace(INTRO_TEXT, "")
        .replace(LEGACY_INTRO_TEXT, "")
        .replace(/^Shortcut:\s*Apply Current Stage Action.*$/im, "")
        .replace(SHORTCUT_NOTE, "")
        .trim();
      withoutIntro = withoutIntro
        .replace(/^# Instructions\s*/, "")
        .replace(/^# User's Description of the Task\s*/, "")
        .trim();
      if (withoutIntro.length > 0) {
        taskDescBodies.push(withoutIntro);
      }
    } else if (section.header === "## Task Description") {
      taskDescBodies.push(bodyText);
    } else if (section.header === "## Draft with AI") {
      const withoutHint = bodyText.replace(DRAFT_WITH_AI_HINT, "").trim();
      if (withoutHint.length > 0) {
        draftBodies.push(withoutHint);
      }
    } else if (section.header === "## Open Questions") {
      questionsBodies.push(bodyText);
    } else {
      // Non-canonical header: move to task description
      taskDescBodies.push(`${section.header}\n\n${bodyText}`);
    }
  }

  return {
    introText: INTRO_TEXT + "\n\n" + SHORTCUT_NOTE,
    shortcutNote: SHORTCUT_NOTE,
    taskDescription: taskDescBodies.join("\n\n").trim(),
    draftWithAI: draftBodies.join("\n\n").trim(),
    openQuestions: questionsBodies.join("\n\n").trim(),
    eol,
  };
}

/**
 * Rebuild a task.md document from parsed sections with canonical V1 structure.
 *
 * Emits canonical V1 structure using UTF-8 without BOM, LF line endings (\n), and one final newline:
 * # Task
 * ## Task Description
 * ## Draft with AI
 *
 * The V1 rewriter never emits ## Open Questions (new clarification needs route to Chat With AI).
 */
export function buildTaskDocument(parsed: ParsedTaskDocument): string {
  const parts: string[] = [];

  parts.push("# Task");
  parts.push("");
  parts.push("## Task Description");
  const taskDesc = parsed.taskDescription ? parsed.taskDescription.replace(/\r\n/g, "\n").trim() : "";
  if (taskDesc) {
    parts.push("");
    parts.push(taskDesc);
    parts.push("");
  } else {
    // An empty description gets a tall blank typing area so the user can see
    // where their text goes (EMPTY_DESCRIPTION_GAP_LINES blank lines).
    for (let i = 0; i < EMPTY_DESCRIPTION_GAP_LINES; i++) {
      parts.push("");
    }
  }
  parts.push("## Draft with AI");
  const draftBody = parsed.draftWithAI ? parsed.draftWithAI.replace(/\r\n/g, "\n").trim() : "";
  if (draftBody) {
    parts.push("");
    parts.push(draftBody);
  } else {
    parts.push("");
    parts.push(DRAFT_WITH_AI_HINT);
  }

  return parts.join("\n") + "\n";
}

export const rebuildTaskDocument = buildTaskDocument;

/**
 * The fixed subsection contract for the AI draft: the `## Draft with AI`
 * body must contain these three headed subsections so the draft states
 * concrete work rather than abstract planning language.
 */
export const DRAFT_REQUIRED_SUBSECTIONS = [
  "Behavior change",
  "Affected areas",
  "Actionable changes",
] as const;

/**
 * Check the draft body for the three required subsections (any heading
 * level, case-insensitive) AND a non-empty body under each.
 */
export function validateDraftStructure(
  draftBody: string
): { valid: boolean; missing: string[] } {
  const lines = draftBody.split(/\r?\n/);
  interface Heading {
    lineIndex: number;
    title: string;
  }
  const headings: Heading[] = [];
  lines.forEach((line, lineIndex) => {
    const match = /^#{1,6}\s*(.*?)\s*$/.exec(line);
    if (match) {
      headings.push({ lineIndex, title: match[1]!.toLowerCase() });
    }
  });
  const missing = DRAFT_REQUIRED_SUBSECTIONS.filter((title) => {
    const at = headings.findIndex((h) => h.title === title.toLowerCase());
    if (at === -1) {
      return true;
    }
    const bodyStart = headings[at]!.lineIndex + 1;
    const bodyEnd =
      at + 1 < headings.length ? headings[at + 1]!.lineIndex : lines.length;
    return lines.slice(bodyStart, bodyEnd).join("\n").trim().length === 0;
  });
  return { valid: missing.length === 0, missing };
}

/**
 * Heading a structurally invalid draft is filed under when it is accepted
 * as a fallback.
 */
export const DRAFT_UNSTRUCTURED_HEADING = "### Draft (unstructured)";

/**
 * Wrap a draft body that failed structure validation under the
 * `Draft (unstructured)` heading with a notice naming the missing/empty
 * subsections.
 */
export function wrapUnstructuredDraft(
  draftBody: string,
  missing: readonly string[]
): string {
  return [
    DRAFT_UNSTRUCTURED_HEADING,
    "",
    `> The AI response was missing (or had empty) required subsection(s) — ${missing.join(", ")}. Review this draft and structure it manually, or run Draft with AI again.`,
    "",
    draftBody,
  ].join("\n");
}
