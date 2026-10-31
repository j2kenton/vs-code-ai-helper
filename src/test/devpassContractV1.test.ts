/**
 * bugs3 Step 14: devpass-code 1.x and 2.x. The 2.x shapes below are taken from
 * the owner's authorized 2026-10-28 capture of devpass-code 2.0.29 (`run
 * --help`, `api --standalone model.list`); the 1.x shapes are the original
 * 1.17/1.18 contract, which must keep working.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { __testOnly, resolveVersionedContractV1 } from "../runners/cliAgentRunner";
import { getCliProvider } from "../runners/providers";
import { parseCliMajorVersionV1 } from "../utils/cliMajorVersionV1";
import {
  DEVPASS_PROVIDER_ID_V1,
  discoverDevpassModelsWithTimeout,
  formatCliDiscoveryFailureV1,
  parseOpencodeApiModelListOutput,
  parseOpencodeModelsOutput,
  setCliDiscoveryFailureSinkV1,
  type CliDiscoveryFailureV1,
} from "../utils/cliModelDiscovery";

const { toFriendlyError } = __testOnly;
const devpass = getCliProvider("devpass-cli")!;

function modelEntry(providerID: string, id: string, variants: string[]): Record<string, unknown> {
  return {
    id,
    modelID: id,
    providerID,
    name: id,
    variants: variants.map((variant) => ({ id: variant, settings: { reasoningEffort: variant } })),
    cost: [{ input: 2, output: 10 }],
  };
}

/** The captured 2.x envelope: the same models under both provider aliases. */
function twoXCatalog(): string {
  return JSON.stringify({
    location: { directory: "<disposable-workspace>" },
    data: [
      modelEntry("llmgateway", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
      modelEntry("llmgateway-devpass", "claude-opus-5-5", ["low", "medium", "high", "xhigh", "max"]),
      modelEntry("llmgateway-devpass", "kimi-k3.1-pro", ["low", "medium", "high"]),
      modelEntry("llmgateway-devpass", "plain-model", []),
    ],
  });
}

void describe("devpass-code version detection", () => {
  void it("reads the major from both CLI generations' --version text", () => {
    assert.equal(parseCliMajorVersionV1("1.18.11\n"), 1);
    assert.equal(parseCliMajorVersionV1("devpass-code v2.0.29"), 2);
    assert.equal(parseCliMajorVersionV1("no version here"), undefined);
  });

  void it("accepts 1.x and 2.x, falls back when unreadable, and names an unsupported major", async () => {
    assert.deepEqual(await resolveVersionedContractV1(devpass, () => Promise.resolve(1)), { cliMajorVersion: 1 });
    assert.deepEqual(await resolveVersionedContractV1(devpass, () => Promise.resolve(2)), { cliMajorVersion: 2 });
    assert.deepEqual(await resolveVersionedContractV1(devpass, () => Promise.resolve(undefined)), { cliMajorVersion: 2 });

    const refused = await resolveVersionedContractV1(devpass, () => Promise.resolve(3));
    assert.equal(refused.cliMajorVersion, undefined);
    assert.match(refused.refusal ?? "", /devpass-code is 3\.x/);
    assert.match(refused.refusal ?? "", /supports devpass-code 1\.x .*and 2\.x/);

    // A provider without a versioned contract is untouched.
    assert.deepEqual(await resolveVersionedContractV1(getCliProvider("codex-cli")!, () => Promise.resolve(9)), {});
  });
});

void describe("devpass-code run arguments", () => {
  void it("2.x: --standalone, and the variant rides on --model as #variant (no --variant)", () => {
    const args = devpass.buildArgs("edit", "llmgateway-devpass/claude-opus-5-5@high", { cliMajorVersion: 2 });
    assert.deepEqual(args.slice(0, 4), ["run", "--standalone", "--format", "json"]);
    assert.equal(args[args.indexOf("--model") + 1], "llmgateway-devpass/claude-opus-5-5#high");
    assert.ok(!args.includes("--variant"));
    assert.equal(args[args.indexOf("--agent") + 1], "build");
  });

  void it("2.x without a variant passes the bare model", () => {
    const args = devpass.buildArgs("text", "llmgateway-devpass/claude-opus-5-5", { cliMajorVersion: 2 });
    assert.equal(args[args.indexOf("--model") + 1], "llmgateway-devpass/claude-opus-5-5");
  });

  void it("1.x keeps the original shape: no --standalone, --variant separate", () => {
    const args = devpass.buildArgs("edit", "llmgateway-devpass/claude-opus-5-5@high", { cliMajorVersion: 1 });
    assert.deepEqual(args.slice(0, 3), ["run", "--format", "json"]);
    assert.ok(!args.includes("--standalone"));
    assert.equal(args[args.indexOf("--model") + 1], "llmgateway-devpass/claude-opus-5-5");
    assert.equal(args[args.indexOf("--variant") + 1], "high");
  });

  void it("2.x resume still pins the exact session", () => {
    const args = devpass.buildArgs("edit", "llmgateway-devpass/x", {
      cliMajorVersion: 2,
      resumePreviousConversation: true,
      resumeSessionId: "ses_123",
    });
    assert.equal(args[args.indexOf("--session") + 1], "ses_123");
    assert.throws(() =>
      devpass.buildArgs("edit", "llmgateway-devpass/x", { cliMajorVersion: 2, resumePreviousConversation: true })
    );
  });
});

void describe("devpass-code 2.x model catalog", () => {
  void it("keeps only llmgateway-devpass and each model's own variant ladder", () => {
    const models = parseOpencodeApiModelListOutput(twoXCatalog(), {
      providerID: DEVPASS_PROVIDER_ID_V1,
      priceTier: false,
    }).map((model) => model.model);
    assert.deepEqual(models, [
      "llmgateway-devpass/claude-opus-5-5",
      "llmgateway-devpass/claude-opus-5-5@low",
      "llmgateway-devpass/claude-opus-5-5@medium",
      "llmgateway-devpass/claude-opus-5-5@high",
      "llmgateway-devpass/claude-opus-5-5@xhigh",
      "llmgateway-devpass/claude-opus-5-5@max",
      "llmgateway-devpass/kimi-k3.1-pro",
      "llmgateway-devpass/kimi-k3.1-pro@low",
      "llmgateway-devpass/kimi-k3.1-pro@medium",
      "llmgateway-devpass/kimi-k3.1-pro@high",
      "llmgateway-devpass/plain-model",
    ]);
  });

  void it("does not label devpass models with an OpenCode price tier", () => {
    const withTier = parseOpencodeApiModelListOutput(twoXCatalog(), { providerID: DEVPASS_PROVIDER_ID_V1 });
    const withoutTier = parseOpencodeApiModelListOutput(twoXCatalog(), {
      providerID: DEVPASS_PROVIDER_ID_V1,
      priceTier: false,
    });
    assert.ok(withTier.some((model) => model.priceTierV1 !== undefined));
    assert.ok(withoutTier.every((model) => model.priceTierV1 === undefined));
  });

  void it("yields nothing for an empty success, malformed or truncated JSON", () => {
    const options = { providerID: DEVPASS_PROVIDER_ID_V1 };
    assert.deepEqual(parseOpencodeApiModelListOutput('{"location":{},"data":[]}', options), []);
    assert.deepEqual(parseOpencodeApiModelListOutput("not json", options), []);
    const full = twoXCatalog();
    assert.deepEqual(parseOpencodeApiModelListOutput(full.slice(0, Math.floor(full.length / 2)), options), []);
  });

  void it("the 1.x verbose parser still reads Windows line endings", () => {
    const verbose =
      'llmgateway-devpass/claude-opus-5-5\r\n{"id":"claude-opus-5-5","providerID":"llmgateway-devpass","name":"Claude Opus 5.5","variants":{"low":{},"high":{}}}\r\n';
    const models = parseOpencodeModelsOutput(verbose).map((model) => model.model);
    assert.deepEqual(models, [
      "llmgateway-devpass/claude-opus-5-5",
      "llmgateway-devpass/claude-opus-5-5@low",
      "llmgateway-devpass/claude-opus-5-5@high",
    ]);
  });
});

function fakeCli(script: string): { command: string; dispose: () => void } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "fake-devpass-"));
  const command = path.join(dir, "devpass-code");
  fs.writeFileSync(command, `#!/usr/bin/env node\n${script}\n`, { mode: 0o755 });
  return { command, dispose: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

void describe("devpass-code discovery command", { skip: process.platform === "win32" }, () => {

  void it("2.x: runs api --standalone model.list and receives output past the 262,144-byte pipe limit", async () => {
    // A catalog well over 262,144 bytes, written in one go and then exiting —
    // the shape that was truncated when stdout was a pipe.
    const padding = Array.from({ length: 3000 }, (_, i) => modelEntry("llmgateway", `filler-model-${i}-${"x".repeat(80)}`, ["low"]));
    const catalog = JSON.parse(twoXCatalog()) as { data: unknown[] };
    catalog.data.push(...padding);
    const body = JSON.stringify(catalog);
    assert.ok(body.length > 262_144);
    const { command, dispose } = fakeCli(
      `const args = process.argv.slice(2).join(" ");
if (args !== "api --standalone model.list") { process.stderr.write("unexpected args: " + args); process.exit(2); }
process.stdout.write(${JSON.stringify(body)});`
    );
    try {
      const models = await discoverDevpassModelsWithTimeout(command, 20_000, () => Promise.resolve(2));
      assert.equal(models.length, 11);
      assert.ok(models.every((model) => model.model.startsWith("llmgateway-devpass/")));
    } finally {
      dispose();
    }
  });

  void it("2.x: a response cut off mid-JSON is a failed discovery, not a partial catalog", async () => {
    const full = twoXCatalog();
    const { command, dispose } = fakeCli(`process.stdout.write(${JSON.stringify(full.slice(0, 200))});`);
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 20_000, () => Promise.resolve(2)), []);
    } finally {
      dispose();
    }
  });

  void it("1.x: still runs models --verbose", async () => {
    const { command, dispose } = fakeCli(
      `if (process.argv.slice(2).join(" ") !== "models --verbose") process.exit(2);
process.stdout.write('llmgateway-devpass/a\\n{"id":"a","providerID":"llmgateway-devpass","name":"A","variants":{"high":{}}}\\n');`
    );
    try {
      const models = await discoverDevpassModelsWithTimeout(command, 20_000, () => Promise.resolve(1));
      assert.deepEqual(
        models.map((model) => model.model),
        ["llmgateway-devpass/a", "llmgateway-devpass/a@high"]
      );
    } finally {
      dispose();
    }
  });
});

void describe("devpass-code run and discovery agree on the contract", { skip: process.platform === "win32" }, () => {
  const argsScript = `process.stdout.write(process.argv.slice(2).join(" ") === "api --standalone model.list"
  ? ${JSON.stringify(twoXCatalog())} : "");`;

  void it("an unreadable version selects 2.x for the run AND for discovery", async () => {
    const run = await resolveVersionedContractV1(devpass, () => Promise.resolve(undefined));
    assert.equal(run.cliMajorVersion, 2);
    const { command, dispose } = fakeCli(argsScript);
    try {
      const models = await discoverDevpassModelsWithTimeout(command, 20_000, () => Promise.resolve(undefined));
      assert.ok(models.length > 0, "discovery used the 2.x command, as the run does");
    } finally {
      dispose();
    }
  });

  void it("an unsupported major is refused by discovery too, with the supported-version remedy", async () => {
    const failures: CliDiscoveryFailureV1[] = [];
    setCliDiscoveryFailureSinkV1((failure) => failures.push(failure));
    const { command, dispose } = fakeCli(argsScript);
    try {
      assert.deepEqual(await discoverDevpassModelsWithTimeout(command, 20_000, () => Promise.resolve(3)), []);
    } finally {
      setCliDiscoveryFailureSinkV1(undefined);
      dispose();
    }
    assert.equal(failures.length, 1);
    assert.equal(failures[0]!.reason, "unsupportedVersion");
    assert.match(failures[0]!.stderrHead, /devpass-code is 3\.x/);
    assert.match(failures[0]!.stderrHead, /npm i -g devpass-code@2\.0\.29/);
    assert.match(formatCliDiscoveryFailureV1(failures[0]!), /not supported/);

    // The run path refuses with the identical text.
    const refused = await resolveVersionedContractV1(devpass, () => Promise.resolve(3));
    assert.equal(refused.refusal, failures[0]!.stderrHead);
  });
});

void describe("devpass-code background-service port conflict", () => {
  void it("names `devpass-code service set port <n>` instead of the raw error", () => {
    const stderr = [
      "Error: Managed service port 49374 on 127.0.0.1 is already in use",
      "    at startManagedService (file:///opt/devpass/service.js:120:11)",
      "    at async run (file:///opt/devpass/run.js:44:3)",
    ].join("\n");
    const friendly = toFriendlyError(devpass, "llmgateway-devpass/x", 1, stderr, "");
    assert.match(friendly.message, /devpass-code service set port <n>/);
    assert.doesNotMatch(friendly.message, /startManagedService|file:\/\//);
    assert.equal(friendly.authFailure, false);
  });

  void it("leaves other devpass failures alone", () => {
    const friendly = toFriendlyError(devpass, "llmgateway-devpass/x", 1, "Error: boom", "");
    assert.doesNotMatch(friendly.message, /service set port/);
  });
});
