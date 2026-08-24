import * as assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  buildChurnEscalationReasonV1,
  classifyChurnLineageV1,
  describeChurnLineageDiagnosisV1,
  formatPriorBlockerLineageListV1,
  resolveBlockerLineageV1,
} from "../utils/reviewRouting";
import { parseReviewBlockers, ReviewBlocker } from "../utils/reviewReadiness";
import { detectPlanArtifactDisagreementV1 } from "../utils/planArtifactMismatchV1";
import { ReviewBlockerIdentity, ReviewScoreHistoryEntry } from "../types/taskProgress";

async function readPrompt(fileName: string): Promise<string> {
  return readFile(path.resolve(__dirname, "../../resources/prompts", fileName), "utf8");
}

function blocker(overrides: Partial<ReviewBlocker> = {}): ReviewBlocker {
  return { category: "completion", resolver: "task-fixable", description: "x", ...overrides };
}

function identity(overrides: Partial<ReviewBlockerIdentity> = {}): ReviewBlockerIdentity {
  return { category: "completion", resolver: "task-fixable", subject: "x", ...overrides };
}

function entry(overrides: Partial<ReviewScoreHistoryEntry> = {}): ReviewScoreHistoryEntry {
  return {
    stage: "impl-high-review",
    score: 5,
    attemptId: `attempt-${Math.random()}`,
    at: new Date().toISOString(),
    blockerCount: 1,
    taskFixableCount: 1,
    ...overrides,
  };
}

void describe("Blocker lineage parsing (Part 10)", () => {
  void it("parses [new], [same:<id>], and [narrowed:<id>] brackets", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] [new] a brand new issue",
      "- [completion] [task-fixable] [same:b1] still the same rollback gap",
      "- [completion] [task-fixable] [narrowed:b2] now only affects one file",
      "<!-- blockers:end -->",
    ].join("\n");
    const blockers = parseReviewBlockers(content);
    assert.deepStrictEqual(blockers[0]?.lineage, { kind: "new" });
    assert.deepStrictEqual(blockers[1]?.lineage, { kind: "same", refId: "b1" });
    assert.deepStrictEqual(blockers[2]?.lineage, { kind: "narrowed", refId: "b2" });
  });

  void it("leaves lineage undefined when no third bracket is present", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] no lineage bracket here",
      "<!-- blockers:end -->",
    ].join("\n");
    const [only] = parseReviewBlockers(content);
    assert.strictEqual(only?.lineage, undefined);
  });

  void it("is case-insensitive on the lineage keyword and its cited id", () => {
    // Ids are opaque, always generated lowercase by resolveBlockerLineageV1 —
    // normalizing the citation's case here means a reviewer typing `B1`
    // still matches a stored `b1` rather than falling through to unknown.
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] [SAME:B1] still broken",
      "<!-- blockers:end -->",
    ].join("\n");
    const [only] = parseReviewBlockers(content);
    assert.deepStrictEqual(only?.lineage, { kind: "same", refId: "b1" });
  });

  void it("does not mistake a bracketed phrase in the description for a lineage bracket", () => {
    const content = [
      "<!-- blockers:start -->",
      "- [completion] [task-fixable] [unrelated] some description with brackets",
      "<!-- blockers:end -->",
    ].join("\n");
    const [only] = parseReviewBlockers(content);
    assert.strictEqual(only?.lineage, undefined);
    assert.strictEqual(only?.description, "[unrelated] some description with brackets");
  });
});

void describe("resolveBlockerLineageV1", () => {
  void it("marks every blocker lineage-unknown on a stage's first scored round, regardless of the declared bracket", () => {
    const resolved = resolveBlockerLineageV1(
      [blocker({ lineage: { kind: "new" } }), blocker({ lineage: { kind: "same", refId: "b1" } })],
      undefined,
      "attempt-1"
    );
    for (const r of resolved) {
      assert.strictEqual(r.lineage, undefined);
      assert.ok(r.id);
    }
  });

  void it("carries the prior id forward when a [same:<id>] citation matches the prior list", () => {
    const prior: ReviewBlockerIdentity[] = [identity({ id: "b1", description: "the rollback gap" })];
    const resolved = resolveBlockerLineageV1(
      [blocker({ lineage: { kind: "same", refId: "b1" }, description: "still the rollback gap" })],
      prior,
      "attempt-2"
    );
    assert.strictEqual(resolved[0]?.id, "b1");
    assert.deepStrictEqual(resolved[0]?.lineage, { kind: "same", refId: "b1" });
  });

  void it("carries the prior id forward on [narrowed:<id>] too", () => {
    const prior: ReviewBlockerIdentity[] = [identity({ id: "b7" })];
    const resolved = resolveBlockerLineageV1(
      [blocker({ lineage: { kind: "narrowed", refId: "b7" } })],
      prior,
      "attempt-3"
    );
    assert.strictEqual(resolved[0]?.id, "b7");
    assert.deepStrictEqual(resolved[0]?.lineage, { kind: "narrowed", refId: "b7" });
  });

  void it("resolves to lineage-unknown (fresh id) when the cited id is absent from the prior list — never best-effort matched", () => {
    const prior: ReviewBlockerIdentity[] = [identity({ id: "b1" })];
    const resolved = resolveBlockerLineageV1(
      [blocker({ lineage: { kind: "same", refId: "does-not-exist" } })],
      prior,
      "attempt-4"
    );
    assert.notStrictEqual(resolved[0]?.id, "does-not-exist");
    assert.strictEqual(resolved[0]?.lineage, undefined);
  });

  void it("assigns a fresh id and keeps the declared 'new' lineage when a prior list exists", () => {
    const prior: ReviewBlockerIdentity[] = [identity({ id: "b1" })];
    const resolved = resolveBlockerLineageV1(
      [blocker({ lineage: { kind: "new" } })],
      prior,
      "attempt-5"
    );
    assert.deepStrictEqual(resolved[0]?.lineage, { kind: "new" });
    assert.ok(resolved[0]?.id && resolved[0].id !== "b1");
  });

  void it("treats a missing bracket as lineage-unknown even when a prior list exists", () => {
    const prior: ReviewBlockerIdentity[] = [identity({ id: "b1" })];
    const resolved = resolveBlockerLineageV1([blocker()], prior, "attempt-6");
    assert.strictEqual(resolved[0]?.lineage, undefined);
    assert.ok(resolved[0]?.id);
  });

  void it("generates ids that never contain a colon (must round-trip through the [same:<id>]/[narrowed:<id>] bracket grammar)", () => {
    // Regression for the production defect: freshId used to be built as
    // `${attemptId}:${index}`, and attemptId is a crypto.randomUUID() (hyphens
    // only). A colon in the id can never be cited back successfully, because
    // BLOCKER_LINE_RE's third bracket only accepts [\w-]+ — every citation of
    // such an id would silently degrade to lineage-unknown forever.
    const resolved = resolveBlockerLineageV1(
      [blocker(), blocker(), blocker()],
      undefined,
      "a1b2c3d4-e5f6-4789-a012-3456789abcde"
    );
    for (const r of resolved) {
      assert.ok(r.id, "expected a fresh id to be assigned");
      assert.doesNotMatch(r.id ?? "", /:/);
      assert.match(r.id ?? "", /^[\w-]+$/);
    }
  });

  void it("end-to-end: a real generated id survives format -> reviewer citation -> parse -> resolve, carrying the same id forward", () => {
    // Round 1: no prior list, so the blocker is lineage-unknown but gets a
    // real production-shaped fresh id.
    const round1 = resolveBlockerLineageV1(
      [blocker({ description: "the rollback gap" })],
      undefined,
      "11111111-2222-4333-8444-555555555555"
    );
    const round1Id = round1[0]?.id;
    assert.ok(round1Id);

    // That id is what actually gets injected into round 2's re-review prompt.
    const injected = formatPriorBlockerLineageListV1(round1);
    assert.match(injected, new RegExp(`id: ${round1Id}\\b`));

    // The reviewer cites it back exactly as instructed.
    const round2Content = [
      "<!-- blockers:start -->",
      `- [completion] [task-fixable] [same:${round1Id}] still the rollback gap`,
      "<!-- blockers:end -->",
    ].join("\n");
    const round2Blockers = parseReviewBlockers(round2Content);
    assert.deepStrictEqual(round2Blockers[0]?.lineage, { kind: "same", refId: round1Id });

    // Resolving round 2 against round 1's prior list must carry the id
    // forward and record the declared lineage — this is the whole point of
    // the mechanism, and it was broken end-to-end by the colon.
    const round2 = resolveBlockerLineageV1(
      round2Blockers,
      round1,
      "66666666-7777-4888-8999-000000000000"
    );
    assert.strictEqual(round2[0]?.id, round1Id);
    assert.deepStrictEqual(round2[0]?.lineage, { kind: "same", refId: round1Id });
  });
});

void describe("formatPriorBlockerLineageListV1", () => {
  void it("tells the reviewer to omit the bracket when there is nothing to cite", () => {
    const text = formatPriorBlockerLineageListV1(undefined);
    assert.match(text, /do not add a third lineage bracket/i);
  });

  void it("renders each id-bearing prior blocker for citation", () => {
    const text = formatPriorBlockerLineageListV1([
      identity({ id: "b3", description: "the migration lacks a rollback path" }),
    ]);
    assert.match(text, /id: b3/);
    assert.match(text, /rollback path/);
  });
});

void describe("classifyChurnLineageV1", () => {
  void it("reports insufficient-evidence when a round in the window has no resolved id", () => {
    const history = [
      entry({ blockers: [identity({ id: "b1" })] }),
      entry({ blockers: [identity({ subject: "y" })] }), // no id — legacy/unknown
    ];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 1);
    assert.strictEqual(diagnosis.kind, "insufficient-evidence");
  });

  void it("reports insufficient-evidence when the window is shorter than requested", () => {
    const history = [entry({ blockers: [identity({ id: "b1" })] })];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 3);
    assert.strictEqual(diagnosis.kind, "insufficient-evidence");
  });

  void it("reports insufficient-evidence when a NON-baseline round has an id but no declared lineage (production shape: resolveBlockerLineageV1 always assigns an id, even lineage-unknown)", () => {
    // Regression: the original hasUsableLineage check tested `id !== undefined`,
    // which is true for every production blocker regardless of whether its
    // lineage bracket actually resolved — this made the check permanently
    // vacuous. It must key on `lineage`, not `id`.
    const history = [
      entry({ blockers: [identity({ id: "attempt-1-0" })] }), // baseline round, exempt
      entry({ blockers: [identity({ id: "attempt-2-0" })] }), // has an id, but no lineage bracket resolved
    ];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 1);
    assert.strictEqual(diagnosis.kind, "insufficient-evidence");
  });

  void it("does not require the window's baseline (first) round to carry declared lineage", () => {
    // A stage's genuinely first-ever scored round always resolves with
    // lineage undefined (resolveBlockerLineageV1's "no prior list" rule) —
    // that must not permanently block classification for every window that
    // happens to start there.
    const history = [
      entry({ blockers: [identity({ id: "b1", description: "the rollback gap" })] }), // baseline, no lineage
      entry({
        blockers: [
          identity({ id: "b1", lineage: { kind: "same", refId: "b1" }, description: "the rollback gap" }),
        ],
      }),
    ];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 1);
    assert.strictEqual(diagnosis.kind, "unchanged");
  });

  void it("classifies as unchanged when the same id is cited 'same' every round", () => {
    const history = [
      entry({ blockers: [identity({ id: "b1", description: "the rollback gap" })] }),
      entry({
        blockers: [
          identity({ id: "b1", lineage: { kind: "same", refId: "b1" }, description: "the rollback gap" }),
        ],
      }),
      entry({
        blockers: [
          identity({ id: "b1", lineage: { kind: "same", refId: "b1" }, description: "the rollback gap" }),
        ],
      }),
    ];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 2);
    assert.strictEqual(diagnosis.kind, "unchanged");
    if (diagnosis.kind === "unchanged") {
      assert.strictEqual(diagnosis.description, "the rollback gap");
    }
  });

  void it("classifies as narrowing when any round declares [narrowed:<id>]", () => {
    const history = [
      entry({ blockers: [identity({ id: "b1" })] }),
      entry({ blockers: [identity({ id: "b1", lineage: { kind: "narrowed", refId: "b1" } })] }),
    ];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 1);
    assert.strictEqual(diagnosis.kind, "narrowing");
  });

  void it("classifies as shifting when the id set changes without a declared narrowing", () => {
    const history = [
      entry({ blockers: [identity({ id: "b1" })] }),
      entry({ blockers: [identity({ id: "b2", lineage: { kind: "new" } })] }),
    ];
    const diagnosis = classifyChurnLineageV1(history, "impl-high-review", 1);
    assert.strictEqual(diagnosis.kind, "shifting");
  });

  void it("describeChurnLineageDiagnosisV1 produces distinct, non-empty text per kind", () => {
    const kinds: Array<ReturnType<typeof classifyChurnLineageV1>> = [
      { kind: "unchanged", description: "d" },
      { kind: "narrowing" },
      { kind: "shifting" },
      { kind: "insufficient-evidence", perRoundSummaries: ["a", "b"] },
    ];
    const texts = kinds.map(describeChurnLineageDiagnosisV1);
    assert.strictEqual(new Set(texts).size, texts.length);
    for (const t of texts) {
      assert.ok(t.length > 0);
    }
  });
});

void describe("buildChurnEscalationReasonV1", () => {
  // Regression: the escalation reason used to unconditionally open with
  // "Automated iteration is churning, not converging." regardless of the
  // diagnosis, which mislabeled reviewer-declared narrowing (real progress)
  // as churn — the inverted-guidance defect this task exists to fix.
  void it("labels an unchanged diagnosis as churning", () => {
    const reason = buildChurnEscalationReasonV1("Implementation High Review", 3, {
      kind: "unchanged",
      description: "the rollback gap",
    });
    assert.match(reason, /churning, not converging/i);
  });

  void it("does NOT label a narrowing diagnosis as churning, and states it is progress", () => {
    const reason = buildChurnEscalationReasonV1("Implementation High Review", 3, {
      kind: "narrowing",
    });
    assert.doesNotMatch(reason, /churning, not converging/i);
    assert.match(reason, /not churn/i);
    assert.match(reason, /progress/i);
  });

  void it("does NOT label a shifting diagnosis as churning, and names an unstable requirement", () => {
    const reason = buildChurnEscalationReasonV1("Implementation High Review", 3, {
      kind: "shifting",
    });
    assert.doesNotMatch(reason, /churning, not converging/i);
    assert.match(reason, /unstable or under-specified/i);
  });

  void it("does NOT label an insufficient-evidence diagnosis as churning", () => {
    const reason = buildChurnEscalationReasonV1("Implementation High Review", 3, {
      kind: "insufficient-evidence",
      perRoundSummaries: ["round 1 blocker"],
    });
    assert.doesNotMatch(reason, /churning, not converging/i);
    assert.match(reason, /cannot yet be determined/i);
  });

  void it("always names the stage and round count regardless of diagnosis", () => {
    const reason = buildChurnEscalationReasonV1("Implementation High Review", 5, {
      kind: "narrowing",
    });
    assert.match(reason, /Implementation High Review/);
    assert.match(reason, /5 consecutive rounds/);
  });
});

void describe("detectPlanArtifactDisagreementV1", () => {
  void it("reports a disagreement when a quoted requirement is a checklist item in one file but not the other", () => {
    const planMd = "- [ ] `add a rollback command to the migration`\n";
    const planFinalMd = "- [x] some unrelated item\n";
    const result = detectPlanArtifactDisagreementV1(
      'still missing `add a rollback command to the migration`',
      planMd,
      planFinalMd
    );
    assert.ok(result);
    assert.match(result ?? "", /plan\.md/);
    assert.match(result ?? "", /plan-final\.md/);
  });

  void it("reports nothing when the requirement text is absent from both, or present in both", () => {
    assert.strictEqual(
      detectPlanArtifactDisagreementV1("no quoted requirement here", "- [ ] item\n", "- [ ] item\n"),
      undefined
    );
    const planMd = "- [ ] `shared requirement text here`\n";
    const planFinalMd = "- [x] `shared requirement text here`\n";
    assert.strictEqual(
      detectPlanArtifactDisagreementV1("`shared requirement text here`", planMd, planFinalMd),
      undefined
    );
  });
});

void describe("rubric and re-review prompt contract for blocker lineage", () => {
  void it("review-scoring-rubric.md declares the lineage bracket vocabulary", async () => {
    const rubric = await readPrompt("review-scoring-rubric.md");
    assert.match(rubric, /\[new\]/);
    assert.match(rubric, /\[same:<id>\]/);
    assert.match(rubric, /\[narrowed:<id>\]/);
    assert.match(rubric, /lineage/i);
  });

  const rereviewTemplates = [
    "review-impl-high-rereview.md",
    "review-impl-low-rereview.md",
    "review-publish-rereview.md",
    "review-plan-high-rereview.md",
    "review-plan-low-rereview.md",
  ];

  for (const fileName of rereviewTemplates) {
    void it(`${fileName} injects the prior round's ID'd blocker list`, async () => {
      const prompt = await readPrompt(fileName);
      assert.match(
        prompt,
        /\{\{priorBlockerLineageList\}\}/,
        `${fileName} must inject {{priorBlockerLineageList}} so the reviewer has ids to cite`
      );
    });
  }
});
