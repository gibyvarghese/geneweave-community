/**
 * Resilience wrapper for the Kaggle adapter.
 *
 * Two layered defences against Kaggle's strict per-account rate limits:
 *   1. Bounded exponential retry via `createRetryBudget` (@weaveintel/resilience).
 *   2. Per-username circuit breaker via `createCircuitBreaker` (@weaveintel/resilience).
 *
 * Phase 5 — the bespoke BreakerState Map is replaced by `createCircuitBreaker`
 * from the canonical resilience package, removing the local duplicate implementation.
 */
// no-adhoc-resilience: allow (reason: this file is a thin wrapper that composes
// `createRetryBudget` + `createCircuitBreaker` from the canonical packages — no
// local re-implementation; basename triggers the lint, hence the per-file allow.)

import { createRetryBudget } from '@weaveintel/resilience';
import { createCircuitBreaker } from '@weaveintel/resilience';
import type { KaggleAdapter, KaggleCredentials } from './kaggle.js';

const FAILURE_THRESHOLD = 5;
const OPEN_COOLDOWN_MS = 60_000;

const circuitBreakers = new Map<string, ReturnType<typeof createCircuitBreaker>>();

function getBreaker(username: string): ReturnType<typeof createCircuitBreaker> {
  let b = circuitBreakers.get(username);
  if (!b) {
    b = createCircuitBreaker({ failureThreshold: FAILURE_THRESHOLD, cooldownMs: OPEN_COOLDOWN_MS });
    circuitBreakers.set(username, b);
  }
  return b;
}

const budget = createRetryBudget({
  maxRetries: 3,
  baseDelayMs: 1500,
  maxDelayMs: 30_000,
  retryableErrors: ['429', 'Too Many Requests'],
});

/**
 * Structured error thrown when the per-username circuit breaker is open OR
 * when the underlying call returned 429.
 */
export class KaggleRateLimitError extends Error {
  readonly code = 'kaggle_rate_limited' as const;
  readonly retryAfterSeconds: number;
  readonly username: string;
  readonly breakerOpen: boolean;
  constructor(username: string, retryAfterSeconds: number, breakerOpen: boolean, message?: string) {
    super(
      message ??
        `Kaggle circuit breaker open for "${username}" — too many recent 429s. ` +
          `Wait ${retryAfterSeconds}s for the per-account quota window to drain before retrying.`,
    );
    this.name = 'KaggleRateLimitError';
    this.username = username;
    this.retryAfterSeconds = retryAfterSeconds;
    this.breakerOpen = breakerOpen;
  }
}

/** Read current breaker state without mutating it. */
export function getKaggleBreakerState(
  username: string,
): { open: boolean; remainingSeconds: number; consecutiveFailures: number } {
  const b = circuitBreakers.get(username);
  if (!b) return { open: false, remainingSeconds: 0, consecutiveFailures: 0 };
  const snap = b.snapshot();
  const remainingMs = snap.state === 'open'
    ? Math.max(0, snap.openedAt + snap.cooldownMs - Date.now())
    : 0;
  return {
    open: snap.state === 'open',
    remainingSeconds: Math.ceil(remainingMs / 1000),
    consecutiveFailures: snap.consecutiveFailures,
  };
}

function isRateLimitError(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return /429|Too Many Requests/i.test(msg);
}

async function guard<T>(username: string, fn: () => Promise<T>): Promise<T> {
  const breaker = getBreaker(username);
  const pass = breaker.canPass();
  if (!pass.allowed) {
    const remainingMs = Math.max(0, pass.reopensAt - Date.now());
    throw new KaggleRateLimitError(username, Math.ceil(remainingMs / 1000), true);
  }

  try {
    const r = await budget.execute(fn);
    breaker.recordSuccess();
    return r;
  } catch (err) {
    if (isRateLimitError(err)) {
      breaker.recordFailure();
      const state = getKaggleBreakerState(username);
      throw new KaggleRateLimitError(
        username,
        state.remainingSeconds || 30,
        state.open,
        err instanceof Error ? err.message : String(err),
      );
    }
    throw err;
  }
}

/**
 * Wrap a `KaggleAdapter` so every method goes through bounded retry + a
 * per-username circuit breaker. The underlying adapter is never mutated.
 */
export function wrapAdapterWithResilience(inner: KaggleAdapter): KaggleAdapter {
  return new Proxy(inner, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function') return value;
      return (...args: unknown[]) => {
        const creds = args[0] as KaggleCredentials | undefined;
        const username = creds?.username ?? '<unknown>';
        return guard(username, () => (value as (...a: unknown[]) => Promise<unknown>).apply(target, args));
      };
    },
  });
}

/** Test-only: reset the per-username breaker map. */
export function __resetBreakerStateForTests(): void {
  circuitBreakers.clear();
}
