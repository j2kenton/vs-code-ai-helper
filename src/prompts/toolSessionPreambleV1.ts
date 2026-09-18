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
import {
  MAX_CONSECUTIVE_DISCOVERY_CALLS_V1,
  MAX_READ_FILE_BYTES_V1,
  MAX_TOOL_ROUNDS_V1,
} from "../types/workflowToolProtocolV1";

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
      "### Your job this round: fix what the review found, then keep building",
      "",
      "A review of this code is included below. Any blockers it lists come FIRST:",
      "they are this round's work. Fix as many as you can.",
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
      "",
      "**Several blockers usually live in the SAME file.** That is fine: two or",
      "more `patchFile` operations on one file, in one plan, are allowed and apply",
      "in order, each verified against the file as the previous one left it. Give",
      "each blocker its own narrow `patchFile` rather than widening a single patch",
      "to span unrelated regions — see the rule below. (Whole-file `replaceFile`",
      "is the exception: a path may carry only one of those.)",
      "",
      // Observed 2026-09-17 (v1 fixes 2, run 2057): a review with ZERO blockers
      // and 74 plan steps unbuilt produced an empty plan. The section above
      // said the blockers ARE the round's work and the checklist is not the
      // authority, so with nothing to fix an empty plan was the honest answer
      // to the question asked — while rule 8 of apply-impl-review-code.md
      // ("no blockers → build the next steps") sat 150 lines further down.
      // Fast Forward keeps dispatching this round on a clean review precisely
      // so the plan keeps being built, so the framing must say so up here.
      // The next attempt (run 2058) did find rule 8, read for five minutes,
      // then declared `failed` with a model-invented `scope-too-large-for-budget`
      // — this framing, unlike the checklist one, never said a slice is enough.
      "### When the review lists NO blockers, build the next plan steps",
      "",
      "\"No blockers\" means nothing is wrong with what exists. It does NOT mean the",
      "task is finished. Check the plan checklist and the review's",
      "`<!-- progress: N/M -->` marker: if steps remain unbuilt (N is less than M,",
      "or the checklist still has `- [ ]` items), this round's work is to BUILD THE",
      "NEXT STEPS, in the plan's own order, starting from the earliest unbuilt item.",
      "The same applies once every blocker you can fix is fixed and the plan has",
      "room left.",
      "",
      "Plan a COHERENT SLICE that fits comfortably in one response and stop there:",
      "whole units, a file finished rather than three half-written, so that what",
      "lands type-checks. This runs as repeated rounds — you are called again for",
      "the rest — so a slice is normal and expected.",
      "",
      "**Never refuse because the remaining work is too large** — not with an empty",
      "plan, and not with a `failed` result. One test scenario, one function, one",
      "wired call site is a valid slice. If the earliest unbuilt item needs more",
      "reading than this session allows, land the part of it you CAN see clearly",
      "(use `ensemble_textSearch` and line-range reads to reach it in a large file),",
      "and say in the plan's reasoning what is left of that item.",
      "",
      "An empty `operations` array is therefore only honest when BOTH hold: no",
      "fixable blocker remains, AND no plan step remains unbuilt. An empty plan",
      "while steps remain stalls the task: the next review reports the same",
      "progress, and nothing moves.",
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

/**
 * Round at which the model should be writing its plan, not still reading:
 * two thirds of the cap, leaving the wind-down notices as a backstop rather
 * than the only signal.
 */
export const PREFLIGHT_PLAN_BY_ROUND_V1 = Math.floor((MAX_TOOL_ROUNDS_V1 * 2) / 3);

/**
 * The model is never otherwise told how many tool rounds it has, or that the
 * session removes older tool results once the conversation is large. Observed
 * 2026-09-17/18 (v1 fixes 2, runs 2059 and 2060): a "build the next steps"
 * round read for 59 of 64 rounds — every request succeeding — then answered
 * the wind-down notice with an empty plan (2060) or a `failed` result blaming
 * its own exhausted budget (2059). Both had read enough to author a slice by
 * round 20; neither knew a cap existed until six rounds from it.
 *
 * Run 2062 then showed WHERE the budget goes, once the Tool Sessions log
 * existed to count it: 59 replies carrying 76 `textSearch` calls, 7
 * `findFiles` and 11 `readFile` — about 1.6 calls per reply, and five sixths
 * of them searches that cannot authorize an operation. The cap is on REPLIES,
 * so batching is worth more than any amount of "read less" advice.
 */
function budgetSectionV1(): string[] {
  return [
    `### Your budget: ${MAX_TOOL_ROUNDS_V1} tool rounds — write the plan before they run out`,
    "",
    `This session allows at most ${MAX_TOOL_ROUNDS_V1} replies in total. A reply carrying one or more`,
    "tool calls consumes one; so does a reply that calls no tool at all, including",
    "your final answer, which also ends the session. A session that reaches the cap",
    "without a plan produces NOTHING: every observation is discarded and the round",
    "is wasted. Once the conversation grows large, older tool results are removed",
    "and would have to be re-read, so put text you intend to use as `findText` into",
    "the plan soon after you read it.",
    "",
    "**Put several calls in ONE reply.** Against this cap, five small calls in one",
    "reply cost what one call costs. They are not free in other ways — every result",
    "still consumes the conversation's byte budget, and when one reply returns",
    "several LARGE results the host may withhold all but one and ask you to re-read",
    "the rest — so batch small searches and line ranges, not several whole big",
    "files. One call per reply is how a session spends sixty replies on discovery",
    "and never writes a plan; it is the single most common way a round is lost.",
    "",
    "A reply used only for `ensemble_textSearch` or `ensemble_findFiles` still",
    "consumes one, and their observations can NEVER authorize an operation — only",
    "an exact-path `ensemble_readFile`, `ensemble_stat` or `ensemble_readDirectory`",
    "can. Searching repeatedly to build a complete picture is the slowest possible",
    "use of this budget: search once, broadly, then read the few places you",
    "actually intend to change.",
    "",
    `**This is enforced.** After ${MAX_CONSECUTIVE_DISCOVERY_CALLS_V1} searches in a row with no exact-path read,`,
    "`ensemble_textSearch` and `ensemble_findFiles` stop returning results and",
    "answer `discoveryBudgetExceeded` instead, naming the paths you already have.",
    "Reading any exact path clears it. This is not a punishment and not an error",
    "on your part — it exists because a session that keeps searching runs out of",
    "replies and delivers nothing, which is worse for you than reading an",
    "imperfectly chosen file.",
    "",
    "Work in this order:",
    "",
    "  1. In your first two or three replies, choose the slice: the earliest work",
    "     you can finish this round (from the review's blockers, then the",
    "     checklist's first unticked items).",
    "  2. Read only what that slice touches: the signatures it calls, the exact",
    "     region you will patch, the end of the test file you will extend. Locate",
    "     with `ensemble_textSearch`, then read the line range.",
    `  3. Be writing the plan by round ${PREFLIGHT_PLAN_BY_ROUND_V1} at the latest. A plan authored at round`,
    "     20 from a few exact reads lands; a complete understanding reached at",
    `     round ${MAX_TOOL_ROUNDS_V1} lands nothing. Shrink the slice rather than keep reading.`,
  ];
}

/**
 * Appended AFTER the caller's rendered prompt on a preflight row, because the
 * prompt it follows was written for a different kind of agent.
 *
 * `apply-impl-review-code.md` — the template every Apply Review round carries —
 * opens with "You are addressing an implementation review by making actual
 * changes to the codebase", tells the model to "Edit files directly in the
 * workspace", to "make sure the workspace files were actually changed" and to
 * "report that failure" if it cannot write, to run the tests covering its
 * changes, and to answer with a Markdown summary. None of that is possible in a
 * read-only planning session, and all of it arrives AFTER the preamble that
 * says so (2026-09-18 adversarial review, finding 1). Run 2058 did exactly what
 * the template asks of an agent that cannot write: it reported failure. Runs
 * 2060 and 2062 inspected exhaustively, as an executor would, and never
 * authored a plan.
 *
 * The contradiction is resolved where the model reads last, rather than by
 * forking the template: the same file must keep working verbatim for CLI
 * providers, which really do edit files directly.
 */
export function buildPreflightClosingOverrideV1(): string {
  return [
    "## Before you answer — this phase is read-only (this overrides the instructions above)",
    "",
    "The instructions above were written for an agent that edits the workspace",
    "directly. Everything in them about editing or writing files, running commands,",
    "tests or type-checks, confirming that files really changed, and producing a",
    "Markdown summary describes the SEALED SECOND PHASE and Ensemble's own",
    "verification — not this reply. Nothing you can do here writes anything.",
    "",
    "In this session you:",
    "",
    "  - do NOT edit, write or delete any file;",
    "  - do NOT run commands, tests or type-checks — and do not report being unable",
    "    to, or treat it as a reason the work cannot be done;",
    "  - do NOT write the Markdown summary, the `## Files Changed` section or the",
    "    `## Plan Item Checklist` — Ensemble collects those after the edits land;",
    "  - DO end by returning one `preflight-plan.v1` result frame containing the",
    "    operations you want applied.",
    "",
    // 2026-09-18, run 2066: the model answered on its FIRST reply with no tool
    // calls at all and an empty plan, explaining that it "was unable to obtain
    // any exact-path file observations before the response needed to be
    // finalized". Nothing was rushing it — 64 replies were available. The
    // wording above said "in this reply", which reads as "answer now".
    "**Nothing here asks you to answer immediately.** Read first: the plan is your",
    "LAST reply, not your first. Every operation needs a `targetObservationId`",
    "from a file you opened in this session, so a plan written before you have read",
    "anything cannot contain a single valid operation. Spend the replies you need,",
    "then plan.",
    "",
    "Read the instructions above for WHAT to change and in what order. The plan you",
    "return is how it gets done: describing an edit here IS making it. A plan that",
    "lands one coherent slice is a successful round. A Markdown summary, an",
    "apology for being unable to edit, or an empty plan while work remains, is a",
    "wasted one.",
  ].join("\n");
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
    ...budgetSectionV1(),
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
    "`ensemble_readFile` takes an optional `startLine`/`endLine` to read only part",
    "of a file. Prefer that for large files: this session has a limited number of",
    "tool rounds, and a file over " + `${MAX_READ_FILE_BYTES_V1 / 1024} KB` + " can only be read in ranges. A",
    "ranged result is exact file text, so it is a valid source for `findText`, and",
    "its observation authorizes a `patchFile` or `deleteFile` on that file. It does",
    "NOT authorize `replaceFile`: a plan that replaces a file from a line-range",
    "observation is rejected, because it would delete every line you did not read.",
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
    "  - `patchFile` / `replaceFile` / `deleteFile` require an observation of kind `file`;",
    "    `replaceFile` additionally requires a WHOLE-file `ensemble_readFile` of that path",
    "    (not a stat, not a line range), since it overwrites everything",
    "  - `deleteEmptyDirectory` requires an observed, provably empty directory",
    "",
    "So stat a path you intend to create even when you expect it to be absent — the",
    "`missing` observation is what authorizes creating it.",
    "",
    // Run 2067 (2026-09-18) lost a real plan to exactly this: it statted the
    // new FILE and had read several files inside src/test, but never observed
    // src or src/test themselves, and a file observation does not prove its
    // parent directory.
    "**Creating a file also needs its directories observed.** Before a `createFile`,",
    "`ensemble_stat` every ancestor directory of the new path — for",
    "`src/test/new.test.ts` that is `src` and `src/test` — so the host can resolve",
    "them. Reading a file inside a directory does NOT observe the directory. An",
    "ancestor that already exists needs no `parentChain` entry once observed; only",
    "one you observed as `missing` needs a `createDirectory` step earlier in the",
    "same plan, linked with `createdByStep`.",
    "",
    "`parentChain` is required ONLY for `createFile` and `createDirectory`. For any",
    "operation on a file that already exists — `patchFile`, `replaceFile`,",
    "`deleteFile` — send an empty `parentChain: []`. The file's own observation",
    "already proves its directories exist, so nothing further is needed.",
    "",
    "When you ARE creating something, an ancestor directory that ALREADY EXISTS is",
    "resolved automatically from what you have observed this session — list nothing",
    "for it. `parentChain` should therefore usually be empty. The ONLY thing it ever",
    'needs is `{"kind":"createdByStep","stepId":"..."}` for an ancestor that does NOT',
    "yet exist and that an earlier operation in this same plan creates — for example,",
    "creating `src/generated/out.ts` right after a `createDirectory` step for",
    "`src/generated` needs one link naming that step; `src` itself needs nothing,",
    "existing ancestors are never listed. Do not send an `\"observed\"` link — the",
    "host already has that information and rejects one if you do.",
    "",
    "**Two or more `patchFile` operations on the SAME file, in one plan, ARE allowed**",
    "and apply in order — each later one is verified and written against the file as",
    "the previous one left it. Any OTHER repeat of a path (a second `createFile`,",
    "`replaceFile`, or a mix of kinds) is rejected before anything is applied: those",
    "carry the file's revision as observed during planning, and the first write",
    "changes it, so a second one would be acting on a revision that no longer exists.",
    "",
    "If a file needs several separate `patchFile` edits, prefer emitting them as",
    "separate operations, each with its own narrow `findText`/`replacementText`,",
    "rather than widening one patch to span unrelated regions.",
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
    "not match. Uniqueness is re-checked against the file as it stands when the",
    "operation actually runs, so a later patch must be unique in the file the",
    "EARLIER patches left behind — not merely in the file you read. For several",
    "separate edits to the SAME file, emit several narrow `patchFile` operations",
    "rather than widening one to span them (see the rule above).",
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
    "  - `ensemble_readFile` — read one file by exact root-relative path, or only",
    "    part of it with `startLine` and `endLine`",
    "  - `ensemble_stat` — check whether a path exists and what kind it is",
    "  - `ensemble_readDirectory` — list one directory's entries",
    "  - `ensemble_findFiles` — find files whose path contains a substring",
    "  - `ensemble_textSearch` — search file contents for a literal string",
    "",
    "### Read line ranges, not whole files",
    "",
    "This session has a limited number of tool rounds, and every file you read is",
    "carried in the conversation from then on. So when the prompt names changed",
    "regions as line ranges (\"lines 2728-2788\"), read exactly those ranges with",
    "`startLine`/`endLine` — widen by a few lines if you need context — instead",
    "of the whole file. A file over " + `${MAX_READ_FILE_BYTES_V1 / 1024} KB` + " can only be read in ranges.",
    "Request several ranges in the same step where you can: several tool calls in",
    "one reply cost one round.",
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

/**
 * Preamble for a text-producing row that DECLARED it must reason about file
 * content (`readsWorkspaceFiles`) but whose workspace read session could not
 * be attached this attempt (`ensureWorkflowWorkspaceRootV1` threw — e.g. no
 * open workspace folder for this task). The row still runs, tool-less, on
 * the context pack alone exactly as it did before item 16 — this is a
 * best-effort degrade, not a failure — but silently doing so overstates the
 * review's own confidence in exactly the way item 15 describes. Naming the
 * degradation in the prompt itself means it can end up in the artifact's own
 * confidence assessment rather than only in a log nobody reads afterward.
 */
export function buildWorkspaceReadSessionDegradedPreambleV1(): string {
  return [
    "## Workspace access — unavailable this attempt",
    "",
    "This review normally has read-only tools to open workspace files directly,",
    "but they could not be attached for this attempt (the workspace root could",
    "not be resolved). You are working from the context pack below ONLY — no",
    "tool calls are available.",
    "",
    "The pack is size-bounded and may truncate or omit files this review needs.",
    "Do not conclude work is missing purely because the pack does not show it.",
    "Where the pack's coverage genuinely prevents you from confirming readiness,",
    "file a `[review-confidence] [unverifiable]` blocker naming the specific file",
    "you could not see, rather than a completion or defect blocker.",
  ].join("\n");
}
