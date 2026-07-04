/**
 * tool-call-line.tsx — a collapsed one-line summary of a tool invocation.
 *
 * Device-gated. Tool calls during a run render as a compact icon + monospace
 * label (e.g. a spinner glyph + `web.search · running`, or a check + `done`)
 * rather than full cards, so the assistant's prose stays the focus. The status
 * glyph goes through the central {@link Icon} so it obeys the icon rules.
 * Tapping is a no-op for M4; a detail sheet arrives with the widget surface (M5).
 */
import { Text, View } from 'react-native';
import type { ToolCallView } from '@weaveintel/api-client';
import { useTheme } from '../../providers/theme-provider';
import { Icon, type IconName, type IconTone } from '../icon';

export function ToolCallLine({ call }: { call: ToolCallView }) {
  const { theme } = useTheme();
  const failed = call.error != null;
  const done = !failed && call.result !== undefined;
  const icon: IconName = failed ? 'close' : done ? 'check' : 'running';
  const tone: IconTone = failed ? 'danger' : done ? 'inactive' : 'accent';
  const status = failed ? 'failed' : done ? 'done' : 'running';
  const color = failed ? theme.colors.danger : theme.colors.textSecondary;
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.xs }}>
      <Icon name={icon} size="sm" tone={tone} />
      <Text
        style={{
          fontFamily: theme.typography.families.mono,
          fontSize: theme.typography.scale.mono.fontSize,
          lineHeight: theme.typography.scale.mono.lineHeight,
          color,
        }}
        numberOfLines={1}
      >
        {call.toolName} · {status}
      </Text>
    </View>
  );
}
