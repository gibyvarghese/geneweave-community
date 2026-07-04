/**
 * query-provider.tsx — TanStack Query client for server-state caching.
 *
 * Device-gated (part of the native view layer). The query client is tuned for
 * mobile: a small `staleTime` so screens feel live, retry disabled on auth
 * errors (the auth controller owns re-authentication), and refetch-on-reconnect
 * so the app self-heals after the device regains connectivity.
 */
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { useRef, type ReactNode } from 'react';
import { AuthExpiredError } from '@weaveintel/api-client';

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        refetchOnReconnect: true,
        retry: (failureCount, error) => {
          if (error instanceof AuthExpiredError) return false;
          return failureCount < 2;
        },
      },
      mutations: { retry: false },
    },
  });
}

export function QueryProvider({ children }: { children: ReactNode }) {
  const ref = useRef<QueryClient | null>(null);
  ref.current ??= makeQueryClient();
  return <QueryClientProvider client={ref.current}>{children}</QueryClientProvider>;
}
