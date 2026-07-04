/**
 * composer.tsx — the message input bar.
 *
 * Device-gated. A growing `TextInput` plus a single trailing affordance that is
 * the heart of the M4 accept criteria: while a run is producing it is a **Stop**
 * button (cancels in well under 500ms via the controller's `stop()`), otherwise
 * a **Send** button. The leading ＋ opens the attachment menu — currently
 * surfaced as "coming soon" because no user-scoped upload route exists yet
 * (flagged, not silently stubbed). The options affordance opens the options sheet.
 */
import { useState } from 'react';
import { Pressable, Text, TextInput, View } from 'react-native';
import type { ChatPhase } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { useVoice } from '../../voice/use-voice';
import { Icon } from '../icon';

export interface ComposerProps {
  text: string;
  phase: ChatPhase;
  onChangeText: (t: string) => void;
  onSend: () => void;
  onStop: () => void;
  onOpenOptions: () => void;
}

export function Composer({ text, phase, onChangeText, onSend, onStop, onOpenOptions }: ComposerProps) {
  const { theme } = useTheme();
  const producing = phase !== 'idle';
  const canSend = text.trim().length > 0;
  const [attachNotice, setAttachNotice] = useState(false);
  const voice = useVoice({ onText: onChangeText });

  function onMicPress() {
    if (!voice.isSupported) {
      // Surface the friendly "needs a dev build" hint rather than failing.
      voice.start(text);
      return;
    }
    voice.toggle(text);
  }

  return (
    <View
      style={{
        borderTopWidth: 1,
        borderTopColor: theme.colors.surfaceElevated,
        backgroundColor: theme.colors.background,
        paddingHorizontal: theme.spacing.md,
        paddingTop: theme.spacing.sm,
        paddingBottom: theme.spacing.md,
        gap: theme.spacing.xs,
      }}
    >
      {attachNotice ? (
        <Text
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.caption.fontSize,
            paddingHorizontal: theme.spacing.sm,
          }}
        >
          Attachments are coming soon.
        </Text>
      ) : null}

      {voice.message ? (
        <Text
          style={{
            color: theme.colors.textMuted,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.caption.fontSize,
            paddingHorizontal: theme.spacing.sm,
          }}
        >
          {voice.message}
        </Text>
      ) : null}

      <View style={{ flexDirection: 'row', alignItems: 'flex-end', gap: theme.spacing.sm }}>
        {/* Attachment menu — flagged: no upload route yet. */}
        <Pressable
          accessibilityLabel="Add attachment"
          onPress={() => setAttachNotice((v) => !v)}
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radii.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.surface,
          }}
        >
          <Icon name="add" size="md" tone="inactive" />
        </Pressable>

        <TextInput
          value={text}
          onChangeText={onChangeText}
          placeholder="Message weaveIntel"
          placeholderTextColor={theme.colors.textMuted}
          multiline
          editable
          style={{
            flex: 1,
            maxHeight: 120,
            minHeight: 40,
            color: theme.colors.text,
            backgroundColor: theme.colors.surface,
            borderRadius: theme.radii.lg,
            paddingHorizontal: theme.spacing.md,
            paddingTop: theme.spacing.sm,
            paddingBottom: theme.spacing.sm,
            fontFamily: theme.typography.families.body,
            fontSize: theme.typography.scale.body.fontSize,
          }}
        />

        <Pressable
          accessibilityLabel="Options"
          onPress={onOpenOptions}
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radii.pill,
            alignItems: 'center',
            justifyContent: 'center',
            backgroundColor: theme.colors.surface,
          }}
        >
          <Icon name="options" size="sm" tone="inactive" />
        </Pressable>

        {/* Voice dictation. Default engine is unsupported in Expo Go and shows a
            hint; a dev build wires the real recognizer via the registry. */}
        {producing ? null : (
          <Pressable
            accessibilityLabel={voice.isActive ? 'Stop dictation' : 'Dictate message'}
            onPress={onMicPress}
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radii.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: voice.isActive ? theme.colors.accentSoft : theme.colors.surface,
            }}
          >
            <Icon name={voice.isActive ? 'mic' : 'micOff'} size="sm" tone={voice.isActive ? 'accent' : 'inactive'} />
          </Pressable>
        )}

        {producing ? (
          <Pressable
            accessibilityLabel="Stop"
            onPress={onStop}
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radii.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: theme.colors.danger,
            }}
          >
            <View style={{ width: 14, height: 14, borderRadius: 3, backgroundColor: theme.colors.onAccent }} />
          </Pressable>
        ) : (
          <Pressable
            accessibilityLabel="Send"
            disabled={!canSend}
            onPress={onSend}
            style={{
              width: 40,
              height: 40,
              borderRadius: theme.radii.pill,
              alignItems: 'center',
              justifyContent: 'center',
              backgroundColor: canSend ? theme.colors.accent : theme.colors.surfaceElevated,
              opacity: canSend ? 1 : 0.6,
            }}
          >
            <Icon name="send" size="sm" tone="onAccent" />
          </Pressable>
        )}
      </View>
    </View>
  );
}
