/**
 * bugs3 Step 5: Kimi's read capacity follows the installed version and the
 * user's config, counts characters on 2.x, and the config change is a minimal,
 * consent-gated TOML edit.
 */
import * as assert from "node:assert/strict";
import { describe, it } from "node:test";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import {
  applyKimiReadMaxCharsConsentV1,
  defaultKimiConfigFileOpsV1,
  type KimiConfigFileOpsV1,
} from "../utils/kimiReadCapacityNodeV1";
import {
  describeKimiReadConfigOfferV1,
  shouldOfferKimiReadConfigV1,
  KIMI_DEFAULT_MAX_CHARS_V1,
  KIMI_LEGACY_READ_CEILING_BYTES_V1,
  kimiPromptExceedsCapacityV1,
  loadKimiReadCapacityV1,
  measureKimiPromptV1,
  parseKimiMajorVersionV1,
  parseKimiReadConfigV1,
  resolveKimiReadCapacityV1,
  setKimiReadDefaultMaxCharsV1,
} from "../utils/kimiReadCapacityV1";
import { preferCandidateWithinReadCeilingV1, promptCeilingAdvisoryV1 } from "../utils/reviewRouting";
import { buildKimiCliPromptFileInstruction } from "../runners/providers";

const V2 = "kimi, version 2.3.2";

void describe("Kimi version and config resolution (bugs3 Step 5)", () => {
  void it("reads the major version from the CLI's own output", () => {
    assert.equal(parseKimiMajorVersionV1(V2), 2);
    assert.equal(parseKimiMajorVersionV1("0.29.2"), 0);
    assert.equal(parseKimiMajorVersionV1("not a version"), undefined);
    assert.equal(parseKimiMajorVersionV1(undefined), undefined);
  });

  void it("keeps the measured byte ceiling for older versions and when the version is unknown", () => {
    assert.deepEqual(resolveKimiReadCapacityV1({ versionOutput: "0.29.2" }), {
      unit: "bytes",
      limit: KIMI_LEGACY_READ_CEILING_BYTES_V1,
      source: "legacy",
    });
    assert.deepEqual(resolveKimiReadCapacityV1({}), {
      unit: "bytes",
      limit: KIMI_LEGACY_READ_CEILING_BYTES_V1,
      source: "unknown",
    });
    // A config cannot raise the ceiling of a version that ignores it.
    assert.equal(
      resolveKimiReadCapacityV1({ versionOutput: "0.29.2", configToml: "[read]\ndefault_max_chars = 500000\n" }).limit,
      KIMI_LEGACY_READ_CEILING_BYTES_V1
    );
  });

  void it("uses 100,000 characters on 2.x without a config and the configured value with one", () => {
    assert.deepEqual(resolveKimiReadCapacityV1({ versionOutput: V2 }), {
      unit: "chars",
      limit: KIMI_DEFAULT_MAX_CHARS_V1,
      source: "default",
    });
    assert.deepEqual(
      resolveKimiReadCapacityV1({ versionOutput: V2, configToml: 'model = "k3"\n\n[read]\ndefault_max_chars = 500_000 # all of it\n' }),
      { unit: "chars", limit: 500000, source: "config" }
    );
    // Beyond the tool's own maximum is clamped, not trusted.
    assert.equal(
      resolveKimiReadCapacityV1({ versionOutput: V2, configToml: "[read]\ndefault_max_chars = 9000000\n" }).limit,
      500000
    );
  });

  void it("ignores a key outside [read]; a malformed value keeps the conservative ceiling", () => {
    assert.equal(parseKimiReadConfigV1("[other]\ndefault_max_chars = 300000\n").kind, "absent");
    assert.equal(parseKimiReadConfigV1("[read]\ndefault_max_chars = \"lots\"\n").kind, "malformed");
    assert.equal(parseKimiReadConfigV1("[read]\ndefault_max_chars = 0\n").kind, "malformed");
    // An unreadable setting may hide a lower limit: do not assume the default.
    assert.deepEqual(resolveKimiReadCapacityV1({ versionOutput: V2, configToml: "[read]\ndefault_max_chars = nope\n" }), {
      unit: "bytes",
      limit: KIMI_LEGACY_READ_CEILING_BYTES_V1,
      source: "unknown",
    });
    assert.deepEqual(resolveKimiReadCapacityV1({ versionOutput: V2, configUnreadable: true }), {
      unit: "bytes",
      limit: KIMI_LEGACY_READ_CEILING_BYTES_V1,
      source: "unknown",
    });
    // A config with no [read] setting is a confirmed absence: the default applies.
    assert.equal(
      resolveKimiReadCapacityV1({ versionOutput: V2, configToml: 'model = "k3"\n' }).limit,
      KIMI_DEFAULT_MAX_CHARS_V1
    );
  });

  void it("loads from injected I/O and stays conservative when either read fails", async () => {
    const ok = await loadKimiReadCapacityV1({
      readVersionOutput: () => Promise.resolve(V2),
      readConfigToml: () => Promise.resolve("[read]\ndefault_max_chars = 250000\n"),
    });
    assert.equal(ok.limit, 250000);
    const failed = await loadKimiReadCapacityV1({
      readVersionOutput: () => Promise.reject(new Error("spawn kimi ENOENT")),
      readConfigToml: () => Promise.resolve(undefined),
    });
    assert.equal(failed.source, "unknown");
    // A config file that exists but cannot be read is not an absent config.
    const unreadable = await loadKimiReadCapacityV1({
      readVersionOutput: () => Promise.resolve(V2),
      readConfigToml: () => Promise.reject(new Error("EACCES")),
    });
    assert.equal(unreadable.source, "unknown");
    assert.equal(unreadable.unit, "bytes");
    // A missing config file (undefined) is a confirmed absence.
    const absent = await loadKimiReadCapacityV1({
      readVersionOutput: () => Promise.resolve(V2),
      readConfigToml: () => Promise.resolve(undefined),
    });
    assert.equal(absent.source, "default");
  });
});

void describe("Kimi capacity comparison (bugs3 Step 5)", () => {
  void it("counts characters on 2.x, so multibyte text is not penalised as bytes", () => {
    const capacity = resolveKimiReadCapacityV1({ versionOutput: V2 });
    // 40,000 three-byte characters on 400 lines: 120,000 bytes but ~43,000 characters read.
    const text = Array.from({ length: 400 }, () => "€".repeat(100)).join("\n");
    const size = measureKimiPromptV1(text);
    assert.ok(size.bytes > 100_000 && size.chars < 100_000);
    assert.equal(kimiPromptExceedsCapacityV1(capacity, size), false);
    assert.equal(kimiPromptExceedsCapacityV1(resolveKimiReadCapacityV1({ versionOutput: "0.29.2" }), size), true);
  });

  void it("charges the line-number prefixes against the limit at the boundary", () => {
    const capacity = resolveKimiReadCapacityV1({ versionOutput: V2 });
    // 1,000 lines of 91 characters + newline: 91,999 characters, plus 1,000 * 8 prefix chars = 99,999 — fits.
    const fits = Array.from({ length: 1000 }, () => "x".repeat(91)).join("\n");
    assert.equal(kimiPromptExceedsCapacityV1(capacity, measureKimiPromptV1(fits)), false);
    const tooBig = `${fits}\nxx`;
    assert.equal(kimiPromptExceedsCapacityV1(capacity, measureKimiPromptV1(tooBig)), true);
  });

  void it("routes by the effective limit: a 140 KB prompt fits a configured 2.x and is rerouted without the config", () => {
    const prompt = Array.from({ length: 1400 }, () => "y".repeat(99)).join("\n");
    const size = measureKimiPromptV1(prompt);
    const ranked = ["kimi:a", "other:b"];
    const providerIdOf = (id: string): string => (id.startsWith("kimi") ? "kimi-cli" : "opencode-cli");
    const configured = { capacity: resolveKimiReadCapacityV1({ versionOutput: V2, configToml: "[read]\ndefault_max_chars = 500000\n" }), prompt: size };
    const unconfigured = { capacity: resolveKimiReadCapacityV1({ versionOutput: V2 }), prompt: size };
    assert.equal(preferCandidateWithinReadCeilingV1(ranked, size.bytes, providerIdOf, configured), undefined);
    assert.equal(preferCandidateWithinReadCeilingV1(ranked, size.bytes, providerIdOf, unconfigured), "other:b");
    assert.equal(promptCeilingAdvisoryV1(size.bytes, "kimi-cli", configured), undefined);
    assert.match(promptCeilingAdvisoryV1(size.bytes, "kimi-cli", unconfigured) ?? "", /100,000 characters per read/);
    // Without a resolved capacity the legacy ceiling still applies.
    assert.equal(preferCandidateWithinReadCeilingV1(ranked, size.bytes, providerIdOf), "other:b");
  });
});

void describe("setKimiReadDefaultMaxCharsV1 (bugs3 Step 5)", () => {
  void it("appends a [read] section to a config without one, keeping everything else", () => {
    const result = setKimiReadDefaultMaxCharsV1('model = "k3"\n[ui]\ntheme = "dark"\n');
    assert.ok(result.ok);
    assert.equal(result.toml, 'model = "k3"\n[ui]\ntheme = "dark"\n\n[read]\ndefault_max_chars = 500000\n');
  });

  void it("creates the file's first section when the config is empty", () => {
    const result = setKimiReadDefaultMaxCharsV1("");
    assert.ok(result.ok);
    assert.equal(result.toml, "[read]\ndefault_max_chars = 500000\n");
  });

  void it("updates an existing key in place and adds a missing key to an existing section", () => {
    const updated = setKimiReadDefaultMaxCharsV1("[read]\n# keep me\ndefault_max_chars = 120000 # old\nmax_chars = 500000\n[ui]\nx = 1\n");
    assert.ok(updated.ok);
    assert.equal(updated.toml, "[read]\n# keep me\ndefault_max_chars = 500000\nmax_chars = 500000\n[ui]\nx = 1\n");
    const added = setKimiReadDefaultMaxCharsV1("[read]\nmax_chars = 500000\n[ui]\nx = 1\n");
    assert.ok(added.ok);
    assert.equal(added.toml, "[read]\ndefault_max_chars = 500000\nmax_chars = 500000\n[ui]\nx = 1\n");
  });

  void it("reports no change when the value is already set, preserves CRLF, and refuses ambiguity", () => {
    const same = setKimiReadDefaultMaxCharsV1("[read]\ndefault_max_chars = 500000\n");
    assert.ok(same.ok);
    assert.equal(same.changed, false);
    const crlf = setKimiReadDefaultMaxCharsV1("a = 1\r\n");
    assert.ok(crlf.ok);
    assert.equal(crlf.toml, "a = 1\r\n\r\n[read]\r\ndefault_max_chars = 500000\r\n");
    assert.equal(setKimiReadDefaultMaxCharsV1("[read]\na=1\n[read]\nb=2\n").ok, false);
    assert.equal(setKimiReadDefaultMaxCharsV1("", 600000).ok, false);
  });
});

void describe("buildKimiCliPromptFileInstruction single-read request (bugs3 Step 5)", () => {
  void it("asks for one Read with max_chars set to the prompt size, capped at 500,000", () => {
    assert.match(buildKimiCliPromptFileInstruction("/tmp/p.txt", false, 139_500), /max_chars argument set to 139500/);
    assert.match(buildKimiCliPromptFileInstruction("/tmp/p.txt", false, 900_000), /max_chars argument set to 500000/);
  });

  void it("keeps the pagination guidance and omits the request when the size is unknown", () => {
    const withSize = buildKimiCliPromptFileInstruction("/tmp/p.txt", false, 1000);
    assert.match(withSize, /explicit line range/);
    assert.doesNotMatch(buildKimiCliPromptFileInstruction("/tmp/p.txt"), /max_chars/);
  });
});

void describe("consented Kimi config change (bugs3 Step 5)", () => {
  const BIG = measureKimiPromptV1(Array.from({ length: 1400 }, () => "y".repeat(99)).join("\n"));

  void it("offers only where raising the setting could let the prompt through", () => {
    const def = resolveKimiReadCapacityV1({ versionOutput: V2 });
    assert.equal(shouldOfferKimiReadConfigV1(def, BIG), true);
    // Already at the offered value, an older Kimi, an unestablished config, and a prompt that fits or can never fit.
    const configured = resolveKimiReadCapacityV1({ versionOutput: V2, configToml: "[read]\ndefault_max_chars = 500000\n" });
    assert.equal(shouldOfferKimiReadConfigV1(configured, BIG), false);
    assert.equal(shouldOfferKimiReadConfigV1(resolveKimiReadCapacityV1({ versionOutput: "0.29.2" }), BIG), false);
    assert.equal(shouldOfferKimiReadConfigV1(resolveKimiReadCapacityV1({ versionOutput: V2, configUnreadable: true }), BIG), false);
    assert.equal(shouldOfferKimiReadConfigV1(def, measureKimiPromptV1("short")), false);
    assert.equal(shouldOfferKimiReadConfigV1(def, measureKimiPromptV1("z".repeat(600_000))), false);
  });

  void it("says the setting applies to all Kimi sessions and can cost tokens", () => {
    const words = describeKimiReadConfigOfferV1(resolveKimiReadCapacityV1({ versionOutput: V2 }), BIG);
    assert.match(words.consequence, /all of your Kimi sessions/);
    assert.match(words.consequence, /more tokens/);
    assert.match(words.declineConsequence, /Changes nothing/);
  });

  function fakeOps(
    initial: string | undefined,
    hooks: { onSecondRead?: () => string | undefined; failWrite?: boolean } = {}
  ): { ops: KimiConfigFileOpsV1; state: { text: string | undefined; reads: number; writes: number } } {
    const state = { text: initial, reads: 0, writes: 0 };
    const ops: KimiConfigFileOpsV1 = {
      read: () => {
        state.reads++;
        if (state.reads === 2 && hooks.onSecondRead) {
          state.text = hooks.onSecondRead();
        }
        return Promise.resolve(state.text);
      },
      writeAtomic: (_path, text) => {
        if (hooks.failWrite) {
          return Promise.reject(new Error("EACCES"));
        }
        state.writes++;
        state.text = text;
        return Promise.resolve();
      },
    };
    return { ops, state };
  }

  void it("writes only the [read] key and keeps unrelated settings", async () => {
    const { ops, state } = fakeOps('model = "k3"\n[ui]\nx = 1\n');
    const result = await applyKimiReadMaxCharsConsentV1(ops, "/home/u/.kimi-code/config.toml");
    assert.deepEqual(result, { ok: true, changed: true, path: "/home/u/.kimi-code/config.toml" });
    assert.equal(state.text, 'model = "k3"\n[ui]\nx = 1\n\n[read]\ndefault_max_chars = 500000\n');
  });

  void it("creates a missing config and writes nothing when the value is already set", async () => {
    const created = fakeOps(undefined);
    assert.equal((await applyKimiReadMaxCharsConsentV1(created.ops, "/c")).ok, true);
    assert.equal(created.state.text, "[read]\ndefault_max_chars = 500000\n");
    const same = fakeOps("[read]\ndefault_max_chars = 500000\n");
    const result = await applyKimiReadMaxCharsConsentV1(same.ops, "/c");
    assert.deepEqual(result, { ok: true, changed: false, path: "/c" });
    assert.equal(same.state.writes, 0);
  });

  void it("refuses and writes nothing when the file changes meanwhile, cannot be read, or cannot be written", async () => {
    const raced = fakeOps("a = 1\n", { onSecondRead: () => "a = 2\n" });
    const racedResult = await applyKimiReadMaxCharsConsentV1(raced.ops, "/c");
    assert.equal(racedResult.ok, false);
    assert.equal(raced.state.writes, 0);
    assert.equal(raced.state.text, "a = 2\n");
    const unreadable = await applyKimiReadMaxCharsConsentV1(
      { read: () => Promise.reject(new Error("EACCES")), writeAtomic: () => Promise.resolve() },
      "/c"
    );
    assert.equal(unreadable.ok, false);
    const unwritable = fakeOps("a = 1\n", { failWrite: true });
    const unwritableResult = await applyKimiReadMaxCharsConsentV1(unwritable.ops, "/c");
    assert.equal(unwritableResult.ok, false);
    assert.match(unwritableResult.ok ? "" : unwritableResult.reason, /nothing was changed/);
    const ambiguous = fakeOps("[read]\na=1\n[read]\nb=2\n");
    assert.equal((await applyKimiReadMaxCharsConsentV1(ambiguous.ops, "/c")).ok, false);
    assert.equal(ambiguous.state.writes, 0);
  });
});

void describe("the real config write keeps the file private (bugs3 Step 5)", () => {
  void it("preserves a 0600 config's mode and leaves no temp file", { skip: process.platform === "win32" }, async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "kimi-cfg-"));
    const previousUmask = process.umask(0o022);
    try {
      const file = path.join(dir, "config.toml");
      await fs.writeFile(file, "a = 1\n", { mode: 0o600 });
      await fs.chmod(file, 0o600);
      const result = await applyKimiReadMaxCharsConsentV1(defaultKimiConfigFileOpsV1, file);
      assert.equal(result.ok, true);
      assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
      assert.match(await fs.readFile(file, "utf8"), /default_max_chars = 500000/);
      assert.deepEqual(await fs.readdir(dir), ["config.toml"]);
      const fresh = path.join(dir, "sub", "config.toml");
      assert.equal((await applyKimiReadMaxCharsConsentV1(defaultKimiConfigFileOpsV1, fresh)).ok, true);
      assert.equal((await fs.stat(fresh)).mode & 0o777, 0o600);
    } finally {
      process.umask(previousUmask);
      await fs.rm(dir, { recursive: true, force: true });
    }
  });
});
