/**
 * Native session-token storage (plan Part 6): Keychain (iOS) / Keystore
 * (Android) via `expo-secure-store`. `appServicesV1` selects this for every
 * platform except web — web's secure-store fallback is NOT secure storage,
 * so web stays on the in-memory store and never persists a refresh token
 * client-side (server-held HttpOnly cookie instead).
 */
import * as SecureStore from 'expo-secure-store';

import type { SecureTokenStoreV1 } from './sessionManagerV1';

export function createSecureStoreTokenStoreV1(): SecureTokenStoreV1 {
  return {
    get: (key) => SecureStore.getItemAsync(key),
    set: (key, value) => SecureStore.setItemAsync(key, value),
    remove: (key) => SecureStore.deleteItemAsync(key),
  };
}
