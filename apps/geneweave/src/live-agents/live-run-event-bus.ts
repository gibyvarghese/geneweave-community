/**
 * Phase 4 — Process-singleton in-process event bus for live run events.
 *
 * The supervisor's `onEvent` callback fires into this bus; the admin SSE
 * route `GET /api/admin/live-runs/:id/stream` subscribes to it.
 *
 * Events are keyed by `runId` so clients only receive events for the run
 * they are watching. MaxListeners is raised to accommodate many concurrent
 * SSE connections.
 */
import { EventEmitter } from 'node:events';
import type { LiveRunEventRowLike } from '@weaveintel/live-agents-runtime';

export type LiveRunEventListener = (event: LiveRunEventRowLike) => void;

let bus: EventEmitter | null = null;

export function getLiveRunEventBus(): EventEmitter {
  if (!bus) {
    bus = new EventEmitter();
    bus.setMaxListeners(200);
  }
  return bus;
}

export function emitLiveRunEvent(runId: string, event: LiveRunEventRowLike): void {
  getLiveRunEventBus().emit(runId, event);
}

export function onLiveRunEvent(runId: string, listener: LiveRunEventListener): void {
  getLiveRunEventBus().on(runId, listener);
}

export function offLiveRunEvent(runId: string, listener: LiveRunEventListener): void {
  getLiveRunEventBus().off(runId, listener);
}

export { type LiveRunEventRowLike };
