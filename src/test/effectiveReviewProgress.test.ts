/**
 * Unit tests for effectiveReviewProgressV1 — the single computation both the
 * stage-advance gates (strict) and the Tasks tree's stage rows (lenient) read
 * a review's effective plan progress through.
 *
 * Pinned here:
 *   1. Plan-review stages pass their raw marker through, unreconciled.
 *   2. Other review stages reconcile against the plan of record's checklist:
 *      a marker claiming 5/5 with checklist items remaining yields the
 *      checklist's counts, never the false completion.
 *   3. A fully-checked (or absent) checklist leaves the marker unchanged.
 *   4. The checklistProgressUnreliable latch stands reconciliation down.
 *   5. Policy split on a corrupt progress file: strict throws and notifies;
 *      lenient stands down (marker unchanged, no notification).
 */
import * as assert from "node:assert/strict";
import * as nodeFs from "node:fs";
import * as nodeOs from "node:os";
import * as nodePath from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";

import {
  effectiveReviewProgressV1,
  readEffectivePlanChecklistProgressV1,
} from "../utils/effectiveReviewProgress";
import {
  deactivateNotificationRouter,
  initNotificationRouter,
} from "../utils/notificationRouter";

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = nodeFs.mkdtempSync(
  nodePath.join(nodeOs.tmpdir(), "ensemble-effective-progress-test-")
);
after(() => {
  nodeFs.rmSync(ROOT, { recursive: true, force: true });
});

const PLAN_TWO_OF_FIVE = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] One",
  "- [x] Two",
  "- [ ] Three",
  "- [ ] Four",
  "- [ ] Five",
  "",
].join("\n");

const PLAN_ALL_CHECKED = [
  "# Final Plan",
  "",
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] One",
  "- [x] Two",
  "",
].join("\n");

const PLAN_WITHOUT_CHECKLIST = ["# Final Plan", "", "Prose only, no checklist.", ""].join("\n");

function validProgressRaw(name: string, extra: Record<string, unknown> = {}): string {
  return JSON.stringify({
    taskFolder: name,
    currentStage: "impl-high-review",
    status: "active",
    createdAt: "2026-08-11T00:00:00.000Z",
    updatedAt: "2026-08-11T00:00:00.000Z",
    ...extra,
  });
}

function makeTask(
  name: string,
  files: { plan?: string; progressRaw?: string }
): vscode.Uri {
  const folder = nodePath.join(ROOT, name);
  nodeFs.mkdirSync(folder, { recursive: true });
  if (files.plan !== undefined) {
    nodeFs.writeFileSync(nodePath.join(folder, "plan-final.md"), files.plan, "utf8");
  }
  if (files.progressRaw !== undefined) {
    nodeFs.writeFileSync(nodePath.join(folder, "task-progress.json"), files.progressRaw, "utf8");
  }
  return vscode.Uri.file(folder);
}

function reviewText(marker?: string): string {
  return [
    "# Implementation Review",
    "",
    "Readiness: 9/10",
    "",
    ...(marker ? [`<!-- progress: ${marker} -->`, ""] : []),
  ].join("\n");
}

/** Back workspace.fs.readFile with the real disk (the stub is notImplemented). */
function installRealFs(): { restore: () => void } {
  const fsRecord = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = fsRecord.readFile;
  fsRecord.readFile = async (uri: vscode.Uri): Promise<Uint8Array> =>
    new TextEncoder().encode(await nodeFs.promises.readFile(uri.fsPath, "utf8"));
  return {
    restore: (): void => {
      fsRecord.readFile = original;
    },
  };
}

function installNotifications(): { captured: string[]; restore: () => void } {
  const captured: string[] = [];
  initNotificationRouter({
    addEntry: (message: string, level: "info" | "warning" | "error"): void => {
      captured.push(`${level}: ${message}`);
    },
  });
  return {
    captured,
    restore: (): void => deactivateNotificationRouter(),
  };
}


// ---------------------------------------------------------------------------
// Marker passthrough and reconciliation
// ---------------------------------------------------------------------------

void describe("effectiveReviewProgressV1 — marker handling", () => {
  void it("passes a plan-review stage's raw marker through unreconciled", async () => {
    const uri = makeTask("plan-review-passthrough", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: validProgressRaw("plan-review-passthrough"),
    });
    const fsStub = installRealFs();
    try {
      // The checklist says 2 of 5; the plan-review marker says 4/5 — the raw
      // marker wins because plan reviews emit no implementation progress of
      // their own and must not inherit the implementation's outstanding count.
      const progress = await effectiveReviewProgressV1(
        uri,
        "plan-high-review",
        reviewText("4/5")
      );
      assert.deepEqual(progress, { complete: 4, total: 5 });
    } finally {
      fsStub.restore();
    }
  });

  void it("reconciles a falsely-complete marker down to the checklist's counts", async () => {
    const uri = makeTask("false-completion", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: validProgressRaw("false-completion"),
    });
    const fsStub = installRealFs();
    try {
      // The reviewer narrowed its denominator and declared 5/5 done, but the
      // plan of record still lists three unchecked items — those counts win.
      const progress = await effectiveReviewProgressV1(
        uri,
        "impl-high-review",
        reviewText("5/5")
      );
      assert.deepEqual(progress, { complete: 2, total: 5 });
    } finally {
      fsStub.restore();
    }
  });

  void it("leaves the marker unchanged when the checklist has nothing remaining", async () => {
    const uri = makeTask("checklist-done", {
      plan: PLAN_ALL_CHECKED,
      progressRaw: validProgressRaw("checklist-done"),
    });
    const fsStub = installRealFs();
    try {
      const progress = await effectiveReviewProgressV1(
        uri,
        "impl-high-review",
        reviewText("3/5")
      );
      assert.deepEqual(progress, { complete: 3, total: 5 });
    } finally {
      fsStub.restore();
    }
  });

  void it("leaves the marker unchanged when there is no checklist to reconcile against", async () => {
    const uri = makeTask("no-checklist", {
      plan: PLAN_WITHOUT_CHECKLIST,
      progressRaw: validProgressRaw("no-checklist"),
    });
    const fsStub = installRealFs();
    try {
      const progress = await effectiveReviewProgressV1(
        uri,
        "impl-low-review",
        reviewText("3/5")
      );
      assert.deepEqual(progress, { complete: 3, total: 5 });
    } finally {
      fsStub.restore();
    }
  });

  void it("returns null when the review carries no usable marker and nothing reconciles", async () => {
    const uri = makeTask("no-marker", {
      plan: PLAN_WITHOUT_CHECKLIST,
      progressRaw: validProgressRaw("no-marker"),
    });
    const fsStub = installRealFs();
    try {
      assert.equal(await effectiveReviewProgressV1(uri, "impl-high-review", reviewText()), null);
      // A nonsensical marker (complete past total) parses to null too.
      assert.equal(
        await effectiveReviewProgressV1(uri, "impl-high-review", reviewText("7/5")),
        null
      );
    } finally {
      fsStub.restore();
    }
  });

  void it("stands reconciliation down while the checklistProgressUnreliable latch is set", async () => {
    const uri = makeTask("latched", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: validProgressRaw("latched", { checklistProgressUnreliable: true }),
    });
    const fsStub = installRealFs();
    try {
      const progress = await effectiveReviewProgressV1(
        uri,
        "impl-high-review",
        reviewText("5/5")
      );
      assert.deepEqual(
        progress,
        { complete: 5, total: 5 },
        "a latched task must not present the frozen checklist counts as live"
      );
    } finally {
      fsStub.restore();
    }
  });
});


// ---------------------------------------------------------------------------
// Policy split on a corrupt progress file
// ---------------------------------------------------------------------------

void describe("effectiveReviewProgressV1 — strict vs lenient policy", () => {
  void it("strict throws and notifies on a corrupt progress file", async () => {
    const uri = makeTask("corrupt-strict", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: "this is not json",
    });
    const fsStub = installRealFs();
    const notifications = installNotifications();
    try {
      await assert.rejects(
        effectiveReviewProgressV1(uri, "impl-high-review", reviewText("5/5"), "strict"),
        /Task progress recovery required/
      );
      assert.ok(
        notifications.captured.some((entry) => entry.startsWith("error: ")),
        "the strict policy must surface the recovery notification"
      );
    } finally {
      notifications.restore();
      fsStub.restore();
    }
  });

  void it("lenient stands reconciliation down on a corrupt progress file", async () => {
    const uri = makeTask("corrupt-lenient", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: "this is not json",
    });
    const fsStub = installRealFs();
    const notifications = installNotifications();
    try {
      const progress = await effectiveReviewProgressV1(
        uri,
        "impl-high-review",
        reviewText("5/5"),
        "lenient"
      );
      assert.deepEqual(
        progress,
        { complete: 5, total: 5 },
        "with the checklist stood down, the marker returns unchanged"
      );
      assert.deepEqual(notifications.captured, [], "a tree render must never notify");
    } finally {
      notifications.restore();
      fsStub.restore();
    }
  });

  void it("defaults to the lenient policy", async () => {
    const uri = makeTask("corrupt-default", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: "this is not json",
    });
    const fsStub = installRealFs();
    const notifications = installNotifications();
    try {
      const progress = await effectiveReviewProgressV1(uri, "impl-high-review", reviewText("5/5"));
      assert.deepEqual(progress, { complete: 5, total: 5 });
      assert.deepEqual(notifications.captured, []);
    } finally {
      notifications.restore();
      fsStub.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// The extracted checklist read itself (shared with readPlanChecklistProgressV1)
// ---------------------------------------------------------------------------

void describe("readEffectivePlanChecklistProgressV1", () => {
  void it("returns the checklist counts for a maintained checklist", async () => {
    const uri = makeTask("counts", {
      plan: PLAN_TWO_OF_FIVE,
      progressRaw: validProgressRaw("counts"),
    });
    const fsStub = installRealFs();
    try {
      const counts = await readEffectivePlanChecklistProgressV1(uri);
      assert.deepEqual(counts, { total: 5, checked: 2, remaining: 3, excluded: 0 });
    } finally {
      fsStub.restore();
    }
  });

  void it("returns undefined for a plan with no checklist", async () => {
    const uri = makeTask("counts-none", {
      plan: PLAN_WITHOUT_CHECKLIST,
      progressRaw: validProgressRaw("counts-none"),
    });
    const fsStub = installRealFs();
    try {
      assert.equal(await readEffectivePlanChecklistProgressV1(uri), undefined);
    } finally {
      fsStub.restore();
    }
  });
});

