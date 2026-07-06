// SPDX-License-Identifier: MIT
/**
 * Registry that composes the per-domain Postgres stores into one method bag. `createPostgresAdapter`
 * layers this on top of the core (lifecycle + chat/skills slice); anything still unported is handled
 * by the boundary Proxy in db-postgres.ts. Add a domain by porting src/db-postgres/<domain>.ts and
 * spreading its factory here — nothing else changes.
 */
import type { PgCtx } from './db-postgres-ctx.js';
import type { DatabaseAdapter } from './db-types/adapter.js';

import { pgCostStore } from './db-postgres/cost.js';
import { pgCapabilityStore } from './db-postgres/capabilities.js';
import { pgVoiceStore } from './db-postgres/voice.js';
import { pgWorkflowStore } from './db-postgres/workflows.js';
import { pgScopesStore } from './db-postgres/scopes.js';
import { pgAgentStore } from './db-postgres/agents.js';

export function composeDomainStores(ctx: PgCtx): Partial<DatabaseAdapter> {
  return {
    ...pgCostStore(ctx),
    ...pgCapabilityStore(ctx),
    ...pgVoiceStore(ctx),
    ...pgWorkflowStore(ctx),
    ...pgScopesStore(ctx),
    ...pgAgentStore(ctx),
  };
}
