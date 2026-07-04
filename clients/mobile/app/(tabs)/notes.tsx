/**
 * (tabs)/notes.tsx — the offline-first notes tab (weaveNotes Phase 7, G7).
 *
 * The list works with NO signal: notes are read from (and written to) an on-device cache first, and
 * a durable outbox syncs to the server when connectivity returns (see {@link useNotes}). Each note
 * shows a sync badge — a filled dot once synced, a hollow "queued" dot while it waits — and the header
 * shows an offline banner + a "N pending" count. Tapping a note opens the editor (text + freehand ink);
 * + New creates one instantly and opens it. Favourites pin to the top; long-press deletes.
 *
 * The tab icon is NotebookPen.
 */
import { useState, useCallback, useMemo } from 'react';
import {
  View, Text, TextInput, FlatList, TouchableOpacity, ActivityIndicator, StyleSheet, Alert,
} from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useRouter } from 'expo-router';
import { useAuth } from '../../src/native/providers/auth-provider';
import { useTheme } from '../../src/native/providers/theme-provider';
import { Icon } from '../../src/native/ui/icon';
import type { Theme } from '@weaveintel/tokens';
import { useNotes } from '../../src/native/notes/use-notes';
import { noteSyncStatus, type LocalNote } from '../../src/lib';
import { blocksPlainText, docToBlocks } from '@weaveintel/notes';

export default function NotesScreen() {
  const { state: authState } = useAuth();
  const { theme } = useTheme();
  const router = useRouter();
  const authed = authState.status === 'authenticated';

  const { notes, loading, syncing, online, pending, create, remove, toggleFavorite, refresh } = useNotes();
  const [search, setSearch] = useState('');
  const [creating, setCreating] = useState(false);

  // Active (non-archived) notes, filtered by the local search box.
  const visible = useMemo(() => {
    const active = notes.filter((n) => !n.archived_at);
    const q = search.trim().toLowerCase();
    if (!q) return active;
    return active.filter((n) => n.title.toLowerCase().includes(q) || blocksPlainText(docToBlocks(n.doc_json)).toLowerCase().includes(q));
  }, [notes, search]);

  const handleCreate = useCallback(async () => {
    setCreating(true);
    try {
      const note = await create({ title: 'Untitled' });
      router.push({ pathname: '/note/[id]' as never, params: { id: note.id } });
    } catch {
      Alert.alert('Error', 'Could not create note. Please try again.');
    } finally {
      setCreating(false);
    }
  }, [create, router]);

  const handleDelete = useCallback((note: LocalNote) => {
    Alert.alert('Delete note', `Delete "${note.title || 'Untitled'}"? This cannot be undone.`, [
      { text: 'Cancel', style: 'cancel' },
      { text: 'Delete', style: 'destructive', onPress: () => void remove(note.id) },
    ]);
  }, [remove]);

  const favs = visible.filter((n) => n.favorite);
  const others = visible.filter((n) => !n.favorite);
  const s = makeStyles(theme);

  function renderNote(note: LocalNote) {
    const isFav = !!note.favorite;
    const synced = noteSyncStatus(note, []) === 'synced'; // the hook folds pending ops into note.dirty
    const updatedDate = new Date(note.updated_at).toLocaleDateString(undefined, { month: 'short', day: 'numeric' });
    const preview = blocksPlainText(docToBlocks(note.doc_json)).slice(0, 80);
    return (
      <TouchableOpacity key={note.id} style={s.noteRow} activeOpacity={0.7}
        onPress={() => router.push({ pathname: '/note/[id]' as never, params: { id: note.id } })}
        onLongPress={() => handleDelete(note)} testID={`note-row-${note.title}`}>
        <Text style={s.noteIcon}>{note.icon ?? '📄'}</Text>
        <View style={s.noteBody}>
          <Text style={s.noteTitle} numberOfLines={1}>{note.title || 'Untitled'}</Text>
          {preview ? <Text style={[s.notePreview, { color: theme.colors.textMuted }]} numberOfLines={1}>{preview}</Text> : null}
          <View style={s.noteMeta}>
            <Text style={[s.noteDate, { color: theme.colors.textMuted }]}>{updatedDate}</Text>
            <View style={[s.syncDot, synced ? { backgroundColor: theme.colors.accent } : s.syncDotQueued]} testID={`sync-${synced ? 'synced' : 'queued'}`} />
            <Text style={[s.syncLabel, { color: theme.colors.textMuted }]}>{synced ? 'Synced' : 'Queued'}</Text>
          </View>
        </View>
        <TouchableOpacity style={s.favBtn} onPress={() => void toggleFavorite(note)} hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Text style={[s.favStar, isFav && s.favStarActive]}>{isFav ? '★' : '☆'}</Text>
        </TouchableOpacity>
      </TouchableOpacity>
    );
  }

  type Row = { type: 'header'; label: string } | { type: 'note'; note: LocalNote };
  const rows: Row[] = [];
  if (favs.length) { rows.push({ type: 'header', label: '★ Favourites' }); favs.forEach((n) => rows.push({ type: 'note', note: n })); }
  if (others.length) { if (favs.length) rows.push({ type: 'header', label: 'All notes' }); others.forEach((n) => rows.push({ type: 'note', note: n })); }

  return (
    <SafeAreaView edges={['top']} style={[s.safe, { backgroundColor: theme.colors.background }]}>
      <View style={s.header}>
        <View style={s.headerLeft}>
          <Icon name="notes" size="md" tone="active" />
          <Text style={[s.headerTitle, { color: theme.colors.text, fontFamily: theme.typography.families.display }]}>Notes</Text>
        </View>
        <TouchableOpacity style={[s.newBtn, { backgroundColor: theme.colors.accent }, creating && s.dim]} onPress={() => void handleCreate()} disabled={creating} testID="new-note">
          {creating ? <ActivityIndicator color={theme.colors.onAccent} size="small" /> : <Text style={[s.newBtnText, { color: theme.colors.onAccent }]}>+ New</Text>}
        </TouchableOpacity>
      </View>

      {/* Offline / sync status strip */}
      {(!online || pending > 0 || syncing) ? (
        <View style={[s.statusStrip, { backgroundColor: online ? '#F3F4F6' : '#FEF3C7' }]} testID="sync-strip">
          <Text style={[s.statusText, { color: online ? theme.colors.textSecondary : '#92400E' }]}>
            {!online ? '✈︎ Offline — your changes are saved on this device' : syncing ? 'Syncing…' : `${pending} change${pending === 1 ? '' : 's'} waiting to sync`}
          </Text>
        </View>
      ) : null}

      <View style={[s.searchBar, { borderBottomColor: theme.colors.border }]}>
        <Icon name="search" size="sm" tone="muted" />
        <TextInput style={[s.searchInput, { color: theme.colors.text }]} placeholder="Search notes…" placeholderTextColor={theme.colors.textMuted}
          value={search} onChangeText={setSearch} clearButtonMode="while-editing" returnKeyType="search" testID="notes-search" />
      </View>

      {loading && notes.length === 0 ? (
        <View style={s.center}><ActivityIndicator color={theme.colors.accent} /></View>
      ) : (
        <FlatList
          data={rows}
          keyExtractor={(row, i) => (row.type === 'header' ? `h-${row.label}` : `n-${row.note.id}-${i}`)}
          onRefresh={() => void refresh()}
          refreshing={false}
          renderItem={({ item }) => item.type === 'header'
            ? <Text style={[s.sectionLabel, { color: theme.colors.textSecondary }]}>{item.label}</Text>
            : renderNote(item.note)}
          ListEmptyComponent={
            <View style={s.empty}>
              <Icon name="notes" size="lg" tone="muted" />
              <Text style={[s.emptyMsg, { color: theme.colors.textSecondary }]}>{search ? 'No notes found' : 'No notes yet'}</Text>
              {!search ? (
                <TouchableOpacity style={[s.newBtnLg, { backgroundColor: theme.colors.accent }]} onPress={() => void handleCreate()} testID="empty-create">
                  <Text style={[s.newBtnText, { color: theme.colors.onAccent }]}>Create your first note</Text>
                </TouchableOpacity>
              ) : null}
            </View>
          }
          contentContainerStyle={rows.length === 0 ? s.flex : undefined}
        />
      )}
      {authed ? null : null}
    </SafeAreaView>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    header: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingTop: 12, paddingBottom: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border },
    headerLeft: { flexDirection: 'row', alignItems: 'center', gap: 10 },
    headerTitle: { fontSize: 20, fontWeight: '700' },
    newBtn: { paddingHorizontal: 14, paddingVertical: 7, borderRadius: 10, alignItems: 'center', justifyContent: 'center', minWidth: 64 },
    dim: { opacity: 0.5 },
    newBtnText: { fontSize: 14, fontWeight: '600' },
    newBtnLg: { marginTop: 12, paddingHorizontal: 20, paddingVertical: 10, borderRadius: 10 },
    statusStrip: { paddingHorizontal: 16, paddingVertical: 6 },
    statusText: { fontSize: 12, fontWeight: '600' },
    searchBar: { flexDirection: 'row', alignItems: 'center', gap: 8, paddingHorizontal: 14, paddingVertical: 8, borderBottomWidth: StyleSheet.hairlineWidth },
    searchInput: { flex: 1, fontSize: 14 },
    sectionLabel: { fontSize: 11, fontWeight: '700', letterSpacing: 0.6, textTransform: 'uppercase', paddingHorizontal: 16, paddingTop: 14, paddingBottom: 6 },
    noteRow: { flexDirection: 'row', alignItems: 'center', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth, borderBottomColor: theme.colors.border, gap: 10 },
    noteIcon: { fontSize: 20, width: 28, textAlign: 'center' },
    noteBody: { flex: 1 },
    noteTitle: { fontSize: 14, fontWeight: '500', color: theme.colors.text, marginBottom: 2 },
    notePreview: { fontSize: 12, marginBottom: 3 },
    noteMeta: { flexDirection: 'row', alignItems: 'center', gap: 6 },
    noteDate: { fontSize: 12 },
    syncDot: { width: 7, height: 7, borderRadius: 4 },
    syncDotQueued: { backgroundColor: 'transparent', borderWidth: 1.2, borderColor: '#9CA3AF' },
    syncLabel: { fontSize: 11 },
    favBtn: { padding: 4 },
    favStar: { fontSize: 18, color: theme.colors.textMuted },
    favStarActive: { color: '#f59e0b' },
    center: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 24 },
    empty: { flex: 1, justifyContent: 'center', alignItems: 'center', padding: 32, gap: 8 },
    emptyMsg: { fontSize: 16, fontWeight: '600', marginTop: 8 },
  });
}
