/**
 * Utilities for normalizing and rewriting task.md documents.
 */

export const INTRO_TEXT = `Briefly describe what changes you want to be made, and then use AI to help you clarify the plan.`;
export const SHORTCUT_NOTE = `Shortcut: Apply Current Stage Action (Windows/Linux: Ctrl+Shift+Alt+I, macOS: Cmd+Shift+Alt+I).`;

export interface ParsedTaskDocument {
  introText: string;
  shortcutNote: string;
  taskDescription: string;
  draftWithAI: string;
  openQuestions: string;
  /** Original EOL style detected */
  eol: "\r\n" | "\n";
}

/**
 * Parse and normalize a task.md document into canonical sections.
 * Only exact top-level `## ` headers at line start, outside fenced code blocks,
 * are treated as canonical section delimiters.
 */
export function parseTaskDocument(content: string): ParsedTaskDocument {
  // Detect EOL style
  const eol = content.includes("\r\n") ? "\r\n" : "\n";
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

    if (!inFencedBlock && /^## /.test(line)) {
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
  let hasIntro = false;
  let hasShortcut = false;

  for (const section of sections) {
    const bodyText = section.body.join("\n").trim();

    if (section.header === null) {
      // Pre-header content: check for intro and shortcut
      if (bodyText.includes(INTRO_TEXT)) {
        hasIntro = true;
      }
      if (bodyText.includes(SHORTCUT_NOTE)) {
        hasShortcut = true;
      }

      // Any stray content goes to task description
      const withoutIntro = bodyText
        .replace(INTRO_TEXT, "")
        .replace(SHORTCUT_NOTE, "")
        .trim();
      if (withoutIntro.length > 0) {
        taskDescBodies.push(withoutIntro);
      }
    } else if (section.header === "## Task Description") {
      if (bodyText.length > 0) {
        taskDescBodies.push(bodyText);
      }
    } else if (section.header === "## Draft with AI") {
      if (bodyText.length > 0) {
        draftBodies.push(bodyText);
      }
    } else if (section.header === "## Open Questions") {
      if (bodyText.length > 0) {
        questionsBodies.push(bodyText);
      }
    } else {
      // Non-canonical header: move to task description
      if (bodyText.length > 0) {
        taskDescBodies.push(`${section.header}\n\n${bodyText}`);
      }
    }
  }

  return {
    introText: hasIntro ? INTRO_TEXT : "",
    shortcutNote: hasShortcut ? SHORTCUT_NOTE : "",
    taskDescription: taskDescBodies.join("\n\n").trim(),
    draftWithAI: draftBodies.join("\n\n").trim(),
    openQuestions: questionsBodies.join("\n\n").trim(),
    eol,
  };
}

/**
 * Rebuild a task.md document from parsed sections with canonical structure.
 */
export function rebuildTaskDocument(parsed: ParsedTaskDocument): string {
  const parts: string[] = [];

  // Intro text and shortcut note
  if (parsed.introText.length > 0) {
    parts.push(parsed.introText);
  } else {
    parts.push(INTRO_TEXT);
  }

  if (parsed.shortcutNote.length > 0) {
    parts.push(parsed.shortcutNote);
  } else {
    parts.push(SHORTCUT_NOTE);
  }

  parts.push(""); // blank line

  // Task Description
  parts.push("## Task Description");
  parts.push("");
  if (parsed.taskDescription.length > 0) {
    parts.push(parsed.taskDescription);
  }
  parts.push("");

  // Draft with AI
  parts.push("## Draft with AI");
  parts.push("");
  if (parsed.draftWithAI.length > 0) {
    parts.push(parsed.draftWithAI);
  }
  parts.push("");

  // Open Questions
  parts.push("## Open Questions");
  parts.push("");
  if (parsed.openQuestions.length > 0) {
    parts.push(parsed.openQuestions);
  }

  return parts.join(parsed.eol);
}
