import type { CapabilityPackStatus, CapabilityPackRow, CapabilityPackInstallationRow, CapabilityPackExperimentRow, GuardrailEvalRow } from './capabilities.js';

export interface ICapabilityStore {
  // Capability packs
  createCapabilityPack(p: Omit<CapabilityPackRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCapabilityPack(id: string): Promise<CapabilityPackRow | null>;
  getCapabilityPackByKeyVersion(packKey: string, version: string): Promise<CapabilityPackRow | null>;
  listCapabilityPacks(opts?: { packKey?: string; status?: CapabilityPackStatus; limit?: number; offset?: number }): Promise<CapabilityPackRow[]>;
  updateCapabilityPack(id: string, fields: Partial<Omit<CapabilityPackRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCapabilityPack(id: string): Promise<void>;
  createCapabilityPackInstallation(i: Omit<CapabilityPackInstallationRow, 'installed_at' | 'uninstalled_at'> & { installed_at?: string }): Promise<void>;
  getCapabilityPackInstallation(id: string): Promise<CapabilityPackInstallationRow | null>;
  listCapabilityPackInstallations(opts?: { packId?: string; activeOnly?: boolean; limit?: number; offset?: number }): Promise<CapabilityPackInstallationRow[]>;
  markCapabilityPackInstallationUninstalled(id: string, uninstalledAt?: string): Promise<void>;
  createCapabilityPackExperiment(e: Omit<CapabilityPackExperimentRow, 'created_at' | 'updated_at'>): Promise<void>;
  getCapabilityPackExperiment(id: string): Promise<CapabilityPackExperimentRow | null>;
  listCapabilityPackExperiments(opts?: { packKey?: string; enabledOnly?: boolean }): Promise<CapabilityPackExperimentRow[]>;
  updateCapabilityPackExperiment(id: string, fields: Partial<Omit<CapabilityPackExperimentRow, 'id' | 'created_at' | 'updated_at'>>): Promise<void>;
  deleteCapabilityPackExperiment(id: string): Promise<void>;

  // Guardrail evaluations
  createGuardrailEval(e: Omit<GuardrailEvalRow, 'created_at'>): Promise<void>;
  listGuardrailEvals(chatId?: string, limit?: number): Promise<GuardrailEvalRow[]>;
}
