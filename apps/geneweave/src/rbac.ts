/**
 * @weaveintel/geneweave — Persona RBAC policy helpers
 */

import {
  DEFAULT_RBAC_POLICY,
  hasPersonaPermission,
  resolvePersonaPermissions,
  canAccessArea as canAccessAreaWithPolicy,
} from '@weaveintel/identity';

export type GeneWeavePersona =
  | 'platform_admin'
  | 'tenant_admin'
  | 'tenant_user'
  | 'agent_worker'
  | 'agent_researcher'
  | 'agent_supervisor';

const VALID_PERSONAS = new Set(Object.keys(DEFAULT_RBAC_POLICY.personas));

export function isValidPersona(persona: string | null | undefined): persona is GeneWeavePersona {
  if (!persona) return false;
  return VALID_PERSONAS.has(persona.trim().toLowerCase());
}

function asKnownPersona(persona: string | null | undefined): GeneWeavePersona | null {
  if (!isValidPersona(persona)) return null;
  return persona.trim().toLowerCase() as GeneWeavePersona;
}

export function normalizePersona(
  persona: string | null | undefined,
  kind: 'user' | 'agent' = 'user',
): GeneWeavePersona {
  const fallback = kind === 'agent'
    ? DEFAULT_RBAC_POLICY.defaultAgentPersona
    : DEFAULT_RBAC_POLICY.defaultUserPersona;
  const candidate = (persona ?? '').trim().toLowerCase();
  return (VALID_PERSONAS.has(candidate) ? candidate : fallback) as GeneWeavePersona;
}

export function personaPermissions(persona: string | null | undefined): string[] {
  const known = asKnownPersona(persona);
  if (!known) return [];
  return resolvePersonaPermissions(DEFAULT_RBAC_POLICY, known);
}

export function canPersonaAccess(persona: string | null | undefined, permission: string): boolean {
  const known = asKnownPersona(persona);
  if (!known) return false;
  return hasPersonaPermission(DEFAULT_RBAC_POLICY, known, permission);
}

/** Can this persona see/use a UI capability area (RBAC surface parity)? Unknown persona → fail-closed. */
export function canPersonaAccessArea(persona: string | null | undefined, area: string): boolean {
  const known = asKnownPersona(persona);
  if (!known) return false;
  return canAccessAreaWithPolicy(DEFAULT_RBAC_POLICY, known, area);
}

export function toolPermissionFor(toolName: string): string {
  if (toolName.startsWith('browser_')) return 'tools:browser:use';
  if (toolName === 'web_search') return 'tools:search';
  if (toolName.startsWith('timer_') || toolName.startsWith('stopwatch_') || toolName.startsWith('reminder_') || toolName === 'datetime' || toolName === 'datetime_add' || toolName === 'timezone_info') {
    return 'tools:time';
  }
  if (toolName === 'memory_recall') return 'tools:memory';
  return 'tools:basic';
}

export function canUseTool(persona: string | null | undefined, toolName: string): boolean {
  if (!canPersonaAccess(persona, 'tools:use')) {
    return false;
  }
  return canPersonaAccess(persona, toolPermissionFor(toolName));
}
