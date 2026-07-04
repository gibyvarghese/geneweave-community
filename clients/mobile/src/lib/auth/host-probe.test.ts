import { describe, it, expect } from 'vitest';
import type { GeneweaveClient } from '@weaveintel/api-client';
import { AuthExpiredError } from '@weaveintel/api-client';
import { createCatalogHostProbe } from './host-probe.js';

function clientWithCatalog(impl: () => Promise<{ surfaceId: string }>): GeneweaveClient {
  return { getCatalog: impl } as unknown as GeneweaveClient;
}

describe('createCatalogHostProbe', () => {
  it('reports reachable with the resolved surfaceId when the catalog loads', async () => {
    const probe = createCatalogHostProbe(() =>
      clientWithCatalog(async () => ({ surfaceId: 'mobile' })),
    );
    const result = await probe('https://api.example.com');
    expect(result).toEqual({ reachable: true, surfaceId: 'mobile' });
  });

  it('treats a 401 (AuthExpiredError) as reachable — the user just is not signed in yet', async () => {
    const probe = createCatalogHostProbe(() =>
      clientWithCatalog(async () => {
        throw new AuthExpiredError({ request: { method: 'GET', path: '/api/me/catalog' } });
      }),
    );
    const result = await probe('https://api.example.com');
    expect(result.reachable).toBe(true);
  });

  it('treats a duck-typed 401 as reachable even across module boundaries', async () => {
    const probe = createCatalogHostProbe(() =>
      clientWithCatalog(async () => {
        // A foreign error object carrying status 401 (not our AuthExpiredError class).
        throw Object.assign(new Error('Unauthorized'), { status: 401 });
      }),
    );
    const result = await probe('https://api.example.com');
    expect(result.reachable).toBe(true);
  });

  it('reports unreachable on a connection-level failure', async () => {
    const probe = createCatalogHostProbe(() =>
      clientWithCatalog(async () => {
        throw new TypeError('fetch failed');
      }),
    );
    const result = await probe('https://nope.invalid');
    expect(result.reachable).toBe(false);
  });
});
