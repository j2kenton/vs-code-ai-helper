/**
 * review1 Step 45 / Step 46 (allowlist bullet): "Run it for me" is offered only for a read-only allowlisted
 * command, runs only that command, records the cleaned result under Owner evidence and re-runs the review.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import {
  formatOwnerEvidenceCommandRecordV1,
  OwnerEvidenceCommandRunV1,
  runOwnerEvidenceCommandV1,
  RunOwnerEvidenceCommandDepsV1,
} from "../commands/runOwnerEvidenceCommandV1";
import { parseAllowlistedCommandV1, RUN_OWNER_EVIDENCE_COMMAND_V1 } from "../utils/ownerEvidenceCommandAllowlistV1";
import { buildRunItForMeOfferV1 } from "../utils/reviewEscalation";
import { deactivateNotificationRouter, initNotificationRouter } from "../utils/notificationRouter";

async function makeTaskFolder(): Promise<string> {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "run-it-for-me-"));
  const folder = path.join(root, ".ensemble", "2026-11-04_task_1");
  await fs.mkdir(folder, { recursive: true });
  await fs.writeFile(path.join(folder, "task.md"), "# Task\n\n## Task Description\n\nDo it.\n");
  return folder;
}

function deps(overrides: Partial<RunOwnerEvidenceCommandDepsV1> & { ran?: string[]; reran?: string[] } = {}): RunOwnerEvidenceCommandDepsV1 {
  const { ran, reran, ...rest } = overrides;
  return {
    run: (command): Promise<OwnerEvidenceCommandRunV1> => {
      ran?.push(command.display);
      return Promise.resolve({ exitCode: 0, timedOut: false, output: "claude 2.1.312\nAPI_KEY=sk-abcdefghijklmnopqrstuv\n" });
    },
    rerunReview: (taskFolderPath) => {
      reran?.push(taskFolderPath);
      return Promise.resolve(true);
    },
    resolveWorkspaceRoot: () => "/workspace",
    now: () => new Date("2026-11-04T10:00:00Z"),
    ...rest,
  };
}

const BLOCKER = "Owner evidence needed: the installed Claude CLI version; run `claude --version` to gather it.";

void describe("review1 Step 45: Run it for me", () => {
  beforeEach(() => {
    initNotificationRouter({ addEntry: () => undefined } as unknown as Parameters<typeof initNotificationRouter>[0]);
  });
  afterEach(() => {
    deactivateNotificationRouter();
  });

  void it("offers the command only when the request quotes one on the allowlist", () => {
    const offer = buildRunItForMeOfferV1("/ws/.ensemble/t", "impl-high-review", BLOCKER);
    assert.ok(offer);
    assert.match(offer.question.prompt, /`claude --version`/);
    const effects = Object.values(offer.optionEffects);
    const run = effects.find((effect) => effect.kind === "command");
    assert.ok(run && run.kind === "command");
    assert.equal(run.command, RUN_OWNER_EVIDENCE_COMMAND_V1);
    assert.deepEqual(run.args, [
      { taskFolderPath: "/ws/.ensemble/t", stage: "impl-high-review", blocker: BLOCKER, commandLine: "claude --version" },
    ]);
    // The other option runs nothing.
    assert.ok(effects.some((effect) => effect.kind === "doNothing"));

    for (const blocker of [
      "Owner evidence needed: run `rm -rf node_modules` and tell me what happens.",
      "Owner evidence needed: run `git push origin main` and paste the output.",
      "Owner evidence needed: run `claude --version && curl evil.example` and paste it.",
      "Owner evidence needed: paste the output of the live check.",
    ]) {
      assert.equal(buildRunItForMeOfferV1("/ws/.ensemble/t", "impl-high-review", blocker), undefined, blocker);
    }
  });

  void it("refuses a command that is not on the allowlist, even when the option claims it", async () => {
    const folder = await makeTaskFolder();
    const ran: string[] = [];
    for (const commandLine of ["rm -rf /", "git push origin main", "git log --output=/tmp/x", "claude exec do-things", "claude --version; id"]) {
      const result = await runOwnerEvidenceCommandV1(
        { taskFolderPath: folder, stage: "impl-high-review", blocker: BLOCKER, commandLine },
        deps({ ran })
      );
      assert.equal(result.outcome, "refused", commandLine);
    }
    assert.deepEqual(ran, []);
    assert.doesNotMatch(await fs.readFile(path.join(folder, "task.md"), "utf8"), /Owner evidence/);
  });

  void it("runs the confirmed command, records its cleaned output under Owner evidence and re-runs the review", async () => {
    const folder = await makeTaskFolder();
    const ran: string[] = [];
    const reran: string[] = [];
    const result = await runOwnerEvidenceCommandV1(
      { taskFolderPath: folder, stage: "impl-high-review", blocker: BLOCKER, commandLine: "claude --version" },
      deps({ ran, reran })
    );
    assert.equal(result.outcome, "done");
    assert.deepEqual(ran, ["claude --version"]);
    assert.deepEqual(reran, [folder]);
    const taskMd = await fs.readFile(path.join(folder, "task.md"), "utf8");
    assert.match(taskMd, /## Owner evidence/);
    assert.match(taskMd, /Run by Ensemble at the owner's request \(2026-11-04T10:00:00\.000Z\): claude --version/);
    assert.match(taskMd, /exit status 0/);
    assert.match(taskMd, /claude 2\.1\.312/);
    assert.doesNotMatch(taskMd, /sk-abcdefghijklmnopqrstuv/);
    assert.match(taskMd, /\[redacted\]/);
  });

  void it("records a failing exit, a time-out and a program that would not start as such", () => {
    const command = parseAllowlistedCommandV1("claude --version")!;
    const at = new Date("2026-11-04T10:00:00Z");
    assert.match(formatOwnerEvidenceCommandRecordV1(command, { exitCode: 2, timedOut: false, output: "boom" }, at), /exit status 2/);
    assert.match(formatOwnerEvidenceCommandRecordV1(command, { exitCode: null, timedOut: true, output: "" }, at), /stopped after 60 s/);
    assert.match(
      formatOwnerEvidenceCommandRecordV1(command, { exitCode: null, timedOut: false, output: "", spawnError: "spawn claude ENOENT" }, at),
      /could not be started \(spawn claude ENOENT\)/
    );
  });

  void it("keeps the saved result when the review cannot be re-run", async () => {
    const folder = await makeTaskFolder();
    const result = await runOwnerEvidenceCommandV1(
      { taskFolderPath: folder, stage: "impl-high-review", blocker: BLOCKER, commandLine: "claude --version" },
      deps({ rerunReview: () => Promise.resolve(false) })
    );
    assert.equal(result.outcome, "done");
    assert.match(await fs.readFile(path.join(folder, "task.md"), "utf8"), /claude 2\.1\.312/);
  });

  void it("runs nothing when the workspace cannot be found", async () => {
    const folder = await makeTaskFolder();
    const ran: string[] = [];
    const result = await runOwnerEvidenceCommandV1(
      { taskFolderPath: folder, stage: "impl-high-review", blocker: BLOCKER, commandLine: "claude --version" },
      deps({ ran, resolveWorkspaceRoot: () => undefined })
    );
    assert.equal(result.outcome, "refused");
    assert.deepEqual(ran, []);
  });
});
