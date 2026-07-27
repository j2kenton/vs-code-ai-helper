/**
 * Coverage for the §3.10 strict writer / splice-based migrator: canonical V1
 * emission, byte-identical ordered opaque preservation, idempotent
 * migration, and stable round-trips. Byte-exact expectations are in-code
 * string literals (LF-only) so checkout line-ending profiles cannot skew
 * them; structural fixture documents live under test-fixtures/task-progress.
 */
import * as assert from "node:assert/strict";
import * as fs from "node:fs";
import * as path from "node:path";
import { describe, it } from "node:test";
import { decodeTaskProgressTextV1 } from "../services/taskProgressDecoderV1";
import {
  encodeTaskProgressV1,
  migrateTaskProgressTextV1,
} from "../services/taskProgressWriterV1";

const FIXTURE_ROOT = path.resolve(__dirname, "..", "..", "test-fixtures", "task-progress");

void describe("taskProgressWriterV1", () => {
  void it("encodes a fresh minimal V1 document with the version marker first", () => {
    const text = encodeTaskProgressV1({
      ensembleProgressVersion: 1,
      taskFolder: "2026-07-01_task_1",
      currentStage: "desc",
      status: "creating",
      createdAt: "2026-07-01T10:00:00.000Z",
      updatedAt: "2026-07-01T10:00:00.000Z",
    });
    assert.equal(
      text,
      `{\n` +
        `  "ensembleProgressVersion": 1,\n` +
        `  "taskFolder": "2026-07-01_task_1",\n` +
        `  "currentStage": "desc",\n` +
        `  "status": "creating",\n` +
        `  "createdAt": "2026-07-01T10:00:00.000Z",\n` +
        `  "updatedAt": "2026-07-01T10:00:00.000Z"\n` +
        `}`
    );
  });

  void it("splices opaque properties through migration byte-identically and in order", () => {
    const legacy =
      `{"taskFolder":"2026-07-01_task_1",` +
      `"zeta":  {"nested": [1, 2,   3]},` +
      `"currentStage":"plan-final",` +
      `"alpha":"u\\u00e9nicode",` +
      `"createdAt":"2026-07-01T10:00:00.000Z",` +
      `"updatedAt":"2026-07-02T11:30:00.000Z"}`;
    const migration = migrateTaskProgressTextV1(legacy);
    assert.equal(migration.ok, true);
    if (!migration.ok) {
      return;
    }
    assert.equal(migration.changed, true);
    assert.equal(
      migration.text,
      `{\n` +
        `  "ensembleProgressVersion": 1,\n` +
        `  "taskFolder": "2026-07-01_task_1",\n` +
        `  "zeta": {"nested": [1, 2,   3]},\n` +
        `  "currentStage": "impl",\n` +
        `  "alpha": "u\\u00e9nicode",\n` +
        `  "createdAt": "2026-07-01T10:00:00.000Z",\n` +
        `  "updatedAt": "2026-07-02T11:30:00.000Z",\n` +
        `  "status": "active"\n` +
        `}`
    );

    // Migrating the migrated text again is a no-op (idempotent splice).
    const again = migrateTaskProgressTextV1(migration.text);
    assert.equal(again.ok, true);
    if (again.ok) {
      assert.equal(again.changed, false);
      assert.equal(again.text, migration.text);
    }
  });

  void it("flattens the historical envelope while preserving inner opaque spans", () => {
    const wrapped =
      `{"schemaVersion": 1, "data": {"taskFolder":"2026-07-01_task_1",` +
      `"legacyNote": "keep me",` +
      `"currentStage":"impl","createdAt":"2026-07-01T10:00:00.000Z",` +
      `"updatedAt":"2026-07-02T11:30:00.000Z"}}`;
    const migration = migrateTaskProgressTextV1(wrapped);
    assert.equal(migration.ok, true);
    if (migration.ok) {
      const reparsed = JSON.parse(migration.text) as Record<string, unknown>;
      assert.equal(reparsed["schemaVersion"], undefined);
      assert.equal(reparsed["data"], undefined);
      assert.equal(reparsed["legacyNote"], "keep me");
      assert.equal(reparsed["ensembleProgressVersion"], 1);
    }
  });

  void it("omits cleared product fields and appends newly set ones in declaration order", () => {
    const source = decodeTaskProgressTextV1(
      JSON.stringify({
        taskFolder: "2026-07-01_task_1",
        currentStage: "impl",
        status: "active",
        reviewAttemptId: "attempt-1",
        createdAt: "2026-07-01T10:00:00.000Z",
        updatedAt: "2026-07-02T11:30:00.000Z",
        custom: "opaque",
      })
    );
    assert.equal(source.ok, true);
    if (!source.ok) {
      return;
    }
    const updated = {
      ...source.decoded.progress,
      reviewAttemptId: undefined,
      completedAt: "2026-07-03T12:00:00.000Z",
      status: "completed" as const,
    };
    const text = encodeTaskProgressV1(updated, source.decoded.entries);
    const reparsed = JSON.parse(text) as Record<string, unknown>;
    assert.equal(reparsed["reviewAttemptId"], undefined);
    assert.equal(reparsed["completedAt"], "2026-07-03T12:00:00.000Z");
    assert.equal(reparsed["custom"], "opaque");
    const keys = Object.keys(reparsed);
    assert.equal(keys[0], "ensembleProgressVersion");
    assert.ok(keys.indexOf("custom") < keys.indexOf("completedAt"));
  });

  void it("round-trips every valid fixture stably (encode∘decode is identity on V1 text)", () => {
    for (const family of ["legacy", "v1"]) {
      const dir = path.join(FIXTURE_ROOT, family);
      for (const file of fs.readdirSync(dir).sort()) {
        const text = fs.readFileSync(path.join(dir, file), "utf8");
        const first = migrateTaskProgressTextV1(text);
        assert.equal(first.ok, true, `${family}/${file} should migrate`);
        if (!first.ok) {
          continue;
        }
        const second = migrateTaskProgressTextV1(first.text);
        assert.equal(second.ok, true, `${family}/${file} migrated output should re-decode`);
        if (second.ok) {
          assert.equal(second.changed, false, `${family}/${file} migration must be idempotent`);
          assert.equal(second.text, first.text);
        }
      }
    }
  });
});
