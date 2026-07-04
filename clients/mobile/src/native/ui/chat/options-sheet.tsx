/**
 * options-sheet.tsx — a half-height modal listing the surface catalog options.
 *
 * Device-gated. The catalog's `entries` are grouped by `kind` (mode / model /
 * agent / skill) — the four kinds the resolver produces — and rendered as
 * selectable rows. The current mode + model selection is lifted to the caller
 * so it can be stamped onto each run's metadata (per-tenant model/token
 * resolution happens server-side from that hint). Entries are DB-driven and
 * RBAC-filtered server-side, so the sheet shows exactly what the signed-in
 * principal may use — nothing is hardcoded here.
 */
import { Modal, Pressable, ScrollView, Text, View } from 'react-native';
import type { Catalog } from '@weaveintel/api-client';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';

/** A single catalog entry, narrowed from the loosely-typed catalog payload. */
interface Entry {
  id: string;
  kind: string;
  label: string;
  description?: string;
}

/** Stable display order + human labels for the four catalog kinds. */
const KIND_ORDER: ReadonlyArray<{ kind: string; title: string }> = [
  { kind: 'mode', title: 'Modes' },
  { kind: 'model', title: 'Models' },
  { kind: 'agent', title: 'Agents' },
  { kind: 'skill', title: 'Skills' },
];

export interface OptionsSheetProps {
  visible: boolean;
  catalog: Catalog | null;
  /** Map of kind → selected entry id (controlled by the caller). */
  selected: Record<string, string>;
  onSelect: (kind: string, id: string) => void;
  onClose: () => void;
}

function narrow(raw: Record<string, unknown>): Entry | null {
  const id = raw['id'];
  const kind = raw['kind'];
  const label = raw['label'];
  if (typeof id !== 'string' || typeof kind !== 'string' || typeof label !== 'string') return null;
  return {
    id,
    kind,
    label,
    ...(typeof raw['description'] === 'string' ? { description: raw['description'] } : {}),
  };
}

export function OptionsSheet({ visible, catalog, selected, onSelect, onClose }: OptionsSheetProps) {
  const { theme } = useTheme();
  const entries: Entry[] = (catalog?.entries ?? [])
    .map(narrow)
    .filter((e): e is Entry => e !== null);

  return (
    <Modal visible={visible} transparent animationType="slide" onRequestClose={onClose}>
      <Pressable style={{ flex: 1, backgroundColor: '#0008' }} onPress={onClose} />
      <View
        style={{
          maxHeight: '70%',
          backgroundColor: theme.colors.background,
          borderTopLeftRadius: theme.radii.xl,
          borderTopRightRadius: theme.radii.xl,
          paddingHorizontal: theme.spacing.lg,
          paddingTop: theme.spacing.md,
          paddingBottom: theme.spacing.xl,
          gap: theme.spacing.md,
        }}
      >
        <View
          style={{
            alignSelf: 'center',
            width: 36,
            height: 4,
            borderRadius: 2,
            backgroundColor: theme.colors.surfaceElevated,
          }}
        />
        <Text
          style={{
            color: theme.colors.text,
            fontFamily: theme.typography.families.display,
            fontSize: theme.typography.scale.title.fontSize,
            fontWeight: '600',
          }}
        >
          Options
        </Text>

        <ScrollView contentContainerStyle={{ gap: theme.spacing.lg }}>
          {KIND_ORDER.map(({ kind, title }) => {
            const group = entries.filter((e) => e.kind === kind);
            if (group.length === 0) return null;
            return (
              <View key={kind} style={{ gap: theme.spacing.sm }}>
                <Text
                  style={{
                    color: theme.colors.textSecondary,
                    fontFamily: theme.typography.families.body,
                    fontSize: theme.typography.scale.label.fontSize,
                    textTransform: 'uppercase',
                    letterSpacing: 1,
                  }}
                >
                  {title}
                </Text>
                {group.map((e) => {
                  const isSelected = selected[kind] === e.id;
                  return (
                    <Pressable
                      key={e.id}
                      onPress={() => onSelect(kind, e.id)}
                      style={{
                        flexDirection: 'row',
                        alignItems: 'center',
                        justifyContent: 'space-between',
                        borderWidth: 1,
                        borderColor: isSelected ? theme.colors.accent : theme.colors.surfaceElevated,
                        borderRadius: theme.radii.md,
                        paddingHorizontal: theme.spacing.md,
                        paddingVertical: theme.spacing.sm,
                        backgroundColor: theme.colors.surface,
                      }}
                    >
                      <View style={{ flex: 1, gap: 2 }}>
                        <Text
                          style={{
                            color: theme.colors.text,
                            fontFamily: theme.typography.families.body,
                            fontSize: theme.typography.scale.body.fontSize,
                          }}
                        >
                          {e.label}
                        </Text>
                        {e.description ? (
                          <Text
                            style={{
                              color: theme.colors.textMuted,
                              fontFamily: theme.typography.families.body,
                              fontSize: theme.typography.scale.caption.fontSize,
                            }}
                            numberOfLines={1}
                          >
                            {e.description}
                          </Text>
                        ) : null}
                      </View>
                      {isSelected ? (
                        <Icon name="check" size="sm" tone="accent" />
                      ) : null}
                    </Pressable>
                  );
                })}
              </View>
            );
          })}

          {entries.length === 0 ? (
            <Text
              style={{
                color: theme.colors.textMuted,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.bodySmall.fontSize,
              }}
            >
              No options available for this surface.
            </Text>
          ) : null}
        </ScrollView>
      </View>
    </Modal>
  );
}
