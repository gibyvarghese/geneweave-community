/**
 * (tabs)/calendar.tsx — WC5 mobile calendar tab.
 *
 * Agenda-first list of upcoming items grouped into Today / Tomorrow / This week /
 * Next week / Later / Overdue buckets.  Pull-to-refresh reloads from the API.
 * A floating quick-add bar at the top accepts natural-language input and posts to
 * POST /api/me/agenda (NL parse happens server-side — no client work needed).
 *
 * Tap a bucket row routes to nothing yet (detail sheet to follow in a later
 * milestone). The tab icon is CalendarDays.
 */
import { useState, useCallback, useEffect } from 'react';
import {
  View,
  Text,
  TextInput,
  FlatList,
  TouchableOpacity,
  RefreshControl,
  ActivityIndicator,
  StyleSheet,
  KeyboardAvoidingView,
  Platform,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useAuth } from '../../src/native/providers/auth-provider';
import { useTheme } from '../../src/native/providers/theme-provider';
import { Icon } from '../../src/native/ui/icon';
import type { Theme } from '@weaveintel/tokens';
import type { AgendaItem, AgendaCategory } from '@weaveintel/api-client';

type Bucket = 'Overdue' | 'Today' | 'Tomorrow' | 'This week' | 'Next week' | 'Later' | 'Unscheduled';
const BUCKET_ORDER: Bucket[] = ['Overdue', 'Today', 'Tomorrow', 'This week', 'Next week', 'Later', 'Unscheduled'];

function toYMD(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function startOfDay(d: Date): Date {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

function bucketFor(startAt: string | null): Bucket {
  if (!startAt) return 'Unscheduled';
  const now = startOfDay(new Date());
  const itemDay = startOfDay(new Date(startAt));
  const diff = Math.round((itemDay.getTime() - now.getTime()) / 86400000);
  if (diff < 0) return 'Overdue';
  if (diff === 0) return 'Today';
  if (diff === 1) return 'Tomorrow';
  if (diff <= 7) return 'This week';
  if (diff <= 14) return 'Next week';
  return 'Later';
}

function formatTime(item: AgendaItem): string {
  if (item.all_day) return 'All day';
  if (!item.start_at) return '';
  const d = new Date(item.start_at);
  return d.toLocaleTimeString(undefined, { hour: '2-digit', minute: '2-digit' });
}

interface BucketSection {
  bucket: Bucket;
  items: AgendaItem[];
}

function buildSections(items: AgendaItem[]): BucketSection[] {
  const map = new Map<Bucket, AgendaItem[]>();
  for (const item of items) {
    const b = bucketFor(item.start_at);
    const arr = map.get(b) ?? [];
    arr.push(item);
    map.set(b, arr);
  }
  return BUCKET_ORDER.filter((b) => map.has(b)).map((b) => ({ bucket: b, items: map.get(b)! }));
}

type ListRow = { type: 'header'; bucket: Bucket } | { type: 'item'; item: AgendaItem; categories: AgendaCategory[] };

export default function CalendarScreen() {
  const { client, state: authState } = useAuth();
  const { theme } = useTheme();
  const authed = authState.status === 'authenticated' && client !== null;

  const [items, setItems] = useState<AgendaItem[]>([]);
  const [categories, setCategories] = useState<AgendaCategory[]>([]);
  const [loading, setLoading] = useState(false);
  const [refreshing, setRefreshing] = useState(false);
  const [quickAdd, setQuickAdd] = useState('');
  const [adding, setAdding] = useState(false);

  const load = useCallback(async (silent = false) => {
    if (!authed || !client) return;
    if (!silent) setLoading(true);
    else setRefreshing(true);
    try {
      const now = new Date();
      const after = new Date(now.getFullYear(), now.getMonth() - 1, 1).toISOString();
      const before = new Date(now.getFullYear(), now.getMonth() + 3, 1).toISOString();
      const [fetchedItems, fetchedCats] = await Promise.all([
        client.listAgendaItems({ after, before }),
        client.listAgendaCategories(),
      ]);
      setItems(fetchedItems);
      setCategories(fetchedCats);
    } catch {
      // silent — show stale data
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  }, [authed, client]);

  useEffect(() => { void load(); }, [load]);

  const handleQuickAdd = useCallback(async () => {
    const text = quickAdd.trim();
    if (!text || !client) return;
    setAdding(true);
    try {
      const item = await client.createAgendaItem({ title: text, nlText: text });
      setItems((prev) => [item, ...prev]);
      setQuickAdd('');
    } catch {
      // ignore
    } finally {
      setAdding(false);
    }
  }, [quickAdd, client]);

  const sections = buildSections(items);
  const rows: ListRow[] = sections.flatMap(({ bucket, items: bucketItems }) => [
    { type: 'header' as const, bucket },
    ...bucketItems.map((item) => ({ type: 'item' as const, item, categories })),
  ]);

  const s = makeStyles(theme);

  function renderRow({ item: row }: { item: ListRow }) {
    if (row.type === 'header') {
      const isOverdue = row.bucket === 'Overdue';
      const isToday = row.bucket === 'Today';
      return (
        <Text style={[s.bucketHeader, isOverdue && s.overdue, isToday && s.todayLabel]}>
          {row.bucket}
        </Text>
      );
    }
    const { item, categories: cats } = row;
    const cat = cats.find((c) => c.id === item.category_id);
    const color = cat?.color ?? theme.colors.accent;
    const timeLabel = formatTime(item);
    return (
      <View style={s.row}>
        <View style={[s.colorBar, { backgroundColor: color }]} />
        <View style={s.rowContent}>
          <Text style={s.rowTitle} numberOfLines={1}>{item.title}</Text>
          <View style={s.rowMeta}>
            {cat ? (
              <View style={[s.catChip, { backgroundColor: color + '22' }]}>
                <Text style={[s.catChipText, { color }]}>{(cat.icon ?? '') + ' ' + cat.name}</Text>
              </View>
            ) : null}
            {timeLabel ? <Text style={s.rowTime}>{timeLabel}</Text> : null}
            {item.location ? <Text style={s.rowMeta2}>📍 {item.location}</Text> : null}
          </View>
        </View>
      </View>
    );
  }

  return (
    <SafeAreaView edges={['top']} style={[s.safe, { backgroundColor: theme.colors.background }]}>
      <KeyboardAvoidingView
        style={s.flex}
        behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        keyboardVerticalOffset={80}
      >
        {/* Header */}
        <View style={s.header}>
          <Icon name="calendar" size="md" tone="active" />
          <Text style={s.headerTitle}>Calendar</Text>
        </View>

        {/* Quick-add bar */}
        <View style={s.qaBar}>
          <TextInput
            style={[s.qaInput, { borderColor: theme.colors.border, backgroundColor: theme.colors.surface, color: theme.colors.text }]}
            placeholder='+ Add event… "meeting tomorrow at 2pm"'
            placeholderTextColor={theme.colors.textMuted}
            value={quickAdd}
            onChangeText={setQuickAdd}
            onSubmitEditing={handleQuickAdd}
            returnKeyType="done"
            editable={!adding}
          />
          <TouchableOpacity
            style={[s.qaBtn, { backgroundColor: theme.colors.accent }, (!quickAdd.trim() || adding) && s.qaBtnDisabled]}
            onPress={handleQuickAdd}
            disabled={!quickAdd.trim() || adding}
          >
            {adding
              ? <ActivityIndicator color={theme.colors.onAccent} size="small" />
              : <Text style={[s.qaBtnText, { color: theme.colors.onAccent }]}>Add</Text>
            }
          </TouchableOpacity>
        </View>

        {/* Agenda list */}
        {loading && items.length === 0 ? (
          <View style={s.center}>
            <ActivityIndicator color={theme.colors.accent} />
          </View>
        ) : (
          <FlatList
            data={rows}
            keyExtractor={(row, i) => (row.type === 'header' ? `h-${row.bucket}` : `i-${row.item.id}-${i}`)}
            renderItem={renderRow}
            refreshControl={
              <RefreshControl
                refreshing={refreshing}
                onRefresh={() => void load(true)}
                tintColor={theme.colors.accent}
              />
            }
            ListEmptyComponent={
              <View style={s.empty}>
                <Icon name="calendar" size="lg" tone="muted" />
                <Text style={[s.emptyMsg, { color: theme.colors.textSecondary }]}>No upcoming events</Text>
                <Text style={[s.emptySub, { color: theme.colors.textMuted }]}>Use the quick-add bar above to create one</Text>
              </View>
            }
            contentContainerStyle={rows.length === 0 ? s.flex : undefined}
          />
        )}
      </KeyboardAvoidingView>
    </SafeAreaView>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 10,
      paddingHorizontal: 16,
      paddingTop: 12,
      paddingBottom: 8,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    headerTitle: {
      fontSize: 20,
      fontWeight: '700',
      color: theme.colors.text,
      fontFamily: theme.typography.families.display,
    },
    qaBar: {
      flexDirection: 'row',
      gap: 8,
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    qaInput: {
      flex: 1,
      borderWidth: 1,
      borderRadius: 10,
      paddingHorizontal: 12,
      paddingVertical: 8,
      fontSize: 14,
    },
    qaBtn: {
      paddingHorizontal: 14,
      borderRadius: 10,
      justifyContent: 'center',
      alignItems: 'center',
      minWidth: 52,
    },
    qaBtnDisabled: { opacity: 0.5 },
    qaBtnText: { fontSize: 14, fontWeight: '600' },
    bucketHeader: {
      fontSize: 11,
      fontWeight: '700',
      letterSpacing: 0.6,
      textTransform: 'uppercase',
      color: theme.colors.textSecondary,
      paddingHorizontal: 16,
      paddingTop: 14,
      paddingBottom: 6,
    },
    overdue: { color: theme.colors.danger ?? '#ef4444' },
    todayLabel: { color: theme.colors.accent },
    row: {
      flexDirection: 'row',
      alignItems: 'flex-start',
      paddingHorizontal: 16,
      paddingVertical: 10,
      borderBottomWidth: StyleSheet.hairlineWidth,
      borderBottomColor: theme.colors.border,
    },
    colorBar: {
      width: 4,
      borderRadius: 2,
      minHeight: 32,
      marginRight: 10,
      marginTop: 2,
    },
    rowContent: { flex: 1 },
    rowTitle: {
      fontSize: 14,
      fontWeight: '500',
      color: theme.colors.text,
      marginBottom: 4,
    },
    rowMeta: { flexDirection: 'row', flexWrap: 'wrap', gap: 6, alignItems: 'center' },
    rowTime: { fontSize: 12, color: theme.colors.textSecondary },
    rowMeta2: { fontSize: 12, color: theme.colors.textMuted },
    catChip: { paddingHorizontal: 7, paddingVertical: 2, borderRadius: 4 },
    catChipText: { fontSize: 11, fontWeight: '500' },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 8 },
    emptyMsg: { fontSize: 16, fontWeight: '600', marginTop: 8 },
    emptySub: { fontSize: 13, textAlign: 'center' },
  });
}
