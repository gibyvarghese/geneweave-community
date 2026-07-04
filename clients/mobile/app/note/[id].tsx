/**
 * note/[id].tsx — the mobile note editor (weaveNotes Phase 7, G7).
 *
 * Opens a note from the offline cache and lets you edit it with NO signal: a title, a multi-line text
 * body, and a freehand **ink canvas** (react-native-svg). Saving writes the shared `doc_json` (text +
 * an `inkCanvas` node) through the offline outbox, so the note — ink included — syncs to the web
 * untouched when connectivity returns. Web-only blocks (a diagram/image authored on the web) are
 * preserved and shown as a hint, never dropped. Ink is hidden if an admin disabled it in weaveNotes
 * settings. The screen is a thin renderer over the pure `editor-model` + the `useNotes` hook.
 */
import { useEffect, useState, useCallback, useRef } from 'react';
import { View, Text, TextInput, ScrollView, TouchableOpacity, ActivityIndicator, StyleSheet } from 'react-native';
import { SafeAreaView } from 'react-native-safe-area-context';
import { useLocalSearchParams } from 'expo-router';
import { goBack } from '../../src/native/navigation/go-back';
import { useTheme } from '../../src/native/providers/theme-provider';
import { useNotes } from '../../src/native/notes/use-notes';
import { InkCanvas } from '../../src/native/notes/ink-canvas';
import { splitNoteForEditor, composeNote, preservedSummary, type LocalNote } from '../../src/lib';
import { blocksToDoc, docToBlocks, type InkStroke } from '@weaveintel/notes';

export default function NoteEditorScreen() {
  const { id } = useLocalSearchParams<{ id: string }>();
  const { theme } = useTheme();
  const { getLocal, edit, capabilities, online, syncing } = useNotes();

  const [note, setNote] = useState<LocalNote | null>(null);
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [strokes, setStrokes] = useState<InkStroke[]>([]);
  const [preserved, setPreserved] = useState<ReturnType<typeof splitNoteForEditor>['preserved']>([]);
  const [loading, setLoading] = useState(true);
  const [showInk, setShowInk] = useState(false);
  const [saved, setSaved] = useState(false);
  const dirtyRef = useRef(false);

  const inkAllowed = capabilities?.mobileInkEnabled !== false;

  // Load the note from the local cache.
  useEffect(() => {
    let alive = true;
    void (async () => {
      const n = id ? await getLocal(id) : null;
      if (!alive || !n) { setLoading(false); return; }
      const model = splitNoteForEditor(docToBlocks(n.doc_json));
      setNote(n); setTitle(n.title); setBody(model.bodyText); setStrokes(model.strokes); setPreserved(model.preserved);
      setShowInk(model.strokes.length > 0);
      setLoading(false);
    })();
    return () => { alive = false; };
  }, [id, getLocal]);

  const markDirty = useCallback(() => { dirtyRef.current = true; setSaved(false); }, []);

  const save = useCallback(async () => {
    if (!note) return;
    const docJson = blocksToDoc(composeNote(body, strokes, preserved));
    await edit(note.id, { title: title.trim() || 'Untitled', doc_json: docJson });
    dirtyRef.current = false;
    setSaved(true);
  }, [note, title, body, strokes, preserved, edit]);

  // Save on leave if there are unsaved edits.
  useEffect(() => () => { if (dirtyRef.current) void save(); }, [save]);

  const onBack = useCallback(async () => { if (dirtyRef.current) await save(); goBack(); }, [save]);

  const s = makeStyles(theme);

  if (loading) return <SafeAreaView style={[s.safe, s.center, { backgroundColor: theme.colors.background }]}><ActivityIndicator color={theme.colors.accent} /></SafeAreaView>;
  if (!note) return (
    <SafeAreaView style={[s.safe, s.center, { backgroundColor: theme.colors.background }]}>
      <Text style={{ color: theme.colors.textSecondary }}>Note not found.</Text>
      <TouchableOpacity onPress={goBack} style={s.linkBtn}><Text style={{ color: theme.colors.accent }}>← Back to notes</Text></TouchableOpacity>
    </SafeAreaView>
  );

  return (
    <SafeAreaView edges={['top']} style={[s.safe, { backgroundColor: theme.colors.background }]}>
      <View style={[s.topbar, { borderBottomColor: theme.colors.border }]}>
        <TouchableOpacity onPress={() => void onBack()} testID="note-back" hitSlop={{ top: 8, right: 8, bottom: 8, left: 8 }}>
          <Text style={[s.back, { color: theme.colors.accent }]}>← Notes</Text>
        </TouchableOpacity>
        <View style={s.topbarRight}>
          <View style={[s.dot, online ? { backgroundColor: note.dirty ? 'transparent' : theme.colors.accent, borderColor: '#9CA3AF', borderWidth: note.dirty ? 1.2 : 0 } : { backgroundColor: '#F59E0B' }]} />
          <Text style={[s.status, { color: theme.colors.textMuted }]}>{!online ? 'Offline' : syncing ? 'Syncing…' : saved ? 'Saved' : note.dirty ? 'Queued' : 'Synced'}</Text>
          <TouchableOpacity onPress={() => void save()} style={[s.saveBtn, { backgroundColor: theme.colors.accent }]} testID="note-save">
            <Text style={[s.saveText, { color: theme.colors.onAccent }]}>Save</Text>
          </TouchableOpacity>
        </View>
      </View>

      <ScrollView style={s.flex} contentContainerStyle={s.body} keyboardShouldPersistTaps="handled">
        <TextInput style={[s.titleInput, { color: theme.colors.text, fontFamily: theme.typography.families.display }]}
          value={title} onChangeText={(t) => { setTitle(t); markDirty(); }} placeholder="Untitled"
          placeholderTextColor={theme.colors.textMuted} testID="note-title" />

        <TextInput style={[s.bodyInput, { color: theme.colors.text }]} value={body}
          onChangeText={(t) => { setBody(t); markDirty(); }} placeholder="Start writing…"
          placeholderTextColor={theme.colors.textMuted} multiline textAlignVertical="top" testID="note-body" />

        {preserved.length > 0 ? (
          <View style={[s.preservedHint, { backgroundColor: '#EEF2FF' }]} testID="preserved-hint">
            <Text style={s.preservedText}>This note also has {preservedSummary(preserved)} — open it on the web to edit that. It stays safe when you save here.</Text>
          </View>
        ) : null}

        {inkAllowed ? (
          <View style={s.inkSection}>
            <View style={s.inkHeader}>
              <Text style={[s.inkTitle, { color: theme.colors.textSecondary }]}>✏️ Drawing</Text>
              {!showInk && strokes.length === 0 ? (
                <TouchableOpacity onPress={() => setShowInk(true)} style={[s.addInk, { borderColor: theme.colors.accent }]} testID="add-ink">
                  <Text style={[s.addInkText, { color: theme.colors.accent }]}>+ Add a drawing</Text>
                </TouchableOpacity>
              ) : null}
            </View>
            {showInk || strokes.length > 0 ? (
              <InkCanvas strokes={strokes} onChange={(next) => { setStrokes(next); markDirty(); }} />
            ) : null}
          </View>
        ) : null}
      </ScrollView>
    </SafeAreaView>
  );
}

function makeStyles(theme: Theme) {
  return StyleSheet.create({
    safe: { flex: 1 },
    flex: { flex: 1 },
    center: { justifyContent: 'center', alignItems: 'center', gap: 10 },
    linkBtn: { padding: 8 },
    topbar: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', paddingHorizontal: 16, paddingVertical: 10, borderBottomWidth: StyleSheet.hairlineWidth },
    back: { fontSize: 15, fontWeight: '600' },
    topbarRight: { flexDirection: 'row', alignItems: 'center', gap: 8 },
    dot: { width: 8, height: 8, borderRadius: 4 },
    status: { fontSize: 12 },
    saveBtn: { paddingHorizontal: 14, paddingVertical: 6, borderRadius: 8 },
    saveText: { fontSize: 13, fontWeight: '700' },
    body: { padding: 16, paddingBottom: 48 },
    titleInput: { fontSize: 24, fontWeight: '700', marginBottom: 12 },
    bodyInput: { fontSize: 16, lineHeight: 24, minHeight: 160 },
    preservedHint: { borderRadius: 10, padding: 12, marginTop: 16 },
    preservedText: { fontSize: 13, color: '#3730A3', lineHeight: 19 },
    inkSection: { marginTop: 24 },
    inkHeader: { flexDirection: 'row', alignItems: 'center', justifyContent: 'space-between', marginBottom: 10 },
    inkTitle: { fontSize: 13, fontWeight: '700', letterSpacing: 0.4, textTransform: 'uppercase' },
    addInk: { borderWidth: 1, borderRadius: 8, paddingHorizontal: 12, paddingVertical: 6 },
    addInkText: { fontSize: 13, fontWeight: '600' },
  });
}

// Local Theme alias (avoids importing the type name into the component scope twice).
type Theme = import('@weaveintel/tokens').Theme;
