/**
 * host-probe.ts — the production {@link HostProbe} built over the api-client.
 *
 * Lives in the pure-logic layer (no React / RN / expo) but does touch the
 * network via an injected {@link ClientFactory}: it spins up a throwaway client
 * with an empty token store and calls `getCatalog('mobile')`.
 *
 * Reachability semantics: the catalog endpoint requires auth, but the server
 * picker runs BEFORE sign-in, so a `401` is the expected (and desirable)
 * response — it proves the host is a geneWeave server that speaks the `/api/me`
 * protocol. We therefore treat both a resolved catalog AND an `AuthExpiredError`
 * (401) as reachable. Any other failure (connection refused, DNS, a non-geneWeave
 * response) is reported as unreachable — never propagated.
 */

import { MemoryTokenStore, AuthExpiredError, type GeneweaveClient, type TokenStore } from '@weaveintel/api-client';
import type { HostProbe } from './host.js';

/** Builds a {@link HostProbe} from a client factory (e.g. `createGeneweaveClient`). */
export function createCatalogHostProbe(
  makeClient: (opts: { host: string; tokenStore: TokenStore }) => GeneweaveClient,
): HostProbe {
  return async (host: string) => {
    const client = makeClient({ host, tokenStore: new MemoryTokenStore() });
    try {
      const catalog = await client.getCatalog('mobile');
      return { reachable: true, surfaceId: catalog.surfaceId };
    } catch (err) {
      // A 401 means "real geneWeave server, just not signed in yet" → reachable.
      // We duck-type the status (rather than rely on `instanceof`) so the check
      // survives the api-client being loaded as two module instances (e.g. by
      // name in one place and by dist path in another).
      const status = (err as { status?: unknown } | null | undefined)?.status;
      if (err instanceof AuthExpiredError || status === 401) return { reachable: true };
      return { reachable: false };
    }
  };
}
