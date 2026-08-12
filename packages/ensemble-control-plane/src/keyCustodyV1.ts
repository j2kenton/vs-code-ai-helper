/**
 * Key custody: envelope encryption for ALL user key material (plan Part 5).
 *
 * Sandbox provider keys AND model-provider keys are encrypted at rest with
 * envelope encryption: each record gets a fresh random 256-bit DEK that
 * encrypts the material (AES-256-GCM), and the DEK itself is wrapped
 * (AES-256-GCM again) under the KEK. The KEK lives behind `KekProviderV1` —
 * a KMS/secret manager in production, an injected-at-boot secret in dev —
 * and is NEVER stored alongside the database: the store persists only the
 * envelope (kek id + wrapped DEK + ciphertext), so the serialized document
 * contains no plaintext material and no unwrapped key (pinned by
 * tests/custody.test.ts).
 *
 * Fail-closed: a KEK provider that cannot produce the KEK throws
 * `KeyCustodyUnavailableErrorV1`, and every custody operation propagates it —
 * key-dependent operations refuse; NOTHING falls back to plaintext.
 *
 * Rotation: `rotateKeyEnvelopeKekV1` unwraps the DEK under the old KEK and
 * re-wraps it under the new one — the data ciphertext is untouched, which is
 * exactly the documented DEK-re-encryption rotation path.
 *
 * Decryption happens only in engine-run memory (the engine adapters receive
 * the plaintext key for request headers and scrub it from errors); the app
 * holds only a session token, and no API response ever carries material back
 * (`controlPlaneServerV1.ts` returns masked metadata only).
 */
import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";

/** Where the KEK comes from. Production: KMS/secret manager. Dev: boot secret. */
export interface KekProviderV1 {
  readonly kekId: string;
  /** Resolve the 32-byte KEK; MUST throw when the KEK is unavailable. */
  getKekBytes(): Promise<Uint8Array>;
}

/** Typed fail-closed error: the KEK (or the envelope's KEK) is unavailable. */
export class KeyCustodyUnavailableErrorV1 extends Error {
  readonly code = "keyCustodyUnavailable";
  constructor(reason: string) {
    super(reason);
    this.name = "KeyCustodyUnavailableErrorV1";
  }
}

/**
 * Dev KEK provider: a secret injected at boot (env/CLI), stretched to 32
 * bytes by SHA-256. A KMS-backed provider implements the same interface.
 */
export function createBootSecretKekProviderV1(options: {
  readonly kekId: string;
  readonly bootSecret: string;
}): KekProviderV1 {
  if (options.bootSecret.length === 0) {
    throw new KeyCustodyUnavailableErrorV1("an empty boot secret cannot be a KEK");
  }
  const kek = createHash("sha256").update(options.bootSecret, "utf8").digest();
  return {
    kekId: options.kekId,
    getKekBytes(): Promise<Uint8Array> {
      return Promise.resolve(new Uint8Array(kek));
    },
  };
}

/** A provider whose KEK cannot be resolved (KMS down / secret missing). */
export function createUnavailableKekProviderV1(kekId: string): KekProviderV1 {
  return {
    kekId,
    getKekBytes(): Promise<Uint8Array> {
      return Promise.reject(
        new KeyCustodyUnavailableErrorV1(`the KEK ${kekId} is unavailable (fail-closed)`)
      );
    },
  };
}

/** The persisted envelope: everything base64, nothing plaintext. */
export interface KeyEnvelopeV1 {
  readonly kekId: string;
  readonly wrappedDekB64: string;
  readonly wrapIvB64: string;
  readonly wrapTagB64: string;
  readonly dataIvB64: string;
  readonly dataTagB64: string;
  readonly ciphertextB64: string;
}

function gcmEncrypt(key: Uint8Array, plaintext: Uint8Array): {
  readonly iv: Buffer;
  readonly tag: Buffer;
  readonly ciphertext: Buffer;
} {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return { iv, tag: cipher.getAuthTag(), ciphertext };
}

function gcmDecrypt(key: Uint8Array, iv: Buffer, tag: Buffer, ciphertext: Buffer): Buffer {
  const decipher = createDecipheriv("aes-256-gcm", key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]);
}

export async function encryptKeyMaterialV1(
  kekProvider: KekProviderV1,
  materialUtf8: string
): Promise<KeyEnvelopeV1> {
  const kek = await kekProvider.getKekBytes();
  const dek = randomBytes(32);
  const data = gcmEncrypt(dek, Buffer.from(materialUtf8, "utf8"));
  const wrap = gcmEncrypt(kek, dek);
  return {
    kekId: kekProvider.kekId,
    wrappedDekB64: wrap.ciphertext.toString("base64"),
    wrapIvB64: wrap.iv.toString("base64"),
    wrapTagB64: wrap.tag.toString("base64"),
    dataIvB64: data.iv.toString("base64"),
    dataTagB64: data.tag.toString("base64"),
    ciphertextB64: data.ciphertext.toString("base64"),
  };
}

async function unwrapDek(kekProvider: KekProviderV1, envelope: KeyEnvelopeV1): Promise<Buffer> {
  if (envelope.kekId !== kekProvider.kekId) {
    throw new KeyCustodyUnavailableErrorV1(
      `the envelope was wrapped under KEK ${envelope.kekId}, not ${kekProvider.kekId} (fail-closed)`
    );
  }
  const kek = await kekProvider.getKekBytes();
  return gcmDecrypt(
    kek,
    Buffer.from(envelope.wrapIvB64, "base64"),
    Buffer.from(envelope.wrapTagB64, "base64"),
    Buffer.from(envelope.wrappedDekB64, "base64")
  );
}

/** Decrypt key material — ONLY ever into engine-run memory. */
export async function decryptKeyMaterialV1(
  kekProvider: KekProviderV1,
  envelope: KeyEnvelopeV1
): Promise<string> {
  const dek = await unwrapDek(kekProvider, envelope);
  return gcmDecrypt(
    dek,
    Buffer.from(envelope.dataIvB64, "base64"),
    Buffer.from(envelope.dataTagB64, "base64"),
    Buffer.from(envelope.ciphertextB64, "base64")
  ).toString("utf8");
}

/** KEK rotation: re-wrap the DEK under the new KEK; ciphertext untouched. */
export async function rotateKeyEnvelopeKekV1(
  oldKekProvider: KekProviderV1,
  newKekProvider: KekProviderV1,
  envelope: KeyEnvelopeV1
): Promise<KeyEnvelopeV1> {
  const dek = await unwrapDek(oldKekProvider, envelope);
  const newKek = await newKekProvider.getKekBytes();
  const wrap = gcmEncrypt(newKek, dek);
  return {
    ...envelope,
    kekId: newKekProvider.kekId,
    wrappedDekB64: wrap.ciphertext.toString("base64"),
    wrapIvB64: wrap.iv.toString("base64"),
    wrapTagB64: wrap.tag.toString("base64"),
  };
}

/** Last-4-style display mask; never reveals more than 4 trailing characters. */
export function maskKeyHintV1(materialUtf8: string): string {
  if (materialUtf8.length <= 6) {
    return "••••";
  }
  return `••••${materialUtf8.slice(-4)}`;
}
