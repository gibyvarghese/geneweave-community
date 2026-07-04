/**
 * interactive-widgets.tsx — approval + form renderers.
 *
 * These are the only widgets that talk back: a tap posts a `widget.action` via
 * the {@link useWidgetAction} context ("a tap is a turn"). They honour the
 * optimistic contract — once an action is in flight the card disables and shows
 * the chosen action pending, then reconciles when the server re-emits the
 * widget (the pure session clears `pending`).
 */
import { useState } from 'react';
import { TextInput, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import type { WidgetViewSpec } from '../../../lib';
import {
  WidgetCard,
  WidgetHeading,
  WidgetText,
  WidgetButton,
  WidgetActions,
} from './widget-shell';
import { useWidgetAction } from './widget-action-context';

type Spec<K extends WidgetViewSpec['kind']> = Extract<WidgetViewSpec, { kind: K }>;

// ---------------------------------------------------------------------------
// Approval
// ---------------------------------------------------------------------------

export function ApprovalWidget({ spec }: { spec: Spec<'approval'> }) {
  const { theme } = useTheme();
  const { submit, pending } = useWidgetAction();
  const pendingActionId = pending[spec.id];
  const isPending = pendingActionId !== undefined;

  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      {spec.title ? <WidgetHeading>{spec.title}</WidgetHeading> : null}
      {spec.riskLevel ? (
        <View
          style={{
            alignSelf: 'flex-start',
            backgroundColor: theme.colors.accentSoft,
            borderRadius: theme.radii.sm,
            paddingHorizontal: theme.spacing.sm,
            paddingVertical: 2,
          }}
        >
          <WidgetText size="caption">{spec.riskLevel}</WidgetText>
        </View>
      ) : null}
      <WidgetText>{spec.description}</WidgetText>
      <WidgetActions>
        {spec.actions.map((a) => (
          <WidgetButton
            key={a.actionId}
            action={a}
            disabled={isPending && pendingActionId !== a.actionId}
            pending={pendingActionId === a.actionId}
            onPress={() => submit(spec.id, a.actionId)}
          />
        ))}
      </WidgetActions>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Form
// ---------------------------------------------------------------------------

export function FormWidget({ spec }: { spec: Spec<'form'> }) {
  const { theme } = useTheme();
  const { submit, pending } = useWidgetAction();
  const pendingActionId = pending[spec.id];
  const isPending = pendingActionId !== undefined;

  const [values, setValues] = useState<Record<string, string>>(() => {
    const seed: Record<string, string> = {};
    for (const f of spec.fields) if (f.defaultValue !== undefined) seed[f.name] = f.defaultValue;
    return seed;
  });

  const setField = (name: string, v: string) => setValues((prev) => ({ ...prev, [name]: v }));

  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      {spec.title ? <WidgetHeading>{spec.title}</WidgetHeading> : null}
      {spec.description ? <WidgetText size="bodySmall">{spec.description}</WidgetText> : null}

      <View style={{ gap: theme.spacing.sm }}>
        {spec.fields.map((f) => (
          <View key={f.name} style={{ gap: 4 }}>
            <WidgetText size="label" muted>
              {f.label}
            </WidgetText>
            {f.type === 'select' && f.options ? (
              <View style={{ flexDirection: 'row', flexWrap: 'wrap', gap: theme.spacing.xs }}>
                {f.options.map((o) => {
                  const active = values[f.name] === o.value;
                  return (
                    <View
                      key={o.value}
                      style={{
                        backgroundColor: active ? theme.colors.accentStrong : theme.colors.surface,
                        borderColor: theme.colors.border,
                        borderWidth: 1,
                        borderRadius: theme.radii.sm,
                        paddingHorizontal: theme.spacing.sm,
                        paddingVertical: theme.spacing.xs,
                      }}
                      onTouchEnd={() => setField(f.name, o.value)}
                    >
                      <WidgetText size="caption">{o.label}</WidgetText>
                    </View>
                  );
                })}
              </View>
            ) : (
              <TextInput
                accessibilityLabel={f.label}
                editable={!isPending}
                value={values[f.name] ?? ''}
                onChangeText={(v) => setField(f.name, v)}
                placeholder={f.placeholder}
                placeholderTextColor={theme.colors.textMuted}
                keyboardType={f.type === 'number' ? 'numeric' : 'default'}
                multiline={f.type === 'textarea'}
                style={{
                  color: theme.colors.text,
                  fontFamily: theme.typography.families.body,
                  fontSize: theme.typography.scale.body.fontSize,
                  backgroundColor: theme.colors.surface,
                  borderColor: theme.colors.border,
                  borderWidth: 1,
                  borderRadius: theme.radii.sm,
                  paddingHorizontal: theme.spacing.sm,
                  paddingVertical: theme.spacing.xs,
                  minHeight: f.type === 'textarea' ? 64 : undefined,
                }}
              />
            )}
          </View>
        ))}
      </View>

      <WidgetActions>
        {spec.actions.map((a) => (
          <WidgetButton
            key={a.actionId}
            action={a}
            disabled={isPending && pendingActionId !== a.actionId}
            pending={pendingActionId === a.actionId}
            onPress={() => submit(spec.id, a.actionId, values)}
          />
        ))}
      </WidgetActions>
    </WidgetCard>
  );
}
