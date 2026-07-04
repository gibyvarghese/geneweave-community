/**
 * GeneWeave — Tool Health Snapshot Job (Phase 3)
 *
 * Runs every 15 minutes and aggregates `tool_audit_events` rows from the
 * previous window into a `tool_health_snapshots` row per active tool.
 *
 * Latency percentiles are computed in-process from the raw duration_ms values
 * retrieved for the window (SQLite has no built-in PERCENTILE_CONT).
 */

import { newUUIDv7 } from '@weaveintel/core';
import type { DatabaseAdapter } from './db-types.js';

const INTERVAL_MS = 15 * 60 * 1000; // 15 minutes

function percentile(sortedAsc: number[], p: number): number | null {
  if (sortedAsc.length === 0) return null;
  const idx = Math.ceil((p / 100) * sortedAsc.length) - 1;
  return sortedAsc[Math.max(0, idx)] ?? null;
}

async function takeSnapshots(db: DatabaseAdapter, windowStart: string, windowEnd: string): Promise<void> {
  // Fetch all events in the window to aggregate per tool.
  const events = await db.listToolAuditEvents({ afterIso: windowStart, beforeIso: windowEnd, limit: 10_000 });

  // Group by tool_name.
  const byTool = new Map<string, typeof events>();
  for (const ev of events) {
    if (!byTool.has(ev.tool_name)) byTool.set(ev.tool_name, []);
    byTool.get(ev.tool_name)!.push(ev);
  }

  for (const [toolName, rows] of byTool) {
    const invocationCount = rows.length;
    const successCount = rows.filter((r) => r.outcome === 'success').length;
    const errorCount   = rows.filter((r) => r.outcome === 'error' || r.outcome === 'timeout').length;
    const deniedCount  = rows.filter((r) => r.outcome.startsWith('denied') || r.outcome === 'circuit_open').length;

    const durations = rows
      .map((r) => r.duration_ms)
      .filter((d): d is number => d !== null)
      .sort((a, b) => a - b);

    const avgDurationMs = durations.length > 0
      ? durations.reduce((sum, d) => sum + d, 0) / durations.length
      : null;
    const p95DurationMs = percentile(durations, 95);

    const errorRate   = invocationCount > 0 ? errorCount   / invocationCount : 0;
    const availability = invocationCount > 0 ? successCount / invocationCount : 1;

    await db.insertToolHealthSnapshot({
      id: newUUIDv7(),
      tool_name: toolName,
      snapshot_at: windowEnd,
      invocation_count: invocationCount,
      success_count: successCount,
      error_count: errorCount,
      denied_count: deniedCount,
      avg_duration_ms: avgDurationMs,
      p95_duration_ms: p95DurationMs,
      error_rate: errorRate,
      availability,
    });
  }
}

/**
 * Start the background health snapshot job.
 * Returns a cleanup handle — call `stop()` on graceful shutdown.
 */
export function startToolHealthJob(db: DatabaseAdapter): { stop: () => void } {
  let lastWindowEnd = new Date(Math.floor(Date.now() / INTERVAL_MS) * INTERVAL_MS).toISOString();

  const handle = setInterval(() => {
    const now = new Date();
    const windowEnd   = new Date(Math.floor(now.getTime() / INTERVAL_MS) * INTERVAL_MS).toISOString();
    const windowStart = lastWindowEnd;
    lastWindowEnd = windowEnd;
    takeSnapshots(db, windowStart, windowEnd).catch((err) => {
      process.stderr.write(`[ToolHealthJob] Snapshot write failed: ${err}\n`);
    });
  }, INTERVAL_MS);

  // Prevent the interval from blocking graceful shutdown.
  if (typeof handle === 'object' && handle !== null && 'unref' in handle) {
    (handle as NodeJS.Timeout).unref();
  }

  return { stop: () => clearInterval(handle) };
}
