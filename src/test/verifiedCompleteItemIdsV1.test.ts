import { afterEach, beforeEach, describe, it } from "node:test";
import * as assert from "node:assert/strict";
import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import {
  deriveApplicableVerifiedTicksV1,
  recordReviewerVerificationOfTickedItemsV1,
  writeVerifiedTicksToPlanV1,
} from "../commands/applyReviewerVerifiedTicks";
import { setExtensionContextV1 } from "../utils/extensionContextV1";
import {
  formatProvisionalTickedItemsForReviewerV1,
  listCheckedVerificationTargetsV1,
  listPlanItemIdsV1,
  resolveVerifiedCompleteEntryTextsV1,
} from "../utils/implementationChecklist";
import { parseReviewVerifiedCompleteV1 } from "../utils/reviewReadiness";
import { makeOwnedTaskFolder } from "./taskFolderFixture";
import { safeRemoveDir } from "./testFsUtils";

// review1 (owner decision 2026-11-05, item identity by design): reviews get the same `[item:<id>]` list rounds get,
// and `## Verified Complete` cites `[item:<id>]` or a `Step N` that names exactly one item. Ensemble records a
// verification only for an id it issued; text alone is the fallback and counts only when it names one item.

const SHARED = [
  "<!-- ensemble:implementation-checklist -->",
  "",
  "- [x] Step 1: Parent",
  "  - [x] Shared wording",
  "- [x] Shared wording",
  "",
].join("\n");

const review = (...lines: string[]): string =>
  ["Readiness: 9/10", "", "<!-- verified-complete:start -->", ...lines, "<!-- verified-complete:end -->", ""].join("\n");

const idOf = (plan: string, nested: boolean, text: string): string => {
  const found = listPlanItemIdsV1(plan).find((entry) => entry.nested === nested && entry.itemText === text);
  assert.ok(found, `no ${nested ? "nested" : "top-level"} item "${text}"`);
  return found.itemId;
};

void describe("parseReviewVerifiedCompleteV1 — item ids", () => {
  const id = "0123456789abcdef";

  void it("reads [item:<id>] with a label, with the evidence line attached", () => {
    const parsed = parseReviewVerifiedCompleteV1(review(`- [item:${id}] Step 3: Add the thing`, "  evidence: opened src/a.ts"));
    assert.deepEqual(parsed.entries, [{ text: "Step 3: Add the thing", itemId: id, evidence: "opened src/a.ts" }]);
    assert.deepEqual(parsed.items, ["Step 3: Add the thing"]);
  });

  void it("reads an id with no label, in bold or backticks, and lower-cases it", () => {
    const parsed = parseReviewVerifiedCompleteV1(
      review(`- item:${id.toUpperCase()}`, `- **[item:${id}]** — Labelled`, `- \`item:${id}\``)
    );
    assert.deepEqual(
      parsed.entries.map((entry) => [entry.itemId, entry.text]),
      [
        [id, `item:${id}`],
        [id, "Labelled"],
        [id, `item:${id}`],
      ]
    );
  });

  void it("leaves a plain text entry, and a Step N entry, without an id", () => {
    const parsed = parseReviewVerifiedCompleteV1(review("- Step 4: Plain item", "- Step 7"));
    assert.deepEqual(
      parsed.entries.map((entry) => entry.itemId),
      [undefined, undefined]
    );
    assert.deepEqual(parsed.items, ["Step 4: Plain item", "Step 7"]);
  });

  void it("does not read a 15- or 17-character hex run as an id", () => {
    const parsed = parseReviewVerifiedCompleteV1(review("- item:0123456789abcde label", "- item:0123456789abcdef0 label"));
    assert.deepEqual(
      parsed.entries.map((entry) => entry.itemId),
      [undefined, undefined]
    );
  });
});

void describe("listCheckedVerificationTargetsV1 — item ids", () => {
  void it("verifies two same-worded items at different levels, each by its own id", () => {
    const child = idOf(SHARED, true, "Shared wording");
    const top = idOf(SHARED, false, "Shared wording");
    assert.notEqual(child, top);
    const resolved = listCheckedVerificationTargetsV1(SHARED, [
      { text: "Shared wording", itemId: child, evidence: "child evidence" },
      { text: "Shared wording", itemId: top, evidence: "top evidence" },
    ]);
    assert.deepEqual(resolved.ambiguous, []);
    assert.deepEqual(resolved.unknownIds, []);
    assert.deepEqual(
      resolved.targets.map((entry) => entry.nested),
      [true, false]
    );
    const evidence = resolved.targets.map((entry) => resolved.sources.get(entry)?.evidence);
    assert.deepEqual(evidence, ["child evidence", "top evidence"]);
  });

  void it("verifies only the item an id was issued for, not its same-worded twin", () => {
    const top = idOf(SHARED, false, "Shared wording");
    const resolved = listCheckedVerificationTargetsV1(SHARED, [{ text: "Shared wording", itemId: top }]);
    assert.deepEqual(
      resolved.targets.map((entry) => entry.nested),
      [false]
    );
  });

  void it("reports an unknown id and records no target for it", () => {
    const resolved = listCheckedVerificationTargetsV1(SHARED, [
      { text: "item:ffffffffffffffff", itemId: "ffffffffffffffff" },
      { text: "Step 1: Parent" },
    ]);
    assert.deepEqual(resolved.unknownIds, [{ id: "ffffffffffffffff", text: "item:ffffffffffffffff" }]);
    assert.deepEqual(
      resolved.targets.map((entry) => entry.text),
      ["Step 1: Parent"]
    );
  });

  void it("reads a bare Step N that names exactly one item, and none when it names several", () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [x] Step 2: One", "- [x] Step 3: Two", "- [x] Step 3: Other", ""].join(
      "\n"
    );
    const one = listCheckedVerificationTargetsV1(plan, ["Step 2"]);
    assert.deepEqual(
      one.targets.map((entry) => entry.text),
      ["Step 2: One"]
    );
    const several = listCheckedVerificationTargetsV1(plan, ["Step 3"]);
    assert.deepEqual(several.targets, []);
    assert.deepEqual(several.ambiguous, [{ text: "Step 3", matches: 2 }]);
  });

  void it("an id for an unticked item verifies nothing", () => {
    const plan = SHARED.replace("\n- [x] Shared wording", "\n- [ ] Shared wording");
    const top = idOf(plan, false, "Shared wording");
    assert.deepEqual(listCheckedVerificationTargetsV1(plan, [{ text: "Shared wording", itemId: top }]).targets, []);
  });
});

void describe("resolveVerifiedCompleteEntryTextsV1", () => {
  void it("reads an issued id as the item's own text, drops an unissued id, and drops shared wording", () => {
    const plan = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Step 1: Alpha", "- [ ] Twin", "- [ ] Twin", ""].join("\n");
    const alpha = idOf(plan, false, "Step 1: Alpha");
    const twin = listPlanItemIdsV1(plan).find((entry) => entry.itemText === "Twin")!.itemId;
    const resolved = resolveVerifiedCompleteEntryTextsV1(plan, [
      { text: "item:" + alpha, itemId: alpha, evidence: "saw it" },
      { text: "item:eeeeeeeeeeeeeeee", itemId: "eeeeeeeeeeeeeeee" },
      { text: "item:" + twin, itemId: twin },
      { text: "Plain text entry" },
    ]);
    assert.deepEqual(resolved.entries, [{ text: "Step 1: Alpha", evidence: "saw it" }, { text: "Plain text entry" }]);
    assert.deepEqual(resolved.unknownIds, [{ id: "eeeeeeeeeeeeeeee", text: "item:eeeeeeeeeeeeeeee" }]);
    assert.equal(resolved.ambiguous.length, 1);
  });
});

void describe("the provisional list shown to a reviewer carries item ids", () => {
  void it("lists [item:<id>] for a provisional item and for its unverified child", () => {
    const text = formatProvisionalTickedItemsForReviewerV1(SHARED, []);
    const top = idOf(SHARED, false, "Step 1: Parent");
    const child = idOf(SHARED, true, "Shared wording");
    assert.match(text, new RegExp(`- \\[item:${top}\\] Step 1: Parent`));
    assert.match(text, new RegExp(`  - \\[item:${child}\\] Shared wording \\[nested: verify separately\\]`));
    assert.match(text, /by its `\[item:<id>\]`/);
  });
});

void describe("recordReviewerVerificationOfTickedItemsV1 — item ids", () => {
  const roots: string[] = [];
  const fsApi = vscode.workspace.fs as unknown as Record<string, unknown>;
  const original = { ...fsApi };

  beforeEach(() => {
    fsApi.readFile = (uri: vscode.Uri): Promise<Uint8Array> => fs.promises.readFile(uri.fsPath);
    fsApi.writeFile = (uri: vscode.Uri, data: Uint8Array): Promise<void> => fs.promises.writeFile(uri.fsPath, data);
    fsApi.createDirectory = (): Promise<void> => Promise.resolve();
    fsApi.readDirectory = (): Promise<Array<[string, number]>> => Promise.resolve([]);
    fsApi.stat = (uri: vscode.Uri): Promise<unknown> => fs.promises.stat(uri.fsPath);
    const backing = new Map<string, unknown>();
    const memento = {
      get: <T>(key: string, fallback?: T): T => (backing.has(key) ? (backing.get(key) as T) : (fallback as T)),
      update: (key: string, value: unknown): Promise<void> => {
        if (value === undefined) backing.delete(key);
        else backing.set(key, value);
        return Promise.resolve();
      },
      keys: () => [...backing.keys()],
    } as unknown as vscode.Memento;
    setExtensionContextV1({ globalState: memento, workspaceState: memento, subscriptions: [] } as unknown as vscode.ExtensionContext);
  });
  afterEach(() => {
    Object.assign(fsApi, original);
    setExtensionContextV1(undefined as unknown as vscode.ExtensionContext);
    for (const root of roots.splice(0)) safeRemoveDir(root);
  });

  function stage(plan: string, reviewText: string): string {
    const { folder } = makeOwnedTaskFolder("verified-item-ids-");
    roots.push(path.dirname(path.dirname(folder)));
    const progressPath = path.join(folder, "task-progress.json");
    const progress = JSON.parse(fs.readFileSync(progressPath, "utf8")) as Record<string, unknown>;
    progress.currentStage = "impl-high-review";
    progress.status = "active";
    fs.writeFileSync(progressPath, JSON.stringify(progress));
    fs.writeFileSync(path.join(folder, "plan-final.md"), plan);
    fs.writeFileSync(path.join(folder, "impl-high-review.md"), reviewText);
    return folder;
  }

  const chatTexts = (folder: string): string[] => {
    const file = path.join(folder, "chat-v1.json");
    if (!fs.existsSync(file)) return [];
    return ((JSON.parse(fs.readFileSync(file, "utf8")) as { messages?: Array<{ text: string }> }).messages ?? []).map(
      (message) => message.text
    );
  };
  const verifiedRows = (folder: string): Array<{ itemKey: string; itemNested?: boolean; verifications?: Array<{ evidence?: string }> }> =>
    (
      (JSON.parse(fs.readFileSync(path.join(folder, "task-progress.json"), "utf8")) as { planItemEvidence?: unknown[] })
        .planItemEvidence ?? []
    ).filter((row) => ((row as { verifications?: unknown[] }).verifications?.length ?? 0) > 0) as Array<{
      itemKey: string;
      itemNested?: boolean;
      verifications?: Array<{ evidence?: string }>;
    }>;

  void it("a same-worded top-level item and child are each verified by their own id, with their own evidence", async () => {
    const top = idOf(SHARED, false, "Shared wording");
    const child = idOf(SHARED, true, "Shared wording");
    const folder = stage(
      SHARED,
      review(`- [item:${child}] Shared wording`, "  evidence: child checked", `- [item:${top}] Shared wording`, "  evidence: top checked")
    );
    assert.equal(await recordReviewerVerificationOfTickedItemsV1(vscode.Uri.file(folder), "impl-high-review"), 2);
    const rows = verifiedRows(folder);
    assert.equal(rows.length, 2);
    const byLevel = new Map(rows.map((row) => [row.itemNested === true ? "nested" : "top", row.verifications?.[0]?.evidence]));
    assert.equal(byLevel.get("nested"), "child checked");
    assert.equal(byLevel.get("top"), "top checked");
    assert.deepEqual(chatTexts(folder).filter((text) => /verified none of them/.test(text)), []);
  });

  void it("an unknown id records nothing and is named in the chat", async () => {
    const folder = stage(SHARED, review("- [item:ffffffffffffffff] Made up", "  evidence: guessed"));
    assert.equal(await recordReviewerVerificationOfTickedItemsV1(vscode.Uri.file(folder), "impl-high-review"), 0);
    assert.deepEqual(verifiedRows(folder), []);
    const lines = chatTexts(folder).filter((text) => /did not issue/.test(text));
    assert.equal(lines.length, 1);
    assert.match(lines[0]!, /item:ffffffffffffffff \("Made up"\)/);
    assert.match(lines[0]!, /impl-high-review\.md/);
  });

  // review1 (review fix, 2026-11-05): the tick-applying path keeps the issued id through selection and application.
  const planTicks = (folder: string): string[] =>
    fs
      .readFileSync(path.join(folder, "plan-final.md"), "utf8")
      .split("\n")
      .filter((line) => /^\s*- \[[ x]\]/.test(line));

  void it("an issued id ticks the unchecked child, not the same-worded parent, and verifies that child", async () => {
    const OPEN = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Shared wording", "  - [ ] Shared wording", ""].join("\n");
    const child = idOf(OPEN, true, "Shared wording");
    const folder = stage(OPEN, review(`- [item:${child}] Shared wording`, "  evidence: child checked"));
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    assert.deepEqual(derived.derivation.applicable, ["Shared wording"]);
    assert.deepEqual(derived.derivation.applicableItemIds, [child]);
    assert.deepEqual(derived.derivation.applicableEvidence, ["child checked"]);
    const written = await writeVerifiedTicksToPlanV1(vscode.Uri.file(folder), derived.derivation);
    assert.deepEqual(written, { kind: "applied", count: 1 });
    assert.equal(planTicks(folder)[0], "- [ ] Shared wording");
    assert.match(planTicks(folder)[1]!, /^ {2}- \[x\] Shared wording/);
    const rows = verifiedRows(folder);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]!.itemNested, true);
    assert.equal(rows[0]!.verifications?.[0]?.evidence, "child checked");
  });

  void it("an issued id ticks the second of two same-level twins, not the first", async () => {
    const TWINS = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Twin", "- [ ] Twin", ""].join("\n");
    const second = listPlanItemIdsV1(TWINS).filter((entry) => entry.itemText === "Twin")[1]!.itemId;
    const folder = stage(TWINS, review(`- [item:${second}] Twin`, "  evidence: second checked"));
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    assert.deepEqual(derived.derivation.applicableItemIds, [second]);
    assert.deepEqual(await writeVerifiedTicksToPlanV1(vscode.Uri.file(folder), derived.derivation), { kind: "applied", count: 1 });
    const ticks = planTicks(folder);
    assert.equal(ticks[0], "- [ ] Twin");
    assert.match(ticks[1]!, /^- \[x\] Twin/);
  });

  void it("two same-worded items each named by their own id are both ticked, each with its own evidence", async () => {
    const TWINS = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Twin", "- [ ] Twin", ""].join("\n");
    const [first, second] = listPlanItemIdsV1(TWINS).filter((entry) => entry.itemText === "Twin").map((entry) => entry.itemId);
    const folder = stage(
      TWINS,
      review(`- [item:${second}] Twin`, "  evidence: second checked", `- [item:${first}] Twin`, "  evidence: first checked")
    );
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    assert.deepEqual(derived.derivation.applicableItemIds, [second, first]);
    assert.deepEqual(await writeVerifiedTicksToPlanV1(vscode.Uri.file(folder), derived.derivation), { kind: "applied", count: 2 });
    assert.ok(planTicks(folder).every((line) => /\[x\]/.test(line)));
    const evidence = verifiedRows(folder).flatMap((row) => row.verifications?.map((entry) => entry.evidence) ?? []).sort();
    assert.deepEqual(evidence, ["first checked", "second checked"]);
  });

  void it("an unissued id is not applied, and a card scoped to one twin does not apply the other", async () => {
    const TWINS = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Twin", "- [ ] Twin", ""].join("\n");
    const [first, second] = listPlanItemIdsV1(TWINS).filter((entry) => entry.itemText === "Twin").map((entry) => entry.itemId);
    const unknown = stage(TWINS, review("- [item:ffffffffffffffff] Twin", "  evidence: guessed"));
    assert.equal((await deriveApplicableVerifiedTicksV1(vscode.Uri.file(unknown), "impl-high-review")).kind, "blocked");
    const scoped = stage(TWINS, review(`- [item:${first}] Twin`, "  evidence: a", `- [item:${second}] Twin`, "  evidence: b"));
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(scoped), "impl-high-review", ["Twin"]);
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    assert.deepEqual(derived.derivation.applicableItemIds, [first]);
  });

  // review1 (review fix, 2026-11-06): the selected id is kept across the stale boundaries.
  const TWINS = ["<!-- ensemble:implementation-checklist -->", "", "- [ ] Twin", "- [ ] Twin", ""].join("\n");
  const twinIds = (): [string, string] => {
    const [first, second] = listPlanItemIdsV1(TWINS).filter((entry) => entry.itemText === "Twin").map((entry) => entry.itemId);
    return [first!, second!];
  };

  void it("a stale card that offered the first twin does not apply the second when a newer review verifies only the second", async () => {
    const [first, second] = twinIds();
    const folder = stage(TWINS, review(`- [item:${second}] Twin`, "  evidence: second checked"));
    // The card was posted when the review named the first twin: it offered "Twin" with the first twin's id.
    const stale = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review", ["Twin"], [first]);
    assert.equal(stale.kind, "blocked");
    // The same card, scoped by wording alone (an older card without ids), keeps its old behaviour.
    const legacy = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review", ["Twin"]);
    assert.equal(legacy.kind, "ok");
    // A card that offered the second twin by its id applies it.
    const own = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review", ["Twin"], [second]);
    assert.equal(own.kind, "ok");
    if (own.kind === "ok") assert.deepEqual(own.derivation.applicableItemIds, [second]);
  });

  void it("a card that offered both twins by id applies only the ones it offered, in any order", async () => {
    const [first, second] = twinIds();
    const folder = stage(TWINS, review(`- [item:${first}] Twin`, "  evidence: a", `- [item:${second}] Twin`, "  evidence: b"));
    const onlySecond = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review", ["Twin"], [second]);
    assert.equal(onlySecond.kind, "ok");
    if (onlySecond.kind === "ok") {
      assert.deepEqual(onlySecond.derivation.applicableItemIds, [second]);
      assert.deepEqual(onlySecond.derivation.applicableEvidence, ["b"]);
    }
  });

  void it("a selected twin that was ticked before the write is dropped, never replaced by its still-open twin", async () => {
    const [first, second] = twinIds();
    const folder = stage(TWINS, review(`- [item:${first}] Twin`, "  evidence: first checked"));
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    assert.deepEqual(derived.derivation.applicableItemIds, [first]);
    // Between derivation and the write, the owner ticked the first twin.
    fs.writeFileSync(
      path.join(folder, "plan-final.md"),
      ["<!-- ensemble:implementation-checklist -->", "", "- [x] Twin", "- [ ] Twin", ""].join("\n")
    );
    assert.deepEqual(await writeVerifiedTicksToPlanV1(vscode.Uri.file(folder), derived.derivation), { kind: "refused" });
    assert.deepEqual(planTicks(folder), ["- [x] Twin", "- [ ] Twin"]);
    assert.deepEqual(verifiedRows(folder), []);
    assert.notEqual(first, second);
  });

  void it("when one of two selected twins went stale, only the other is ticked and verified", async () => {
    const [first, second] = twinIds();
    const folder = stage(TWINS, review(`- [item:${first}] Twin`, "  evidence: first", `- [item:${second}] Twin`, "  evidence: second"));
    const derived = await deriveApplicableVerifiedTicksV1(vscode.Uri.file(folder), "impl-high-review");
    assert.equal(derived.kind, "ok");
    if (derived.kind !== "ok") return;
    fs.writeFileSync(
      path.join(folder, "plan-final.md"),
      ["<!-- ensemble:implementation-checklist -->", "", "- [x] Twin", "- [ ] Twin", ""].join("\n")
    );
    assert.deepEqual(await writeVerifiedTicksToPlanV1(vscode.Uri.file(folder), derived.derivation), { kind: "applied", count: 1 });
    assert.deepEqual(planTicks(folder), ["- [x] Twin", "- [x] Twin"]);
    const evidence = verifiedRows(folder).flatMap((row) => row.verifications?.map((entry) => entry.evidence) ?? []);
    assert.deepEqual(evidence, ["second"]);
  });
});
