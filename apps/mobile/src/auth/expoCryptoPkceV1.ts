/**
 * Native PKCE crypto source (plan Part 6): `expo-crypto` behind the same
 * `PkceCryptoV1` seam `createWebCryptoPkceV1` implements for web, so
 * `generatePkcePairV1` and the S256 challenge derivation are identical on
 * both platforms. `appServicesV1` selects this whenever
 * `globalThis.crypto.subtle` is unavailable (Hermes on native has no
 * WebCrypto), closing the "no SHA-256 source" unavailability path.
 */
import * as ExpoCrypto from 'expo-crypto';

import type { PkceCryptoV1 } from './pkceV1';

export function createExpoCryptoPkceV1(): PkceCryptoV1 {
  return {
    randomBytes(length: number): Uint8Array {
      return ExpoCrypto.getRandomBytes(length);
    },
    async sha256(data: Uint8Array): Promise<Uint8Array> {
      const digest = await ExpoCrypto.digest(ExpoCrypto.CryptoDigestAlgorithm.SHA256, data as BufferSource);
      return new Uint8Array(digest);
    },
  };
}
