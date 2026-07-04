/**
 * offline-state.ts — network reachability observer.
 *
 * Device-gated: imports @react-native-community/netinfo. Provides a typed
 * observable for network state so the offline provider can show banners,
 * disable interactive widgets, and flush the run outbox when connectivity
 * returns.
 *
 * We treat `isInternetReachable === false` (NetInfo's deeper check) as offline
 * rather than just `isConnected === false`, to handle captive portals and
 * LAN-only connections gracefully. On web/simulator `isInternetReachable` can
 * be null; we default to treating null as online (fail-open) to avoid spurious
 * offline banners in the dev environment.
 */
import NetInfo, { type NetInfoState, type NetInfoSubscription } from '@react-native-community/netinfo';

export interface NetworkStatus {
  isOnline: boolean;
  connectionType: string | null;
}

export type NetworkStatusListener = (status: NetworkStatus) => void;

function toStatus(state: NetInfoState): NetworkStatus {
  const isOnline = state.isInternetReachable !== false;
  return {
    isOnline,
    connectionType: state.type ?? null,
  };
}

/** Subscribe to network status changes. Returns an unsubscribe function. */
export function subscribeNetworkStatus(listener: NetworkStatusListener): () => void {
  const sub: NetInfoSubscription = NetInfo.addEventListener((state) => {
    listener(toStatus(state));
  });
  return () => sub();
}

/** Read the current network status (one-shot). */
export async function fetchNetworkStatus(): Promise<NetworkStatus> {
  const state = await NetInfo.fetch();
  return toStatus(state);
}
