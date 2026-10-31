/**
 * bugs3 Step 14: the last readable CLI major is kept between windows, so a
 * `--version` probe that fails does not flip a devpass-code 1.x install onto the
 * 2.x command contract (or the reverse).
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { afterEach, describe, it } from "node:test";

import {
  clearCliMajorVersionCacheV1,
  getCliMajorVersionV1,
  lastKnownCliMajorV1,
  setCliMajorPersistenceV1,
  type CliMajorPersistenceV1,
} from "../utils/cliMajorVersionV1";

function memoryStore(initial: Record<string, number> = {}): CliMajorPersistenceV1 & {
  readonly values: Record<string, number>;
  saves: number;
} {
  const store = {
    values: { ...initial },
    saves: 0,
    load: (command: string): number | undefined => store.values[command],
    save: (command: string, major: number): void => {
      store.saves += 1;
      store.values[command] = major;
    },
  };
  return store;
}

const MISSING_COMMAND = "ensemble-no-such-cli-for-version-probe";

afterEach(() => {
  setCliMajorPersistenceV1(undefined);
  clearCliMajorVersionCacheV1();
});

void describe("persisted CLI major (bugs3 Step 14)", () => {
  void it("remembers a readable major and does not rewrite an unchanged one", async () => {
    const store = memoryStore();
    setCliMajorPersistenceV1(store);
    const major = await getCliMajorVersionV1(process.execPath);
    assert.equal(major, Number(process.versions.node.split(".")[0]));
    assert.equal(store.values[process.execPath], major);
    assert.equal(store.saves, 1);
    clearCliMajorVersionCacheV1();
    await getCliMajorVersionV1(process.execPath);
    assert.equal(store.saves, 1, "the same major is not saved again");
  });

  void it("a failed probe resolves to the major last reported on this machine", async () => {
    setCliMajorPersistenceV1(memoryStore({ [MISSING_COMMAND]: 1 }));
    assert.equal(await getCliMajorVersionV1(MISSING_COMMAND), 1);
    assert.equal(lastKnownCliMajorV1(MISSING_COMMAND), 1);
  });

  void it("a failed probe with nothing remembered stays unreadable, so the default contract applies", async () => {
    setCliMajorPersistenceV1(memoryStore());
    assert.equal(await getCliMajorVersionV1(MISSING_COMMAND), undefined);
    setCliMajorPersistenceV1(undefined);
    assert.equal(await getCliMajorVersionV1(MISSING_COMMAND), undefined);
  });

  void it("a store that throws or holds junk never breaks the probe", async () => {
    setCliMajorPersistenceV1({
      load: () => {
        throw new Error("state unavailable");
      },
      save: () => {
        throw new Error("state unavailable");
      },
    });
    assert.equal(await getCliMajorVersionV1(MISSING_COMMAND), undefined);
    assert.equal(await getCliMajorVersionV1(process.execPath), Number(process.versions.node.split(".")[0]));
    setCliMajorPersistenceV1({ load: () => 1.5, save: () => undefined });
    assert.equal(lastKnownCliMajorV1(MISSING_COMMAND), undefined);
  });

  void it("wiring: activation installs the store before any dispatch or discovery can probe", () => {
    const source = fs.readFileSync(path.resolve(__dirname, "..", "..", "src", "extension.ts"), "utf8");
    const install = source.indexOf("setCliMajorPersistenceV1({");
    const warm = source.indexOf("void warmCliModelCache();");
    assert.ok(install > 0 && warm > install, "the store must be installed before the model-cache warm-up");
    assert.match(source.slice(install, install + 400), /context\.globalState/);
  });
});
