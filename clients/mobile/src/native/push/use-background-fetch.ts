/**
 * use-background-fetch.ts — registers the 15-minute Actions-badge refresh task.
 *
 * Device-gated. Wraps {@link registerBackgroundFetch} in a one-shot useEffect
 * so the task is registered exactly once per app lifecycle, after the JS bundle
 * has evaluated and the background task definitions from
 * {@link background-action-handler} are already in scope.
 *
 * The task itself runs in a background process (expo-background-fetch /
 * expo-task-manager) and is defined in background-action-handler.ts at module
 * level. This hook only handles the OS registration step.
 */
import { useEffect } from 'react';
import { registerBackgroundFetch } from './background-action-handler';

export function useBackgroundFetch(): void {
  useEffect(() => {
    void registerBackgroundFetch().catch((err: unknown) => {
      console.warn('[push] background fetch registration failed:', String(err));
    });
  }, []);
}
