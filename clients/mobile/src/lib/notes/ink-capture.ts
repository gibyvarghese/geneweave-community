/**
 * ink-capture.ts — turn raw touch input into validated ink strokes (weaveNotes Phase 7, mobile).
 *
 * The on-device drawing surface (a react-native-svg canvas driven by PanResponder) collects a list
 * of touch points per stroke. This pure module converts those points into the shared {@link InkStroke}
 * model from `@weaveintel/notes` — the SAME model the web uses — running every stroke through the
 * package's strict `validateStrokes` gate so a finger-drawn line is bounded, finite, and safe.
 *
 * Keeping this pure (no react-native-svg, no PanResponder) means the capture maths is unit-testable
 * in Node; the RN component only wires gestures to `beginStroke`/`extendStroke`/`endStroke`.
 */
import { validateStrokes, strokeToPath, type InkStroke, type InkPoint, type InkTool } from '@weaveintel/notes';

/** The default pen + the highlighter the mobile toolbar offers (agency-coloured ink). */
export const PEN_COLORS = ['#14201B', '#C2410C', '#1D4ED8', '#15803D', '#B91C1C'] as const;
export const HIGHLIGHTER_COLOR = '#FDE68A';
export const DEFAULT_PEN_WIDTH = 3;
export const HIGHLIGHTER_WIDTH = 14;

export interface PenSettings { color: string; width: number; tool: InkTool }

export const DEFAULT_PEN: PenSettings = { color: PEN_COLORS[0], width: DEFAULT_PEN_WIDTH, tool: 'pen' };
export const HIGHLIGHTER_PEN: PenSettings = { color: HIGHLIGHTER_COLOR, width: HIGHLIGHTER_WIDTH, tool: 'highlighter' };

/** Start a new stroke at the first touch point with the active pen. */
export function beginStroke(point: InkPoint, pen: PenSettings): InkStroke {
  return { points: [point], color: pen.color, width: pen.width, tool: pen.tool, author: 'user' };
}

/** Append a point as the finger moves (dedupes a point identical to the previous one). */
export function extendStroke(stroke: InkStroke, point: InkPoint): InkStroke {
  const last = stroke.points[stroke.points.length - 1];
  if (last && last.x === point.x && last.y === point.y) return stroke;
  return { ...stroke, points: [...stroke.points, point] };
}

/**
 * Finish a stroke: validate it through the package gate. A stroke with fewer than 2 points (a tap)
 * is dropped (returns null) so stray taps never become invisible zero-length strokes.
 */
export function endStroke(stroke: InkStroke): InkStroke | null {
  if (stroke.points.length < 2) return null;
  const [clean] = validateStrokes([stroke]);
  return clean ?? null;
}

/** Append a finished stroke to a set, re-validating the whole set (the canonical persisted form). */
export function commitStroke(strokes: InkStroke[], stroke: InkStroke | null): InkStroke[] {
  if (!stroke) return strokes;
  return validateStrokes([...strokes, stroke]);
}

/** Remove the most recent stroke (the toolbar's Undo). */
export function undoStroke(strokes: InkStroke[]): InkStroke[] {
  return strokes.slice(0, -1);
}

/** Render a stroke to an SVG path `d` attribute (for react-native-svg `<Path>`). Reuses the package smoother. */
export function strokePath(stroke: InkStroke): string {
  return strokeToPath(stroke.points);
}
