/**
 * @weaveintel/geneweave — Dashboard service
 *
 * Aggregates metrics, costs, evals from the database into
 * dashboard-ready views.
 */

import type { DatabaseAdapter, MetricsSummary, MetricRow, EvalRow } from './db.js';

// ─── Dashboard types ─────────────────────────────────────────

export interface DashboardOverview {
  summary: MetricsSummary;
  recentMetrics: MetricRow[];
  recentEvals: EvalRow[];
}

export interface CostBreakdown {
  total: number;
  byModel: Array<{ model: string; provider: string; cost: number; percentage: number }>;
  byDay: Array<{ date: string; cost: number }>;
}

export interface PerformanceStats {
  avgLatency: number;
  p50Latency: number;
  p95Latency: number;
  totalRequests: number;
  errorRate: number;
  byModel: Array<{ model: string; avgLatency: number; count: number }>;
}

// ─── Dashboard service ───────────────────────────────────────

export class DashboardService {
  constructor(private readonly db: DatabaseAdapter) {}

  async getOverview(userId: string, from?: string, to?: string): Promise<DashboardOverview> {
    const [summary, recentMetrics, recentEvals] = await Promise.all([
      this.db.getMetricsSummary(userId, from, to),
      this.db.getMetrics(userId, from, to),
      this.db.getEvals(userId, from, to),
    ]);

    return {
      summary,
      recentMetrics: recentMetrics.slice(0, 50),
      recentEvals: recentEvals.slice(0, 50),
    };
  }

  async getCostBreakdown(userId: string, from?: string, to?: string): Promise<CostBreakdown> {
    const summary = await this.db.getMetricsSummary(userId, from, to);
    const total = summary.total_cost;

    return {
      total,
      byModel: summary.by_model.map((m) => ({
        model: m.model ?? 'unknown',
        provider: m.provider ?? 'unknown',
        cost: m.cost,
        percentage: total > 0 ? (m.cost / total) * 100 : 0,
      })),
      byDay: summary.by_day.map((d) => ({ date: d.date, cost: d.cost })),
    };
  }

  async getPerformance(userId: string, from?: string, to?: string): Promise<PerformanceStats> {
    const metrics = await this.db.getMetrics(userId, from, to);
    if (metrics.length === 0) {
      return { avgLatency: 0, p50Latency: 0, p95Latency: 0, totalRequests: 0, errorRate: 0, byModel: [] };
    }

    const latencies = metrics
      .map((m) => m.latency_ms)
      .filter((v): v is number => typeof v === 'number' && v >= 0)
      .sort((a, b) => a - b);
    const errorCount = metrics.filter((m) => m.type === 'error').length;

    // Group by model — skip entries with null latency to keep averages meaningful
    const modelMap = new Map<string, { total: number; count: number }>();
    for (const m of metrics) {
      if (typeof m.latency_ms !== 'number' || m.latency_ms < 0) continue;
      const key = m.model ?? 'unknown';
      const entry = modelMap.get(key) ?? { total: 0, count: 0 };
      entry.total += m.latency_ms;
      entry.count += 1;
      modelMap.set(key, entry);
    }

    return {
      avgLatency: latencies.length > 0 ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0,
      p50Latency: latencies[Math.floor(latencies.length * 0.5)] ?? 0,
      p95Latency: latencies[Math.floor(latencies.length * 0.95)] ?? 0,
      totalRequests: metrics.length,
      errorRate: metrics.length > 0 ? (errorCount / metrics.length) * 100 : 0,
      byModel: Array.from(modelMap.entries()).map(([model, v]) => ({
        model,
        avgLatency: Math.round(v.total / v.count),
        count: v.count,
      })),
    };
  }
}
