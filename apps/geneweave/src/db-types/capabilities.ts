/** Capability pack and guardrail eval row types. */

export type CapabilityPackStatus = 'draft' | 'published' | 'retired';

export interface CapabilityPackRow {
  id: string;
  pack_key: string;
  version: string;
  status: CapabilityPackStatus;
  name: string;
  description: string;
  authored_by: string | null;
  /** JSON-serialized `CapabilityPack` manifest from `@weaveintel/core/capability-packs`. */
  manifest: string;
  installed_at: string | null;
  installed_by: string | null;
  created_at: string;
  updated_at: string;
}

export interface CapabilityPackInstallationRow {
  id: string;
  pack_id: string;
  pack_key: string;
  pack_version: string;
  /** JSON-serialized `PackInstallationLedger`. */
  ledger: string;
  installed_by: string | null;
  installed_at: string;
  uninstalled_at: string | null;
}

export interface CapabilityPackExperimentRow {
  id: string;
  pack_key: string;
  name: string;
  /** JSON: `Array<{ version: string; weight: number }>`. */
  variants: string;
  enabled: number;
  created_at: string;
  updated_at: string;
}

export interface GuardrailEvalRow {
  id: string;
  chat_id: string | null;
  message_id: string | null;
  stage: string;
  input_preview: string | null;
  results: string;
  overall_decision: string;
  /** JSON: EscalationResult | null — set when at least one escalation policy was evaluated. */
  escalation: string | null;
  created_at: string;
}
