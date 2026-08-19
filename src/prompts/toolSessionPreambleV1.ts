/**
 * The request-local preflight session's preamble (plan §7.2/§7.3).
 *
 * Preflight is phase one of the two-phase edit: the model may only READ, and
 * answers with a `preflight-plan.v1` describing the mutations it wants; the
 * host validates that plan against the attempt's observation ledger and
 * executes it in a sealed second phase. None of that was ever stated to the
 * model, and three of the values it is required to produce were unknowable:
 *
 *  - `rootId` — every read tool takes one, documented as coming from "the
 *    session preamble", which did not exist. The handler compares it by exact
 *    string equality, so every call answered `unknownRoot` and the 2026-08-17
 *    impl run failed with the model's own "unknown-root-id".
 *  - `rootBindingId` / `requestDigest` — the plan must echo both verbatim, and
 *    both are host-computed (the digest is a SHA-256 over the exact prompt
 *    bytes; a model cannot derive it).
 *
 * With the tools read-only and the prompt asking for an implementation, the
 * model's next honest answer was "no_write_capability" — the second observed
 * failure. It was right: it had no way to write and had not been told that
 * planning WAS the deliverable.
 *
 * These are opaque host-issued identifiers, not paths or anything derivable.
 * Stating them verbatim is the whole contract.
 */

/** Everything the model must know before it can plan a single edit. */
export interface PreflightToolSessionPreambleInputV1 {
  /** The single registered root id, exactly as the handler compares it. */
  readonly rootId: string;
  /** Echoed verbatim by the plan (§7.3). */
  readonly rootBindingId: string;
  /** SHA-256 over the exact prompt bytes; echoed verbatim by the plan (§7.3). */
  readonly requestDigest: string;
  /**
   * What this round is FOR. Every preflight row shared one preamble, and that
   * preamble described the job as "work the plan checklist until it is
   * complete" — correct for an implementation round, actively wrong for a
   * review-fix round, whose work is the blockers the review lists and which
   * commonly has no checklist item at all (a defect in already-built code is
   * not an unbuilt plan step).
   *
   * Observed 2026-08-19 in the jester task: Apply Review rounds read the
   * workspace at length and then returned `operations: []`, round after round,
   * while the low-level review held the same three task-fixable blockers. The
   * framing at the top of the prompt told the model its job was a checklist
   * that was 69/73 done with nothing actionable left, and explicitly offered
   * an empty plan as a valid answer — so an empty plan is what it produced,
   * with the blockers sitting unread further down the same prompt.
   *
   * Defaults to "checklist" so any caller not yet passing one keeps the exact
   * prior text.
   */
  readonly purpose?: PreflightRoundPurposeV1;
}

/** See `PreflightToolSessionPreambleInputV1.purpose`. */
export type PreflightRoundPurposeV1 = "checklist" | "review-fixes" | "lint-fixes";

/**
 * Build the preamble prepended to the preflight row's prompt.
 *
 * Assembled in the row rather than the coordinator because the row is the
 * only layer that holds all three identifiers — the coordinator treats the
 * validated input as opaque. A preamble missing any one of them leaves the
 * model unable to produce a valid plan at all.
 */
/**
 * The "what is this round for" section. Shared shape, different work:
 * partial progress is normal in all three, but what counts as progress — and
 * what makes an empty plan honest rather than a wasted round — differs.
 */
function purposeSectionV1(purpose: PreflightRoundPurposeV1): string[] {
  if (purpose === "review-fixes") {
    return [
      "### Your job this round: fix what the review found",
      "",
      "A review of this code is included below. The blockers it lists ARE this",
      "round's work. Fix as many as you can.",
      "",
      "Most of them are defects in code that already exists, so do NOT expect to",
      "find them as unticked items on the plan checklist — a checklist that looks",
      "complete is not evidence that there is nothing to do. The review is the",
      "authority on what is wrong here, not the checklist.",
      "",
      "**Do not return an empty plan while blockers remain.** An empty",
      "`operations` array is only honest if you have OPENED the code each blocker",
      "names and confirmed it is already fixed. If you believe a blocker is wrong",
      "or already resolved, say so in the plan's reasoning — but do not answer",
      "\"nothing to change\" without having read the relevant file. A round that",
      "plans nothing while the review still reports problems is a wasted round:",
      "the next review reports exactly the same blockers, and nothing moves.",
      "",
      "You do not have to fix every blocker in one plan. Fixing some and leaving",
      "the rest for the next round is normal and expected. Fixing none is not.",
    ];
  }
  if (purpose === "lint-fixes") {
    return [
      "### Your job this round: fix the reported lint failures",
      "",
      "The failures reported below are this round's work. An empty `operations`",
      "array is only correct if you have read the files they name and confirmed",
      "they are already clean.",
    ];
  }
  return [
    "An empty `operations` array is a valid answer when nothing needs to change.",
    "",
    "### You do not have to finish the whole task in one plan",
    "",
    "This runs as REPEATED rounds. After your plan is applied the work is reviewed",
    "and you are called again, with the workspace as your previous round left it,",
    "until the checklist is complete. A plan covering part of the task is normal and",
    "expected — not a failure, and not something to apologise for.",
    "",
    "So when a task is large, plan a COHERENT SLICE that fits comfortably in one",
    "response and stop there. Prefer whole units: a file finished rather than three",
    "files half-written, so that what lands always type-checks and the next round",
    "starts from a clean state. Order the slice so the earliest unticked checklist",
    "items are addressed first.",
    "",
    "**Never refuse a task for being too large.** Returning no operations because",
    "the whole job will not fit wastes the round entirely: nothing is implemented,",
    "the review sees no progress, and the next round faces exactly the same task. A",
    "small slice that lands beats a perfect plan that does not.",
  ];
}

export function buildPreflightToolSessionPreambleV1(
  input: PreflightToolSessionPreambleInputV1
): string {
  return [
    "## How this request works (read-only planning phase)",
    "",
    "This is phase one of two. You CANNOT modify anything in this phase, and no",
    "tool offered to you writes. Do not treat that as a failure or report a missing",
    "capability: producing the plan IS the deliverable. You describe the changes,",
    "and the host validates and applies them in a sealed second phase.",
    "",
    "Answer with a `preflight-plan.v1` result listing the operations you want",
    "performed.",
    "",
    ...purposeSectionV1(input.purpose ?? "checklist"),
    "",
    "### Session identifiers",
    "",
    "Use these values verbatim. They are opaque host-issued identifiers — not",
    "paths, not derivable, and not to be reformatted or invented:",
    "",
    `    rootId:        ${input.rootId}`,
    `    rootBindingId: ${input.rootBindingId}`,
    `    requestDigest: ${input.requestDigest}`,
    "",
    "Every tool call and every operation takes `rootId`. The plan itself must echo",
    "`rootBindingId` and `requestDigest` exactly as given above.",
    "",
    "### Reading the workspace",
    "",
    "Paths are root-relative, forward-slash, with no leading `/`, no `.` and no",
    "`..`. Use `ensemble_readDirectory` with an empty `relativePath` to list the",
    "root.",
    "",
    "`ensemble_findFiles` and `ensemble_textSearch` are discovery only. Their",
    "observations can NEVER authorize an operation — only `ensemble_readFile`,",
    "`ensemble_stat` and `ensemble_readDirectory` can. Locate a candidate with",
    "discovery if you like, then read or stat its exact path before planning against",
    "it.",
    "",
    "### Planning an operation",
    "",
    "Every operation needs `targetObservationId`: the `observationId` returned by",
    "the read/stat/readDirectory call for that exact path. The observation must",
    "match the state the operation assumes, or the plan is rejected:",
    "",
    "  - `createFile` / `createDirectory` require an observation of kind `missing`",
    "  - `patchFile` / `replaceFile` / `deleteFile` require an observation of kind `file`",
    "  - `deleteEmptyDirectory` requires an observed, provably empty directory",
    "",
    "So stat a path you intend to create even when you expect it to be absent — the",
    "`missing` observation is what authorizes creating it.",
    "",
    "`parentChain` is required ONLY for `createFile` and `createDirectory`. For any",
    "operation on a file that already exists — `patchFile`, `replaceFile`,",
    "`deleteFile` — send an empty `parentChain: []`. The file's own observation",
    "already proves its directories exist, so nothing further is needed.",
    "",
    "When you ARE creating something, `parentChain` lists every directory between",
    "the root (exclusive) and the new item's immediate parent (inclusive), in",
    "root-to-parent order — one link per path segment before the final name. Each",
    'link is either `{"kind":"observed","observationId":"..."}` for a directory you',
    'observed, or `{"kind":"createdByStep","stepId":"..."}` for one an earlier',
    "operation in this same plan creates. Something created directly in the root",
    "has an empty `parentChain`.",
    "",
    "Count the segments rather than copying an example. Creating",
    "`apps/server/new.ts` needs two links (`apps`, `apps/server`); creating",
    "`apps/server/lib/competition/new.ts` needs four (`apps`, `apps/server`,",
    "`apps/server/lib`, `apps/server/lib/competition`). A plain `ensemble_stat` on",
    "each is enough — you do NOT need to list their contents. Use `ensemble_stat`,",
    "not `ensemble_findFiles` or `ensemble_textSearch`: a discovery result can never",
    "authorize anything, including a parent link.",
    "",
    "**At most ONE operation per file, per plan.** Two operations on the same path",
    "are rejected before anything is applied. This is not arbitrary: each operation",
    "carries the file's revision as observed during planning, and the first write",
    "changes it — so a second operation on that file would be acting on a revision",
    "that no longer exists.",
    "",
    "If a file needs several separate edits, either widen ONE `patchFile` so its",
    "`findText` spans them all (include the unchanged lines in between, verbatim, in",
    "both `findText` and `replacementText`), or make the nearest edit now and leave",
    "the rest for the next round. Do not split one file across two operations.",
    "",
    "`stepId` is yours to choose and must be unique within the plan.",
    "",
    "### Changing an existing file: prefer `patchFile`",
    "",
    "`patchFile` replaces one region and carries only that region:",
    "",
    "  - `findText` — the EXACT existing text to replace, copied verbatim",
    "  - `replacementText` — the new text",
    "",
    "Send these as ordinary JSON strings. Do NOT base64-encode them: normal JSON",
    "escaping already carries newlines, quotes and Unicode, and hand-encoding is an",
    "error-prone step you should not attempt. (`findBase64`/`replacementBase64`",
    "exist for tooling that already has encoded bytes; never encode by hand to use",
    "them, and never send both forms for the same payload.)",
    "",
    "The text in `findText` must appear EXACTLY ONCE in the file. If it appears",
    "more than once the operation is refused, so include enough surrounding lines",
    "to make it unique rather than matching a bare fragment. Copy it verbatim from",
    "what `ensemble_readFile` returned — a paraphrase or a re-indented copy will",
    "not match. For several separate edits to the SAME file, widen one",
    "`patchFile` to span them or leave the rest for the next round — see the",
    "one-operation-per-file rule above; a second operation on the same path is",
    "rejected before anything is applied.",
    "",
    "Prefer this for ANY edit to an existing file. `replaceFile` carries the whole",
    "file in `contentBase64`, so it is limited by your own output budget: a small",
    "change to a large file cannot be expressed that way at all, and attempting it",
    "wastes the round. `patchFile`'s cost scales with the size of the change, not",
    "the size of the file.",
    "",
    "Use `replaceFile` only when you are genuinely rewriting a file end to end, or",
    "for `createFile`, where `contentBase64` is base64 of the COMPLETE new file",
    "bytes. Do not add a length or checksum field — the host derives those from",
    "the content itself.",
  ].join("\n");
}

/**
 * Preamble for a READ-ONLY workspace session attached to a text-producing row
 * (currently review). Much shorter than the preflight preamble: there is no
 * plan to author, no digests to echo, no operations to construct — the model
 * just needs to know it can open files, and which identifier to pass.
 *
 * Without this the tools are attached but never mentioned, and a model that
 * is not told it can read will reason from the prompt alone — exactly the
 * failure this whole change exists to remove.
 */
export function buildWorkspaceReadSessionPreambleV1(input: { readonly rootId: string }): string {
  return [
    "## Workspace access",
    "",
    "You can read this workspace directly. Do NOT rely only on excerpts quoted in",
    "the prompt below — they may be truncated. If a file matters to your",
    "conclusion, open it and check.",
    "",
    "Tools available to you (read-only — nothing here can modify anything):",
    "",
    "  - `ensemble_readFile` — read one file by exact root-relative path",
    "  - `ensemble_stat` — check whether a path exists and what kind it is",
    "  - `ensemble_readDirectory` — list one directory's entries",
    "  - `ensemble_findFiles` — find files whose path contains a substring",
    "  - `ensemble_textSearch` — search file contents for a literal string",
    "",
    "Every call takes `rootId`. Exactly one root is registered:",
    "",
    `    rootId: ${input.rootId}`,
    "",
    "Pass that value verbatim. Paths are root-relative, forward-slash, with no",
    "leading `/`, no `.` and no `..`. Use `ensemble_readDirectory` with an empty",
    "`relativePath` to list the root.",
    "",
    "**Never report work as missing because you could not see it.** If an excerpt",
    "is truncated or a file is absent from the prompt, read it before judging. If",
    "you still cannot verify something, say so explicitly as a confidence",
    "limitation rather than concluding the work was not done.",
    "",
    "### When you stop calling tools, you are finished",
    "",
    "Keep calling tools for as long as you need. But the FIRST reply you send",
    "without a tool call ends this session and is taken as your complete answer —",
    "there is no later turn. So that reply must be the full result frame required",
    "by the result contract below, and nothing else.",
    "",
    "Do not use a tool-free reply to summarise findings, think aloud, or announce",
    "what you are about to write. A reply that says you will produce the answer",
    "next is recorded AS the answer, and is then rejected for not matching the",
    "contract — losing all the work you just did.",
  ].join("\n");
}
