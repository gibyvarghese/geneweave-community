/**
 * Phase K5 — Kaggle live-agents module barrel.
 *
 * Phase D — bespoke mesh templating (`bootKaggleMesh`, `buildKaggleMeshTemplate`)
 * was removed. Mesh provisioning now goes through the generic
 * `provisionMesh` from `@weaveintel/live-agents-runtime` driven by the
 * `live_mesh_definitions` row keyed `'kaggle'`. This barrel still re-exports
 * the kaggle-specific capability matrix, attention policy, store, and
 * playbook resolver because those remain kaggle-domain concerns.
 *
 * See `docs/live-agents/kaggle.md` for the topology diagram and capability
 * matrix.
 */

export {
  KAGGLE_CAPABILITY_MATRIX,
  bindingConstraintsFor,
  bindingConstraintsForCaps,
  resolveCapabilitiesFor,
  loadKaggleCapabilityMatrix,
  type KaggleAgentRole,
} from './account-bindings.js';
export {
  buildKaggleBridge,
  KAGGLE_BRIDGE_TOPICS,
  type KaggleBridgeOptions,
} from './bridge.js';
export {
  createKaggleAttentionPolicy,
  createKaggleAttentionPolicyFromDb,
  type KaggleAttentionPolicyOptions,
} from './agents.js';
export { getKaggleLiveStore, _resetKaggleLiveStoreForTests } from './store.js';
export {
  KAGGLE_PLAYBOOK_CATEGORY,
  KAGGLE_PLAYBOOK_DEFAULT_PATTERN,
  createDbKagglePlaybookResolver,
  extractCompetitionSlugFromText,
  type KagglePlaybook,
  type KagglePlaybookConfig,
  type KagglePlaybookResolver,
  type PlaybookResolveOptions,
} from './playbook-resolver.js';
// Note: seedKaggleDemoMesh is intentionally NOT re-exported here because it
// imports the geneweave DatabaseAdapter type, which would pull the entire
// app DB layer into any consumer of this barrel (e.g. examples). Import it
// directly from './seed.js' from server boot only.
