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
}

/**
 * Build the preamble prepended to the preflight row's prompt.
 *
 * Assembled in the row rather than the coordinator because the row is the
 * only layer that holds all three identifiers — the coordinator treats the
 * validated input as opaque. A preamble missing any one of them leaves the
 * model unable to produce a valid plan at all.
 */
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
    "performed. An empty `operations` array is a valid answer when nothing needs to",
    "change.",
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
    "`parentChain` lists every directory between the root (exclusive) and the",
    "operation's immediate parent (inclusive), in root-to-parent order. Each link is",
    'either `{"kind":"observed","observationId":"..."}` for a directory you observed,',
    'or `{"kind":"createdByStep","stepId":"..."}` for one an earlier operation in',
    "this same plan creates. A file directly in the root has an empty `parentChain`.",
    "",
    "So `apps/server/lib/x.ts` needs three links, in this order: `apps`,",
    "`apps/server`, `apps/server/lib`. A plain `ensemble_stat` on each is enough —",
    "you do NOT need to list their contents. Use `ensemble_stat`, not",
    "`ensemble_findFiles` or `ensemble_textSearch`: a discovery result can never",
    "authorize anything, including a parent link.",
    "",
    "Two operations may not target the same path. `stepId` is yours to choose and",
    "must be unique within the plan.",
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
    "not match. Use several `patchFile` operations for several separate edits.",
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
