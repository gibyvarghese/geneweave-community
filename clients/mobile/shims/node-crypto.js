// RN shim for Node's `node:crypto` — only the surface the bundled (mostly
// dead-code) `@weaveintel/core` paths touch on device. `newUUIDv7` calls
// `randomBytes(n)` to mint idempotency keys, so that one must be real; it is
// backed by Expo's CSPRNG. Everything else in core's crypto usage (cipher /
// hmac for tenant encryption) is server-only dead code on the client, so the
// remaining named exports are intentionally absent.
import { getRandomBytes } from 'expo-crypto';

/** Returns `byteCount` cryptographically-strong random bytes as a Uint8Array. */
export function randomBytes(byteCount) {
  return getRandomBytes(byteCount);
}

export default { randomBytes };
