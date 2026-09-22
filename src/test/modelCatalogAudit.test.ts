import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { CLI_PROVIDERS, getCliProvider, providerAccountIdForModelId } from "../runners/providers";
import {
  AUDIT_BLOCKS,
  AUDIT_MANIFEST_RELATIVE_TAIL,
  AUDIT_PROVIDER_IDS,
  blockForSeedId,
  buildSeedBaseIdIndex,
  classifySeedCoverage,
  dispositionsFromManifest,
  findFreeAllowlistViolations,
  findFreeLabelViolations,
  findStatusSeedDisagreements,
  hasFreeMarker,
  loadAuditManifest,
  partitionSeedByBlock,
  resolveAuditManifestPath,
  splitBaseSelectionId,
  stripFreeMarker,
  toBaseSelectionId,
  validateAuditManifest,
  type AuditProviderId,
} from "../utils/modelCatalogAudit";
import { VERIFIED_FREE_MODEL_IDS, getSeededCatalogForAudit } from "../utils/modelSelection";
import { AUDIT_MANIFEST_PATH } from "./helpers/modelCatalogManifest";

type Json = Record<string, unknown>;

const SNAPSHOT = {
  command: "fixture models --verbose",
  cliVersion: "1.0.0",
  capturedAt: "2026-09-20",
  authContext: "fixture credential class",
  catalogAuthority: "context-only",
};

const EVIDENCE = {
  authContext: "fixture sign-in, standard tier",
  cliVersion: "1.0.0",
  source: "fixture models --verbose",
  date: "2026-09-20",
};

function pickerRecord(overrides: Json = {}): Json {
  return {
    provider: "claude-cli",
    scope: "picker",
    defaultAuthPath: "fixture default path",
    supportedPathClasses: ["fixture-class"],
    evidence: EVIDENCE,
    coverage: "entries",
    freeLabelsAudited: true,
    entries: [],
    ...overrides,
  };
}

function manifestWith(records: Json[], extra: Json = {}): Json {
  return {
    version: 1,
    auditDate: "2026-09-20",
    policy: "audit.md",
    providerContext: {},
    humanScopeWaivers: [],
    records,
    ...extra,
  };
}

function verified(id: string, extra: Json = {}): Json {
  return { id, status: "verified", checkedAt: "2026-09-20", source: "fixture", ...extra };
}

const FREE = { date: "2026-09-20", source: "fixture pricing page" };

const ZEN_RECORD_ENTRIES: Json[] = [
  verified("opencode/free-model", { free: FREE }),
  verified("opencode/claude-fable-5", { requiresCompanion: "opencode/claude-fable-5-1" }),
  { id: "opencode/claude-fable-5-1", status: "added", checkedAt: "2026-09-20", source: "fixture" },
  { id: "opencode/renamed", status: "relabelled", checkedAt: "2026-09-20", source: "fixture", note: "marker stripped" },
  { id: "opencode/conditional", status: "verified-conditional", checkedAt: "2026-09-20", source: "fixture", qualifier: "(API key only)" },
  { id: "opencode/absent", status: "unverified", reason: "absent from a context-only capture" },
  { id: "opencode/announced", status: "not-added", reason: "announced only" },
  {
    id: "opencode/retired",
    status: "removed",
    checkedAt: "2026-09-20",
    source: "fixture",
    removalEvidence: { kind: "documented-retirement", source: "fixture changelog", date: "2026-09-01" },
    savedSelection: { outcome: "preserve" },
  },
];

function zenSnapshotRecord(overrides: Json = {}): Json {
  return pickerRecord({
    provider: "opencode-cli",
    block: "opencode",
    coverage: "snapshot",
    snapshot: SNAPSHOT,
    entries: ZEN_RECORD_ENTRIES,
    ...overrides,
  });
}

void describe("audit manifest path", () => {
  void it("resolves to <repo root>/test-fixtures/model-catalog/audit-2026-09.json with no out segment", () => {
    let dir = __dirname;
    while (!fs.existsSync(path.join(dir, "package.json"))) {
      dir = path.dirname(dir);
    }
    assert.equal(AUDIT_MANIFEST_PATH, path.join(dir, "test-fixtures", "model-catalog", "audit-2026-09.json"));
    assert.ok(fs.existsSync(AUDIT_MANIFEST_PATH));
    assert.ok(!AUDIT_MANIFEST_PATH.split(path.sep).includes("out"));
    assert.deepEqual([...AUDIT_MANIFEST_RELATIVE_TAIL], ["test-fixtures", "model-catalog", "audit-2026-09.json"]);
  });

  void it("throws an error naming the start directory when no repository root is above it", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-path-"));
    try {
      assert.throws(() => resolveAuditManifestPath(tmp), (error: Error) => error.message.includes(tmp));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  void it("loads the checked-in manifest with the real allowlist", () => {
    const manifest = loadAuditManifest(AUDIT_MANIFEST_PATH, { freeAllowlist: VERIFIED_FREE_MODEL_IDS });
    assert.equal(manifest.policy, "test-fixtures/model-catalog/audit-2026-09.md");
    assert.ok(manifest.records.every((record) => AUDIT_BLOCKS[record.provider].some((b) => b.block === record.block)));
    for (const id of Object.keys(manifest.providerContext)) {
      assert.ok(splitBaseSelectionId(`${id}:x`), `providerContext id ${id} is a real provider`);
    }
  });
});

void describe("audit manifest loader", () => {
  void it("names the path for a missing file and for malformed JSON", () => {
    const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "audit-load-"));
    try {
      const missing = path.join(tmp, "missing.json");
      assert.throws(() => loadAuditManifest(missing), (e: Error) => e.message.includes("not found") && e.message.includes(missing));
      const bad = path.join(tmp, "bad.json");
      fs.writeFileSync(bad, "{ not json");
      assert.throws(() => loadAuditManifest(bad), (e: Error) => e.message.includes("not valid JSON") && e.message.includes(bad));
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true });
    }
  });

  /* eslint-disable @typescript-eslint/explicit-function-return-type -- one-line manifest builders in a table */
  const rejections: [string, () => unknown, RegExp][] = [
    ["an unknown status", () => manifestWith([pickerRecord({ entries: [verified("sonnet", { status: "great" })] })]), /claude-cli entry "sonnet".*unknown status/],
    ["a missing required field", () => manifestWith([pickerRecord({ entries: [{ id: "sonnet", status: "verified", checkedAt: "2026-09-20" }] })]), /claude-cli entry "sonnet".*missing required field "source"/],
    ["the provider name cline", () => manifestWith([pickerRecord({ provider: "cline" })]), /unknown provider "cline"/],
    ["the provider name opencode", () => manifestWith([pickerRecord({ provider: "opencode" })]), /unknown provider "opencode"/],
    ["an unknown block", () => manifestWith([zenSnapshotRecord({ block: "nope" })]), /opencode-cli record has unknown or missing block "nope"/],
    ["a block on a single-block provider", () => manifestWith([pickerRecord({ block: "default" })]), /claude-cli has a single block and its record must omit "block"/],
    ["a missing block on a multi-block provider", () => manifestWith([zenSnapshotRecord({ block: undefined })]), /opencode-cli record has unknown or missing block undefined/],
    ["a duplicate (provider, block) record", () => manifestWith([pickerRecord(), pickerRecord()]), /Duplicate audit record for claude-cli block "default"/],
    ["a picker record without evidence", () => manifestWith([pickerRecord({ evidence: undefined })]), /claude-cli block "default" is missing required field "evidence"/],
    ["evidence without a cliVersion", () => manifestWith([pickerRecord({ evidence: { ...EVIDENCE, cliVersion: "" } })]), /evidence is missing required string "cliVersion"/],
    ["evidence without a source", () => manifestWith([pickerRecord({ evidence: { ...EVIDENCE, source: undefined } })]), /evidence is missing required string "source"/],
    ["a picker record without a default auth path", () => manifestWith([pickerRecord({ defaultAuthPath: undefined })]), /is missing required field "defaultAuthPath"/],
    ["a picker record with empty path classes", () => manifestWith([pickerRecord({ supportedPathClasses: [] })]), /"supportedPathClasses" must be a non-empty array/],
    ["a picker record that disagrees with providerContext", () => manifestWith([pickerRecord()], { providerContext: { "claude-cli": { defaultAuthPath: "other", supportedPathClasses: ["fixture-class"] } } }), /disagree with providerContext for claude-cli/],
    ["a snapshot without a command", () => manifestWith([zenSnapshotRecord({ snapshot: { ...SNAPSHOT, command: undefined } })]), /snapshot is missing required string "command"/],
    ["a snapshot without a cliVersion", () => manifestWith([zenSnapshotRecord({ snapshot: { ...SNAPSHOT, cliVersion: undefined } })]), /snapshot is missing required string "cliVersion"/],
    ["a manifest with no providerContext", () => manifestWith([], { providerContext: undefined }), /missing required field "providerContext"/],
    ["a manifest with no humanScopeWaivers", () => manifestWith([], { humanScopeWaivers: undefined }), /missing required field "humanScopeWaivers"/],
    ["a manifest with no records", () => manifestWith([], { records: undefined }), /missing required field "records"/],
    ["a non-numeric version", () => manifestWith([], { version: "1" }), /"version" must be a positive integer/],
    ["a non-string auditDate", () => manifestWith([], { auditDate: 20260920 }), /"auditDate" must be a non-empty string/],
    ["a non-string policy", () => manifestWith([], { policy: { path: "x" } }), /"policy" must be a non-empty string/],
    ["a non-array humanScopeWaivers", () => manifestWith([], { humanScopeWaivers: {} }), /"humanScopeWaivers" must be an array/],
    ["a non-object providerContext", () => manifestWith([], { providerContext: [] }), /"providerContext" must be an object/],
    ["a duplicate entry id", () => manifestWith([pickerRecord({ entries: [verified("sonnet"), verified("sonnet")] })]), /lists entry id "sonnet" twice/],
    ["an entry id with a provider prefix", () => manifestWith([pickerRecord({ entries: [verified("claude-cli:sonnet")] })]), /claude-cli entry "claude-cli:sonnet".*provider prefix/],
    ["an entry id with an @effort suffix", () => manifestWith([pickerRecord({ entries: [verified("sonnet@high")] })]), /claude-cli entry "sonnet@high".*suffix/],
    ["an entry id with a +fast suffix", () => manifestWith([pickerRecord({ provider: "codex-cli", entries: [verified("gpt-5.4+fast")] })]), /codex-cli entry "gpt-5.4\+fast".*suffix/],
    ["an entry id outside its block", () => manifestWith([zenSnapshotRecord({ entries: [verified("opencode-go/kimi-k3")] })]), /opencode-cli entry "opencode-go\/kimi-k3" does not belong to block "opencode"/],
    ["a picker record with missing coverage", () => manifestWith([pickerRecord({ coverage: undefined })]), /claude-cli block "default" has missing or unknown coverage/],
    ["a picker record with unknown coverage", () => manifestWith([pickerRecord({ coverage: "everything" })]), /unknown coverage "everything"/],
    ["a snapshot object on an entries record", () => manifestWith([pickerRecord({ snapshot: SNAPSHOT })]), /coverage "entries" but carries a snapshot/],
    ["a snapshot record without a snapshot object", () => manifestWith([zenSnapshotRecord({ snapshot: undefined })]), /coverage "snapshot" but no snapshot object/],
    ["free on a removed entry", () => manifestWith([pickerRecord({ entries: [{ ...(ZEN_RECORD_ENTRIES[7] as Json), id: "sonnet", free: FREE }] })]), /entry "sonnet" \(removed\) must not carry "free"/],
    ["qualifier on a not-added entry", () => manifestWith([pickerRecord({ entries: [{ id: "sonnet", status: "not-added", reason: "r", qualifier: "(API key only)" }] })]), /entry "sonnet" \(not-added\) must not carry "qualifier"/],
    ["requiresCompanion on a not-added entry", () => manifestWith([pickerRecord({ entries: [{ id: "sonnet", status: "not-added", reason: "r", requiresCompanion: "x" }] })]), /entry "sonnet" \(not-added\) must not carry "requiresCompanion"/],
    ["a non-picker record carrying coverage", () => manifestWith([{ provider: "opencode-cli", block: "external", scope: "non-picker", reason: "r", coverage: "entries" }]), /non-picker and must not carry "coverage"/],
    ["a non-picker record carrying a snapshot", () => manifestWith([{ provider: "opencode-cli", block: "external", scope: "non-picker", reason: "r", snapshot: SNAPSHOT }]), /must not carry "snapshot"/],
    ["a non-picker record carrying entries", () => manifestWith([{ provider: "opencode-cli", block: "external", scope: "non-picker", reason: "r", entries: [] }]), /must not carry "entries"/],
    ["a non-picker record without a reason", () => manifestWith([{ provider: "opencode-cli", block: "external", scope: "non-picker" }]), /non-picker and needs a "reason"/],
    ["a record scope that disagrees with its block", () => manifestWith([pickerRecord({ scope: "non-picker" })]), /has scope "non-picker", expected "picker"/],
    ["an entitlement-independent snapshot without a citation", () => manifestWith([zenSnapshotRecord({ snapshot: { ...SNAPSHOT, catalogAuthority: "entitlement-independent" } })]), /entitlement-independent authority without a citation/],
    ["a free field without a date", () => manifestWith([pickerRecord({ entries: [verified("sonnet", { free: { source: "x" } })] })]), /"free" needs a source and a date/],
    ["an alias saved selection without a cited source", () => manifestWith([pickerRecord({ entries: [{ ...(ZEN_RECORD_ENTRIES[7] as Json), id: "sonnet", savedSelection: { outcome: "alias", target: "opus" } }] })]), /alias savedSelection needs a target and a cited source/],
  ];
  /* eslint-enable @typescript-eslint/explicit-function-return-type */
  for (const [label, build, pattern] of rejections) {
    void it(`rejects ${label}`, () => {
      assert.throws(() => validateAuditManifest(build()), pattern);
    });
  }

  void it("rejects an allowlist id that falls in a non-picker block", () => {
    const manifest = manifestWith([]);
    assert.throws(
      () => validateAuditManifest(manifest, { freeAllowlist: ["opencode-cli:github-copilot/free-thing"] }),
      /falls in a non-picker block/
    );
    assert.doesNotThrow(() => validateAuditManifest(manifest, { freeAllowlist: ["opencode-cli:opencode/free-thing"] }));
  });

  void it("loads a snapshot record holding every entry status", () => {
    const manifest = validateAuditManifest(manifestWith([zenSnapshotRecord()]));
    const record = manifest.records[0];
    assert.equal(record?.coverage, "snapshot");
    assert.deepEqual(
      record?.entries?.map((e) => e.status),
      ["verified", "verified", "added", "relabelled", "verified-conditional", "unverified", "not-added", "removed"]
    );
    assert.deepEqual(record?.entries?.[0]?.free, FREE);
    assert.equal(record?.entries?.[1]?.requiresCompanion, "opencode/claude-fable-5-1");
    assert.deepEqual(
      dispositionsFromManifest(manifest).map((d) => d.id).slice(0, 2),
      ["opencode-cli:opencode/free-model", "opencode-cli:opencode/claude-fable-5"]
    );
  });

  void it("lets a snapshot cover a seeded id that has no entry, but an unverified entry stays unverified", () => {
    const manifest = validateAuditManifest(manifestWith([zenSnapshotRecord()]));
    assert.deepEqual(classifySeedCoverage(manifest, "opencode-cli", "opencode/anything-else"), { state: "covered-by-snapshot" });
    assert.deepEqual(classifySeedCoverage(manifest, "opencode-cli", "opencode/absent"), { state: "entry", status: "unverified" });
    // A Zen snapshot never covers another block's ids.
    assert.deepEqual(classifySeedCoverage(manifest, "opencode-cli", "opencode-go/kimi-k3"), { state: "uncovered" });
    assert.deepEqual(classifySeedCoverage(manifest, "opencode-cli", "openai/gpt-5"), { state: "uncovered" });
  });

  void it("agrees entry status with the seed", () => {
    const seed = { "opencode-cli": [{ model: "opencode/a" }, { model: "opencode/b@high" }, { model: "opencode/gone" }] };
    const index = buildSeedBaseIdIndex(seed);
    const entry = (id: string, status: string, extra: Json = {}): Json => ({
      id,
      status,
      checkedAt: "2026-09-20",
      source: "fixture",
      ...extra,
    });
    const ok = validateAuditManifest(
      manifestWith([zenSnapshotRecord({ entries: [entry("opencode/a", "added"), entry("opencode/b", "verified")] })])
    );
    assert.deepEqual(findStatusSeedDisagreements(ok, index), []);

    const added = validateAuditManifest(manifestWith([zenSnapshotRecord({ entries: [entry("opencode/missing", "added")] })]));
    assert.match(findStatusSeedDisagreements(added, index).join("\n"), /opencode\/missing is added but not in the seed/);

    const removed = validateAuditManifest(
      manifestWith([
        zenSnapshotRecord({
          entries: [
            entry("opencode/gone", "removed", {
              removalEvidence: { kind: "documented-retirement", source: "s", date: "2026-09-01" },
              savedSelection: { outcome: "preserve" },
            }),
          ],
        }),
      ])
    );
    assert.match(findStatusSeedDisagreements(removed, index).join("\n"), /opencode\/gone is removed but still in the seed/);
  });

  void it("rejects the same id twice even across statuses", () => {
    assert.throws(
      () =>
        validateAuditManifest(
          manifestWith([zenSnapshotRecord({ entries: [verified("opencode/x"), { id: "opencode/x", status: "unverified", reason: "r" }] })])
        ),
      /lists entry id "opencode\/x" twice/
    );
  });
});

void describe("audit blocks", () => {
  const catalog = getSeededCatalogForAudit();

  void it("mirrors the real ProviderId list", () => {
    assert.deepEqual([...AUDIT_PROVIDER_IDS].sort(), ["copilot", ...CLI_PROVIDERS.map((def) => def.id)].sort());
  });

  void it("puts every opencode-cli seed id in exactly one block, agreeing with providerAccountIdForModelId", () => {
    const models = catalog.seeded["opencode-cli"] ?? [];
    assert.ok(models.length > 0);
    const legacyByBlock = { opencode: "opencode-zen", "opencode-go": "opencode-go", external: "opencode-cli" } as const;
    for (const { model } of models) {
      const base = model.replace(/@[^@]*$/, "");
      const matching = ["opencode-go", "opencode", "external"].filter((block) => {
        if (block === "opencode-go") {return base.startsWith("opencode-go/");}
        if (block === "opencode") {return base.startsWith("opencode/");}
        return !base.startsWith("opencode-go/") && !base.startsWith("opencode/");
      });
      assert.equal(matching.length, 1, model);
      const block = blockForSeedId("opencode-cli", base).block;
      assert.equal(block, matching[0], model);
      assert.equal(providerAccountIdForModelId(`opencode-cli:${model}`), legacyByBlock[block as keyof typeof legacyByBlock], model);
    }
    assert.equal(blockForSeedId("opencode-cli", "opencode-go/x").block, "opencode-go");
  });

  void it("makes `external` exactly the github-copilot/* and openai/* ids, and non-picker", () => {
    const groups = partitionSeedByBlock("opencode-cli", catalog.seeded["opencode-cli"] ?? []);
    const external = groups.find((g) => g.block === "external");
    assert.ok(external);
    assert.equal(external.scope, "non-picker");
    assert.ok(external.entries.length > 0);
    assert.ok(external.entries.every((e) => /^(github-copilot|openai)\//.test(e.model)));
    const others = groups.filter((g) => g.block !== "external");
    assert.deepEqual(others.map((g) => g.scope), others.map(() => "picker"));
    for (const group of others) {
      assert.ok(group.entries.every((e) => e.model.startsWith(group.block === "opencode" ? "opencode/" : "opencode-go/")));
    }
    assert.equal(
      groups.reduce((sum, g) => sum + g.entries.length, 0),
      catalog.seeded["opencode-cli"]?.length
    );
  });

  void it("puts every other provider's ids in its single default block", () => {
    for (const [provider, models] of Object.entries(catalog.seeded)) {
      if (provider === "opencode-cli") {continue;}
      const groups = partitionSeedByBlock(provider as AuditProviderId, models ?? []);
      assert.deepEqual(groups.map((g) => [g.block, g.scope]), [["default", "picker"]], provider);
    }
    // No Copilot loop: since v1 fixes 2 item 19 Copilot has no static seed
    // (base ids only, discovered through the VS Code LM API), so there are no
    // Copilot ids for this audit to partition.
    for (const id of catalog.geminiFallbackIds) {
      assert.equal(blockForSeedId("gemini-cli", id).block, "default");
    }
  });

  void it("throws when an id matches no block", () => {
    const strict = { ...AUDIT_BLOCKS, "opencode-cli": AUDIT_BLOCKS["opencode-cli"].filter((b) => b.prefix !== undefined) };
    assert.throws(() => blockForSeedId("opencode-cli", "openai/gpt-5", strict), /No audit block for opencode-cli:openai\/gpt-5/);
    assert.equal(blockForSeedId("opencode-cli", "opencode/x", strict).block, "opencode");
  });

  void it("exposes the audit accessor without seed data moving", () => {
    assert.ok(catalog.geminiFallbackIds.includes("gemini-2.5-pro"));
    assert.deepEqual(catalog.strippedFreeMarkerIds, []);
    assert.ok((catalog.seeded["claude-cli"] ?? []).some((m) => m.model === "fable"));
  });

  void it("collapses variants in toBaseSelectionId with the runners' last-@ split", () => {
    assert.equal(toBaseSelectionId("cline-cli", "cline-free/glm-5.2@high"), "cline-cli:cline-free/glm-5.2");
    assert.equal(toBaseSelectionId("codex-cli", "gpt-5.4@high+fast"), "codex-cli:gpt-5.4");
    assert.equal(toBaseSelectionId("claude-cli", "fable"), "claude-cli:fable");
    assert.equal(toBaseSelectionId("opencode-cli", "opencode/claude-fable-5@max"), "opencode-cli:opencode/claude-fable-5");
    assert.equal(toBaseSelectionId("kimi-cli", "kimi-code/k3@low"), "kimi-cli:kimi-code/k3");
    assert.equal(toBaseSelectionId("antigravity-cli", "Gemini 3.7 Flash (Low)"), "antigravity-cli:Gemini 3.7 Flash (Low)");
  });
});

void describe("free-marker helpers", () => {
  void it("detects the bracketed token and the standalone word, not substrings", () => {
    assert.ok(hasFreeMarker("GLM-5.2 (Free)"));
    assert.ok(hasFreeMarker("Claude Haiku 4.5 (Free) (high)"));
    assert.ok(hasFreeMarker("DeepSeek V4 Flash Free"));
    assert.ok(!hasFreeMarker("DeepSeek V4 Flash"));
    assert.ok(!hasFreeMarker("Freedom Model 2"));
  });

  void it("strips either form, tidies spacing and keeps a trailing variant suffix", () => {
    assert.equal(stripFreeMarker("Claude Haiku 4.5 (Free) (high)"), "Claude Haiku 4.5 (high)");
    assert.equal(stripFreeMarker("MiMo V2.5 Free"), "MiMo V2.5");
    assert.equal(stripFreeMarker("GLM-5.2 (Free)"), "GLM-5.2");
    assert.equal(stripFreeMarker("MiMo V2.5 Free (high)"), "MiMo V2.5 (high)");
    assert.equal(stripFreeMarker("Freedom Model"), "Freedom Model");
  });
});

void describe("free allowlist guards", () => {
  const real = validateAuditManifest(loadRaw());
  const catalog = getSeededCatalogForAudit();

  function loadRaw(): unknown {
    return JSON.parse(fs.readFileSync(AUDIT_MANIFEST_PATH, "utf8"));
  }

  const claudeAudited = validateAuditManifest(manifestWith([pickerRecord({ entries: [verified("haiku", { free: FREE })] })]));
  const claudeUnaudited = validateAuditManifest(manifestWith([pickerRecord({ freeLabelsAudited: false, entries: [verified("haiku", { free: FREE })] })]));
  const zenSnapshotOnly = validateAuditManifest(manifestWith([zenSnapshotRecord({ entries: [] })]));

  void it("passes on the real data with the empty allowlist", () => {
    assert.deepEqual(VERIFIED_FREE_MODEL_IDS, []);
    assert.deepEqual(findFreeAllowlistViolations({ manifest: real, allowlist: VERIFIED_FREE_MODEL_IDS, strippedFreeMarkerIds: catalog.strippedFreeMarkerIds }), []);
    assert.deepEqual(findFreeLabelViolations({ seed: catalog.seeded, manifest: real, allowlist: VERIFIED_FREE_MODEL_IDS }), []);
  });

  void it("accepts an allowlist id backed by an audited block and a dated free entry", () => {
    assert.deepEqual(
      findFreeAllowlistViolations({ manifest: claudeAudited, allowlist: ["claude-cli:haiku"], strippedFreeMarkerIds: [] }),
      []
    );
  });

  void it("fails for a block lacking freeLabelsAudited: true", () => {
    const problems = findFreeAllowlistViolations({ manifest: claudeUnaudited, allowlist: ["claude-cli:haiku"], strippedFreeMarkerIds: [] });
    assert.match(problems.join("\n"), /no record with freeLabelsAudited: true/);
    const noRecord = findFreeAllowlistViolations({ manifest: validateAuditManifest(manifestWith([])), allowlist: ["claude-cli:haiku"], strippedFreeMarkerIds: [] });
    assert.match(noRecord.join("\n"), /no record with freeLabelsAudited: true/);
  });

  void it("fails for a non-picker block and for a `cline:` prefix", () => {
    assert.match(
      findFreeAllowlistViolations({ manifest: real, allowlist: ["opencode-cli:openai/gpt-5"], strippedFreeMarkerIds: [] }).join("\n"),
      /non-picker block "external"/
    );
    assert.match(
      findFreeAllowlistViolations({ manifest: real, allowlist: ["cline:cline-free/glm-5.2"], strippedFreeMarkerIds: [] }).join("\n"),
      /no ProviderId prefix/
    );
  });

  void it("fails when only a snapshot claim backs the id, with no annotation entry", () => {
    assert.match(
      findFreeAllowlistViolations({ manifest: zenSnapshotOnly, allowlist: ["opencode-cli:opencode/some-free"], strippedFreeMarkerIds: [] }).join("\n"),
      /needs an explicit seeded-status entry with a dated free field/
    );
  });

  void it("requires a relabelled entry for every stripped free-marker id", () => {
    const withRelabel = validateAuditManifest(manifestWith([zenSnapshotRecord()]));
    assert.deepEqual(
      findFreeAllowlistViolations({ manifest: withRelabel, allowlist: [], strippedFreeMarkerIds: ["opencode-cli:opencode/renamed"] }),
      []
    );
    assert.match(
      findFreeAllowlistViolations({ manifest: withRelabel, allowlist: [], strippedFreeMarkerIds: ["opencode-cli:opencode/other"] }).join("\n"),
      /stripped free marker has no relabelled entry/
    );
  });

  void it("applies the block-scoped free-label rule to base entries and every variant", () => {
    const seed = {
      "claude-cli": [
        { model: "haiku", name: "Claude Haiku 4.5 (Free)" },
        { model: "haiku@high", name: "Claude Haiku 4.5 (Free) (high)" },
      ],
    };
    assert.deepEqual(findFreeLabelViolations({ seed, manifest: claudeAudited, allowlist: ["claude-cli:haiku"] }), []);
    assert.equal(findFreeLabelViolations({ seed, manifest: claudeAudited, allowlist: [] }).length, 2);
    const variantMissing = { "claude-cli": [{ model: "haiku", name: "Claude Haiku 4.5 (Free)" }, { model: "haiku@high", name: "Claude Haiku 4.5 (high)" }] };
    assert.equal(findFreeLabelViolations({ seed: variantMissing, manifest: claudeAudited, allowlist: ["claude-cli:haiku"] }).length, 1);
    const bareWord = { "opencode-cli": [{ model: "opencode/mimo-v2.5-free", name: "MiMo V2.5 Free" }] };
    assert.equal(findFreeLabelViolations({ seed: bareWord, manifest: validateAuditManifest(manifestWith([zenSnapshotRecord()])), allowlist: [] }).length, 1);
    // Unaudited and non-picker blocks are not evaluated.
    assert.deepEqual(findFreeLabelViolations({ seed, manifest: claudeUnaudited, allowlist: [] }), []);
    assert.deepEqual(
      findFreeLabelViolations({ seed: { "opencode-cli": [{ model: "openai/x", name: "X Free" }] }, manifest: real, allowlist: [] }),
      []
    );
  });
});

void describe("checked-in manifest against the real seed", () => {
  const manifest = loadAuditManifest(AUDIT_MANIFEST_PATH, { freeAllowlist: VERIFIED_FREE_MODEL_IDS });
  const catalog = getSeededCatalogForAudit();
  const seedIndex = buildSeedBaseIdIndex(catalog.seeded);

  void it("has no duplicate ids within any provider seed", () => {
    for (const [provider, models] of Object.entries(catalog.seeded)) {
      const ids = (models ?? []).map((m) => m.model);
      assert.deepEqual(ids.filter((id, i) => ids.indexOf(id) !== i), [], `${provider} seed has duplicate ids`);
    }
  });

  void it("covers every seeded base id of each recorded picker block", () => {
    for (const record of manifest.records.filter((r) => r.scope === "picker")) {
      const models = (catalog.seeded as Readonly<Partial<Record<string, readonly { model: string; name: string }[]>>>)[record.provider] ?? [];
      const group = partitionSeedByBlock(record.provider, models).find((g) => g.block === record.block);
      const baseIds = new Set((group?.entries ?? []).map((m) => toBaseSelectionId(record.provider, m.model).slice(record.provider.length + 1)));
      assert.ok(baseIds.size > 0, `${record.provider}/${record.block} has no seeded ids`);
      for (const baseId of baseIds) {
        assert.notEqual(
          classifySeedCoverage(manifest, record.provider, baseId).state,
          "uncovered",
          `${record.provider}:${baseId} has no manifest entry`
        );
      }
    }
  });

  void it("agrees entry status with the seed, and leaves no removed id in a seed", () => {
    assert.deepEqual(findStatusSeedDisagreements(manifest, seedIndex), []);
  });

  void it("requires qualifying evidence for every removed entry", () => {
    for (const record of manifest.records) {
      for (const entry of record.entries ?? []) {
        if (entry.status !== "removed") {
          continue;
        }
        const evidence = entry.removalEvidence;
        assert.ok(evidence, `${record.provider}:${entry.id} is removed without evidence`);
        if (evidence.kind === "universal-catalog") {
          assert.ok(
            (record.coverage === "snapshot" && record.snapshot?.catalogAuthority === "entitlement-independent") ||
              evidence.citation,
            `${record.provider}:${entry.id} universal-catalog removal needs an entitlement-independent source`
          );
        }
        if (evidence.kind === "all-path-classes") {
          const covered = new Set((evidence.captures ?? []).map((c) => c.pathClass));
          for (const pathClass of record.supportedPathClasses ?? []) {
            assert.ok(covered.has(pathClass), `${record.provider}:${entry.id} lacks a ${pathClass} capture`);
          }
        }
      }
    }
  });

  void it("keeps every requiresCompanion pair in the same seed", () => {
    for (const record of manifest.records) {
      for (const entry of record.entries ?? []) {
        if (!entry.requiresCompanion) {
          continue;
        }
        const seeded = seedIndex.get(record.provider);
        assert.ok(seeded?.has(entry.id), `${record.provider}:${entry.id} is not seeded`);
        assert.ok(seeded?.has(entry.requiresCompanion), `${record.provider}:${entry.requiresCompanion} companion is not seeded`);
      }
    }
  });

  void it("offers Fable 5.1 and the explicit Fable 5 pin on Claude Code next to the relabelled floating alias", () => {
    const byModel = new Map((catalog.seeded["claude-cli"] ?? []).map((m) => [m.model, m.name]));
    assert.equal(byModel.get("claude-fable-5-1"), "Fable 5.1");
    assert.equal(byModel.get("claude-fable-5-1@high"), "Fable 5.1 (High)");
    assert.equal(byModel.get("claude-fable-5"), "Fable 5");
    assert.equal(byModel.get("claude-fable-5@high"), "Fable 5 (High)");
    assert.equal(byModel.get("fable"), "Fable (latest)");
    assert.equal(byModel.get("fable@max"), "Fable (latest) (Max)");
    const record = manifest.records.find((r) => r.provider === "claude-cli");
    const status = (id: string): string | undefined => record?.entries?.find((e) => e.id === id)?.status;
    assert.equal(status("claude-fable-5-1"), "added");
    assert.equal(status("claude-fable-5"), "added");
    assert.equal(status("fable"), "relabelled");
    assert.equal(
      record?.entries?.find((e) => e.id === "claude-fable-5")?.requiresCompanion,
      "claude-fable-5-1"
    );
  });

  void it("only offers Claude efforts the runner turns into a thinking budget", () => {
    const claude = getCliProvider("claude-cli");
    assert.ok(claude, "expected claude-cli provider definition");
    for (const { model } of catalog.seeded["claude-cli"] ?? []) {
      const args = claude.buildArgs("edit", model, { cwd: "/workspace/project", promptFile: "/tmp/prompt.txt" });
      assert.ok(!args.some((arg) => arg.includes("@")), `${model} kept a literal @effort in its arguments`);
    }
  });

  void it("keeps opencode ids inside their block namespace and devpass ids inside theirs", () => {
    for (const group of partitionSeedByBlock("opencode-cli", catalog.seeded["opencode-cli"] ?? [])) {
      const prefix = AUDIT_BLOCKS["opencode-cli"].find((def) => def.block === group.block)?.prefix;
      if (group.scope === "picker") {
        assert.ok(group.entries.every((m) => m.model.startsWith(prefix ?? "")), group.block);
      }
    }
    for (const { model } of catalog.seeded["devpass-cli"] ?? []) {
      assert.ok(model.startsWith("llmgateway-devpass/"), model);
    }
  });

  void it("has the external non-picker record with a reason and no entries", () => {
    const external = manifest.records.find((r) => r.provider === "opencode-cli" && r.block === "external");
    assert.equal(external?.scope, "non-picker");
    assert.ok(external?.reason);
    assert.equal(external?.entries, undefined);
  });
});
