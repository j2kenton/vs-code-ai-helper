/**
 * Coverage for openPlanNonGoalsV1 — the `reconsiderRequirement` escalation
 * option's effect (see buildEscalationDecisionV1 in reviewEscalation.ts).
 * Exercises the two observable branches through NotificationRouter, since
 * the test-stub `vscode.window` has no `activeTextEditor` to assert the
 * reveal/selection against.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { after, describe, it } from "node:test";
import * as vscode from "vscode";
import { openPlanFinalV1, openPlanNonGoalsV1 } from "../commands/openPlanNonGoalsV1";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

class RecordingSurface {
  entries: { message: string; level: "info" | "warning" | "error" }[] = [];
  addEntry(message: string, level: "info" | "warning" | "error"): void {
    this.entries.push({ message, level });
  }
}

const TEST_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-open-plan-non-goals-test-"));
after(() => {
  fs.rmSync(TEST_ROOT, { recursive: true, force: true });
});

function makeTaskFolder(name: string): string {
  const dir = path.join(TEST_ROOT, name);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** Same shape as other command tests' `installRealFs` helper — the stub's
 * default `workspace.fs.readFile` throws "not implemented", so a test whose
 * command reads real files written via `fs.writeFileSync` needs this. */
function installRealFs(): { restore: () => void } {
  const stubFs = vscode.workspace.fs as unknown as Record<string, unknown>;
  const orig = { readFile: stubFs.readFile };
  stubFs.readFile = (uri: vscode.Uri): Promise<Uint8Array> =>
    Promise.resolve(new Uint8Array(fs.readFileSync(uri.fsPath)));
  return {
    restore: (): void => {
      stubFs.readFile = orig.readFile;
    },
  };
}

void describe("openPlanNonGoalsV1", () => {
  void it("reports plan-final.md missing rather than opening nothing silently", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const realFs = installRealFs();
    try {
      const folder = makeTaskFolder("no-plan-file");
      await openPlanNonGoalsV1({ taskFolderPath: folder });
      assert.ok(
        surface.entries.some(
          (e) => e.level === "info" && e.message.includes("plan-final.md does not exist yet")
        )
      );
    } finally {
      realFs.restore();
      deactivateNotificationRouter();
    }
  });

  void it("opens plan-final.md without a warning when it has an Accepted Non-Goals section", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const realFs = installRealFs();
    try {
      const folder = makeTaskFolder("with-non-goals");
      fs.writeFileSync(
        path.join(folder, "plan-final.md"),
        "# Plan\n\nSome content.\n\n## Accepted Non-Goals\n\nThe X blocker is out of scope.\n"
      );
      await openPlanNonGoalsV1({ taskFolderPath: folder });
      assert.equal(surface.entries.length, 0, "must not warn when the section is present");
    } finally {
      realFs.restore();
      deactivateNotificationRouter();
    }
  });

  void it("tells the user no Accepted Non-Goals section exists yet, rather than silently opening the top of the file", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const realFs = installRealFs();
    try {
      const folder = makeTaskFolder("without-non-goals");
      fs.writeFileSync(path.join(folder, "plan-final.md"), "# Plan\n\nSome content, no non-goals section.\n");
      await openPlanNonGoalsV1({ taskFolderPath: folder });
      assert.ok(
        surface.entries.some(
          (e) => e.level === "info" && e.message.includes('has no "## Accepted Non-Goals" section yet')
        )
      );
    } finally {
      realFs.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does nothing when called without a taskFolderPath", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    try {
      await openPlanNonGoalsV1(undefined);
      assert.equal(surface.entries.length, 0);
    } finally {
      deactivateNotificationRouter();
    }
  });
});

void describe("openPlanFinalV1", () => {
  void it("reports plan-final.md missing rather than opening nothing silently", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const realFs = installRealFs();
    try {
      const folder = makeTaskFolder("plan-final-no-plan-file");
      await openPlanFinalV1({ taskFolderPath: folder });
      assert.ok(
        surface.entries.some(
          (e) => e.level === "info" && e.message.includes("plan-final.md does not exist yet")
        )
      );
    } finally {
      realFs.restore();
      deactivateNotificationRouter();
    }
  });

  void it("opens plan-final.md plainly, without warning, regardless of whether it has a non-goals section", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    const realFs = installRealFs();
    try {
      const folder = makeTaskFolder("plan-final-with-non-goals");
      fs.writeFileSync(
        path.join(folder, "plan-final.md"),
        "# Plan\n\nSome content.\n\n## Accepted Non-Goals\n\nThe X blocker is out of scope.\n"
      );
      await openPlanFinalV1({ taskFolderPath: folder });
      assert.equal(surface.entries.length, 0, "must not warn about the non-goals section — that is openPlanNonGoalsV1's concern, not this one's");
    } finally {
      realFs.restore();
      deactivateNotificationRouter();
    }
  });

  void it("does nothing when called without a taskFolderPath", async () => {
    const surface = new RecordingSurface();
    initNotificationRouter(surface);
    try {
      await openPlanFinalV1(undefined);
      assert.equal(surface.entries.length, 0);
    } finally {
      deactivateNotificationRouter();
    }
  });
});
