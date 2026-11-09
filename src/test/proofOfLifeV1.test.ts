/**
 * run1 Step 16: the proof of life a running round carries on its operation, read from the round's
 * activity feed, throttled to one push every 2 s, and mirrored to viewer windows.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import { RoundActivityFeedV1 } from "../utils/roundActivityFeedV1";
import {
  PROOF_OF_LIFE_MIN_INTERVAL_MS_V1,
  ProofOfLifeReporterV1,
  proofOfLifeOfFeedV1,
  type ProofOfLifeV1,
} from "../utils/proofOfLifeV1";
import { TaskOperationRegistry, type TaskOperationSnapshot } from "../utils/taskOperations";
import { isRunnerReportingV1, liveMirroredOperationsV1 } from "../services/hostOperationsMirrorV1";

const ROOT = "/work/repo";
const toolLine = (id: string, name: string, input: Record<string, unknown>): string =>
  JSON.stringify({ type: "assistant", message: { content: [{ type: "tool_use", id, name, input }] } });

function clock(): { now: () => number; advance: (ms: number) => void } {
  let t = 1_000_000;
  return { now: () => t, advance: (ms) => (t += ms) };
}

void describe("proof of life (run1 Step 16)", () => {
  void it("carries contact and progress from the feed, and observed changes apart for the tooltip only", () => {
    const c = clock();
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, now: c.now });
    feed.recordContact();
    c.advance(5_000);
    feed.recordStreamLine(toolLine("t1", "Edit", { file_path: `${ROOT}/src/a.ts` }));
    c.advance(5_000);
    feed.recordFileChanges([`${ROOT}/src/other.ts`]);
    const proof = proofOfLifeOfFeedV1(feed, { pid: 4242, processState: "alive" });
    assert.equal(proof.pid, 4242);
    assert.equal(proof.processState, "alive");
    assert.ok(proof.lastContactAt !== undefined);
    assert.match(proof.lastProgressWhat ?? "", /a\.ts/);
    assert.match(proof.lastObservedChangeWhat ?? "", /other\.ts/);
    assert.ok(
      (proof.lastObservedChangeAt ?? 0) > (proof.lastProgressAt ?? 0),
      "the observed change is later, and did not move the progress time"
    );
  });

  void it("pushes at most once every 2 s, and only when something changed", () => {
    const c = clock();
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, now: c.now });
    const sent: ProofOfLifeV1[] = [];
    const reporter = new ProofOfLifeReporterV1(feed, (proof) => sent.push(proof), { now: c.now });
    reporter.setProcess(77);
    assert.equal(sent.length, 1, "the pid is sent at once");
    feed.recordContact();
    reporter.tick();
    assert.equal(sent.length, 1, "a tick inside the interval sends nothing");
    c.advance(PROOF_OF_LIFE_MIN_INTERVAL_MS_V1);
    reporter.tick();
    assert.equal(sent.length, 2, "the next due tick sends the new contact time");
    c.advance(PROOF_OF_LIFE_MIN_INTERVAL_MS_V1);
    reporter.tick();
    assert.equal(sent.length, 2, "nothing changed, so nothing is sent");
  });

  void it("sends the process ending and the settled outcome at once", () => {
    const c = clock();
    const feed = new RoundActivityFeedV1({ workspaceRoot: ROOT, streaming: true, now: c.now });
    const sent: ProofOfLifeV1[] = [];
    const reporter = new ProofOfLifeReporterV1(feed, (proof) => sent.push(proof), { now: c.now });
    reporter.setProcess(77);
    reporter.markProcessEnded();
    assert.equal(sent[sent.length - 1]?.processState, "ended");
    reporter.markSettled({ status: "failed", cause: "processEnded" });
    assert.deepEqual(sent[sent.length - 1]?.settledOutcome, { status: "failed", cause: "processEnded" });
  });

  void it("lands on the task's running operation, and is mirrored to a viewer registry", () => {
    const task = "/w/.ensemble/2026-11-06_task_9";
    const runner = new TaskOperationRegistry();
    const op = runner.begin(task, { label: "Implementation", exclusive: true, cancellable: true });
    assert.ok(op);
    assert.equal(runner.reportProofOfLifeForTask("/w/.ensemble/other_task", { processState: "alive" }), false);
    const proof: ProofOfLifeV1 = { pid: 9, lastProgressAt: 5, lastProgressWhat: "edited `a.ts`", processState: "alive" };
    assert.equal(runner.reportProofOfLifeForTask(task, proof), true);
    const running = runner.getTaskOperations(task)[0] as TaskOperationSnapshot;
    assert.deepEqual(running.proofOfLifeV1, proof);

    // The runner writes the snapshot as JSON; the viewer reads it back and puts it in its registry.
    const written = JSON.parse(
      JSON.stringify({
        writtenAt: Date.now(),
        operations: [
          {
            id: running.id,
            key: running.key,
            label: running.label,
            taskName: running.taskName,
            startedAt: running.startedAt,
            waitingForUser: false,
            proofOfLifeV1: running.proofOfLifeV1,
          },
        ],
      })
    ) as Parameters<typeof liveMirroredOperationsV1>[0];
    assert.equal(isRunnerReportingV1(written, Date.now()), true);
    const viewer = new TaskOperationRegistry();
    viewer.setMirroredOperations(
      liveMirroredOperationsV1(written, Date.now()).map((m) => ({
        ...m,
        exclusive: true,
        cancellable: false,
        state: "running" as const,
      })) as unknown as TaskOperationSnapshot[]
    );
    const mirrored = viewer.getMirroredTaskOperations(task)[0];
    assert.deepEqual(mirrored?.proofOfLifeV1, proof, "the viewer's row shows the runner's evidence");
    runner.end(op);
  });
});
