/**
 * (tabs)/profile.tsx — the account hub (M8).
 *
 * Identity card + entry points to Memory and Settings, plus inline security
 * controls (biometric gate, sign-out) and a persona-gated "Manage on web →"
 * link. Identity/persona derivation lives in {@link useProfile}; biometric +
 * sign-out delegate to the pure auth controller. Memory/Settings are pushed as
 * root Stack screens so they slide over the tab bar.
 */
import { useState } from 'react';
import { Linking } from 'react-native';
import { router } from 'expo-router';
import { useAuth } from '../../src/native/providers';
import { useProfile } from '../../src/native/profile/use-profile';
import { ProfileHeader } from '../../src/native/ui/profile/profile-header';
import { ListScreen, ScreenHeader, Section, NavRow, SwitchRow, RowDivider, SectionNote } from '../../src/native/ui/list';

export default function ProfileScreen() {
  const { controller } = useAuth();
  const { name, initials, persona, host, canManageWeb, manageUrl } = useProfile();

  const biometricAvailable = controller.isBiometricAvailable();
  const [biometricOn, setBiometricOn] = useState(controller.isBiometricEnabled());

  async function onToggleBiometric(next: boolean) {
    try {
      await controller.setBiometricEnabled(next);
      setBiometricOn(next);
    } catch {
      // Secure store write failed — leave UI showing the current persisted state.
    }
  }

  function openManageWeb() {
    if (manageUrl) void Linking.openURL(manageUrl);
  }

  return (
    <ListScreen>
      <ScreenHeader title="Profile" />
      <ProfileHeader name={name} initials={initials} persona={persona} host={host} />

      <Section>
        <NavRow icon="memory" label="Memory" sublabel="What the assistant remembers" onPress={() => router.push('/memory')} />
        <RowDivider />
        <NavRow icon="settings" label="Settings" sublabel="Notifications, appearance, privacy" onPress={() => router.push('/settings')} />
      </Section>

      {canManageWeb ? (
        <Section title="Organization">
          <NavRow icon="web" iconTone="accent" label="Manage on web" labelTone="accent" sublabel="Admin console" onPress={openManageWeb} />
        </Section>
      ) : null}

      <Section title="Security">
        <SwitchRow
          icon="security"
          label="Require biometric unlock"
          {...(biometricAvailable ? {} : { sublabel: 'No biometrics enrolled on this device' })}
          value={biometricOn}
          onValueChange={(v) => void onToggleBiometric(v)}
          disabled={!biometricAvailable}
        />
        <RowDivider />
        <NavRow icon="signout" iconTone="danger" label="Sign out" labelTone="danger" onPress={() => void controller.signOut()} />
      </Section>

      <SectionNote>Signed in as {persona}. Memory and notification preferences sync to your account.</SectionNote>
    </ListScreen>
  );
}
