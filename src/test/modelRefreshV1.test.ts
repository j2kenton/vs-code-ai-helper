/**
 * bugs3 Step 10: "Refresh models" re-runs every provider's discovery without a
 * reload, each provider's outcome is kept (live, or the built-in list with the
 * reason the live one is unavailable), a failed discovery never wipes the list
 * the picker already had, and a viewer window — which has no startup warm-up —
 * discovers on demand when AI Models opens.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, beforeEach, describe, it } from "node:test";

import { CLI_PROVIDERS } from "../runners/providers";
import {
  clearCliDiscoveryFailuresV1,
  describeCliDiscoveryFailureReasonV1,
  discoverKiroModelsWithTimeout,
  latestCliDiscoveryFailureV1,
  type CliDiscoveryFailureV1,
  type DiscoveredCliModel,
} from "../utils/cliModelDiscovery";
import {
  __testOnly,
  describeCliDiscoveryFallbackV1,
  getAvailableModels,
  getSeededCatalogForAudit,
  getCliDiscoveryStatusV1,
  hasUndiscoveredCliProvidersV1,
  refreshCliModelsV1,
} from "../utils/modelSelection";
import { describeProviderDiscoveryNoteV1, shouldDiscoverModelsOnDemandV1 } from "../views/settingsView";

interface MutableDefinition {
  command: string;
  commandAliases?: readonly string[];
  discoverModels?: (command: string) => Promise<readonly DiscoveredCliModel[]>;
}

type Stub = (command: string) => Promise<readonly DiscoveredCliModel[]>;

const KIRO = "kiro-cli";
const originals = new Map<string, MutableDefinition>();

/** Point every discoverable provider at this process's own executable, with the given stubs. */
function stubDiscovery(stubs: Readonly<Record<string, Stub>>, commands: Readonly<Record<string, string>> = {}): void {
  for (const def of CLI_PROVIDERS) {
    if (def.discoverModels === undefined) {
      continue;
    }
    const mutable = def as unknown as MutableDefinition;
    if (!originals.has(def.id)) {
      originals.set(def.id, { command: mutable.command, commandAliases: mutable.commandAliases, discoverModels: mutable.discoverModels });
    }
    mutable.command = commands[def.id] ?? process.execPath;
    mutable.commandAliases = [];
    mutable.discoverModels = stubs[def.id] ?? ((): Promise<readonly DiscoveredCliModel[]> => Promise.resolve([]));
  }
}

beforeEach(() => {
  __testOnly.restoreSeededCliModelCache();
  __testOnly.resetCliDiscoveryStatus();
  clearCliDiscoveryFailuresV1();
});

afterEach(() => {
  for (const def of CLI_PROVIDERS) {
    const original = originals.get(def.id);
    if (original !== undefined) {
      Object.assign(def as unknown as MutableDefinition, original);
    }
  }
  originals.clear();
  __testOnly.clearModelSelectionTestOverrides();
  __testOnly.restoreSeededCliModelCache();
  __testOnly.resetCliDiscoveryStatus();
  clearCliDiscoveryFailuresV1();
});

const model = (id: string): DiscoveredCliModel => ({ model: id, name: id.toUpperCase() });

void describe("Refresh models (bugs3 Step 10)", () => {
  void it("re-runs discovery without a reload: a list that grew after the window opened shows up", async () => {
    let live: DiscoveredCliModel[] = [model("alpha")];
    stubDiscovery({ [KIRO]: () => Promise.resolve(live) });
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(true),
    });
    await refreshCliModelsV1();
    const before = (await getAvailableModels(true)).map((entry) => entry.id);
    assert.ok(before.includes("kiro-cli:alpha"));
    assert.ok(!before.includes("kiro-cli:beta"));

    live = [model("alpha"), model("beta")];
    await refreshCliModelsV1();
    const after = (await getAvailableModels(true)).map((entry) => entry.id);
    assert.ok(after.includes("kiro-cli:beta"), "the model the CLI started listing after the window opened is offered");
    assert.equal(getCliDiscoveryStatusV1(KIRO)?.status, "live");
    assert.equal(describeCliDiscoveryFallbackV1(KIRO), undefined);
  });

  void it("reports every discoverable provider, one outcome each", async () => {
    stubDiscovery({ [KIRO]: () => Promise.resolve([model("alpha")]) });
    const outcomes = await refreshCliModelsV1();
    const discoverable = CLI_PROVIDERS.filter((def) => def.discoverModels !== undefined).map((def) => def.id);
    assert.deepEqual(outcomes.map((outcome) => outcome.providerId), discoverable);
    assert.equal(outcomes.find((outcome) => outcome.providerId === KIRO)?.status?.status, "live");
  });

  void it("one provider failing leaves the others live and keeps the list it already had", async () => {
    let fail = false;
    stubDiscovery({
      [KIRO]: () => Promise.resolve(fail ? [] : [model("alpha")]),
      "opencode-cli": () => Promise.resolve([{ model: "opencode-go/some-model", name: "Some" }]),
    });
    await refreshCliModelsV1();
    fail = true;
    await refreshCliModelsV1();
    assert.equal(getCliDiscoveryStatusV1(KIRO)?.status, "fallback");
    assert.equal(getCliDiscoveryStatusV1("opencode-cli")?.status, "live");
    // The list on screen is the earlier LIVE one, so the note must not call it the built-in list.
    const kept = describeCliDiscoveryFallbackV1(KIRO) ?? "";
    assert.match(kept, /^Showing the last live list \(captured .+\); refreshing it failed: /);
    assert.doesNotMatch(kept, /built-in/);
    __testOnly.setModelSelectionTestOverrides({
      getAvailableCopilotModels: () => Promise.resolve([]),
      cliCommandExists: () => Promise.resolve(true),
    });
    const ids = (await getAvailableModels(true)).map((entry) => entry.id);
    assert.ok(ids.includes("kiro-cli:alpha"), "the earlier list is kept, not emptied by a failed discovery");
  });

  void it("a CLI that is not on PATH names the command", async () => {
    stubDiscovery({}, { [KIRO]: "ensemble-no-such-cli-for-discovery" });
    await refreshCliModelsV1();
    const note = describeCliDiscoveryFallbackV1(KIRO);
    assert.match(note ?? "", /^Showing the built-in list; live list unavailable: /);
    assert.match(note ?? "", /`kiro-cli` was not found on PATH|`ensemble-no-such-cli-for-discovery`|was not found on PATH/);
  });

  void it("a discovery that failed names its own reason, from the logged failure", async () => {
    // This process's own executable stands in for the CLI: it rejects the Kiro arguments and exits non-zero.
    stubDiscovery({ [KIRO]: (command) => discoverKiroModelsWithTimeout(command, 10_000) });
    await refreshCliModelsV1();
    const status = getCliDiscoveryStatusV1(KIRO);
    assert.equal(status?.status, "fallback");
    assert.match(describeCliDiscoveryFallbackV1(KIRO) ?? "", /live list unavailable: the model listing (exited with code \d+|returned nothing Ensemble could read)/);
    assert.ok(latestCliDiscoveryFailureV1(process.execPath, 0) !== undefined, "the failure was logged for the diagnostic output");
  });

  void it("a failure from before this refresh is not blamed on it", async () => {
    stubDiscovery({ [KIRO]: (command) => discoverKiroModelsWithTimeout(command, 10_000) });
    await refreshCliModelsV1();
    const future = Date.now() + 60_000;
    assert.equal(latestCliDiscoveryFailureV1(process.execPath, future), undefined);
  });

  void it("an empty answer with no logged failure still says the listing returned nothing", async () => {
    stubDiscovery({ [KIRO]: () => Promise.resolve([]) });
    await refreshCliModelsV1();
    assert.match(describeCliDiscoveryFallbackV1(KIRO) ?? "", /the model listing returned no models/);
  });

  void it("the provider row note is the fallback line, and empty for a live, untried or CLI-less provider", async () => {
    stubDiscovery({ [KIRO]: () => Promise.resolve([]) }, {});
    assert.equal(describeProviderDiscoveryNoteV1(KIRO), "", "untried");
    await refreshCliModelsV1();
    assert.match(describeProviderDiscoveryNoteV1(KIRO), /Showing the built-in list/);
    stubDiscovery({ [KIRO]: () => Promise.resolve([model("alpha")]) });
    await refreshCliModelsV1();
    assert.equal(describeProviderDiscoveryNoteV1(KIRO), "", "live");
    assert.equal(describeProviderDiscoveryNoteV1(undefined), "", "Copilot has no CLI");
  });
});

void describe("built-in catalog (bugs3 Step 10)", () => {
  void it("the seeded OpenCode Go Kimi K3.1 Pro carries the low, high and max levels the CLI lists", () => {
    const seeded = getSeededCatalogForAudit().seeded["opencode-cli"] ?? [];
    const ids = seeded.map((entry) => entry.model);
    for (const level of ["low", "high", "max"]) {
      assert.ok(ids.includes(`opencode-go/kimi-k3.1-pro@${level}`), `opencode-go/kimi-k3.1-pro@${level} is seeded`);
    }
  });
});

void describe("failure reasons in plain words (bugs3 Step 10)", () => {
  const failure = (reason: CliDiscoveryFailureV1["reason"], extra: Partial<CliDiscoveryFailureV1> = {}): CliDiscoveryFailureV1 => ({
    provider: "opencode",
    command: "opencode api --standalone model.list",
    reason,
    stderrHead: "",
    ...extra,
  });

  void it("says what happened for each way discovery fails", () => {
    assert.equal(describeCliDiscoveryFailureReasonV1(failure("timeout")), "the model listing timed out");
    assert.equal(describeCliDiscoveryFailureReasonV1(failure("exit", { exitCode: 3 })), "the model listing exited with code 3");
    assert.equal(describeCliDiscoveryFailureReasonV1(failure("spawn")), "the CLI could not be started");
    assert.match(describeCliDiscoveryFailureReasonV1(failure("overflow")), /more output than the discovery limit/);
    assert.match(describeCliDiscoveryFailureReasonV1(failure("outputFile")), /temporary output file/);
    assert.match(describeCliDiscoveryFailureReasonV1(failure("noModels")), /returned nothing Ensemble could read/);
    assert.match(describeCliDiscoveryFailureReasonV1(failure("emptyCatalog")), /empty model list/);
  });

  void it("an unsupported version carries its remedy", () => {
    assert.equal(
      describeCliDiscoveryFailureReasonV1(failure("unsupportedVersion", { stderrHead: "This devpass-code is 3.x; install 2.0.29." })),
      "This devpass-code is 3.x; install 2.0.29."
    );
    assert.equal(describeCliDiscoveryFailureReasonV1(failure("unsupportedVersion")), "this CLI version is not supported");
  });
});

void describe("viewer windows discover on demand (bugs3 Step 10)", () => {
  void it("only a viewer, and only while a provider has not been asked", () => {
    assert.equal(shouldDiscoverModelsOnDemandV1("viewer", true), true);
    assert.equal(shouldDiscoverModelsOnDemandV1("viewer", false), false);
    assert.equal(shouldDiscoverModelsOnDemandV1("runner", true), false);
    assert.equal(shouldDiscoverModelsOnDemandV1("standalone", true), false);
  });

  void it("tracks which providers have been asked in this window", async () => {
    stubDiscovery({});
    assert.equal(hasUndiscoveredCliProvidersV1(), true);
    await refreshCliModelsV1();
    assert.equal(hasUndiscoveredCliProvidersV1(), false);
  });

  void it("bugs5 Step 28: Refresh models sits on its own line under the provider buttons, with a one-line note", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "views", "settingsView.ts"), "utf8");
    const saveButton = source.indexOf('id="save-providers-btn"');
    const discardButton = source.indexOf('id="discard-providers-btn"');
    const refreshButton = source.indexOf('id="refresh-models-btn"');
    const fieldsetEnd = source.indexOf("</fieldset>';", saveButton);
    assert.ok(discardButton > 0 && saveButton > discardButton, "Discard then Save keep their own row");
    assert.ok(refreshButton > saveButton && refreshButton < fieldsetEnd, "Refresh models is after Save, inside the section");
    // The provider row closes before Refresh models starts, so the row keeps only its own buttons.
    const providerRowEnd = source.indexOf("Save Provider Selection</button></div>");
    assert.ok(providerRowEnd > 0 && providerRowEnd < refreshButton);
    assert.match(
      source,
      /Re-reads the model lists from the AI tools installed on this machine\. Doesn\\\\'t change your saved choices or other machines\./
    );
    assert.match(source, /title="Ask every installed CLI for its current model list and update the pickers below, without reloading the window"/);
  });

  void it("wiring: opening AI Models discovers for a viewer, and the view offers Refresh models", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "views", "settingsView.ts"), "utf8");
    assert.match(source, /shouldDiscoverModelsOnDemandV1\(resolveEnsembleHostRoleV1\(\), hasUndiscoveredCliProvidersV1\(\)\)/);
    assert.match(source, /case "refreshModels":/);
    assert.match(source, /id="refresh-models-btn"/);
    const extension = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "extension.ts"), "utf8");
    const viewerReturn = extension.indexOf("Ensemble viewer: ${VIEWER_HOST_REFUSAL_MESSAGE_V1}");
    const warm = extension.indexOf("void warmCliModelCache();");
    assert.ok(viewerReturn > 0 && warm > viewerReturn, "a viewer still skips the blanket startup warm-up");
  });
});
