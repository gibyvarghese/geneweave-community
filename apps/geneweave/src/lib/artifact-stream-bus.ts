/**
 * In-process event bus for streaming artifact SSE delivery.
 *
 * Lifecycle:
 *   1. A tool (emit_artifact in streaming mode) calls `emitArtifactStreamEvent`
 *      to broadcast progress, complete, or error events for a given artifact id.
 *   2. The SSE endpoint (`GET /api/artifacts/:id/stream`) subscribes via
 *      `onArtifactStreamEvent` and pushes events over the open HTTP response.
 *   3. When the SSE client disconnects, the endpoint calls
 *      `offArtifactStreamEvent` to clean up.
 *
 * This is intentionally lightweight: Map-based, synchronous dispatch,
 * no queuing. It follows the same pattern as `live-run-event-bus.ts`.
 */

export interface ArtifactStreamBusEvent {
  /** 'update' = partial data; 'complete' = final; 'error' = failed. */
  kind: 'update' | 'complete' | 'error';
  artifactId: string;
  /** 0.0–1.0 progress fraction. */
  progress: number;
  /** Partial or final artifact content (text or serialisable). */
  data?: unknown;
  /** Current version number (populated on 'complete'). */
  version?: number;
  /** Error message (populated on 'error'). */
  message?: string;
  /** ISO timestamp. */
  timestamp: string;
}

export type ArtifactStreamBusListener = (event: ArtifactStreamBusEvent) => void;

const listeners = new Map<string, Set<ArtifactStreamBusListener>>();

/**
 * Emit a streaming event for a given artifact id. All subscribed SSE
 * connections for that artifact receive the event synchronously.
 */
export function emitArtifactStreamEvent(artifactId: string, event: Omit<ArtifactStreamBusEvent, 'artifactId' | 'timestamp'>): void {
  const set = listeners.get(artifactId);
  if (!set || set.size === 0) return;
  const full: ArtifactStreamBusEvent = { ...event, artifactId, timestamp: new Date().toISOString() };
  for (const fn of set) {
    try { fn(full); } catch { /* listener errors must not interrupt other listeners */ }
  }
}

/** Subscribe to streaming events for a specific artifact id. */
export function onArtifactStreamEvent(artifactId: string, listener: ArtifactStreamBusListener): void {
  let set = listeners.get(artifactId);
  if (!set) { set = new Set(); listeners.set(artifactId, set); }
  set.add(listener);
}

/** Unsubscribe a listener. Cleans up the Map entry when empty. */
export function offArtifactStreamEvent(artifactId: string, listener: ArtifactStreamBusListener): void {
  const set = listeners.get(artifactId);
  if (!set) return;
  set.delete(listener);
  if (set.size === 0) listeners.delete(artifactId);
}

/** Returns `true` when at least one SSE client is subscribed for the given artifact. */
export function hasArtifactStreamListeners(artifactId: string): boolean {
  return (listeners.get(artifactId)?.size ?? 0) > 0;
}
