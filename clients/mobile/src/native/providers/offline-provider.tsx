/**
 * offline-provider.tsx — provides network status + outbox flush coordination.
 *
 * Device-gated. Responsibilities:
 *   1. Subscribe to network status via NetInfo.
 *   2. When connectivity returns, flush the run outbox via `client.flushOutbox()`.
 *   3. Track how many runs are queued in the outbox so the offline banner can
 *      show "N messages queued".
 *   4. Expose `isOnline` and `queuedCount` to child components.
 *
 * The provider uses a polling interval (10s) to refresh the queued count while
 * offline, in addition to flush-on-reconnect, so the banner stays accurate
 * if items are added while offline.
 */
import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useRef,
  useState,
  type ReactNode,
} from 'react';
import { useAuth } from './auth-provider';
import { subscribeNetworkStatus, fetchNetworkStatus, type NetworkStatus } from '../offline/offline-state';

interface OfflineContextValue {
  isOnline: boolean;
  connectionType: string | null;
  /** Number of runs queued in the outbox (0 when online or outbox is empty). */
  queuedCount: number;
  /** Manually trigger an outbox flush (no-op when offline). */
  flush: () => Promise<void>;
}

const OfflineContext = createContext<OfflineContextValue | null>(null);

export function useOffline(): OfflineContextValue {
  const ctx = useContext(OfflineContext);
  if (!ctx) throw new Error('useOffline must be used within <OfflineProvider>');
  return ctx;
}

const QUEUE_POLL_MS = 10_000;

export function OfflineProvider({ children }: { children: ReactNode }) {
  const { client } = useAuth();
  const [networkStatus, setNetworkStatus] = useState<NetworkStatus>({ isOnline: true, connectionType: null });
  const [queuedCount, setQueuedCount] = useState(0);
  const wasOnlineRef = useRef(true);
  const pollTimerRef = useRef<ReturnType<typeof setInterval> | null>(null);

  // Snapshot queued count from the client outbox.
  const refreshQueuedCount = useCallback(async () => {
    if (!client) { setQueuedCount(0); return; }
    try {
      // The api-client exposes listOutbox() only when an outbox is configured.
      // We duck-type: if enqueueRun exists, the outbox is wired.
      const enqueued = typeof (client as { listOutbox?: unknown }).listOutbox === 'function'
        ? await (client as { listOutbox: () => Promise<Array<unknown>> }).listOutbox()
        : [];
      setQueuedCount(enqueued.length);
    } catch {
      setQueuedCount(0);
    }
  }, [client]);

  const flush = useCallback(async () => {
    if (!client || !networkStatus.isOnline) return;
    try {
      await client.flushOutbox();
      await refreshQueuedCount();
    } catch (err) {
      console.warn('[offline] outbox flush failed:', String(err));
    }
  }, [client, networkStatus.isOnline, refreshQueuedCount]);

  // Subscribe to network changes.
  useEffect(() => {
    // Initial fetch.
    void fetchNetworkStatus().then(setNetworkStatus).catch(() => {});

    const unsubscribe = subscribeNetworkStatus((status) => {
      setNetworkStatus(status);
      const comingOnline = status.isOnline && !wasOnlineRef.current;
      wasOnlineRef.current = status.isOnline;
      if (comingOnline && client) {
        void client.flushOutbox().then(() => refreshQueuedCount()).catch(() => {});
      }
    });
    return unsubscribe;
  }, [client, flush, refreshQueuedCount]);

  // Poll queued count while offline.
  useEffect(() => {
    if (networkStatus.isOnline) {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
      setQueuedCount(0);
      return;
    }
    void refreshQueuedCount();
    pollTimerRef.current = setInterval(() => void refreshQueuedCount(), QUEUE_POLL_MS);
    return () => {
      if (pollTimerRef.current) { clearInterval(pollTimerRef.current); pollTimerRef.current = null; }
    };
  }, [networkStatus.isOnline, refreshQueuedCount]);

  return (
    <OfflineContext.Provider
      value={{
        isOnline: networkStatus.isOnline,
        connectionType: networkStatus.connectionType,
        queuedCount,
        flush,
      }}
    >
      {children}
    </OfflineContext.Provider>
  );
}
