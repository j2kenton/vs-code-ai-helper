/**
 * Coverage for the §1.8 workflow file store: exclusive creation,
 * revision-guarded replacement/deletion, bounded reads, bounded nonrecursive
 * directory listing, nonrecursive directory operations, untrusted-root
 * mutation rejection, and the stable unavailable codes for unsupported roots
 * and unsafe paths.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { describe, it } from "node:test";
import {
  createWorkflowFileStoreV1,
  WorkflowFileStoreResultV1,
  WorkflowFileStoreV1,
} from "../services/workflowFileStoreV1";

interface StoreFixture {
  rootDir: string;
  store: WorkflowFileStoreV1;
  cleanup(): void;
}

function makeStore(trustedForMutation = true): StoreFixture {
  const rootDir = fs.mkdtempSync(path.join(os.tmpdir(), "ensemble-file-store-"));
  const store = createWorkflowFileStoreV1([
    { rootId: "root", fsPath: rootDir, trustedForMutation },
  ]);
  return {
    rootDir,
    store,
    cleanup: (): void => fs.rmSync(rootDir, { recursive: true, force: true }),
  };
}

function expectOk<T>(result: WorkflowFileStoreResultV1<T>): T {
  assert.equal(result.kind, "ok", `expected ok, got ${JSON.stringify(result)}`);
  return (result as { kind: "ok"; value: T }).value;
}

function expectFailed<T>(result: WorkflowFileStoreResultV1<T>, code: string): void {
  assert.equal(result.kind, "failed", `expected failed/${code}, got ${JSON.stringify(result)}`);
  assert.equal((result as { kind: "failed"; code: string }).code, code);
}

function expectUnavailable<T>(result: WorkflowFileStoreResultV1<T>, code: string): void {
  assert.equal(result.kind, "unavailable", `expected unavailable/${code}, got ${JSON.stringify(result)}`);
  assert.equal((result as { kind: "unavailable"; code: string }).code, code);
}

void describe("workflowFileStoreV1", () => {
  void it("creates exclusively, reads back, and refuses a second creation", async () => {
    const fixture = makeStore();
    try {
      const locator = { rootId: "root", relativePath: "file.txt" };
      const created = expectOk(await fixture.store.createFileExclusive(locator, Buffer.from("one")));
      assert.match(created.revision, /^v1:\d+:\d+:\d+$/);

      const read = expectOk(await fixture.store.readFileBounded(locator, 1024));
      assert.equal(read.bytes.toString("utf8"), "one");
      assert.equal(read.revision, created.revision);
      assert.equal(read.sha256, created.sha256);

      expectFailed(await fixture.store.createFileExclusive(locator, Buffer.from("two")), "targetExists");
      // The clobber attempt must not have altered the original.
      const after = expectOk(await fixture.store.readFileBounded(locator, 1024));
      assert.equal(after.bytes.toString("utf8"), "one");
    } finally {
      fixture.cleanup();
    }
  });

  void it("fails creation into a missing parent instead of mkdir -p", async () => {
    const fixture = makeStore();
    try {
      expectFailed(
        await fixture.store.createFileExclusive(
          { rootId: "root", relativePath: "no-parent/file.txt" },
          Buffer.from("x")
        ),
        "parentMissing"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("bounds reads by the open handle's size", async () => {
    const fixture = makeStore();
    try {
      const locator = { rootId: "root", relativePath: "big.bin" };
      expectOk(await fixture.store.createFileExclusive(locator, Buffer.alloc(64, 7)));
      expectFailed(await fixture.store.readFileBounded(locator, 63), "readLimitExceeded");
      const read = expectOk(await fixture.store.readFileBounded(locator, 64));
      assert.equal(read.bytes.length, 64);
      expectFailed(
        await fixture.store.readFileBounded({ rootId: "root", relativePath: "absent.bin" }, 16),
        "targetMissing"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("lists directories nonrecursively with an entry-count bound", async () => {
    const fixture = makeStore();
    try {
      expectFailed(
        await fixture.store.listDirectoryBounded({ rootId: "root", relativePath: "absent" }, 16),
        "targetMissing"
      );

      expectOk(await fixture.store.createDirectory({ rootId: "root", relativePath: "family" }));
      expectOk(await fixture.store.createDirectory({ rootId: "root", relativePath: "family/sub" }));
      expectOk(
        await fixture.store.createFileExclusive(
          { rootId: "root", relativePath: "family/a.json" },
          Buffer.from("{}")
        )
      );

      const listed = expectOk(
        await fixture.store.listDirectoryBounded({ rootId: "root", relativePath: "family" }, 16)
      );
      assert.deepEqual(listed, [
        { name: "a.json", kind: "file" },
        { name: "sub", kind: "directory" },
      ]);

      // Bounded: more entries than the ceiling fails closed, never truncates.
      expectFailed(
        await fixture.store.listDirectoryBounded({ rootId: "root", relativePath: "family" }, 1),
        "readLimitExceeded"
      );
      // A file target is not listable.
      expectFailed(
        await fixture.store.listDirectoryBounded({ rootId: "root", relativePath: "family/a.json" }, 16),
        "notADirectory"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("replaces only on an exact revision match", async () => {
    const fixture = makeStore();
    try {
      const locator = { rootId: "root", relativePath: "doc.md" };
      const created = expectOk(await fixture.store.createFileExclusive(locator, Buffer.from("v1")));

      const replaced = expectOk(
        await fixture.store.replaceFileExact(locator, Buffer.from("v2"), created.revision)
      );
      assert.notEqual(replaced.revision, created.revision);
      assert.equal(
        expectOk(await fixture.store.readFileBounded(locator, 1024)).bytes.toString("utf8"),
        "v2"
      );

      // The old revision is now stale: the replace must refuse and leave v2.
      expectFailed(
        await fixture.store.replaceFileExact(locator, Buffer.from("v3"), created.revision),
        "revisionMismatch"
      );
      assert.equal(
        expectOk(await fixture.store.readFileBounded(locator, 1024)).bytes.toString("utf8"),
        "v2"
      );
      // No temp litter left behind in the root.
      const leftovers = fs.readdirSync(fixture.rootDir).filter((name) => name.includes(".tmp"));
      assert.deepEqual(leftovers, []);

      expectFailed(
        await fixture.store.replaceFileExact(
          { rootId: "root", relativePath: "absent.md" },
          Buffer.from("x"),
          created.revision
        ),
        "targetMissing"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("deletes only on an exact revision match and verifies removal", async () => {
    const fixture = makeStore();
    try {
      const locator = { rootId: "root", relativePath: "gone.txt" };
      const created = expectOk(await fixture.store.createFileExclusive(locator, Buffer.from("data")));

      // Out-of-band modification invalidates the recorded revision.
      fs.writeFileSync(path.join(fixture.rootDir, "gone.txt"), "changed");
      expectFailed(await fixture.store.deleteFileExact(locator, created.revision), "revisionMismatch");

      const current = expectOk(await fixture.store.stat(locator));
      assert.equal(current.kind, "file");
      expectOk(await fixture.store.deleteFileExact(locator, current.revision ?? ""));
      assert.equal(expectOk(await fixture.store.stat(locator)).kind, "missing");
      expectFailed(await fixture.store.deleteFileExact(locator, "v1:0:0:0"), "targetMissing");
    } finally {
      fixture.cleanup();
    }
  });

  void it("creates and removes directories nonrecursively", async () => {
    const fixture = makeStore();
    try {
      expectFailed(
        await fixture.store.createDirectory({ rootId: "root", relativePath: "a/b" }),
        "parentMissing"
      );
      expectOk(await fixture.store.createDirectory({ rootId: "root", relativePath: "a" }));
      expectOk(await fixture.store.createDirectory({ rootId: "root", relativePath: "a/b" }));
      expectFailed(
        await fixture.store.createDirectory({ rootId: "root", relativePath: "a" }),
        "targetExists"
      );

      expectFailed(
        await fixture.store.deleteEmptyDirectory({ rootId: "root", relativePath: "a" }),
        "directoryNotEmpty"
      );
      expectOk(await fixture.store.deleteEmptyDirectory({ rootId: "root", relativePath: "a/b" }));
      expectOk(await fixture.store.deleteEmptyDirectory({ rootId: "root", relativePath: "a" }));
      expectFailed(
        await fixture.store.deleteEmptyDirectory({ rootId: "root", relativePath: "a" }),
        "targetMissing"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("keeps untrusted roots readable but rejects every mutation", async () => {
    const trusted = makeStore();
    try {
      // Seed via direct fs so the untrusted store has something to read.
      fs.writeFileSync(path.join(trusted.rootDir, "seed.txt"), "readable");
      const untrusted = createWorkflowFileStoreV1([
        { rootId: "root", fsPath: trusted.rootDir, trustedForMutation: false },
      ]);
      const locator = { rootId: "root", relativePath: "seed.txt" };
      assert.equal(
        expectOk(await untrusted.readFileBounded(locator, 1024)).bytes.toString("utf8"),
        "readable"
      );
      expectUnavailable(await untrusted.createFileExclusive({ rootId: "root", relativePath: "new.txt" }, Buffer.from("x")), "workspaceRootUnsupported");
      expectUnavailable(await untrusted.replaceFileExact(locator, Buffer.from("x"), "v1:0:0:0"), "workspaceRootUnsupported");
      expectUnavailable(await untrusted.deleteFileExact(locator, "v1:0:0:0"), "workspaceRootUnsupported");
      expectUnavailable(await untrusted.createDirectory({ rootId: "root", relativePath: "dir" }), "workspaceRootUnsupported");
      expectUnavailable(await untrusted.deleteEmptyDirectory({ rootId: "root", relativePath: "dir" }), "workspaceRootUnsupported");
      // Nothing was mutated.
      assert.deepEqual(fs.readdirSync(trusted.rootDir).sort(), ["seed.txt"]);
    } finally {
      trusted.cleanup();
    }
  });

  void it("re-consults a live trust predicate on every mutation, independent of the one-time trustedForMutation flag", async () => {
    const fixture = makeStore();
    try {
      fs.writeFileSync(path.join(fixture.rootDir, "seed.txt"), "readable");
      let liveTrust = false;
      const store = createWorkflowFileStoreV1([
        {
          rootId: "root",
          fsPath: fixture.rootDir,
          trustedForMutation: true,
          isCurrentlyTrustedForMutation: (): boolean => liveTrust,
        },
      ]);
      const locator = { rootId: "root", relativePath: "seed.txt" };

      // Reads never consult the mutation predicate.
      assert.equal((await store.readFileBounded(locator, 1024)).kind, "ok");

      // Trust withdrawn: every mutation is rejected, nothing on disk changes.
      expectUnavailable(
        await store.createFileExclusive({ rootId: "root", relativePath: "new.txt" }, Buffer.from("x")),
        "workspaceRootUnsupported"
      );
      expectUnavailable(
        await store.replaceFileExact(locator, Buffer.from("x"), "v1:0:0:0"),
        "workspaceRootUnsupported"
      );
      expectUnavailable(await store.deleteFileExact(locator, "v1:0:0:0"), "workspaceRootUnsupported");
      expectUnavailable(
        await store.createDirectory({ rootId: "root", relativePath: "dir" }),
        "workspaceRootUnsupported"
      );
      assert.deepEqual(fs.readdirSync(fixture.rootDir).sort(), ["seed.txt"]);

      // Trust re-granted (e.g. a later re-verification succeeds): the SAME
      // store instance and locator now mutate — proving the check is live,
      // not cached at store construction.
      liveTrust = true;
      expectOk(await store.createFileExclusive({ rootId: "root", relativePath: "new.txt" }, Buffer.from("x")));
    } finally {
      fixture.cleanup();
    }
  });

  void it("returns stable unavailable codes for unknown roots and unsafe paths", async () => {
    const fixture = makeStore();
    try {
      expectUnavailable(
        await fixture.store.stat({ rootId: "unregistered", relativePath: "x" }),
        "workspaceRootUnsupported"
      );
      expectUnavailable(
        await fixture.store.stat({ rootId: "root", relativePath: "../escape.txt" }),
        "workspacePathUnsafe"
      );
      expectUnavailable(
        await fixture.store.createFileExclusive(
          { rootId: "root", relativePath: "bad\\slash.txt" },
          Buffer.from("x")
        ),
        "workspacePathUnsafe"
      );
    } finally {
      fixture.cleanup();
    }
  });

  void it("refuses to mutate through a link component", async () => {
    const fixture = makeStore();
    try {
      fs.mkdirSync(path.join(fixture.rootDir, "real"));
      const linkType = process.platform === "win32" ? "junction" : "dir";
      fs.symlinkSync(path.join(fixture.rootDir, "real"), path.join(fixture.rootDir, "linked"), linkType);
      expectUnavailable(
        await fixture.store.createFileExclusive(
          { rootId: "root", relativePath: "linked/file.txt" },
          Buffer.from("x")
        ),
        "workspacePathUnsafe"
      );
      expectUnavailable(
        await fixture.store.readFileBounded({ rootId: "root", relativePath: "linked/file.txt" }, 16),
        "workspacePathUnsafe"
      );
      assert.deepEqual(fs.readdirSync(path.join(fixture.rootDir, "real")), []);
    } finally {
      fixture.cleanup();
    }
  });
});
