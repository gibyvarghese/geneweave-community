/**
 * apps/geneweave/src/lib/uuid.ts
 *
 * Back-compat re-export. The canonical UUID v7 helper lives in
 * `@weaveintel/core` so every package and the geneweave app share one
 * implementation. Existing imports keep working unchanged.
 */

export { newUUIDv7 } from '@weaveintel/core';
