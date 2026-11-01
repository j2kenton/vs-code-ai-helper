/**
 * bugs4 item 34: a Commit & Push that ends before it opens its tracked operation
 * (stage not eligible, ownership binding unverifiable, admission busy) says in the
 * task chat that nothing was committed, why, and what to do next. The pop-up alone
 * is never the outcome.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";

import { ResolvedTaskContext } from "../utils/resolveTaskContext";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const chatActionOfferModule = require("../utils/chatActionOfferV1") as {
  offerActionInChatV1: (input: {
    taskFolderPath: string;
    taskLabel?: string;
    actionLabel: string;
    command: string;
    noticeText: string;
    actionConsequence?: string;
    recommend?: { target: unknown; reasoning: string };
    doNothingOption?: { label: string; consequence: string };
  }) => Promise<undefined>;
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const commitAndPushTaskModule = require("../commands/commitAndPushTask") as {
  postCommitPushNotStartedInChatV1: (
    resolvedTask: ResolvedTaskContext,
    reason: string,
    nextStep: string,
    retryHelps: boolean
  ) => Promise<void>;
  postCommitPushBusyInChatV1: (candidateFolderPath: string | undefined, refusalText: string) => Promise<void>;
};

type Offer = Parameters<typeof chatActionOfferModule.offerActionInChatV1>[0];

async function capture(run: () => Promise<void>): Promise<Offer[]> {
  const offers: Offer[] = [];
  const original = chatActionOfferModule.offerActionInChatV1;
  chatActionOfferModule.offerActionInChatV1 = (input): Promise<undefined> => {
    offers.push(input);
    return Promise.resolve(undefined);
  };
  try {
    await run();
  } finally {
    chatActionOfferModule.offerActionInChatV1 = original;
  }
  return offers;
}

const TASK = {
  taskFolderPath: "/ws/.ensemble/2026-11-01_task_1",
  folderName: "2026-11-01_task_1",
  progress: { displayName: "Fix the thing", currentStage: "impl" },
} as unknown as ResolvedTaskContext;

void describe("Commit & Push endings before the operation opens post to chat (bugs4 item 34)", () => {
  void it("a stage that is not eligible says nothing was committed, why, and recommends nothing", async () => {
    const offers = await capture(() =>
      commitAndPushTaskModule.postCommitPushNotStartedInChatV1(
        TASK,
        'The task is at "Implementation", and Commit & Push only runs once the task has reached Publish.',
        "Finish the current stage until the task is at Publish.",
        false
      )
    );
    assert.equal(offers.length, 1, "exactly one chat card");
    const offer = offers[0]!;
    assert.match(offer.noticeText, /did not start, so nothing was committed/);
    assert.match(offer.noticeText, /Implementation/);
    assert.match(offer.taskLabel ?? "", /Fix the thing/, "the card names the task, not a default label");
    assert.equal(offer.doNothingOption?.label, "Not now");
    assert.match(offer.doNothingOption?.consequence ?? "", /Nothing is committed/);
    assert.equal(offer.recommend?.target, "none", "re-running cannot help, so it is not recommended");
  });

  void it("a retry-able ending keeps the default recommendation", async () => {
    const offers = await capture(() =>
      commitAndPushTaskModule.postCommitPushNotStartedInChatV1(TASK, "Another action holds the task.", "Wait, then retry.", true)
    );
    assert.equal(offers.length, 1);
    assert.equal(offers[0]!.recommend, undefined);
  });

  void it("an admission-busy refusal posts one card; with no candidate folder nothing is posted", async () => {
    const offers = await capture(() =>
      commitAndPushTaskModule.postCommitPushBusyInChatV1(TASK.taskFolderPath, '"Fix the thing" already has a stage action in progress.')
    );
    assert.equal(offers.length, 1);
    assert.match(offers[0]!.noticeText, /nothing was committed/);
    assert.match(offers[0]!.noticeText, /already has a stage action in progress/);
    assert.equal(offers[0]!.recommend?.target, "none");
    const none = await capture(() => commitAndPushTaskModule.postCommitPushBusyInChatV1(undefined, "busy"));
    assert.deepEqual(none, []);
  });

  void it("an unreachable chat never changes the outcome (the helpers do not throw)", async () => {
    const original = chatActionOfferModule.offerActionInChatV1;
    chatActionOfferModule.offerActionInChatV1 = (): Promise<undefined> => Promise.reject(new Error("no chat"));
    try {
      await commitAndPushTaskModule.postCommitPushNotStartedInChatV1(TASK, "reason", "next", true);
      await commitAndPushTaskModule.postCommitPushBusyInChatV1(TASK.taskFolderPath, "busy");
    } finally {
      chatActionOfferModule.offerActionInChatV1 = original;
    }
  });
});
