import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  CLI_PROVIDERS,
  getCliProvider,
  getProviderAccountEntry,
  parseCopilotModelSelection,
  parseCodexModelSelection,
  parseModelSelection,
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

    const textArgs = antigravity.buildArgs("text", undefined, undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(textArgs, [
      "--print=/tmp/prompt.txt",
      "--dangerously-skip-permissions",
    ]);

    const editArgs = antigravity.buildArgs("edit", "gemini-3-pro", undefined, {
      promptFile: "/tmp/prompt.txt",
    });
    assert.deepStrictEqual(editArgs, [
      "--print=/tmp/prompt.txt",
      "--dangerously-skip-permissions",
      "--model",
      "gemini-3-pro",
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
      if (bypassed.length === 0) {
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

    // Guard against the loop above passing vacuously: Antigravity is the
    // known exception and must actually be flagged, naming the real flag so
    // the warning means something to someone reading it.
    const antigravity = getCliProvider("antigravity-cli");
    assert.ok(
      antigravity?.permissionWarning,
      "expected Antigravity to carry a permission warning"
    );
    assert.match(
      antigravity.permissionWarning,
      /--dangerously-skip-permissions/
    );
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
      "--model",
      "sonnet",
      "--max-thinking-tokens",
      "8192",
    ]);
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

    // Every CLI provider's account entry carries its validated sign-in:
    // an interactive launch-then-send dispatch when the login surface is an
    // in-session slash command (Claude), otherwise a terminal action with
    // the validated command line.
    for (const entry of PROVIDER_ACCOUNT_ENTRIES) {
      if (entry.id === "copilot") continue;
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
      "claude-cli": { kind: "interactive", launch: "claude", send: "/usage" },
      "codex-cli": { kind: "interactive", launch: "codex", send: "/status" },
      "gemini-cli": { kind: "unsupported" },
      "antigravity-cli": { kind: "unsupported" },
      "kiro-cli": { kind: "unsupported" },
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
      if (entry.usage.kind === "unsupported") {
        assert.ok(entry.usage.reason.length > 0, `${entry.id} unsupported usage needs a reason`);
      }
      // Every provider's sign-in button reads "Sign in / Switch account":
      // re-running the same flow while already authenticated is how a user
      // switches accounts for CLIs with no dedicated logout/switch command.
      assert.strictEqual(entry.signInLabel, "Sign in / Switch account", entry.id);
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
    assert.ok(claude.usage.kind === "interactive");
    assert.strictEqual(claude.usage.validated, "verified");

    // Copilot's unsupported reason still tells the user where usage lives,
    // and its button opens that page directly instead of staying disabled.
    const copilot = getProviderAccountEntry("copilot");
    assert.ok(copilot);
    assert.ok(copilot.usage.kind === "unsupported");
    assert.match(copilot.usage.reason, /github\.com\/settings\/copilot/);
    assert.strictEqual(copilot.usage.url, "https://github.com/settings/copilot");

    // Kiro has no usage command either, but links out to its account usage
    // page rather than leaving the button dead.
    const kiroEntry = getProviderAccountEntry("kiro-cli");
    assert.ok(kiroEntry);
    assert.ok(kiroEntry.usage.kind === "unsupported");
    assert.strictEqual(kiroEntry.usage.url, "https://app.kiro.dev/account/usage");

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
