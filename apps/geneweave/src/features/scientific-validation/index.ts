/**
 * Hypothesis Validation Feature — entry point
 *
 * Exports the route registration function and the chat-bridge consumed by the
 * geneweave server. The legacy `runner.ts` workflow engine, custom agents,
 * recipes, and standalone workflow definition have been removed in favour of
 * fully DB-driven orchestration via chat.ts. Only UI components, DB seed data,
 * and the thin chat-bridge remain in this feature folder.
 */

export { registerSVRoutes } from './routes/index.js';
export { SVChatBridge } from './chat-bridge.js';
export type { SVRunInput, SVChatBridgeOptions } from './chat-bridge.js';
