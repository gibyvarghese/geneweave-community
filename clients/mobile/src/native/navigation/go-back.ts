/**
 * go-back.ts — robust back navigation for pushed account sub-screens.
 *
 * `router.back()` silently no-ops when the history stack is empty (e.g. after a
 * cold reload that deep-links straight onto Memory or Settings). This helper
 * pops when it can and otherwise lands the user on the home tab, so the back
 * affordance always goes somewhere.
 */
import { router } from 'expo-router';

export function goBack(): void {
  if (router.canGoBack()) router.back();
  else router.replace('/(tabs)');
}
