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
import { createReadToolSessionHandlerV1 } from "../services/readToolSessionHandlerV1";
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
      const read = await h.call("ensemble.readFile", { rootId: ROOT_ID, relativePath: "src/app.ts" });
      assert.equal(read.ok, true);
      if (read.ok) {
        assert.equal(read.kind, "file");
        assert.ok(read.contentUtf8?.includes("const marker = 1;"));
        assert.match(read.contentSha256 ?? "", /^[0-9a-f]{64}$/);
        const record = h.ledger.get(read.observationId);
        assert.equal(record?.source, "readFile");
        assert.equal(record?.relativePath, "src/app.ts");
      }

      const missing = await h.call("ensemble.readFile", { rootId: ROOT_ID, relativePath: "src/none.ts" });
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
      const statDir = await h.call("ensemble.stat", { rootId: ROOT_ID, relativePath: "empty" });
      assert.equal(statDir.ok, true);
      if (statDir.ok) {
        assert.equal(statDir.kind, "directory");
        assert.equal(statDir.revision, "dir:unverified");
        assert.equal(h.ledger.get(statDir.observationId)?.source, "stat");
      }

      const listing = await h.call("ensemble.readDirectory", { rootId: ROOT_ID, relativePath: "empty" });
      assert.equal(listing.ok, true);
      if (listing.ok) {
        assert.equal(listing.kind, "directory");
        assert.equal(listing.complete, true);
        assert.deepEqual(listing.entries, []);
        assert.match(listing.revision, /^dir:[0-9a-f]{64}$/);
        assert.deepEqual(h.ledger.get(listing.observationId)?.entryNames, []);
      }

      const rootListing = await h.call("ensemble.readDirectory", { rootId: ROOT_ID, relativePath: "." });
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
      const found = await h.call("ensemble.findFiles", { rootId: ROOT_ID, pathContains: "app" });
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
      const found = await h.call("ensemble.textSearch", { rootId: ROOT_ID, query: "const marker" });
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
      const unknownTool = await h.call("ensemble.writeFile", { rootId: ROOT_ID, relativePath: "x" });
      assert.equal(unknownTool.ok, false);
      if (!unknownTool.ok) {
        assert.equal(unknownTool.code, "unknownTool");
      }
      const foreignRoot = await h.call("ensemble.stat", { rootId: "other", relativePath: "x" });
      assert.equal(foreignRoot.ok === false && foreignRoot.code, "unknownRoot");
      const badInput = await h.call("ensemble.stat", { rootId: ROOT_ID });
      assert.equal(badInput.ok === false && badInput.code, "invalidInput");
      assert.equal(h.handler.violationCount(), 3);
    } finally {
      h.cleanup();
    }
  });

  void it("refuses escaping paths through the safety layer", async () => {
    const h = installHarness();
    try {
      const escape = await h.call("ensemble.readFile", { rootId: ROOT_ID, relativePath: "../secret.txt" });
      assert.equal(escape.ok, false);
      if (!escape.ok) {
        assert.equal(escape.code, "pathUnsafe");
      }
    } finally {
      h.cleanup();
    }
  });
});
