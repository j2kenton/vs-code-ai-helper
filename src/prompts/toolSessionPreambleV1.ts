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
    "The text in `findBase64` must appear EXACTLY ONCE in the file. If it appears",
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
