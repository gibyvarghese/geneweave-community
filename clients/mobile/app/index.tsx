/**
 * Initial route (`/`) for the geneWeave mobile app.
 *
 * This screen is only ever shown for a frame before `useProtectedRoute`
 * (driven by the auth state machine in the root layout) redirects into the
 * `(auth)` or `(tabs)` group. It renders a themed spinner so the hand-off from
 * the splash screen is seamless.
 */
import { ActivityIndicator, View } from 'react-native';
import { useTheme } from '../src/native/providers';

export default function Index() {
  const { theme } = useTheme();
  return (
    <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', backgroundColor: theme.colors.background }}>
      <ActivityIndicator color={theme.colors.accent} />
    </View>
  );
}
