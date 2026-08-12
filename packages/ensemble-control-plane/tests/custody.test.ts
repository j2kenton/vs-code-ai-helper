/**
 * Key custody (plan Part 5, criterion 1): envelope encryption roundtrip,
 * fail-closed KEK unavailability (nothing falls back to plaintext), the
 * DEK-re-wrap rotation path, display masking, and the at-rest guarantee
 * that the serialized store never contains key material.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createBootSecretKekProviderV1,
  createUnavailableKekProviderV1,
  decryptKeyMaterialV1,
  encryptKeyMaterialV1,
  KeyCustodyUnavailableErrorV1,
  maskKeyHintV1,
  rotateKeyEnvelopeKekV1,
} from "../src/keyCustodyV1";
import {
  createControlPlaneStoreV1,
  createFileControlPlanePersistenceV1,
} from "../src/storeV1";

const MATERIAL = "e2b_live_supersecret_key_material_1234";

test("envelope roundtrip: decrypts to the original, stores nothing readable", async () => {
  const kek = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot-secret" });
  const envelope = await encryptKeyMaterialV1(kek, MATERIAL);
  assert.equal(await decryptKeyMaterialV1(kek, envelope), MATERIAL);
  const serialized = JSON.stringify(envelope);
  assert.ok(!serialized.includes(MATERIAL));
  assert.ok(!serialized.includes("boot-secret"));
  assert.equal(envelope.kekId, "kek-1");
});

test("fail-closed: an unavailable KEK refuses encryption AND decryption", async () => {
  const good = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot-secret" });
  const envelope = await encryptKeyMaterialV1(good, MATERIAL);

  const down = createUnavailableKekProviderV1("kek-1");
  await assert.rejects(encryptKeyMaterialV1(down, MATERIAL), KeyCustodyUnavailableErrorV1);
  await assert.rejects(decryptKeyMaterialV1(down, envelope), KeyCustodyUnavailableErrorV1);

  // A different KEK id is also fail-closed, even when its KEK resolves.
  const wrongId = createBootSecretKekProviderV1({ kekId: "kek-2", bootSecret: "boot-secret" });
  await assert.rejects(decryptKeyMaterialV1(wrongId, envelope), KeyCustodyUnavailableErrorV1);
});

test("rotation re-wraps the DEK under the new KEK; ciphertext untouched", async () => {
  const oldKek = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "old" });
  const newKek = createBootSecretKekProviderV1({ kekId: "kek-2", bootSecret: "new" });
  const envelope = await encryptKeyMaterialV1(oldKek, MATERIAL);
  const rotated = await rotateKeyEnvelopeKekV1(oldKek, newKek, envelope);

  assert.equal(rotated.kekId, "kek-2");
  assert.equal(rotated.ciphertextB64, envelope.ciphertextB64);
  assert.notEqual(rotated.wrappedDekB64, envelope.wrappedDekB64);
  assert.equal(await decryptKeyMaterialV1(newKek, rotated), MATERIAL);
  await assert.rejects(decryptKeyMaterialV1(oldKek, rotated), KeyCustodyUnavailableErrorV1);
});

test("display masking reveals at most the last four characters", () => {
  assert.equal(maskKeyHintV1("e2b_live_abcd1234"), "••••1234");
  assert.equal(maskKeyHintV1("short"), "••••");
});

test("at rest: the persisted store document never contains key material", async () => {
  const path = join(mkdtempSync(join(tmpdir(), "ensemble-cp-custody-")), "store.json");
  const store = createControlPlaneStoreV1({
    persistence: createFileControlPlanePersistenceV1(path),
  });
  const kek = createBootSecretKekProviderV1({ kekId: "kek-1", bootSecret: "boot-secret" });
  store.writeKeyRecord({
    keyKind: "sandbox:e2b",
    ownerUserId: "user-a",
    envelope: await encryptKeyMaterialV1(kek, MATERIAL),
    maskedHint: maskKeyHintV1(MATERIAL),
    updatedAt: "2026-08-12T00:00:00.000Z",
  });
  const serialized = readFileSync(path, "utf8");
  assert.ok(!serialized.includes(MATERIAL));
  assert.ok(serialized.includes("sandbox:e2b"));
  assert.equal(store.readKeyRecord("user-a", "sandbox:e2b")?.maskedHint, "••••1234");
});
