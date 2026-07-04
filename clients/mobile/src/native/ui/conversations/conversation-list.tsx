/**
 * conversation-list.tsx — the Chats list surface (M6).
 *
 * Device-gated, presentational. Renders a search field, filter chips, and a
 * sectioned (Running / Pinned / Recent) list of {@link ConversationRow}s with
 * pull-to-refresh and loading / empty / error states. All list/section logic is
 * computed by the pure brain in `src/lib`; this component only renders the
 * `sections` it is handed and lifts interaction up to the screen. Icons go
 * through the central {@link Icon}; colors come from {@link useTheme}.
 */
import { ActivityIndicator, Pressable, RefreshControl, SectionList, Text, TextInput, View } from 'react-native';
import type { Conversation } from '@weaveintel/api-client';
import type { ConversationChip, ConversationSection } from '../../../lib';
import { useTheme } from '../../providers/theme-provider';
import { Icon } from '../icon';
import { ConversationRow } from './conversation-row';

const CHIPS: ReadonlyArray<{ id: ConversationChip; label: string }> = [
  { id: 'all', label: 'All' },
  { id: 'pinned', label: 'Pinned' },
  { id: 'pending', label: 'Needs action' },
];

export interface ConversationListProps {
  sections: ConversationSection[];
  isLoading: boolean;
  isRefetching: boolean;
  isError: boolean;
  query: string;
  chip: ConversationChip;
  onQueryChange: (q: string) => void;
  onChipChange: (chip: ConversationChip) => void;
  onRefresh: () => void;
  onPressRow: (conversation: Conversation) => void;
  onLongPressRow: (conversation: Conversation) => void;
}

export function ConversationList({
  sections,
  isLoading,
  isRefetching,
  isError,
  query,
  chip,
  onQueryChange,
  onChipChange,
  onRefresh,
  onPressRow,
  onLongPressRow,
}: ConversationListProps) {
  const { theme } = useTheme();
  const isEmpty = sections.length === 0;

  return (
    <View style={{ flex: 1, backgroundColor: theme.colors.background }}>
      {/* Search field */}
      <View style={{ paddingHorizontal: theme.spacing.lg, paddingTop: theme.spacing.md, gap: theme.spacing.md }}>
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'center',
            gap: theme.spacing.sm,
            borderWidth: 1,
            borderColor: theme.colors.surfaceElevated,
            borderRadius: theme.radii.md,
            paddingHorizontal: theme.spacing.md,
            backgroundColor: theme.colors.surface,
          }}
        >
          <Icon name="search" size="sm" tone="muted" />
          <TextInput
            value={query}
            onChangeText={onQueryChange}
            placeholder="Search chats"
            placeholderTextColor={theme.colors.textMuted}
            autoCapitalize="none"
            autoCorrect={false}
            returnKeyType="search"
            style={{
              flex: 1,
              paddingVertical: theme.spacing.sm,
              color: theme.colors.text,
              fontFamily: theme.typography.families.body,
              fontSize: theme.typography.scale.body.fontSize,
            }}
          />
          {query ? (
            <Pressable onPress={() => onQueryChange('')} hitSlop={8}>
              <Icon name="close" size="sm" tone="muted" />
            </Pressable>
          ) : null}
        </View>

        {/* Filter chips */}
        <View style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
          {CHIPS.map((c) => {
            const active = c.id === chip;
            return (
              <Pressable
                key={c.id}
                onPress={() => onChipChange(c.id)}
                style={{
                  paddingHorizontal: theme.spacing.md,
                  paddingVertical: theme.spacing.sm,
                  borderRadius: theme.radii.pill,
                  borderWidth: 1,
                  borderColor: active ? theme.colors.accent : theme.colors.surfaceElevated,
                  backgroundColor: active ? theme.colors.accentSoft : 'transparent',
                }}
              >
                <Text
                  style={{
                    color: active ? theme.colors.accent : theme.colors.textSecondary,
                    fontFamily: theme.typography.families.body,
                    fontSize: theme.typography.scale.bodySmall.fontSize,
                    fontWeight: active ? '600' : '400',
                  }}
                >
                  {c.label}
                </Text>
              </Pressable>
            );
          })}
        </View>
      </View>

      {/* Body: loading / error / empty / list */}
      {isLoading && isEmpty ? (
        <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center' }}>
          <ActivityIndicator color={theme.colors.accent} />
        </View>
      ) : (
        <SectionList
          sections={sections.map((s) => ({ ...s, data: s.items }))}
          keyExtractor={(item) => item.id}
          stickySectionHeadersEnabled={false}
          contentContainerStyle={isEmpty ? { flexGrow: 1 } : { paddingBottom: theme.spacing.xl }}
          refreshControl={
            <RefreshControl
              refreshing={isRefetching}
              onRefresh={onRefresh}
              tintColor={theme.colors.accent}
              colors={[theme.colors.accent]}
            />
          }
          renderSectionHeader={({ section }) => (
            <Text
              style={{
                paddingHorizontal: theme.spacing.lg,
                paddingTop: theme.spacing.lg,
                paddingBottom: theme.spacing.sm,
                color: theme.colors.textSecondary,
                fontFamily: theme.typography.families.body,
                fontSize: theme.typography.scale.label.fontSize,
                textTransform: 'uppercase',
                letterSpacing: 1,
              }}
            >
              {section.title}
            </Text>
          )}
          renderItem={({ item }) => (
            <ConversationRow conversation={item} onPress={onPressRow} onLongPress={onLongPressRow} />
          )}
          ListEmptyComponent={
            <View style={{ flex: 1, alignItems: 'center', justifyContent: 'center', gap: theme.spacing.md, padding: theme.spacing.xl }}>
              <Icon name={isError ? 'error' : 'empty'} size="lg" tone={isError ? 'danger' : 'muted'} />
              <Text
                style={{
                  color: theme.colors.textSecondary,
                  fontFamily: theme.typography.families.body,
                  fontSize: theme.typography.scale.body.fontSize,
                  textAlign: 'center',
                }}
              >
                {isError
                  ? 'Could not load chats. Pull to retry.'
                  : query || chip !== 'all'
                    ? 'No chats match your filters.'
                    : 'No chats yet. Start a conversation to see it here.'}
              </Text>
            </View>
          }
        />
      )}
    </View>
  );
}
