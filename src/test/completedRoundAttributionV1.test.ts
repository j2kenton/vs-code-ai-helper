import * as assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  completedRoundAttributionV1,
  readCompletedRoundFallbackReasonFromRunLogV1,
} from "../utils/completedRoundAttributionV1";
import { formatRoundOutcomeMessageV1 } from "../utils/roundLedgerV1";
import { RoundLedgerEntryV1 } from "../types/taskProgress";

void describe("completedRoundAttributionV1", () => {
  void it("projects the actual reviewer identity rather than a configured model", () => {
    const result = completedRoundAttributionV1({
      reviewScoreHistory: [
        {
          stage: "impl-high-review",
          score: 8,
          attemptId: "review-1",
          at: "2026-10-21T00:00:00Z",
          blockerCount: 0,
          taskFixableCount: 0,
          reviewer: { providerLabel: "OpenAI Codex", storedModelId: "codex-cli:gpt-6-luna@high" },
        },
      ],
    }, "impl-high-review");
    assert.deepEqual(result, { modelId: "codex-cli:gpt-6-luna@high", providerLabel: "OpenAI Codex" });
  });

  void it("uses the latest stored implementation round identity", () => {
    const result = completedRoundAttributionV1({
      roundOutcomes: [
        {
          stage: "impl",
          classification: "edits-produced",
          at: "2026-10-20T00:00:00Z",
          modelId: "codex-cli:gpt-6-sol@high",
          providerId: "codex-cli",
        },
        {
          stage: "impl",
          classification: "edits-produced",
          at: "2026-10-21T00:00:00Z",
          modelId: "claude-cli:sonnet@high",
          providerId: "claude-cli",
        },
      ],
    }, "impl");
    assert.deepEqual(result, { modelId: "claude-cli:sonnet@high", providerId: "claude-cli" });
  });

  void it("projects the successful reviewer identity from the review record", () => {
    const result = completedRoundAttributionV1({
      reviewScoreHistory: [
        {
          stage: "impl-high-review",
          score: 8,
          blockerCount: 0,
          taskFixableCount: 0,
          at: "2026-10-21T01:00:00Z",
          attemptId: "backup-round",
          reviewer: {
            providerLabel: "Claude Code",
            storedModelId: "claude-cli:sonnet@high",
          },
        },
      ],
    }, "impl-high-review", ["backup-round"]);
    assert.deepEqual(result, {
      modelId: "claude-cli:sonnet@high",
      providerLabel: "Claude Code",
    });
  });

  void it("renders the successful backup and primary failure together in the Chat projection", () => {
    const entry: RoundLedgerEntryV1 = {
      roundId: "backup-round",
      attemptIds: ["backup-round"],
      stage: "impl",
      mode: "implementation",
      startedAt: "2026-10-21T01:00:00Z",
      endedAt: "2026-10-21T01:05:00Z",
      state: "completed",
      outcome: { filesChanged: ["src/app.ts"] },
    };
    const line = formatRoundOutcomeMessageV1(
      entry,
      undefined,
      {
        roundOutcomes: [{
          stage: "impl",
          classification: "edits-produced",
          at: "2026-10-21T01:05:00Z",
          attemptId: "backup-round",
          modelId: "claude-cli:sonnet@high",
          providerId: "claude-cli",
        }],
      },
      "Backup used; primary was skipped or failed: codex-cli:gpt-6-luna@high cliExit.1"
    );
    assert.match(line, /model claude-cli \(claude-cli:sonnet@high\)/);
    assert.match(line, /primary was skipped or failed: codex-cli:gpt-6-luna@high cliExit\.1/);
  });

  void it("reads backup provenance from the exact round's durable review run log", async () => {
    const runs = await fs.mkdtemp(path.join(os.tmpdir(), "completed-review-attribution-"));
    try {
      await fs.writeFile(
        path.join(runs, "001-review-v1-impl-high-review.md"),
        "# Review Run\n\nReview round: round-older\nBackup used; primary was skipped or failed: old-primary unavailable\n"
      );
      await fs.writeFile(
        path.join(runs, "002-review-v1-impl-high-review.md"),
        "# Review Run\n\nReview round: round-current\nBackup used; primary was skipped or failed: codex-cli:gpt-6-luna@high cliExit.1\n"
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl-high-review", "round-current"),
        "codex-cli:gpt-6-luna@high cliExit.1"
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl-high-review", "round-without-backup"),
        undefined
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl-low-review", "round-current"),
        undefined
      );
    } finally {
      await fs.rm(runs, { recursive: true, force: true });
    }
  });

  void it("can recover provenance from the newest legacy stage log", async () => {
    const runs = await fs.mkdtemp(path.join(os.tmpdir(), "legacy-review-attribution-"));
    try {
      await fs.writeFile(
        path.join(runs, "009-review-v1-impl-low-review.md"),
        "# Review Run\n\nBackup used; primary was skipped or failed: legacy primary unavailable\n"
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl-low-review", "legacy-round"),
        "legacy primary unavailable"
      );
    } finally {
      await fs.rm(runs, { recursive: true, force: true });
    }
  });

  void it("reads implementation fallback provenance from its round run log", async () => {
    const runs = await fs.mkdtemp(path.join(os.tmpdir(), "implementation-round-attribution-"));
    try {
      await fs.writeFile(
        path.join(runs, "011-codex-cli-impl.md"),
        "# Implementation Run\n\nRound ID: impl-round-11\n\n" +
          "Backup used; primary was skipped or failed: OpenAI Codex gpt-6-luna hit a usage limit; this round ran on Claude Code Sonnet.\n"
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl", "impl-round-11"),
        "OpenAI Codex gpt-6-luna hit a usage limit; this round ran on Claude Code Sonnet."
      );
    } finally {
      await fs.rm(runs, { recursive: true, force: true });
    }
  });

  void it("joins recovery continuation provenance by ledger round id, not prompt round id", async () => {
    const runs = await fs.mkdtemp(path.join(os.tmpdir(), "implementation-continuation-attribution-"));
    try {
      await fs.writeFile(
        path.join(runs, "012-codex-cli-impl.md"),
        "# Implementation Run\n\nRound ID: continuation-ledger-id\n" +
          "Prompt Round ID: distinct-prompt-id\n\n" +
          "Backup used; primary was skipped or failed: codex-cli:gpt-6-luna@high cliExit.1\n"
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl", "continuation-ledger-id"),
        "codex-cli:gpt-6-luna@high cliExit.1"
      );
      assert.equal(
        await readCompletedRoundFallbackReasonFromRunLogV1(runs, "impl", "distinct-prompt-id"),
        undefined
      );
    } finally {
      await fs.rm(runs, { recursive: true, force: true });
    }
  });
});
