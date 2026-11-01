/**
 * bugs4 item 2: ledger eligibility follows a round's STAGE and action, not its
 * legacy internal mode. A plan-writing or plan-revising round carries an
 * `implementation` / `apply-review` mode purely as a dispatch label; it is not
 * code-editing history and must neither require a change list nor invalidate
 * known implementation scope.
 */
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";
import {
  hasUncertainLedgerProvenanceV1,
  isCodeBearingLedgerRowV1,
  resolveImplementationReviewScopeV1,
  resolveLedgerImplReviewFilesV1,
  type ImplReviewLedgerRowV1,
} from "../utils/implReviewFileSelection";

const THREE = ["src/test/gitIndexLockV1.test.ts", "src/utils/gitIndexLockV1.ts", "src/utils/roundGitStateV1.ts"];

function row(overrides: Partial<ImplReviewLedgerRowV1> & { roundId: string }): ImplReviewLedgerRowV1 {
  return { stage: "impl", mode: "implementation", state: "completed", outcome: { filesChanged: [] }, ...overrides };
}

// The captured 2026-10-28 shape: an old Plan-stage row with an internal
// `implementation` mode and no change list, plus the real impl row.
const PLAN_ROW = row({ roundId: "d51eb029", stage: "plan", mode: "implementation", outcome: undefined });
const IMPL_ROW = row({ roundId: "9422f594", stage: "impl", outcome: { filesChanged: THREE } });

void describe("isCodeBearingLedgerRowV1", () => {
  void it("plan-writing stages are never code-bearing, whatever the legacy mode", () => {
    for (const stage of ["desc", "plan", "plan-high-review", "plan-low-review"]) {
      for (const mode of ["implementation", "apply-review", "continuation"] as const) {
        assert.equal(isCodeBearingLedgerRowV1({ stage, mode }), false, `${stage}/${mode}`);
      }
    }
  });

  void it("implementation, apply-review and continuation at the code stages are code-bearing", () => {
    for (const stage of ["impl", "impl-high-review", "impl-low-review", "publish"]) {
      for (const mode of ["implementation", "apply-review", "continuation"] as const) {
        assert.equal(isCodeBearingLedgerRowV1({ stage, mode }), true, `${stage}/${mode}`);
      }
    }
  });

  void it("a review-mode row is never code-bearing, and a literal impl row stays code-bearing whatever its originatingReviewStage", () => {
    assert.equal(isCodeBearingLedgerRowV1({ stage: "impl", mode: "review" }), false);
    assert.equal(isCodeBearingLedgerRowV1(row({ roundId: "x", originatingReviewStage: "impl-high-review" })), true);
    assert.equal(isCodeBearingLedgerRowV1(row({ roundId: "x", originatingReviewStage: "plan-high-review" })), true);
  });

  void it("a missing or unknown stage is uncertain provenance, not classified as code-bearing", () => {
    assert.equal(isCodeBearingLedgerRowV1({ stage: undefined, mode: "implementation" }), false);
    assert.equal(hasUncertainLedgerProvenanceV1({ stage: undefined, mode: "implementation" }), true);
    assert.equal(hasUncertainLedgerProvenanceV1({ stage: "mystery", mode: "apply-review" }), true);
    assert.equal(hasUncertainLedgerProvenanceV1({ stage: undefined, mode: "review" }), false);
    assert.equal(hasUncertainLedgerProvenanceV1({ stage: "plan", mode: "implementation" }), false);
  });
});

void describe("resolveLedgerImplReviewFilesV1 — stage-aware eligibility", () => {
  void it("the captured Plan row without a change list does not poison the real impl row: scope is established", () => {
    const result = resolveLedgerImplReviewFilesV1([PLAN_ROW, IMPL_ROW], 200);
    assert.deepEqual(result, { established: true, files: THREE });
  });

  void it("the captured shape establishes scope with no tracked set (review scope resolver)", () => {
    const scope = resolveImplementationReviewScopeV1(undefined, [PLAN_ROW, IMPL_ROW], 200);
    assert.equal(scope.kind, "established");
    if (scope.kind === "established") {
      assert.equal(scope.source, "ledger");
      assert.deepEqual([...scope.files].sort(), [...THREE].sort());
    }
  });

  void it("plan-review fix rounds with generic modes are ignored, even when live or failed", () => {
    const rows = [
      row({ roundId: "p1", stage: "plan-high-review", mode: "apply-review", outcome: undefined }),
      row({ roundId: "p2", stage: "plan-low-review", mode: "implementation", state: "open", outcome: undefined }),
      row({ roundId: "p3", stage: "plan", mode: "continuation", state: "failed", outcome: undefined }),
      IMPL_ROW,
    ];
    assert.deepEqual(resolveLedgerImplReviewFilesV1(rows, 200), { established: true, files: THREE });
  });

  void it("only plan-stage rows means there is no code history: unavailable, with the reason saying so", () => {
    const result = resolveLedgerImplReviewFilesV1([PLAN_ROW], 200);
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /no implementation-mode rounds recorded/);
      assert.match(result.reason, /plan-stage rounds/);
      assert.match(result.reason, /run an Implementation round/);
    }
  });

  void it("code-review fix rounds (apply-review at an impl-review stage) contribute their changes", () => {
    const rows = [
      IMPL_ROW,
      row({ roundId: "fix1", stage: "impl-high-review", mode: "apply-review", outcome: { filesChanged: ["src/fixed.ts"] } }),
    ];
    const result = resolveLedgerImplReviewFilesV1(rows, 200);
    assert.equal(result.established, true);
    if (result.established) {
      assert.deepEqual(result.files, ["src/fixed.ts", ...THREE]);
    }
  });

  void it("a real code-bearing round with no change list stays conservative and names stage, mode, state and recovery", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [row({ roundId: "r-nolist", stage: "impl-low-review", mode: "apply-review", outcome: undefined }), IMPL_ROW],
      200
    );
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /r-nolist/);
      assert.match(result.reason, /stage impl-low-review/);
      assert.match(result.reason, /mode apply-review/);
      assert.match(result.reason, /completed/);
      assert.match(result.reason, /no change list/);
      assert.match(result.reason, /Run an Implementation round again/);
    }
  });

  void it("failed and quarantined code-bearing rows with an unknown change list still refuse", () => {
    for (const state of ["failed", "rejected", "interrupted", "cancelled"] as const) {
      const result = resolveLedgerImplReviewFilesV1(
        [IMPL_ROW, row({ roundId: `q-${state}`, state, outcome: { filesChangedUnknown: true } })],
        200
      );
      assert.equal(result.established, false, state);
    }
  });

  void it("an active code-bearing round refuses; the reason says to wait", () => {
    const result = resolveLedgerImplReviewFilesV1([IMPL_ROW, row({ roundId: "live", state: "open", outcome: undefined })], 200);
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /live/);
      assert.match(result.reason, /still open/);
      assert.match(result.reason, /wait/);
    }
  });

  void it("legacy rows with no stage refuse rather than guess", () => {
    const legacy = { roundId: "legacy", mode: "implementation", state: "completed", outcome: { filesChanged: ["a.ts"] } } as ImplReviewLedgerRowV1;
    const result = resolveLedgerImplReviewFilesV1([legacy, IMPL_ROW], 200);
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /legacy/);
      assert.match(result.reason, /no recorded stage/);
    }
  });

  void it("the retention cap is never trusted, whatever the rows say", () => {
    const result = resolveLedgerImplReviewFilesV1([PLAN_ROW, IMPL_ROW], 2);
    assert.equal(result.established, false);
    if (!result.established) {
      assert.match(result.reason, /retention cap/);
    }
  });

  void it("an unsafe ledger path is omitted from scope and counted, not adopted", () => {
    const scope = resolveImplementationReviewScopeV1(
      undefined,
      [row({ roundId: "u", outcome: { filesChanged: ["../escape.ts", "/abs.ts", "C:/x.ts", "src/ok.ts"] } })],
      200
    );
    assert.equal(scope.kind, "established");
    if (scope.kind === "established") {
      assert.deepEqual(scope.files, ["src/ok.ts"]);
      assert.equal(scope.omittedPaths, 3);
    }
  });

  void it("an existing safe tracked set is preserved when a complete replacement is unavailable", () => {
    const scope = resolveImplementationReviewScopeV1(
      ["src/tracked.ts"],
      [row({ roundId: "live", state: "open", outcome: undefined })],
      200
    );
    assert.equal(scope.kind, "established");
    if (scope.kind === "established") {
      assert.equal(scope.source, "tracked");
      assert.deepEqual(scope.files, ["src/tracked.ts"]);
      assert.match(scope.reason ?? "", /still open/);
    }
  });

  void it("with no tracked set and no replacement the scope is unavailable with the ledger's reason", () => {
    const scope = resolveImplementationReviewScopeV1(undefined, [PLAN_ROW], 200);
    assert.equal(scope.kind, "unavailable");
  });
});

void describe("ledger-based scope never adopts unattributed (concurrent) edits", () => {
  const OWNER_EDIT = "src/owner-hand-edit.ts";

  void it("a completed row's unattributedFiles are subtracted from the rebuilt set", () => {
    const result = resolveLedgerImplReviewFilesV1(
      [PLAN_ROW, row({ roundId: "c", outcome: { filesChanged: [...THREE, OWNER_EDIT], unattributedFiles: [OWNER_EDIT] } })],
      200
    );
    assert.equal(result.established, true);
    if (result.established) assert.deepEqual(result.files, THREE);
  });

  void it("the established review scope excludes the owner edit, even with a tracked set", () => {
    const scope = resolveImplementationReviewScopeV1(
      ["src/tracked.ts"],
      [row({ roundId: "c", outcome: { filesChanged: [...THREE, OWNER_EDIT], unattributedFiles: [OWNER_EDIT] } })],
      200
    );
    assert.equal(scope.kind, "established");
    if (scope.kind === "established") {
      assert.equal(scope.files.includes(OWNER_EDIT), false);
      assert.deepEqual([...scope.files].sort(), [...THREE, "src/tracked.ts"].sort());
    }
  });

  void it("control: with no unattributedFiles recorded every changed file is task-owned", () => {
    const result = resolveLedgerImplReviewFilesV1([row({ roundId: "c", outcome: { filesChanged: THREE } })], 200);
    assert.equal(result.established, true);
    if (result.established) assert.deepEqual(result.files, THREE);
  });
});
