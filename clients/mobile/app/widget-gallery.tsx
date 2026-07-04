/**
 * widget-gallery.tsx — dev-only gallery rendering every widget render kind.
 *
 * Reachable in development via the deep link `geneweave://widget-gallery`. It
 * renders one {@link WidgetBlock} per entry in `widgetFixtures` (which covers
 * all 12 render kinds plus the unknown-type and unsupported-schemaVersion
 * fallbacks), so the native renderers can be eyeballed without driving a live
 * run. Wrapped in an inert {@link WidgetActionProvider}, so interactive cards
 * render but their taps are no-ops here. Hidden in production builds.
 */
import { ScrollView, Text, View } from 'react-native';
import { Redirect } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import { widgetFixtures } from '../src/lib';
import { useTheme } from '../src/native/providers/theme-provider';
import { WidgetActionProvider, WidgetBlock } from '../src/native/ui/widgets';

export default function WidgetGalleryScreen() {
  const { theme } = useTheme();

  if (!__DEV__) return <Redirect href="/" />;

  return (
    <SafeAreaView style={{ flex: 1, backgroundColor: theme.colors.background }}>
      <WidgetActionProvider value={{ submit: () => {}, pending: {} }}>
        <ScrollView contentContainerStyle={{ padding: theme.spacing.lg, gap: theme.spacing.lg }}>
          <Text
            style={{
              color: theme.colors.text,
              fontFamily: theme.typography.families.display,
              fontSize: theme.typography.scale.title.fontSize,
              lineHeight: theme.typography.scale.title.lineHeight,
            }}
          >
            Widget gallery
          </Text>
          {widgetFixtures.map((fixture) => (
            <View key={fixture.caption} style={{ gap: theme.spacing.sm }}>
              <Text
                style={{
                  color: theme.colors.textMuted,
                  fontFamily: theme.typography.families.body,
                  fontSize: theme.typography.scale.label.fontSize,
                }}
              >
                {fixture.caption}
              </Text>
              <WidgetBlock view={fixture.view} />
            </View>
          ))}
        </ScrollView>
      </WidgetActionProvider>
    </SafeAreaView>
  );
}
