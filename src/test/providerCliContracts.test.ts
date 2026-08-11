import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { FRAME_END_V1, FRAME_START_V1 } from "../types/aiResultEnvelope";
import {
  buildKimiCliPromptFileInstruction,
  CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT,
  CLI_PROVIDERS,
  CLINE_CLI_ARGV_PROMPT_PLACEHOLDER,
  getCliProvider,
  getProviderAccountEntry,
  parseClineModelSelection,
  parseCopilotModelSelection,
  parseCodexModelSelection,
  parseKimiModelSelection,
  parseModelSelection,
  parseOpencodeModelSelection,
  providerAccountIdForModelId,
  PROVIDER_ACCOUNT_ENTRIES,
  type CliProviderDefinition,
} from "../runners/providers";

void describe("provider CLI contracts", () => {
  function modelArgValue(args: readonly string[]): string | undefined {
    const index = args.indexOf("--model");
    return index >= 0 ? args[index + 1] : undefined;
  }

  function buildTextArgs(
    provider: CliProviderDefinition,
    model: string | undefined
  ): string[] {
    return provider.buildArgs("text", model, "/tmp/last-message.md", {
      cwd: "/workspace/project",
      promptFile: "/tmp/prompt.txt",
    });
  }

  void it("Kiro uses stdin prompt transport for --no-interactive", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    assert.strictEqual(kiro.promptTransport, "stdin");
    assert.strictEqual(kiro.useShell, false);
    assert.strictEqual(kiro.maxArgvPromptBytes, undefined);

    const textArgs = kiro.buildArgs("text", undefined, undefined);
    assert.deepStrictEqual(textArgs, [
      "chat",
      "--no-interactive",
      "--trust-tools",
      "fs_read,grep,glob",
    ]);

    const editArgs = kiro.buildArgs("edit", "claude-opus-4.6", undefined);
    assert.deepStrictEqual(editArgs, [
      "chat",
      "--no-interactive",
      "--trust-all-tools",
      "--model",
      "claude-opus-4.6",
    ]);
  });

  void it("Antigravity supports both agy and antigravity executable names", () => {
    const antigravity = getCliProvider("antigravity-cli");
    assert.ok(antigravity, "expected antigravity-cli provider definition");

    assert.strictEqual(antigravity.command, "agy");
    assert.deepStrictEqual(antigravity.commandAliases, ["antigravity"]);
    assert.strictEqual(antigravity.promptTransport, "file");
    assert.strictEqual(antigravity.useShell, false);
    assert.strictEqual(antigravity.maxArgvPromptBytes, undefined);
    assert.deepStrictEqual(antigravity.models, [
      { model: undefined, name: "Antigravity (CLI default)" },
    ]);

    // `--print` carries the PROMPT TEXT, not a path. Passing the bare path
    // made agy treat the file as untrusted material to report on rather than
    // instructions to follow (verified 2026-08-06: it answered "This file
    // contains a prompt injection attempt ... I won't follow those
    // instructions" and did no work), so the path is wrapped in the shared
    // file-instruction sentence. Only the extension-generated path is
    // interpolated, so argv stays fixed-size for any prompt.
    const textArgs = antigravity.buildArgs("text", undefined, undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(textArgs, [
      `--print=${buildKimiCliPromptFileInstruction("/tmp/prompt.txt")}`,
      "--print-timeout=55m0s",
      "--dangerously-skip-permissions",
    ]);

    const editArgs = antigravity.buildArgs("edit", "gemini-3-pro", undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(editArgs, [
      `--print=${buildKimiCliPromptFileInstruction("/tmp/prompt.txt")}`,
      "--print-timeout=55m0s",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3-pro",
    ]);

    const resumedArgs = antigravity.buildArgs("edit", undefined, undefined, {
      promptFile: "/tmp/prompt.txt",
      resumePreviousConversation: true,
    });
    assert.deepStrictEqual(resumedArgs, [
      `--print=${buildKimiCliPromptFileInstruction("/tmp/prompt.txt")}`,
      "--print-timeout=55m0s",
      "--dangerously-skip-permissions",
      "--continue",
    ]);
    assert.deepStrictEqual(antigravity.conversationResume?.errorMarkers, [
      "error: timeout waiting for response",
    ]);

    // promptTransport: "file" is a contract with the caller — cliAgentRunner
    // always writes the prompt to disk and supplies its path before calling
    // buildArgs. A missing promptFile means that contract was violated, and
    // must fail loudly rather than silently building `--print=` (an empty
    // prompt indistinguishable from a real one downstream). Matching
    // /misconfiguration/, not just /promptFile/: with a fully-omitted
    // context argument, an unguarded `context.promptFile` access would
    // throw its own TypeError containing the word "promptFile" even if the
    // explicit guard were deleted, making a looser regex pass vacuously.
    assert.throws(
      () => antigravity.buildArgs("text", undefined, undefined, {}),
      /misconfiguration/
    );
    assert.throws(
      () => antigravity.buildArgs("text", undefined, undefined),
      /misconfiguration/
    );
  });

  void it("opencode uses stdin prompt transport and an explicit --agent per mode", () => {
    const opencode = getCliProvider("opencode-cli");
    assert.ok(opencode, "expected opencode-cli provider definition");

    assert.strictEqual(opencode.promptTransport, "stdin");
    assert.strictEqual(opencode.useShell, undefined);
    assert.strictEqual(opencode.usesLastMessageFile, false);
    assert.ok(
      opencode.authErrorMarkers.includes("no provider available"),
      "Zen's 401 provider-entitlement error must show opencode's sign-in recovery hint"
    );
    assert.ok(
      opencode.authErrorMarkers.includes("401"),
      "a JSON statusCode 401 must show opencode's sign-in recovery hint"
    );

    const textArgs = opencode.buildArgs("text", undefined, undefined);
    assert.deepStrictEqual(textArgs, [
      "run",
      "--format",
      "json",
      "--agent",
      "plan",
    ]);

    const editArgs = opencode.buildArgs("edit", "openai/gpt-5", undefined);
    assert.deepStrictEqual(editArgs, [
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "--model",
      "openai/gpt-5",
    ]);
  });

  void it("opencode model selections carry an optional per-model @variant suffix", () => {
    // opencode has no single fixed reasoning-effort ladder shared by every
    // model (unlike Codex) — each model declares its own variant set
    // (verified live via `opencode models --verbose`: "deepseek-v4-flash"
    // has "high"/"max", "north-mini-code-free" has "none"/"high"), so the
    // suffix is passed through to --variant verbatim rather than validated
    // against an allowlist — see parseOpencodeModelSelection's doc comment.
    assert.deepStrictEqual(parseOpencodeModelSelection(undefined), {
      model: undefined,
      variant: undefined,
    });
    assert.deepStrictEqual(parseOpencodeModelSelection("opencode/deepseek-v4-flash"), {
      model: "opencode/deepseek-v4-flash",
      variant: undefined,
    });
    assert.deepStrictEqual(
      parseOpencodeModelSelection("opencode/deepseek-v4-flash@high"),
      { model: "opencode/deepseek-v4-flash", variant: "high" }
    );
    assert.deepStrictEqual(
      parseOpencodeModelSelection("opencode/north-mini-code-free@none"),
      { model: "opencode/north-mini-code-free", variant: "none" }
    );

    const opencode = getCliProvider("opencode-cli");
    assert.ok(opencode);
    const editArgs = opencode.buildArgs("edit", "opencode/deepseek-v4-flash@high", undefined);
    assert.deepStrictEqual(editArgs, [
      "run",
      "--format",
      "json",
      "--agent",
      "build",
      "--model",
      "opencode/deepseek-v4-flash",
      "--variant",
      "high",
    ]);

    // Full round trip through the provider-qualified storage prefix too —
    // parseModelSelection only splits on the FIRST ":", so the "@variant"
    // suffix survives into the raw model string untouched and is split
    // apart locally by buildArgs, the same way Codex's "@effort+tier"
    // suffix already does.
    const parsedStored = parseModelSelection("opencode-cli:opencode/deepseek-v4-flash@high");
    assert.strictEqual(parsedStored.provider, "opencode-cli");
    assert.strictEqual(parsedStored.model, "opencode/deepseek-v4-flash@high");
  });

  void it("separates OpenCode Zen and Go account controls while keeping one CLI adapter", () => {
    assert.strictEqual(
      providerAccountIdForModelId("opencode-cli:opencode/deepseek-v4-flash@high"),
      "opencode-zen"
    );
    assert.strictEqual(
      providerAccountIdForModelId("opencode-cli:opencode-go/kimi-k3@max"),
      "opencode-go"
    );
    assert.strictEqual(
      providerAccountIdForModelId("opencode-cli:openai/gpt-5"),
      "opencode-cli",
      "external OpenCode CLI providers must not be labeled as Zen"
    );

    const zen = getProviderAccountEntry("opencode-zen");
    const go = getProviderAccountEntry("opencode-go");
    assert.ok(zen, "expected the OpenCode Zen provider-account row");
    assert.ok(go, "expected the OpenCode Go provider-account row");
    assert.strictEqual(getProviderAccountEntry("opencode-cli"), undefined);
    assert.strictEqual(zen.label, "OpenCode Zen");
    assert.strictEqual(go.label, "OpenCode Go");
    assert.strictEqual(zen.signIn.kind, "interactive");
    assert.strictEqual(go.signIn.kind, "interactive");
    if (zen.signIn.kind === "interactive" && go.signIn.kind === "interactive") {
      assert.deepStrictEqual(zen.signIn, {
        kind: "interactive",
        launch: "opencode",
        send: "/connect",
        validated: "verified",
      });
      assert.deepStrictEqual(go.signIn, zen.signIn);
    }

    const opencode = getCliProvider("opencode-cli");
    assert.ok(opencode);
    assert.match(opencode.loginHintForModel?.("opencode-go/kimi-k3") ?? "", /OpenCode Go/);
    assert.match(opencode.loginHintForModel?.("opencode/glm-5.2") ?? "", /OpenCode Zen/);
  });

  void it("text mode stays permission-constrained unless the provider warns the user", () => {
    // "text mode must keep the CLI read-only" is the contract stated on
    // CliProviderDefinition.buildArgs. Antigravity is the one deliberate
    // exception — its headless CLI grants no scoped access in any mode, and
    // a run without the bypass flag does nothing at all (see the comment on
    // its definition for the flags and allow-rule forms that were tested).
    // The price of that exception is telling the user before they enable
    // the provider, so any future provider that skips permissions in text
    // mode must pay it too.
    const PERMISSION_BYPASS_FLAGS = [
      "--dangerously-skip-permissions",
      "--dangerously-bypass-approvals-and-sandbox",
      "--yolo",
    ];

    for (const provider of CLI_PROVIDERS) {
      const textArgs = provider.buildArgs("text", undefined, undefined, {
        promptFile: "/tmp/prompt.txt",
      });
      const bypassed = textArgs.filter((arg) =>
        PERMISSION_BYPASS_FLAGS.includes(arg)
      );
      // Cline is a second known exception, but not detectable via a
      // bypass-flag literal the way Antigravity is: its text mode passes
      // `--plan`, which LOOKS like a scoped read-only flag but (verified
      // live — see its buildArgs comment) does not gate the tool that
      // matters, so nothing in PERMISSION_BYPASS_FLAGS appears in its
      // textArgs at all. The signal here has to come from the provider
      // declaring permissionWarning itself. Kimi is a third: its text mode
      // passes NO flag at all (verified live: `--plan` cannot even be
      // combined with `-p`), which is even less detectable via a flag
      // literal than Cline's case, so it needs the same explicit exception.
      const isKnownException =
        bypassed.length > 0 ||
        provider.id === "cline-cli" ||
        provider.id === "kimi-cli";
      if (!isKnownException) {
        assert.strictEqual(
          provider.permissionWarning,
          undefined,
          `${provider.id} constrains text mode and should not carry a permission warning`
        );
        continue;
      }
      assert.ok(
        provider.permissionWarning,
        `${provider.id} skips permissions in text mode (${bypassed.join(" ")}) and must carry a permissionWarning`
      );
      // The settings view renders from the account entry, not the CLI
      // definition — a warning that stops here never reaches the user.
      assert.strictEqual(
        getProviderAccountEntry(provider.id)?.permissionWarning,
        provider.permissionWarning,
        `${provider.id}'s warning must reach its provider-account entry`
      );
    }

    // Guard against the loop above passing vacuously: each known exception
    // must actually be flagged, and its user-facing warning must lead with
    // the concrete risk in plain language (the CLI-flag mechanics live in
    // the provider definitions' code comments, not in the warning the user
    // reads) and stay a warning-sized message, not an essay.
    for (const id of ["antigravity-cli", "cline-cli", "kimi-cli"] as const) {
      const provider = getCliProvider(id);
      assert.ok(provider?.permissionWarning, `expected ${id} to carry a permission warning`);
      assert.match(
        provider.permissionWarning,
        /create, change, or delete any file and run shell commands without asking/,
        `${id}'s warning must lead with the concrete risk in plain language`
      );
      assert.match(
        provider.permissionWarning,
        /every stage including plan and review/,
        `${id}'s warning must say the risk applies to every stage`
      );
      assert.doesNotMatch(
        provider.permissionWarning,
        /unlike|other providers|applies to .* only/i,
        `${id}'s warning must not compare against other providers`
      );
      assert.ok(
        provider.permissionWarning.length <= 220,
        `${id}'s warning must stay short (${provider.permissionWarning.length} chars)`
      );
    }
  });

  void it("Kimi carries the whole prompt in a temp file, never in argv", () => {
    // Kimi's `-p` is its only prompt input and it has no prompt-file flag,
    // so argv transport capped every run at the OS command-line ceiling and
    // made real context packs fail with cliPromptTooLarge (118 KB pack vs a
    // 20 KB cap). "file" transport + a short read-this-file instruction
    // removes prompt size from argv entirely — see the provider's
    // promptTransport comment for the live verification behind it.
    const kimi = getCliProvider("kimi-cli");
    assert.ok(kimi, "expected kimi-cli provider definition");

    assert.strictEqual(kimi.promptTransport, "file");
    // "file" transport is enforced as shell:false by execCliAgent; this is
    // also why Kimi must be the native binary, not an npm .cmd shim.
    assert.strictEqual(kimi.useShell, false);
    // An argv byte cap would be meaningless now — and leaving one behind
    // would re-impose a prompt-size limit that no longer applies.
    assert.strictEqual(kimi.maxArgvPromptBytes, undefined);

    const promptFile = "/tmp/ensemble-kimi-prompt.txt";
    const args = kimi.buildArgs("text", "kimi-code/k3", undefined, { promptFile });
    assert.deepStrictEqual(args, [
      "--output-format",
      "stream-json",
      "-m",
      "kimi-code/k3",
      "-p",
      buildKimiCliPromptFileInstruction(promptFile),
    ]);

    // stream-json is load-bearing, not cosmetic: in plain `text` mode Kimi
    // narrates before answering ("• The file is large...") and indents the
    // answer, and parseAiResultEnvelopeV1 rejects ANY bytes before the frame
    // marker — so a genuinely completed V1 review settled as malformedResult.
    // Pinning both the flag and the paired stream tag together, since either
    // alone silently breaks the extraction (see extractKimiFinalOutput).
    assert.strictEqual(kimi.structuredEventStream, "kimi");

    // The instruction must name the file, and must carry both load-bearing
    // clauses: read it ALL (its Read tool paginates on large files) and
    // treat it as instructions rather than material to summarize (its
    // default posture toward file contents is untrusted-data).
    const instruction = buildKimiCliPromptFileInstruction(promptFile);
    assert.ok(instruction.includes(promptFile), "instruction must name the prompt file");
    assert.match(instruction, /entire file/i);
    assert.match(instruction, /authoritative prompt/i);

    // The frame reminder is opt-in (V1 text transport only) — the legacy path
    // expects free text, so adding it there would demand a frame nothing
    // parses. Default-off keeps that split explicit.
    assert.ok(
      !instruction.includes(FRAME_START_V1),
      "the frame reminder must not leak into the default (legacy) instruction"
    );

    // With it on, the V1 output contract is restated in argv. A live
    // kimi-code/k3 run (2026-08-06, 15 steps over a ~200 KB prompt) did the
    // review correctly and then answered in plain prose, dropping the frame
    // stated hundreds of lines into the file it read through its paginated
    // Read tool — a complete review discarded as invalidFrame on formatting
    // alone. argv is the one channel delivered directly rather than read.
    const framed = buildKimiCliPromptFileInstruction(promptFile, true);
    assert.ok(framed.startsWith(instruction), "framed form must extend, not replace, the base instruction");
    assert.ok(framed.includes(FRAME_START_V1), "must name the exact opening marker the parser requires");
    assert.ok(framed.includes(FRAME_END_V1), "must name the exact closing marker the parser requires");
    assert.match(framed, /final message/i);
    // Fixed-size and path-free: argv can never grow with prompt size, which
    // is the entire reason these providers use a prompt file.
    assert.ok(
      Buffer.byteLength(framed, "utf8") - Buffer.byteLength(instruction, "utf8") < 600,
      "the argv reminder must stay small — argv is the constrained channel"
    );

    // The V1 text transport is what turns it on; buildArgs must thread it.
    const framedArgs = kimi.buildArgs("text", "kimi-code/k3", undefined, {
      promptFile,
      requiresFramedResult: true,
    });
    assert.deepStrictEqual(framedArgs[framedArgs.length - 1], framed);
    // Edit mode is byte-identical: Kimi rejects every permission flag
    // alongside -p, so mode changes nothing (see permissionWarning).
    assert.deepStrictEqual(
      kimi.buildArgs("edit", "kimi-code/k3", undefined, { promptFile }),
      args
    );

    // promptTransport "file" is a caller contract; a missing promptFile is
    // an upstream violation and must name itself rather than silently
    // pointing Kimi at "undefined". Matching /misconfiguration/ (not merely
    // /promptFile/) so an unguarded property access throwing its own
    // TypeError cannot satisfy this vacuously — same rule as Antigravity's.
    assert.throws(
      () => kimi.buildArgs("text", undefined, undefined, {}),
      /misconfiguration/
    );
    assert.throws(
      () => kimi.buildArgs("text", undefined, undefined),
      /misconfiguration/
    );
  });

  void it("Kimi reasoning effort is an environment variable, not a CLI flag", () => {
    // Verified live against kimi-code 0.29.2: -m rejects any "@effort"
    // suffix outright ("Model ... is not configured in config.toml"), but
    // KIMI_MODEL_THINKING_EFFORT=low/high both succeeded for kimi-code/k3
    // and =bogus 400'd from the API. So buildArgs must pass only the bare
    // model to -m, and the effort must reach the CLI via buildEnv instead.
    assert.deepStrictEqual(parseKimiModelSelection(undefined), {
      model: undefined,
      reasoningEffort: undefined,
    });
    assert.deepStrictEqual(parseKimiModelSelection("kimi-code/k3"), {
      model: "kimi-code/k3",
      reasoningEffort: undefined,
    });
    assert.deepStrictEqual(parseKimiModelSelection("kimi-code/k3@low"), {
      model: "kimi-code/k3",
      reasoningEffort: "low",
    });
    assert.deepStrictEqual(parseKimiModelSelection("kimi-code/k3-256k@max"), {
      model: "kimi-code/k3-256k",
      reasoningEffort: "max",
    });
    // An unrecognized suffix is not a valid effort — the whole string is
    // kept as the model, same convention as Codex/Claude/Cline's parsers.
    assert.deepStrictEqual(parseKimiModelSelection("kimi-code/k3@medium"), {
      model: "kimi-code/k3@medium",
      reasoningEffort: undefined,
    });

    const kimi = getCliProvider("kimi-cli");
    assert.ok(kimi, "expected kimi-cli provider definition");
    assert.ok(kimi.buildEnv, "expected kimi-cli to declare buildEnv");

    // buildArgs strips the suffix before -m; buildEnv is where the effort
    // actually reaches the CLI.
    const args = kimi.buildArgs("text", "kimi-code/k3@high", undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    const modelIndex = args.indexOf("-m");
    assert.ok(modelIndex >= 0, "expected -m flag in kimi's buildArgs output");
    assert.strictEqual(args[modelIndex + 1], "kimi-code/k3");
    assert.ok(
      !args.some((arg) => arg.includes("@")),
      "no argv element may carry the raw @effort-suffixed model id"
    );

    assert.deepStrictEqual(kimi.buildEnv("kimi-code/k3@low"), {
      KIMI_MODEL_THINKING_EFFORT: "low",
    });
    assert.deepStrictEqual(kimi.buildEnv("kimi-code/k3-256k@max"), {
      KIMI_MODEL_THINKING_EFFORT: "max",
    });
    // No suffix, or a model with no effort ladder at all (K2.7) — no env
    // override is added; the model runs at its own configured default.
    assert.strictEqual(kimi.buildEnv("kimi-code/k3"), undefined);
    assert.strictEqual(kimi.buildEnv("kimi-code/kimi-for-coding"), undefined);
    assert.strictEqual(kimi.buildEnv(undefined), undefined);
  });

  void it("Kimi can resume its own conversation instead of replaying a long prompt", () => {
    // Kimi is the slowest provider here (live-timed at ~10-18 minutes for one
    // plan review against a one-hour process cap), so a timed-out run is
    // disproportionately expensive to redo from scratch. Declaring
    // conversationResume makes Ensemble's own RUN_TIMEOUT_MS path
    // retry-eligible (cliAgentRunner keys that solely off the field being
    // defined) and makes the retry send only continuationPrompt with
    // --continue, preserving partial edits.
    const kimi = getCliProvider("kimi-cli");
    assert.ok(kimi, "expected kimi-cli provider definition");
    assert.ok(kimi.conversationResume, "expected kimi-cli to declare conversationResume");

    // Deliberately empty: no Kimi-owned RECOVERABLE diagnostic has been
    // observed. Every failure captured live is terminal (bad model alias,
    // rejected effort, missing session), and a marker matching one of those
    // would trade a clean failure for a pointless second full-length run.
    // The timeout path needs no marker. See the field's comment before
    // adding one.
    assert.deepStrictEqual(kimi.conversationResume.errorMarkers, []);
    assert.ok(
      kimi.conversationResume.continuationPrompt.length > 0,
      "a resumed run still needs a continuation prompt to send"
    );

    const promptFile = "/tmp/ensemble-kimi-prompt.txt";
    const fresh = kimi.buildArgs("text", "kimi-code/k3", undefined, { promptFile });
    assert.ok(
      !fresh.includes("--continue"),
      "a first attempt must not continue a previous conversation"
    );

    const resumed = kimi.buildArgs("text", "kimi-code/k3", undefined, {
      promptFile,
      resumePreviousConversation: true,
    });
    assert.ok(resumed.includes("--continue"), "a resumed attempt must pass --continue");
    // Verified live that --continue coexists with -p (unlike --yolo/--auto/
    // --plan, which the CLI rejects outright alongside it), so the rest of
    // the vector must stay intact.
    assert.deepStrictEqual(resumed, [
      "--output-format",
      "stream-json",
      "--continue",
      "-m",
      "kimi-code/k3",
      "-p",
      resumed[resumed.length - 1],
    ]);
  });

  void it("Codex model variants map to base model plus reasoning config", () => {
    const codex = getCliProvider("codex-cli");
    assert.ok(codex, "expected codex-cli provider definition");

    const parsed = parseCodexModelSelection("gpt-5.6-terra@ultra+fast");
    assert.deepStrictEqual(parsed, {
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
      serviceTier: "priority",
    });

    const textArgs = codex.buildArgs(
      "text",
      "gpt-5.6-terra@ultra+fast",
      "/tmp/codex-last-message.md"
    );
    assert.deepStrictEqual(textArgs, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--sandbox",
      "read-only",
      "--model",
      "gpt-5.6-terra",
      "-c",
      'model_reasoning_effort="ultra"',
      "-c",
      'service_tier="priority"',
      "--output-last-message",
      "/tmp/codex-last-message.md",
      "-",
    ]);

    const editArgs = codex.buildArgs(
      "edit",
      undefined,
      undefined,
      { cwd: "/workspace/project" }
    );
    assert.deepStrictEqual(editArgs, [
      "exec",
      "--json",
      "--skip-git-repo-check",
      "--color",
      "never",
      "--cd",
      "/workspace/project",
      "--sandbox",
      "workspace-write",
      "-",
    ]);

    assert.ok(
      !editArgs.includes("--dangerously-bypass-approvals-and-sandbox"),
      "Codex implementation runs must always remain sandboxed"
    );
  });

  void it("Copilot model variants map to base model plus reasoning and context config", () => {
    const parsed = parseCopilotModelSelection("gpt-5.6-terra@ultra+long");
    assert.deepStrictEqual(parsed, {
      model: "gpt-5.6-terra",
      reasoningEffort: "ultra",
      contextWindow: "long",
    });
  });

  void it("Claude model variants map to base model plus thinking budget", () => {
    const claude = getCliProvider("claude-cli");
    assert.ok(claude, "expected claude-cli provider definition");

    const textArgs = claude.buildArgs("text", "sonnet@high", undefined);
    assert.deepStrictEqual(textArgs, [
      "-p",
      "--output-format",
      "text",
      "--permission-mode",
      "plan",
      "--append-system-prompt",
      CLAUDE_CLI_HEADLESS_PLAN_MODE_SYSTEM_PROMPT,
      "--model",
      "sonnet",
      "--max-thinking-tokens",
      "8192",
    ]);
  });

  void it("Cline model variants map to base model plus thinking effort; prompt is stdin-only", () => {
    const cline = getCliProvider("cline-cli");
    assert.ok(cline, "expected cline-cli provider definition");

    assert.strictEqual(cline.promptTransport, "stdin");
    assert.strictEqual(cline.structuredEventStream, "cline");

    const parsed = parseClineModelSelection("cline-pass/deepseek-v4-pro@high");
    assert.deepStrictEqual(parsed, {
      model: "cline-pass/deepseek-v4-pro",
      reasoningEffort: "high",
    });

    // An unrecognized suffix is not a reasoning effort — the whole string is
    // kept as the model, mirroring Codex/Copilot's own fallback.
    assert.deepStrictEqual(parseClineModelSelection("cline-pass/glm-5.2@bogus"), {
      model: "cline-pass/glm-5.2@bogus",
      reasoningEffort: undefined,
    });

    // Cline's ladder (none/low/medium/high/xhigh) is deliberately NARROWER
    // than Codex's/Copilot's (which also accept "max"/"ultra") — a suffix
    // valid on those sibling ladders must still be rejected here, not just
    // an arbitrary nonsense one (which wouldn't catch an accidental
    // copy-paste widening of CLINE_REASONING_EFFORTS to match them).
    for (const foreignEffort of ["max", "ultra"]) {
      assert.deepStrictEqual(
        parseClineModelSelection(`cline-pass/glm-5.2@${foreignEffort}`),
        { model: `cline-pass/glm-5.2@${foreignEffort}`, reasoningEffort: undefined },
        `"${foreignEffort}" is valid for Codex/Copilot but must not be for Cline`
      );
    }

    // No --cwd argv flag, even when the context supplies one: cwd is
    // provided to the child process via spawn()'s own `cwd` option, never
    // through a shell-parsed argument — see the buildArgs comment in
    // providers.ts for why (a workspace path containing a shell
    // metacharacter would otherwise be misparsed or worse, since this
    // provider's Windows spawn goes through shell:true with only
    // space-wrapping, not full escaping).
    const textArgs = cline.buildArgs(
      "text",
      "cline-pass/deepseek-v4-pro@high",
      undefined,
      { cwd: "/workspace/project", promptFile: "/tmp/prompt.txt" }
    );
    assert.deepStrictEqual(textArgs, [
      "--json",
      "--plan",
      "-P",
      "cline-pass",
      "-m",
      "cline-pass/deepseek-v4-pro",
      "--thinking",
      "high",
      CLINE_CLI_ARGV_PROMPT_PLACEHOLDER,
    ]);
    assert.ok(
      !textArgs.includes("--cwd"),
      "cline's buildArgs must never pass cwd through argv"
    );

    const editArgs = cline.buildArgs("edit", undefined, undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(editArgs, [
      "--json",
      "--auto-approve",
      "true",
      "-P",
      "cline-pass",
      CLINE_CLI_ARGV_PROMPT_PLACEHOLDER,
    ]);

    // The fixed placeholder is never derived from user content, and the
    // real prompt is delivered via stdin instead (promptTransport above) —
    // this is what makes it safe to also pass a positional argv element
    // despite `useShell` staying at its default `true` (required so
    // Windows resolves cline's npm .cmd shim). See
    // CLINE_CLI_ARGV_PROMPT_PLACEHOLDER's doc comment in providers.ts.
    assert.notStrictEqual(cline.useShell, false);
  });

  void it("round-trips a seeded Cline model id that itself contains a colon", () => {
    // "poolside/laguna-m.1:free" (one of the seeded ClinePass free models —
    // see createSeededClineModels in modelSelection.ts) is the only seeded
    // model id anywhere in this codebase with an embedded colon. Storage
    // uses "<provider>:<model>" with a FIRST-colon split (parseModelSelection)
    // — pin that this specific real id, and its "@high"-suffixed variant,
    // survive that split intact rather than being truncated at the model's
    // own colon.
    const cline = getCliProvider("cline-cli");
    assert.ok(cline, "expected cline-cli provider definition");

    const bare = parseModelSelection("cline-cli:poolside/laguna-m.1:free");
    assert.strictEqual(bare.provider, "cline-cli");
    assert.strictEqual(bare.model, "poolside/laguna-m.1:free");

    const withEffort = parseModelSelection("cline-cli:poolside/laguna-m.1:free@high");
    assert.strictEqual(withEffort.provider, "cline-cli");
    assert.strictEqual(withEffort.model, "poolside/laguna-m.1:free@high");

    const parsedEffort = parseClineModelSelection(withEffort.model);
    assert.deepStrictEqual(parsedEffort, {
      model: "poolside/laguna-m.1:free",
      reasoningEffort: "high",
    });

    const args = cline.buildArgs("text", withEffort.model, undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    const modelIndex = args.indexOf("-m");
    assert.ok(modelIndex >= 0, "expected -m flag in cline's buildArgs output");
    assert.strictEqual(args[modelIndex + 1], "poolside/laguna-m.1:free");
  });

  void it("provider-qualified CLI selections pass only native model names to buildArgs", () => {
    const cases: Array<{
      storedId: string;
      expectedProvider: string;
      expectedModelArg: string | undefined;
    }> = [
      {
        storedId: "claude-cli:opus@max",
        expectedProvider: "claude-cli",
        expectedModelArg: "opus",
      },
      {
        storedId: "codex-cli:gpt-5.6-terra@ultra+fast",
        expectedProvider: "codex-cli",
        expectedModelArg: "gpt-5.6-terra",
      },
      {
        storedId: "gemini-cli:gemini-2.5-pro",
        expectedProvider: "gemini-cli",
        expectedModelArg: "gemini-2.5-pro",
      },
      {
        // Legacy slug from before Antigravity's storage format switched to
        // the CLI's own display-name strings — must still resolve to a
        // model `agy --model` actually accepts, via legacyModelAliases.
        storedId: "antigravity-cli:gpt-oss-120b-medium",
        expectedProvider: "antigravity-cli",
        expectedModelArg: "GPT-OSS 120B (Medium)",
      },
      {
        // Current format: the model portion is agy's verbatim display name
        // (spaces and parens included) and must survive buildArgs as a
        // single --model argument, not be split on whitespace.
        storedId: "antigravity-cli:Gemini 3.5 Flash (Medium)",
        expectedProvider: "antigravity-cli",
        expectedModelArg: "Gemini 3.5 Flash (Medium)",
      },
      {
        storedId: "kiro-cli:claude-opus-4.6",
        expectedProvider: "kiro-cli",
        expectedModelArg: "claude-opus-4.6",
      },
      {
        storedId: "antigravity-cli:default",
        expectedProvider: "antigravity-cli",
        expectedModelArg: undefined,
      },
      {
        storedId: "kiro-cli:default",
        expectedProvider: "kiro-cli",
        expectedModelArg: undefined,
      },
    ];

    for (const testCase of cases) {
      const parsed = parseModelSelection(testCase.storedId);
      assert.strictEqual(parsed.provider, testCase.expectedProvider);
      const provider = getCliProvider(parsed.provider);
      assert.ok(provider, `expected ${parsed.provider} provider definition`);

      const args = buildTextArgs(provider, parsed.model);
      assert.strictEqual(
        modelArgValue(args),
        testCase.expectedModelArg,
        testCase.storedId
      );
      assert.ok(
        !args.some((arg) => arg.startsWith(`${testCase.expectedProvider}:`)),
        `${testCase.storedId} leaked its storage prefix into CLI args`
      );
    }
  });

  void it("sign-in actions use each CLI's validated auth entry point", () => {
    // Pinned to the commands validated against installed CLI versions on
    // 2026-07-17 (see the signInCommand/signInAction doc comments in
    // providers.ts). Changing a value here requires re-validating against
    // that CLI. claude: `/login` is an IN-SESSION slash command — the CLI is
    // launched interactively and the slash command is then sent (never a
    // one-shot `claude /login` command line); kiro: logging out first allows
    // switching an already-signed-in account (`kiro-cli login` alone refuses
    // with "Already logged in").
    const validatedSignIns: Record<
      string,
      { command: string } | { launch: string; send: string }
    > = {
      "claude-cli": { launch: "claude", send: "/login" },
      "codex-cli": { command: "codex login" },
      "gemini-cli": { command: "gemini" },
      "antigravity-cli": { command: "agy" },
      "kiro-cli": { command: "kiro-cli logout; kiro-cli login" },
      "opencode-cli": { command: "opencode" },
      "cline-cli": { command: "cline auth cline-pass" },
      "kimi-cli": { command: "kimi login" },
      "devpass-cli": { command: "devpass-code providers login" },
    };

    for (const provider of CLI_PROVIDERS) {
      const expected = validatedSignIns[provider.id];
      assert.ok(
        expected !== undefined,
        `${provider.id} has no validated sign-in on record`
      );
      let executable: string;
      if ("launch" in expected) {
        assert.deepStrictEqual(
          provider.signInAction,
          { launch: expected.launch, send: expected.send, validated: "verified" },
          provider.id
        );
        assert.strictEqual(
          provider.signInCommand,
          undefined,
          `${provider.id} must not also carry a one-shot sign-in command line`
        );
        assert.ok(
          expected.send.startsWith("/"),
          `${provider.id} in-session sign-in must be a slash command`
        );
        executable = expected.launch;
      } else {
        assert.strictEqual(provider.signInCommand, expected.command, provider.id);
        assert.strictEqual(provider.signInAction, undefined, provider.id);
        executable = provider.signInCommand?.split(" ")[0] ?? "";
      }
      assert.ok(
        [provider.command, ...(provider.commandAliases ?? [])].includes(
          executable
        ),
        `${provider.id} sign-in must launch the provider's own executable`
      );
      assert.ok(
        provider.signInLabel.length > 0,
        `${provider.id} sign-in action needs a label`
      );
    }

    const claude = getCliProvider("claude-cli");
    assert.ok(claude);
    // Re-running the sign-in flow while already authenticated is how a user
    // switches accounts for CLIs with no dedicated logout/switch command.
    assert.strictEqual(claude.signInLabel, "Sign in / Switch account");

    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro);
    assert.match(kiro.signInGuidance ?? "", /KIRO_API_KEY/);
  });

  void it("Copilot sign-in is VS Code-native, never a shell command", () => {
    // Copilot auth is the GitHub account VS Code itself is signed into —
    // there is no CLI login for it. The sign-in button must go through the
    // candidate command lists (newest-first, first REGISTERED one wins —
    // see ProviderSignInAction's doc comment), and must never launch a
    // terminal command.
    const copilot = getProviderAccountEntry("copilot");
    assert.ok(copilot, "expected a copilot provider-account entry");
    assert.strictEqual(copilot.signIn.kind, "vscode-command");
    if (copilot.signIn.kind === "vscode-command") {
      assert.ok(
        copilot.signIn.commands.includes("github.copilot.chat.triggerPermissiveSignIn"),
        "expected the current Copilot Chat sign-in command among the candidates"
      );
      assert.ok(
        copilot.signIn.commands.includes("github.copilot.signIn"),
        "expected the legacy Copilot sign-in command among the candidates"
      );
      assert.ok(
        copilot.signIn.fallbackCommands.includes("workbench.action.manageAccounts"),
        "expected the current Accounts-menu command among the fallback candidates"
      );
      assert.ok(
        copilot.signIn.fallbackCommands.includes("workbench.action.showAccounts"),
        "expected the legacy Accounts-menu command among the fallback candidates"
      );
    }
    assert.strictEqual(copilot.enabledByDefault, true);

    // Every regular CLI provider's account entry carries its validated sign-in:
    // an interactive launch-then-send dispatch when the login surface is an
    // in-session slash command (Claude), otherwise a terminal action with
    // the validated command line.
    for (const entry of PROVIDER_ACCOUNT_ENTRIES) {
      if (entry.id === "copilot" || entry.id === "opencode-zen" || entry.id === "opencode-go") continue;
      const cli = getCliProvider(entry.id);
      assert.ok(cli, `expected CLI definition for ${entry.id}`);
      if (cli.signInAction) {
        assert.strictEqual(entry.signIn.kind, "interactive", entry.id);
        if (entry.signIn.kind === "interactive") {
          assert.strictEqual(entry.signIn.launch, cli.signInAction.launch, entry.id);
          assert.strictEqual(entry.signIn.send, cli.signInAction.send, entry.id);
        }
      } else {
        assert.strictEqual(entry.signIn.kind, "terminal", entry.id);
        if (entry.signIn.kind === "terminal") {
          assert.strictEqual(entry.signIn.command, cli.signInCommand, entry.id);
        }
      }
    }
  });

  void it("orders Provider Selection with devpass-code first and Antigravity last", () => {
    assert.strictEqual(
      PROVIDER_ACCOUNT_ENTRIES[0]?.id,
      "devpass-cli",
      "devpass-code leads Provider Selection"
    );
    assert.strictEqual(
      PROVIDER_ACCOUNT_ENTRIES[PROVIDER_ACCOUNT_ENTRIES.length - 1]?.id,
      "antigravity-cli",
      "Antigravity stays last"
    );
  });

  void it("provider account entries carry the usage capability matrix", () => {
    // The capability descriptor is the single source of truth for both the
    // UI button state and dispatch behavior. Usage surfaces are IN-SESSION
    // slash commands, so the interactive kind launches the CLI and then
    // sends the slash command into the running session — never a one-shot
    // command line. Only VERIFIED descriptors are automated OR even offered
    // as a manual fallback: an unverified one (Gemini's /stats model,
    // Antigravity's /usage) renders a DISABLED button ("unsupported", no
    // url) rather than a nonfunctional "try this in a terminal" suggestion —
    // per the approved capability matrix, an unconfirmed action must not
    // ship as if it works. Copilot/Kiro usage is likewise "unsupported" (no
    // command reports their quota at all); unsupported renders a disabled
    // button with the reason (or an enabled link-out button when a url is
    // present).
    const expectations: Record<
      string,
      { kind: string; launch?: string; send?: string }
    > = {
      copilot: { kind: "unsupported" },
      // Claude's usage check is a one-shot `claude -p "/usage"` terminal
      // command, not a launch-then-send interactive session — see
      // usageCommand on the claude-cli provider definition.
      "claude-cli": { kind: "terminal" },
      "codex-cli": { kind: "interactive", launch: "codex", send: "/status" },
      "gemini-cli": { kind: "unsupported" },
      "antigravity-cli": { kind: "unsupported" },
      // Kiro's usage check pipes "/usage" into `kiro-cli chat` as a one-shot
      // terminal command — see usageCommand on the kiro-cli provider definition.
      "kiro-cli": { kind: "terminal" },
      "opencode-zen": { kind: "unsupported" },
      "opencode-go": { kind: "unsupported" },
      "cline-cli": { kind: "unsupported" },
      // Kimi Code CLI has no non-interactive usage/quota subcommand at all
      // (verified against its full --help command list) — see
      // usageUnsupportedReason on the kimi-cli provider definition.
      "kimi-cli": { kind: "unsupported" },
      // devpass-code has no non-interactive quota/entitlement command —
      // `devpass-code stats` only reports local observed usage, not
      // remaining LLM Gateway DevPass quota — see usageUnsupportedReason on
      // the devpass-cli provider definition.
      "devpass-cli": { kind: "unsupported" },
    };
    for (const entry of PROVIDER_ACCOUNT_ENTRIES) {
      const expected = expectations[entry.id];
      assert.ok(expected, `${entry.id} has no usage-capability expectation on record`);
      assert.strictEqual(entry.usage.kind, expected.kind, entry.id);
      if (entry.usage.kind === "interactive") {
        assert.strictEqual(entry.usage.launch, expected.launch, entry.id);
        assert.strictEqual(entry.usage.send, expected.send, entry.id);
        assert.ok(
          entry.usage.send.startsWith("/"),
          `${entry.id} usage must be an in-session slash command`
        );
        // Only descriptors verified against an installed CLI may automate.
        assert.strictEqual(entry.usage.validated, "verified", entry.id);
      }
      if (entry.usage.kind === "terminal") {
        assert.ok(entry.usage.command.length > 0, `${entry.id} terminal usage needs a command`);
        assert.strictEqual(entry.usage.validated, "verified", entry.id);
      }
      if (entry.usage.kind === "unsupported") {
        assert.ok(entry.usage.reason.length > 0, `${entry.id} unsupported usage needs a reason`);
      }
      if (entry.id === "opencode-zen" || entry.id === "opencode-go") {
        assert.match(entry.signInLabel, /^Connect OpenCode /, entry.id);
      } else {
        // Re-running the same flow while already authenticated is how a user
        // switches accounts for the ordinary CLI provider rows.
        assert.strictEqual(entry.signInLabel, "Sign in / Switch account", entry.id);
      }
    }

    // Gemini's /stats invocation follows the CLI's documented slash-command
    // surface but has not been re-confirmed against an installed binary —
    // its descriptor stays "unverified", so the account entry renders a
    // DISABLED usage button (no url) rather than a nonfunctional suggestion.
    const geminiCli = getCliProvider("gemini-cli");
    assert.ok(geminiCli?.usageAction);
    assert.strictEqual(geminiCli.usageAction.validated, "unverified");
    const gemini = getProviderAccountEntry("gemini-cli");
    assert.ok(gemini);
    assert.ok(gemini.usage.kind === "unsupported");
    assert.strictEqual(gemini.usage.url, undefined, "unverified usage must not resolve to an enabled button");
    assert.match(gemini.usage.reason, /gemini/);
    const claude = getProviderAccountEntry("claude-cli");
    assert.ok(claude);
    assert.ok(claude.usage.kind === "terminal");
    assert.strictEqual(claude.usage.validated, "verified");
    assert.match(claude.usage.command, /claude -p "\/usage"/);
    assert.strictEqual(claude.usage.shell, "powershell.exe");

    // Copilot's unsupported reason still tells the user where usage lives,
    // and its button opens that page directly instead of staying disabled.
    const copilot = getProviderAccountEntry("copilot");
    assert.ok(copilot);
    assert.ok(copilot.usage.kind === "unsupported");
    assert.match(copilot.usage.reason, /github\.com\/settings\/copilot/);
    assert.strictEqual(copilot.usage.url, "https://github.com/settings/copilot");

    // Kiro's usage check pipes "/usage" into `kiro-cli chat` as a one-shot
    // terminal command.
    const kiroEntry = getProviderAccountEntry("kiro-cli");
    assert.ok(kiroEntry);
    assert.ok(kiroEntry.usage.kind === "terminal");
    assert.strictEqual(kiroEntry.usage.command, 'echo "/usage" | kiro-cli chat');

    // Antigravity's /usage invocation follows the CLI's documented
    // slash-command surface but has not been re-confirmed against an
    // installed binary — its descriptor stays "unverified", so its account
    // entry renders a DISABLED usage button too, the same treatment as
    // Gemini's /stats (no unverified provider may resolve to an enabled
    // button anywhere).
    const antigravityCli = getCliProvider("antigravity-cli");
    assert.ok(antigravityCli?.usageAction);
    assert.strictEqual(antigravityCli.usageAction.validated, "unverified");
    const antigravity = getProviderAccountEntry("antigravity-cli");
    assert.ok(antigravity);
    assert.ok(antigravity.usage.kind === "unsupported");
    assert.strictEqual(antigravity.usage.url, undefined, "unverified usage must not resolve to an enabled button");
    assert.match(antigravity.usage.reason, /agy/);

    // Zen and Go each report their own entitlement in the OpenCode account,
    // but neither has a safe non-interactive status command. Their buttons
    // therefore stay disabled with tier-specific explanatory guidance.
    for (const accountId of ["opencode-zen", "opencode-go"] as const) {
      const opencodeEntry = getProviderAccountEntry(accountId);
      assert.ok(opencodeEntry);
      assert.ok(opencodeEntry.usage.kind === "unsupported");
      assert.strictEqual(opencodeEntry.usage.url, undefined);
      assert.match(opencodeEntry.usage.reason, /opencode/i);
    }

    // Cline has no non-interactive usage command either, but links out to
    // the ClinePass billing/usage dashboard rather than leaving the button
    // dead — the same treatment as Kiro's account usage page.
    const clineEntry = getProviderAccountEntry("cline-cli");
    assert.ok(clineEntry);
    assert.ok(clineEntry.usage.kind === "unsupported");
    assert.strictEqual(
      clineEntry.usage.url,
      "https://app.cline.bot/dashboard/subscription"
    );
  });

  void it("Kiro hints mention KIRO_API_KEY requirement", () => {
    const kiro = getCliProvider("kiro-cli");
    assert.ok(kiro, "expected kiro-cli provider definition");

    assert.match(kiro.installHint, /KIRO_API_KEY/i);
    assert.match(kiro.loginHint, /KIRO_API_KEY/i);
  });

  void it("argv prompt transport providers require shell=false", () => {
    for (const provider of CLI_PROVIDERS) {
      if (provider.promptTransport === "argv") {
        assert.strictEqual(
          provider.useShell,
          false,
          `${provider.id} must set useShell=false when promptTransport=argv`
        );
      }
    }
  });

  void it("implementation prompts are provider-neutral for CLI agents", () => {
    for (const fileName of [
      "run-implementation.md",
      "apply-impl-review-code.md",
    ]) {
      const content = fs.readFileSync(
        path.join(process.cwd(), "resources", "prompts", fileName),
        "utf8"
      );

      assert.match(content, /CLI coding agent/);
      assert.match(content, /native shell, patch, and file-editing tools/);
      assert.match(content, /If you cannot write files, report that failure/);
      assert.doesNotMatch(
        content,
        /You have the following tools available:\s*\n\s*-\s*`read_file/
      );
    }
  });

  void it("does not expose a Codex sandbox-bypass setting", () => {
    const packageJson = JSON.parse(
      fs.readFileSync(path.join(process.cwd(), "package.json"), "utf8")
    ) as {
      contributes?: {
        configuration?: {
          properties?: Record<string, { default?: unknown; type?: string }>;
        };
      };
    };
    const setting =
      packageJson.contributes?.configuration?.properties?.[
        "vs-code-ai-helper.codexDangerouslyBypassSandboxForImplementation"
      ];

    assert.strictEqual(setting, undefined);
  });
});
