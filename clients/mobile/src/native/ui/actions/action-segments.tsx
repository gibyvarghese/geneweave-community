/**
 * action-segments.tsx — the Approvals / Tasks / Reminders segmented control (M7).
 *
 * Device-gated, presentational. Renders three pill segments with an optional
 * count badge (e.g. pending approvals) and lifts selection to the screen. The
 * active segment uses the one sanctioned accent; counts use the amber attention
 * token per the icon rules. Colors come from {@link useTheme}, so per-tenant
 * themes re-skin the control.
 */
import { Pressable, Text, View } from 'react-native';
import type { ActionSegment } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon, type IconName } from '../icon';

interface SegmentDef {
  id: ActionSegment;
  label: string;
  icon: IconName;
}

const SEGMENTS: readonly SegmentDef[] = [
  { id: 'approvals', label: 'Approvals', icon: 'approval' },
  { id: 'tasks', label: 'Tasks', icon: 'task' },
  { id: 'reminders', label: 'Reminders', icon: 'reminder' },
];

export interface ActionSegmentsProps {
  active: ActionSegment;
  onChange: (segment: ActionSegment) => void;
  /** Per-segment count badges (0 / undefined hides the badge). */
  counts?: Partial<Record<ActionSegment, number>>;
}

export function ActionSegments({ active, onChange, counts }: ActionSegmentsProps) {
  const { theme } = useTheme();
  return (
    <View
      style={{
        flexDirection: 'row',
        gap: theme.spacing.sm,
        paddingHorizontal: theme.spacing.lg,
        paddingTop: theme.spacing.md,
      }}
    >
      {SEGMENTS.map((s) => {
        const isActive = s.id === active;
        const count = counts?.[s.id] ?? 0;
        return (
          <Pressable
            key={s.id}
            onPress={() => onChange(s.id)}
            style={{
              flex: 1,
              flexDirection: 'row',
              alignItems: 'center',
              justifyContent: 'center',
              gap: theme.spacing.sm,
              paddingVertical: theme.spacing.sm,
              borderRadius: theme.radii.pill,
              borderWidth: 1,
              borderColor: isActive ? theme.colors.accent : theme.colors.surfaceElevated,
              backgroundColor: isActive ? theme.colors.accentSoft : 'transparent',
            }}
          >
            {/* Badge overlaid on the icon so it never overflows the pill */}
            <View style={{ position: 'relative' }}>
              <Icon name={s.icon} size="sm" tone={isActive ? 'accent' : 'inactive'} />
              {count > 0 ? (
                <View
                  style={{
                    position: 'absolute',
                    top: -5,
                    right: -7,
                    minWidth: 16,
                    height: 16,
                    paddingHorizontal: 4,
                    borderRadius: 8,
                    alignItems: 'center',
                    justifyContent: 'center',
                    backgroundColor: theme.colors.warning,
                  }}
                >
                  <Text
                    style={{
                      color: theme.colors.background,
                      fontFamily: theme.typography.families.body,
                      fontSize: 10,
                      fontWeight: '700',
                      lineHeight: 13,
                    }}
                  >
                    {count > 99 ? '99+' : count}
                  </Text>
                </View>
              ) : null}
            </View>
            <Text
              style={{
                color: isActive ? theme.colors.accent : theme.colors.textSecondary,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.bodySmall.fontSize,
                fontWeight: isActive ? '600' : '400',
              }}
            >
              {s.label}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}
