/**
 * bugs4 Step 31 / item 28: an authentication failure only holds back models that share the
 * failed model's provider and account; a backup from another provider is still tried.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  authFailureRescueNoteV1,
  crossProviderAuthCandidatesV1,
  SAME_SIGN_IN_HELD_BACK_REASON_V1,
  sameSignInScopeV1,
  SignInScopeV1,
} from "../utils/authFallbackScopeV1";

const DEVPASS: SignInScopeV1 = { providerId: "devpass-cli", accountKey: "devpass" };
const CLAUDE: SignInScopeV1 = { providerId: "claude-cli", accountKey: "claude" };
const scopes: Record<string, SignInScopeV1 | undefined> = {
  "devpass-cli:a": DEVPASS,
  "devpass-cli:b": DEVPASS,
  "claude-cli:sonnet": CLAUDE,
  "mystery:x": undefined,
};
const scopeOf = (model: string): SignInScopeV1 | undefined => scopes[model];

void describe("crossProviderAuthCandidatesV1", () => {
  void it("devpass first and Claude Code later: only Claude Code is still tried", () => {
    assert.deepEqual(
      crossProviderAuthCandidatesV1(DEVPASS, ["devpass-cli:b", "claude-cli:sonnet"], scopeOf),
      ["claude-cli:sonnet"]
    );
  });

  void it("only devpass models in the chain: nothing is tried, so the round fails with the sign-in instruction", () => {
    assert.deepEqual(crossProviderAuthCandidatesV1(DEVPASS, ["devpass-cli:a", "devpass-cli:b"], scopeOf), []);
  });

  void it("a model whose provider cannot be resolved is never crossed to on a guess", () => {
    assert.deepEqual(crossProviderAuthCandidatesV1(DEVPASS, ["mystery:x"], scopeOf), []);
  });

  void it("the same provider under a different account is a different sign-in", () => {
    assert.equal(sameSignInScopeV1(DEVPASS, { providerId: "devpass-cli", accountKey: "devpass#work" }), false);
    assert.equal(sameSignInScopeV1(DEVPASS, DEVPASS), true);
  });

  void it("the held-back reason names the shared sign-in", () => {
    assert.match(SAME_SIGN_IN_HELD_BACK_REASON_V1, /same sign-in/);
  });
});

void describe("authFailureRescueNoteV1", () => {
  void it("names the failed provider, the reason, the model that ran and the sign-in step", () => {
    const note = authFailureRescueNoteV1(
      "devpass",
      "APIError: Unauthorized: This LLMGateway API token is not active (it may be disabled or deleted) (HTTP 401)",
      "Claude Code claude-sonnet-5-5@high"
    );
    assert.match(note, /^devpass sign-in failed \(/);
    assert.match(note, /not active/);
    assert.match(note, /this round ran on Claude Code claude-sonnet-5-5@high\./);
    assert.match(note, /Sign in to devpass again to use it\.$/);
    assert.doesNotMatch(note, /\{/);
  });

  void it("still reads cleanly with no error text", () => {
    assert.equal(
      authFailureRescueNoteV1("devpass", undefined, "Claude Code x"),
      "devpass sign-in failed; this round ran on Claude Code x. Sign in to devpass again to use it."
    );
  });
});
