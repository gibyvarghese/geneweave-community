/**
 * quiet-hours-editor.tsx — set the do-not-disturb window (M8).
 *
 * Device-gated. Captures `start`/`end` as `HH:MM` plus an IANA timezone (the
 * device zone by default) and lifts a {@link QuietHours} window — or null to
 * turn it off — to the Settings screen, which encodes it into the opaque
 * `quietHours` string via the pure brain. Validation reuses the pure
 * {@link decodeQuietHours} round-trip so a malformed window can't be saved.
 */
import { useEffect, useMemo, useState } from 'react';
import { Modal, Pressable, Text, View } from 'react-native';
import { decodeQuietHours, encodeQuietHours, type QuietHours } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Field, PrimaryButton, ErrorText } from '../primitives';

const HHMM = /^([01]\d|2[0-3]):([0-5]\d)$/;

export interface QuietHoursEditorProps {
  visible: boolean;
  /** The current stored quietHours string (or null). */
  current: string | null;
  onSave: (window: QuietHours | null) => void;
  onClose: () => void;
}

function deviceTimezone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

export function QuietHoursEditor({ visible, current, onSave, onClose }: QuietHoursEditorProps) {
  const { theme } = useTheme();
  const tz = useMemo(() => decodeQuietHours(current)?.timezone ?? deviceTimezone(), [current]);
  const [start, setStart] = useState('22:00');
  const [end, setEnd] = useState('07:00');
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!visible) return;
    const decoded = decodeQuietHours(current);
    setStart(decoded?.start ?? '22:00');
    setEnd(decoded?.end ?? '07:00');
    setError(null);
  }, [visible, current]);

  function save() {
    if (!HHMM.test(start) || !HHMM.test(end)) {
      setError('Use 24-hour times like 22:00 and 07:00.');
      return;
    }
    const window: QuietHours = { start, end, timezone: tz };
    // Round-trip through the pure encoder/decoder to guarantee a valid string.
    if (!decodeQuietHours(encodeQuietHours(window))) {
      setError('That window could not be saved.');
      return;
    }
    onSave(window);
    onClose();
  }

  function turnOff() {
    onSave(null);
    onClose();
  }

  return (
    <Modal visible={visible} animationType="slide" transparent onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#00000066', justifyContent: 'flex-end' }} onPress={onClose}>
        <Pressable
          style={{
            backgroundColor: theme.colors.background,
            borderTopLeftRadius: theme.radii.xl,
            borderTopRightRadius: theme.radii.xl,
            padding: theme.spacing.lg,
            gap: theme.spacing.md,
          }}
        >
          <Text style={{ color: theme.colors.text, fontFamily: theme.typography.families.display, fontSize: theme.typography.scale.headline.fontSize, fontWeight: '600' }}>
            Quiet hours
          </Text>
          <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>
            Pushes are held during this window. Times are in {tz}.
          </Text>
          <View style={{ flexDirection: 'row', gap: theme.spacing.md }}>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: theme.colors.textSecondary, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>From</Text>
              <Field value={start} onChangeText={setStart} placeholder="22:00" keyboardType="numbers-and-punctuation" maxLength={5} />
            </View>
            <View style={{ flex: 1, gap: 4 }}>
              <Text style={{ color: theme.colors.textSecondary, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.caption.fontSize }}>To</Text>
              <Field value={end} onChangeText={setEnd} placeholder="07:00" keyboardType="numbers-and-punctuation" maxLength={5} />
            </View>
          </View>
          {error ? <ErrorText>{error}</ErrorText> : null}
          <PrimaryButton label="Save quiet hours" onPress={save} />
          <Pressable onPress={turnOff} hitSlop={8} style={{ alignItems: 'center', paddingVertical: theme.spacing.sm }}>
            <Text style={{ color: theme.colors.textMuted, fontFamily: theme.typography.families.body, fontSize: theme.typography.scale.bodySmall.fontSize }}>
              Turn off quiet hours
            </Text>
          </Pressable>
        </Pressable>
      </Pressable>
    </Modal>
  );
}
