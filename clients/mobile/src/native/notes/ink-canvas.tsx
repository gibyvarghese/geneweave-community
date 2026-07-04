/**
 * ink-canvas.tsx — the on-device freehand drawing surface (weaveNotes Phase 7, G7).
 *
 * A react-native-svg canvas driven by PanResponder. Touch points are turned into the shared
 * {@link InkStroke} model via the pure `ink-capture` helpers (reusing `@weaveintel/notes`' smoother +
 * validation), so a drawing made here is byte-identical to one the web renders — the Phase-7
 * "ink intact" guarantee. The component is presentational: it owns the in-progress stroke and reports
 * the finished stroke set up via `onChange`.
 */
import { useRef, useState, useMemo } from 'react';
import { View, PanResponder, StyleSheet, Text, TouchableOpacity } from 'react-native';
import Svg, { Path } from 'react-native-svg';
import {
  beginStroke, extendStroke, endStroke, commitStroke, undoStroke, strokePath,
  PEN_COLORS, DEFAULT_PEN, HIGHLIGHTER_PEN, type PenSettings,
} from '../../lib';
import type { InkStroke } from '@weaveintel/notes';

export interface InkCanvasProps {
  strokes: InkStroke[];
  onChange: (strokes: InkStroke[]) => void;
  height?: number;
  /** Disable drawing (read-only preview / capability gated off). */
  readonly?: boolean;
}

export function InkCanvas({ strokes, onChange, height = 240, readonly = false }: InkCanvasProps) {
  const [pen, setPen] = useState<PenSettings>(DEFAULT_PEN);
  const [live, setLive] = useState<InkStroke | null>(null);
  const liveRef = useRef<InkStroke | null>(null);
  const penRef = useRef(pen);
  penRef.current = pen;

  const responder = useMemo(() => PanResponder.create({
    onStartShouldSetPanResponder: () => !readonly,
    onMoveShouldSetPanResponder: () => !readonly,
    onPanResponderGrant: (e) => {
      const { locationX, locationY } = e.nativeEvent;
      const s = beginStroke({ x: round(locationX), y: round(locationY) }, penRef.current);
      liveRef.current = s; setLive(s);
    },
    onPanResponderMove: (e) => {
      if (!liveRef.current) return;
      const { locationX, locationY } = e.nativeEvent;
      const s = extendStroke(liveRef.current, { x: round(locationX), y: round(locationY) });
      liveRef.current = s; setLive(s);
    },
    onPanResponderRelease: () => {
      const finished = endStroke(liveRef.current ?? { points: [], color: pen.color, width: pen.width, tool: pen.tool });
      liveRef.current = null; setLive(null);
      if (finished) onChange(commitStroke(strokes, finished));
    },
  }), [readonly, strokes, onChange, pen]);

  const allStrokes = live ? [...strokes, live] : strokes;

  return (
    <View>
      <View style={[styles.canvas, { height }]} {...(readonly ? {} : responder.panHandlers)} testID="ink-canvas">
        <Svg width="100%" height={height}>
          {allStrokes.map((s, i) => (
            <Path key={i} d={strokePath(s)} stroke={s.color}
              strokeWidth={s.width} fill="none" strokeLinecap="round" strokeLinejoin="round"
              opacity={s.tool === 'highlighter' ? 0.4 : 1} />
          ))}
        </Svg>
      </View>
      {readonly ? null : (
        <View style={styles.toolbar}>
          {PEN_COLORS.map((c) => (
            <TouchableOpacity key={c} onPress={() => setPen({ color: c, width: DEFAULT_PEN.width, tool: 'pen' })}
              style={[styles.swatch, { backgroundColor: c }, pen.color === c && pen.tool === 'pen' && styles.swatchActive]}
              testID={`pen-${c}`} accessibilityLabel={`pen ${c}`} />
          ))}
          <TouchableOpacity onPress={() => setPen(HIGHLIGHTER_PEN)}
            style={[styles.tool, pen.tool === 'highlighter' && styles.toolActive]} testID="ink-highlighter">
            <Text style={styles.toolText}>Highlighter</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onChange(undoStroke(strokes))} style={styles.tool} testID="ink-undo">
            <Text style={styles.toolText}>Undo</Text>
          </TouchableOpacity>
          <TouchableOpacity onPress={() => onChange([])} style={styles.tool} testID="ink-clear">
            <Text style={styles.toolText}>Clear</Text>
          </TouchableOpacity>
        </View>
      )}
    </View>
  );
}

function round(n: number): number { return Math.round(n * 10) / 10; }

const styles = StyleSheet.create({
  canvas: { borderWidth: StyleSheet.hairlineWidth, borderColor: '#D1D5DB', borderRadius: 10, backgroundColor: '#FFFFFF', overflow: 'hidden' },
  toolbar: { flexDirection: 'row', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginTop: 8 },
  swatch: { width: 24, height: 24, borderRadius: 12, borderWidth: 2, borderColor: 'transparent' },
  swatchActive: { borderColor: '#111827' },
  tool: { paddingHorizontal: 10, paddingVertical: 6, borderRadius: 8, backgroundColor: '#F3F4F6' },
  toolActive: { backgroundColor: '#FDE68A' },
  toolText: { fontSize: 12, fontWeight: '600', color: '#374151' },
});
