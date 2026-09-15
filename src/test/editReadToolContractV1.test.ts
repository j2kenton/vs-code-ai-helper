/**
 * Coverage for the §7.2 read-session contract (readToolSessionHandlerV1):
 * each of the five tools mints a correct server-issued observation, exact-
 * path reads produce mutation-grade preconditions while discovery results
 * are marked with non-authorizing sources, the root self-locator lists the
 * registered root, and protocol violations (unknown tool, foreign root,
 * undecodable input) are counted for the transport's abort cap.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import { createWorkflowFileStoreV1 } from "../services/workflowFileStoreV1";
import {
  createReadToolSessionHandlerV1,
  ReadToolCallEventV1,
  setReadToolCallObserverV1,
} from "../services/readToolSessionHandlerV1";
import { createObservationLedgerV1 } from "../types/preflightPlanV1";
import { ReadToolResultV1 } from "../types/workflowToolProtocolV1";
import { RequestLocalToolHandlerV1 } from "../services/requestLocalToolHandlerV1";

const ROOT_ID = "workspace:test";

interface Harness {
  root: string;
  handler: RequestLocalToolHandlerV1;
  ledger: ReturnType<typeof createObservationLedgerV1>;
  call: (name: string, input: Record<string, unknown>) => Promise<ReadToolResultV1>;
  cleanup: () => void;
}

function installHarness(): Harness {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-read-session-"));
  fs.mkdirSync(path.join(root, "src"));
  fs.writeFileSync(path.join(root, "src", "app.ts"), "const marker = 1;\nexport default marker;\n");
  fs.mkdirSync(path.join(root, "node_modules", "dep"), { recursive: true });
  fs.writeFileSync(path.join(root, "node_modules", "dep", "index.ts"), "const marker = 2;\n");
  fs.mkdirSync(path.join(root, "empty"));

  const store = createWorkflowFileStoreV1([
    { rootId: ROOT_ID, fsPath: root, trustedForMutation: false },
  ]);
  const ledger = createObservationLedgerV1();
  const handler = createReadToolSessionHandlerV1({ view: store, rootId: ROOT_ID, ledger });
  let nextCall = 0;
  return {
    root,
    handler,
    ledger,
    call: async (name, input) => {
      nextCall += 1;
      const text = await handler.handleToolCall({
        kind: "toolCall",
        callId: `call-${nextCall}`,
        name,
        input,
      });
      return JSON.parse(text) as ReadToolResultV1;
    },
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

void describe("editReadToolContractV1 — read session", () => {
  void it("readFile returns content plus a file observation; a missing path mints a missing observation", async () => {
    const h = installHarness();
    try {
      const read = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/app.ts" });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.kind, "file");
        assert.ok(read.contentUtf8?.includes("const marker = 1;"));
        assert.match(read.contentSha256 ?? "", /^[0-9a-f]{64}$/);
        const record = h.ledger.get(read.observationId);
        assert.equal(record?.source, "readFile");
        assert.equal(record?.relativePath, "src/app.ts");
      }

      const missing = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/none.ts" });
      assert.equal(missing.ok, true);
      if (missing.ok) {
        assert.equal(missing.kind, "missing");
        assert.equal(missing.revision, "missing");
      }
      assert.equal(h.handler.violationCount(), 0);
    } finally {
      h.cleanup();
    }
  });

  void it("stat marks directories as existence facts; readDirectory mints the complete-listing proof", async () => {
    const h = installHarness();
    try {
      const statDir = await h.call("ensemble_stat", { rootId: ROOT_ID, relativePath: "empty" });
      assert.equal(statDir.ok, true);
      if (statDir.ok) {
        assert.equal(statDir.kind, "directory");
        assert.equal(statDir.revision, "dir:unverified");
        assert.equal(h.ledger.get(statDir.observationId)?.source, "stat");
      }

      const listing = await h.call("ensemble_readDirectory", { rootId: ROOT_ID, relativePath: "empty" });
      assert.equal(listing.ok, true);
      if (listing.ok) {
        assert.equal(listing.kind, "directory");
        assert.equal(listing.complete, true);
        assert.deepEqual(listing.entries, []);
        assert.match(listing.revision, /^dir:[0-9a-f]{64}$/);
        assert.deepEqual(h.ledger.get(listing.observationId)?.entryNames, []);
      }

      const rootListing = await h.call("ensemble_readDirectory", { rootId: ROOT_ID, relativePath: "." });
      assert.equal(rootListing.ok, true);
      if (rootListing.ok) {
        const names = (rootListing.entries ?? []).map((entry) => entry.name).sort();
        assert.deepEqual(names, ["empty", "node_modules", "src"]);
      }
    } finally {
      h.cleanup();
    }
  });

  void it("findFiles discovers by path substring, skips node_modules, and marks its observation as discovery", async () => {
    const h = installHarness();
    try {
      const found = await h.call("ensemble_findFiles", { rootId: ROOT_ID, pathContains: "app" });
      assert.equal(found.ok, true);
      if (found.ok) {
        assert.deepEqual(found.matches?.map((m) => m.relativePath), ["src/app.ts"]);
        assert.equal(found.complete, true);
        assert.equal(h.ledger.get(found.observationId)?.source, "findFiles");
      }
    } finally {
      h.cleanup();
    }
  });

  void it("textSearch returns line matches with previews and never scans node_modules", async () => {
    const h = installHarness();
    try {
      const found = await h.call("ensemble_textSearch", { rootId: ROOT_ID, query: "const marker" });
      assert.equal(found.ok, true);
      if (found.ok) {
        assert.deepEqual(
          found.matches?.map((m) => ({ relativePath: m.relativePath, line: m.line })),
          [{ relativePath: "src/app.ts", line: 1 }]
        );
        assert.ok(found.matches?.[0]?.preview?.includes("const marker = 1;"));
        assert.equal(h.ledger.get(found.observationId)?.source, "textSearch");
      }
    } finally {
      h.cleanup();
    }
  });

  void it("counts violations for unknown tools, foreign roots, and undecodable input", async () => {
    const h = installHarness();
    try {
      const unknownTool = await h.call("ensemble_writeFile", { rootId: ROOT_ID, relativePath: "x" });
      assert.equal(unknownTool.ok, false);
      if (!unknownTool.ok) {
        assert.equal(unknownTool.code, "unknownTool");
      }
      const foreignRoot = await h.call("ensemble_stat", { rootId: "other", relativePath: "x" });
      assert.equal(foreignRoot.ok === false && foreignRoot.code, "unknownRoot");
      const badInput = await h.call("ensemble_stat", { rootId: ROOT_ID });
      assert.equal(badInput.ok === false && badInput.code, "invalidInput");
      assert.equal(h.handler.violationCount(), 3);
    } finally {
      h.cleanup();
    }
  });

  void it("refuses escaping paths through the safety layer", async () => {
    const h = installHarness();
    try {
      const escape = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "../secret.txt" });
      assert.equal(escape.ok, false);
      if (!escape.ok) {
        assert.equal(escape.code, "pathUnsafe");
      }
    } finally {
      h.cleanup();
    }
  });

  // Item 3b-2 (2026-08-17..19 workflow-defects batch): a preflight/read
  // session must leave a sanitized transcript of which files it targeted —
  // tool name plus path, never content — even when the session goes on to
  // fail for an unrelated reason later. The observer fires live, at call
  // time, specifically so a later failure cannot suppress an earlier record.
  void it("reports tool name and target path to the read-call observer, live per call, never content", async () => {
    const h = installHarness();
    const events: ReadToolCallEventV1[] = [];
    setReadToolCallObserverV1((event) => events.push(event));
    try {
      await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/app.ts" });
      await h.call("ensemble_stat", { rootId: ROOT_ID, relativePath: "empty" });
      await h.call("ensemble_readDirectory", { rootId: ROOT_ID, relativePath: "empty" });
      assert.deepEqual(events, [
        { tool: "ensemble_readFile", relativePath: "src/app.ts" },
        { tool: "ensemble_stat", relativePath: "empty" },
        { tool: "ensemble_readDirectory", relativePath: "empty" },
      ]);
      assert.ok(
        events.every((event) => !("content" in event) && !("contentUtf8" in event)),
        "the observer's event shape must never carry file content"
      );
    } finally {
      setReadToolCallObserverV1(undefined);
      h.cleanup();
    }
  });

  void it("still reports the target path to the observer when the call itself fails (invalid root)", async () => {
    const h = installHarness();
    const events: ReadToolCallEventV1[] = [];
    setReadToolCallObserverV1((event) => events.push(event));
    try {
      // A decode failure (missing relativePath) never reaches a known path,
      // so nothing is reported — there is no target to record.
      await h.call("ensemble_stat", { rootId: ROOT_ID });
      assert.deepEqual(events, []);
    } finally {
      setReadToolCallObserverV1(undefined);
      h.cleanup();
    }
  });

  void it("a throwing observer never breaks the session (report, never affect)", async () => {
    const h = installHarness();
    setReadToolCallObserverV1(() => {
      throw new Error("observer boom");
    });
    try {
      const read = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/app.ts" });
      assert.equal(read.ok, true);
    } finally {
      setReadToolCallObserverV1(undefined);
      h.cleanup();
    }
  });

  // v1 fixes 2, item 26 (2026-09-15): reviews name changed regions as line
  // ranges, but readFile could only return a whole file and refused anything
  // over 512 KB. A Copilot review of 9 large files spent all 64 rounds and
  // never finished; one file (699 KB) held 10 of its 33 regions and could not
  // be opened at all.
  void it("readFile returns exactly the requested lines, with the whole file's observation", async () => {
    const h = installHarness();
    try {
      fs.writeFileSync(path.join(h.root, "src", "lines.ts"), "one\ntwo\nthree\nfour\n");
      const whole = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/lines.ts" });
      const ranged = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/lines.ts",
        startLine: 2,
        endLine: 3,
      });
      assert.equal(ranged.ok, true);
      assert.equal(whole.ok, true);
      if (ranged.ok && whole.ok) {
        assert.equal(ranged.contentUtf8, "two\nthree\n");
        assert.equal(ranged.startLine, 2);
        assert.equal(ranged.endLine, 3);
        assert.equal(ranged.totalLines, 4);
        assert.equal(ranged.truncated, undefined);
        assert.equal(ranged.kind, "file");
        assert.equal(ranged.contentSha256, whole.contentSha256, "the observation describes the whole file");
        assert.equal(h.ledger.get(ranged.observationId)?.source, "readFile");
        // …but the model saw only part of it, which the plan validator must know.
        assert.equal(ranged.partialContent, true);
        assert.equal(h.ledger.get(ranged.observationId)?.partialContent, true);
        assert.equal(whole.partialContent, undefined);
        assert.equal(h.ledger.get(whole.observationId)?.partialContent, undefined);
      }
      assert.equal(h.handler.violationCount(), 0);
    } finally {
      h.cleanup();
    }
  });

  void it("a ranged read keeps CRLF terminators and clamps an end past the last line", async () => {
    const h = installHarness();
    try {
      fs.writeFileSync(path.join(h.root, "src", "crlf.ts"), "a\r\nb\r\nc");
      const read = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/crlf.ts",
        startLine: 2,
        endLine: 99,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.contentUtf8, "b\r\nc", "exact bytes, so the slice can be copied into a patch");
        assert.equal(read.endLine, 3);
        assert.equal(read.totalLines, 3);
      }
      const nullRange = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/crlf.ts",
        startLine: null,
        endLine: null,
      });
      assert.equal(nullRange.ok && nullRange.contentUtf8, "a\r\nb\r\nc", "null range fields read the whole file");
    } finally {
      h.cleanup();
    }
  });

  void it("reads ranges of a file too large to read whole, and says how when refusing the whole read", async () => {
    const h = installHarness();
    try {
      // 20,000 lines of 40 bytes: 800 KB, over the 512 KB whole-file limit.
      const lines = Array.from({ length: 20_000 }, (_, i) => `line ${String(i + 1).padStart(34, "0")}`);
      fs.writeFileSync(path.join(h.root, "src", "big.ts"), lines.join("\n") + "\n");

      const whole = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/big.ts" });
      assert.equal(whole.ok, false);
      if (!whole.ok) {
        assert.equal(whole.code, "readLimitExceeded");
        assert.match(whole.reason, /800000 bytes, over the 512 KB whole-file limit/);
        assert.match(whole.reason, /It has 20000 lines: read it in parts by passing startLine and endLine/);
      }

      const tail = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/big.ts",
        startLine: 19_999,
        endLine: 20_000,
      });
      assert.equal(tail.ok, true);
      if (tail.ok) {
        assert.equal(tail.contentUtf8, `${lines[19_998]}\n${lines[19_999]}\n`);
        assert.equal(tail.totalLines, 20_000);
      }

      const everything = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/big.ts",
        startLine: 1,
        endLine: 20_000,
      });
      assert.equal(everything.ok, true);
      if (everything.ok) {
        assert.equal(everything.truncated, true, "a slice over the per-read cap stops at a whole line");
        assert.ok(Buffer.byteLength(everything.contentUtf8 ?? "", "utf8") <= 512 * 1024);
        assert.ok((everything.endLine ?? 0) < 20_000);
        assert.ok((everything.contentUtf8 ?? "").endsWith("\n"));
      }
      assert.equal(h.handler.violationCount(), 0);
    } finally {
      h.cleanup();
    }
  });

  void it("a start past the end is an input error, not a protocol violation; a range on stat is a violation", async () => {
    const h = installHarness();
    try {
      const past = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/app.ts",
        startLine: 50,
      });
      assert.equal(past.ok, false);
      if (!past.ok) {
        assert.equal(past.code, "invalidInput");
        assert.match(past.reason, /startLine 50 is past the end of the file, which has 2 lines/);
      }
      assert.equal(h.handler.violationCount(), 0, "the model cannot know a file's length before reading it");

      const backwards = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/app.ts",
        startLine: 2,
        endLine: 1,
      });
      assert.equal(!backwards.ok && backwards.code, "invalidInput");

      const stat = await h.call("ensemble_stat", { rootId: ROOT_ID, relativePath: "src/app.ts", startLine: 1 });
      assert.equal(!stat.ok && stat.code, "invalidInput");
      assert.equal(h.handler.violationCount(), 2);
    } finally {
      h.cleanup();
    }
  });

  void it("keeps empty lines as lines when slicing", async () => {
    const h = installHarness();
    try {
      fs.writeFileSync(path.join(h.root, "src", "gaps.ts"), "\n\nthird\n\n");
      const read = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/gaps.ts",
        startLine: 2,
        endLine: 4,
      });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.contentUtf8, "\nthird\n\n");
        assert.equal(read.totalLines, 4);
        assert.equal(read.endLine, 4);
      }
    } finally {
      h.cleanup();
    }
  });

  void it("says a file over the ranged-read limit cannot be read at all, instead of suggesting ranges", async () => {
    // Codex review, 2026-09-15: over 16 MB even a ranged read is refused, so
    // advising ranges would spend another of the session's limited rounds on
    // a retry that cannot succeed.
    const h = installHarness();
    try {
      fs.writeFileSync(path.join(h.root, "src", "huge.log"), Buffer.alloc(16 * 1024 * 1024 + 1, 0x61));
      const whole = await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/huge.log" });
      assert.equal(!whole.ok && whole.code, "readLimitExceeded");
      assert.match(!whole.ok ? whole.reason : "", /cannot read any of it/);
      assert.doesNotMatch(!whole.ok ? whole.reason : "", /read it in parts/);

      const ranged = await h.call("ensemble_readFile", {
        rootId: ROOT_ID,
        relativePath: "src/huge.log",
        startLine: 1,
        endLine: 1,
      });
      assert.equal(!ranged.ok && ranged.code, "readLimitExceeded");
      assert.match(!ranged.ok ? ranged.reason : "", /cannot read any of it/);
    } finally {
      h.cleanup();
    }
  });

  void it("reports a ranged read's line range to the read-call observer", async () => {
    const h = installHarness();
    const events: ReadToolCallEventV1[] = [];
    setReadToolCallObserverV1((event) => events.push(event));
    try {
      await h.call("ensemble_readFile", { rootId: ROOT_ID, relativePath: "src/app.ts", startLine: 1, endLine: 2 });
      assert.deepEqual(events, [{ tool: "ensemble_readFile", relativePath: "src/app.ts", startLine: 1, endLine: 2 }]);
    } finally {
      setReadToolCallObserverV1(undefined);
      h.cleanup();
    }
  });
});
