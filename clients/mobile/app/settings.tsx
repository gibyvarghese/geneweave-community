/**
 * settings.tsx — notifications, appearance, and privacy (M8).
 *
 * Pushed as a root Stack screen over the tabs. Master notifications switch +
 * per-category switches + a quiet-hours window (server-backed via
 * {@link useSettings}; tz encoded into the opaque string by the pure brain),
 * plus a local appearance preference (no server route — persisted on device via
 * {@link useAppearance}) and a privacy footnote. Thin renderer over the hook +
 * pure helpers.
 */
import { useState } from 'react';
import { ActivityIndicator, Text, View } from 'react-native';
import { router } from 'expo-router';
import { goBack } from '../src/native/navigation/go-back';
import {
  NOTIFICATION_CATEGORIES,
  isCategoryEnabled,
  quietHoursLabel,
  type QuietHours,
} from '../src/lib';
import { useSettings } from '../src/native/settings/use-settings';
import { useAppearance, useTheme } from '../src/native/providers';
import { ListScreen, ScreenHeader, Section, SwitchRow, NavRow, RowDivider, SectionNote, InfoRow } from '../src/native/ui/list';
import { ErrorText } from '../src/native/ui/primitives';
import { QuietHoursEditor } from '../src/native/ui/settings/quiet-hours-editor';
import { AppearanceSegments } from '../src/native/ui/settings/appearance-segments';

export default function SettingsScreen() {
  const { theme } = useTheme();
  const { prefs, isLoading, isError, error, setEnabled, toggleCategory, setQuietHours } = useSettings();
  const { preference, setPreference } = useAppearance();
  const [quietOpen, setQuietOpen] = useState(false);

  function onSaveQuiet(window: QuietHours | null) {
    setQuietHours(window);
  }

  return (
    <ListScreen>
      <ScreenHeader title="Settings" onBack={goBack} />

      {error ? <ErrorText>{error}</ErrorText> : null}

      {isLoading ? (
        <ActivityIndicator color={theme.colors.accent} style={{ marginTop: theme.spacing.lg }} />
      ) : (
        <>
          <Section title="Notifications">
            <SwitchRow icon="notifications" label="Push notifications" sublabel="Allow this device to notify you" value={prefs.enabled} onValueChange={setEnabled} />
          </Section>

          <Section title="What you hear about">
            {NOTIFICATION_CATEGORIES.map((cat, i) => (
              <View key={cat.id}>
                {i > 0 ? <RowDivider /> : null}
                <SwitchRow
                  label={cat.label}
                  sublabel={cat.description}
                  value={isCategoryEnabled(prefs, cat.id)}
                  onValueChange={() => toggleCategory(cat.id)}
                  disabled={!prefs.enabled}
                />
              </View>
            ))}
          </Section>

          <Section title="Quiet hours">
            <NavRow icon="quiet" label="Do not disturb" trailingText={quietHoursLabel(prefs.quietHours)} onPress={() => setQuietOpen(true)} />
          </Section>

          <View style={{ gap: theme.spacing.sm }}>
            <Text
              style={{
                color: theme.colors.textSecondary,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.label.fontSize,
                fontWeight: '600',
                textTransform: 'uppercase',
                letterSpacing: 0.5,
                paddingHorizontal: theme.spacing.xs,
              }}
            >
              Appearance
            </Text>
            <AppearanceSegments active={preference} onChange={setPreference} />
            <SectionNote>Appearance is saved on this device only.</SectionNote>
          </View>

          <Section title="Privacy">
            <InfoRow icon="data" label="Your data" value="Synced to your account" />
            <RowDivider />
            <NavRow icon="memory" label="Manage memory" sublabel="Review what the assistant remembers" onPress={() => router.push('/memory')} />
          </Section>

          {isError ? <SectionNote>Showing defaults — preferences could not be loaded.</SectionNote> : null}
        </>
      )}

      <QuietHoursEditor visible={quietOpen} current={prefs.quietHours} onSave={onSaveQuiet} onClose={() => setQuietOpen(false)} />
    </ListScreen>
  );
}
