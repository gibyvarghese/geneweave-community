/**
 * widget-spec.ts — the pure brain of the M5 widget surface.
 *
 * The server streams rich UI as `widget.update` envelopes; the run reducer folds
 * each into a `WidgetView` ({@link WidgetInput}) carrying an opaque `payload`
 * record and an optional `schemaVersion`. This module turns that loosely-typed
 * record into a **fully-resolved, serialisable** {@link WidgetViewSpec} — a
 * discriminated union the native layer renders dumbly.
 *
 * Every hard decision lives here, never in a component:
 *   - which of the 8 `WidgetType`s + 4 payload families (approval / citation /
 *     artifact / progress) a widget maps to;
 *   - graceful coercion of every field (never throws on malformed data);
 *   - the **mandatory fallback** path — taken when the type is unknown, the
 *     declared `schemaVersion` exceeds what this client supports, the type is the
 *     open-ended `custom`, or structured data is too broken to render. The
 *     fallback carries `text` (+ an "open on desktop" `href` when the server gave
 *     a link), so the user is never shown a blank space;
 *   - the accessibility label every renderer must set, derived from
 *     `a11ySummary ?? title ?? a humanised type`.
 *
 * No `react`, no `react-native`, no `fetch`: this file runs in Node and is
 * snapshot-tested per widget kind.
 */

// ---------------------------------------------------------------------------
// Input — a structural subset of the reducer's `WidgetView`.
// ---------------------------------------------------------------------------

/** The minimal shape the spec builder needs from a reduced widget view. */
export interface WidgetInput {
  /** Stable widget id (used for action correlation + reconcile). */
  id: string;
  /** The raw widget payload record as streamed by the server. */
  payload: Record<string, unknown>;
  /** Schema version the server tagged this widget with, if any. */
  schemaVersion?: number;
}

// ---------------------------------------------------------------------------
// Output — the discriminated render spec.
// ---------------------------------------------------------------------------

/** A button on an interactive widget (approval / form). */
export interface ActionSpec {
  /** Human label shown on the control. */
  label: string;
  /** Stable action id posted back as the widget action. */
  actionId: string;
  /** Visual emphasis; defaults to neutral when omitted. */
  style?: 'primary' | 'danger' | 'secondary';
}

/** A single editable field on a `form` widget. */
export interface FormFieldSpec {
  /** Field key used in the submitted value map. */
  name: string;
  /** Human label. */
  label: string;
  /** Control kind. */
  type: 'text' | 'number' | 'textarea' | 'select';
  /** Placeholder for free-text controls. */
  placeholder?: string;
  /** Choices for `select`. */
  options?: { label: string; value: string }[];
  /** Initial value. */
  defaultValue?: string;
}

interface SpecBase {
  id: string;
  /** Always set — the value every renderer puts on `accessibilityLabel`. */
  a11yLabel: string;
  /** Optional heading. */
  title?: string;
}

/** The fully-resolved render description for one widget. */
export type WidgetViewSpec =
  | (SpecBase & { kind: 'table'; columns: string[]; rows: string[][] })
  | (SpecBase & {
      kind: 'chart';
      chartType?: string;
      series: { label: string; value?: number }[];
      summary?: string;
    })
  | (SpecBase & { kind: 'code'; language?: string; code: string })
  | (SpecBase & { kind: 'image'; uri: string; caption?: string })
  | (SpecBase & { kind: 'map'; summary: string; href?: string })
  | (SpecBase & {
      kind: 'timeline';
      events: { label: string; timestamp?: string; detail?: string }[];
    })
  | (SpecBase & {
      kind: 'form';
      description?: string;
      fields: FormFieldSpec[];
      actions: ActionSpec[];
    })
  | (SpecBase & {
      kind: 'approval';
      description: string;
      riskLevel?: string;
      actions: ActionSpec[];
    })
  | (SpecBase & {
      kind: 'citation';
      citations: { id: string; text: string; source: string; url?: string; page?: number }[];
    })
  | (SpecBase & {
      kind: 'artifact';
      artifactType: string;
      mimeType: string;
      downloadable: boolean;
      preview?: string;
    })
  | (SpecBase & {
      kind: 'progress';
      label: string;
      current: number;
      total: number;
      percentage: number;
      status: string;
    })
  | (SpecBase & { kind: 'fallback'; text: string; href?: string });

/** Every render kind the native layer must handle (incl. the fallback). */
export const WIDGET_RENDER_KINDS = [
  'table',
  'chart',
  'code',
  'image',
  'map',
  'timeline',
  'form',
  'approval',
  'citation',
  'artifact',
  'progress',
  'fallback',
] as const;

export type WidgetRenderKind = (typeof WIDGET_RENDER_KINDS)[number];

/**
 * Highest `schemaVersion` this client knows how to render per incoming widget
 * type. A payload tagged higher than its entry degrades to the fallback — the
 * forward-compat contract that lets the server ship v2 widgets without breaking
 * older apps. `custom` is intentionally absent: it always degrades.
 */
export const SUPPORTED_SCHEMA_VERSION: Record<string, number> = {
  table: 1,
  chart: 1,
  form: 1,
  code: 1,
  image: 1,
  map: 1,
  timeline: 1,
  approval: 1,
  citation: 1,
  artifact: 1,
  progress: 1,
};

// ---------------------------------------------------------------------------
// Safe coercion helpers — never throw, always degrade to a sensible default.
// ---------------------------------------------------------------------------

function asRecord(v: unknown): Record<string, unknown> | undefined {
  return v !== null && typeof v === 'object' && !Array.isArray(v)
    ? (v as Record<string, unknown>)
    : undefined;
}

function asString(v: unknown): string | undefined {
  if (typeof v === 'string') return v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  return undefined;
}

function asNumber(v: unknown): number | undefined {
  if (typeof v === 'number' && Number.isFinite(v)) return v;
  if (typeof v === 'string' && v.trim() !== '' && Number.isFinite(Number(v))) return Number(v);
  return undefined;
}

function asArray(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

function asBool(v: unknown): boolean {
  return v === true || v === 'true' || v === 1;
}

/** Humanise a type/key (`dose_response` → `Dose response`) for fallbacks/a11y. */
function humanise(s: string): string {
  const cleaned = s.replace(/[_-]+/g, ' ').trim();
  if (cleaned === '') return 'Widget';
  return cleaned.charAt(0).toUpperCase() + cleaned.slice(1);
}

/** The fields the builder reads off any widget payload, all coerced safely. */
interface CoercedPayload {
  id: string;
  type: string;
  title?: string;
  data: Record<string, unknown>;
  config: Record<string, unknown>;
  a11ySummary?: string;
  fallback?: { kind?: string; text?: string; href?: string };
  schemaVersion?: number;
  /** The untouched payload record, for builders that read root-level fields. */
  raw: Record<string, unknown>;
}

function coercePayload(view: WidgetInput): CoercedPayload {
  const p = view.payload ?? {};
  const fallbackRec = asRecord(p['fallback']);
  return {
    id: asString(p['id']) ?? view.id,
    type: (asString(p['type']) ?? 'custom').toLowerCase(),
    raw: p,
    ...(asString(p['title']) !== undefined ? { title: asString(p['title']) } : {}),
    data: asRecord(p['data']) ?? {},
    config: asRecord(p['config']) ?? {},
    ...(asString(p['a11ySummary']) !== undefined ? { a11ySummary: asString(p['a11ySummary']) } : {}),
    ...(fallbackRec
      ? {
          fallback: {
            ...(asString(fallbackRec['kind']) !== undefined ? { kind: asString(fallbackRec['kind']) } : {}),
            ...(asString(fallbackRec['text']) !== undefined ? { text: asString(fallbackRec['text']) } : {}),
            ...(asString(fallbackRec['href']) !== undefined ? { href: asString(fallbackRec['href']) } : {}),
          },
        }
      : {}),
    ...(asNumber(p['schemaVersion']) !== undefined ? { schemaVersion: asNumber(p['schemaVersion']) } : {}),
  };
}

function deriveA11yLabel(p: CoercedPayload): string {
  return p.a11ySummary ?? p.title ?? humanise(p.type);
}

/** Build the always-available fallback spec for a payload. */
function buildFallback(p: CoercedPayload, a11yLabel: string): Extract<WidgetViewSpec, { kind: 'fallback' }> {
  const isLink = p.fallback?.kind === 'link';
  const text =
    p.fallback?.text ??
    p.title ??
    p.a11ySummary ??
    'This content can’t be shown here. Open it on desktop.';
  const href = isLink ? p.fallback?.href : undefined;
  return {
    kind: 'fallback',
    id: p.id,
    a11yLabel,
    text: href ? `${text} — open on desktop` : text,
    ...(href !== undefined ? { href } : {}),
  };
}

function withTitle(base: WidgetViewSpec, p: CoercedPayload): WidgetViewSpec {
  return p.title !== undefined ? ({ ...base, title: p.title } as WidgetViewSpec) : base;
}

// ---------------------------------------------------------------------------
// Per-type builders. Each returns a typed spec, or `null` to degrade gracefully
// to the fallback when the structured data is unusable.
// ---------------------------------------------------------------------------

function buildTable(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const rawColumns = asArray(p.data['columns']);
  const columns = rawColumns.map((c) => {
    const rec = asRecord(c);
    return asString(rec?.['label']) ?? asString(rec?.['key']) ?? asString(c) ?? '';
  });
  const rawRows = asArray(p.data['rows']);
  const rows = rawRows.map((row) => {
    if (Array.isArray(row)) return row.map((cell) => asString(cell) ?? '');
    const rec = asRecord(row);
    if (rec && columns.length > 0) {
      // Object rows keyed by column label/key.
      const keys = rawColumns.map((c) => {
        const cr = asRecord(c);
        return asString(cr?.['key']) ?? asString(cr?.['label']) ?? asString(c) ?? '';
      });
      return keys.map((k) => asString(rec[k]) ?? '');
    }
    return [asString(row) ?? ''];
  });
  if (columns.length === 0 && rows.length === 0) return null;
  return withTitle({ kind: 'table', id: p.id, a11yLabel, columns, rows }, p);
}

function buildChart(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const series = asArray(p.data['series'] ?? p.data['points'] ?? p.data['data']).map((s) => {
    const rec = asRecord(s);
    const label = asString(rec?.['label']) ?? asString(rec?.['x']) ?? asString(rec?.['name']) ?? '';
    const value = asNumber(rec?.['value']) ?? asNumber(rec?.['y']);
    return value !== undefined ? { label, value } : { label };
  });
  const chartType = asString(p.data['chartType']) ?? asString(p.config['chartType']);
  if (series.length === 0 && p.a11ySummary === undefined) return null;
  return withTitle(
    {
      kind: 'chart',
      id: p.id,
      a11yLabel,
      series,
      ...(chartType !== undefined ? { chartType } : {}),
      ...(p.a11ySummary !== undefined ? { summary: p.a11ySummary } : {}),
    },
    p,
  );
}

function buildCode(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const code = asString(p.data['code']) ?? asString(p.data['source']) ?? asString(p.data['content']);
  if (code === undefined) return null;
  const language = asString(p.data['language']) ?? asString(p.config['language']);
  return withTitle(
    { kind: 'code', id: p.id, a11yLabel, code, ...(language !== undefined ? { language } : {}) },
    p,
  );
}

function buildImage(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const uri = asString(p.data['uri']) ?? asString(p.data['url']) ?? asString(p.data['src']);
  if (uri === undefined) return null;
  const caption = asString(p.data['caption']) ?? asString(p.data['alt']);
  return withTitle(
    { kind: 'image', id: p.id, a11yLabel, uri, ...(caption !== undefined ? { caption } : {}) },
    p,
  );
}

function buildMap(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const summary =
    asString(p.data['summary']) ??
    asString(p.data['location']) ??
    asString(p.data['address']) ??
    p.a11ySummary ??
    p.title;
  if (summary === undefined) return null;
  const href = p.fallback?.href ?? asString(p.config['href']) ?? asString(p.data['href']);
  return withTitle(
    { kind: 'map', id: p.id, a11yLabel, summary, ...(href !== undefined ? { href } : {}) },
    p,
  );
}

function buildTimeline(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const events = asArray(p.data['events'] ?? p.data['items']).map((e) => {
    const rec = asRecord(e);
    const label = asString(rec?.['label']) ?? asString(rec?.['title']) ?? asString(e) ?? '';
    const timestamp = asString(rec?.['timestamp']) ?? asString(rec?.['time']) ?? asString(rec?.['date']);
    const detail = asString(rec?.['detail']) ?? asString(rec?.['description']);
    return {
      label,
      ...(timestamp !== undefined ? { timestamp } : {}),
      ...(detail !== undefined ? { detail } : {}),
    };
  });
  if (events.length === 0) return null;
  return withTitle({ kind: 'timeline', id: p.id, a11yLabel, events }, p);
}

function coerceActions(raw: unknown): ActionSpec[] {
  return asArray(raw)
    .map((a) => {
      const rec = asRecord(a);
      if (!rec) return null;
      const label = asString(rec['label']) ?? asString(rec['value']) ?? '';
      const actionId = asString(rec['value']) ?? asString(rec['actionId']) ?? asString(rec['id']) ?? label;
      const style = asString(rec['style']);
      if (label === '' && actionId === '') return null;
      return {
        label: label || actionId,
        actionId: actionId || label,
        ...(style === 'primary' || style === 'danger' || style === 'secondary' ? { style } : {}),
      } as ActionSpec;
    })
    .filter((a): a is ActionSpec => a !== null);
}

function buildForm(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const fields = asArray(p.data['fields']).map((f) => {
    const rec = asRecord(f) ?? {};
    const name = asString(rec['name']) ?? asString(rec['key']) ?? '';
    const label = asString(rec['label']) ?? humanise(name);
    const rawType = (asString(rec['type']) ?? 'text').toLowerCase();
    const type: FormFieldSpec['type'] =
      rawType === 'number' || rawType === 'textarea' || rawType === 'select'
        ? (rawType as FormFieldSpec['type'])
        : 'text';
    const placeholder = asString(rec['placeholder']);
    const defaultValue = asString(rec['defaultValue']) ?? asString(rec['value']);
    const options = asArray(rec['options'])
      .map((o) => {
        const orec = asRecord(o);
        const value = asString(orec?.['value']) ?? asString(o);
        const olabel = asString(orec?.['label']) ?? value;
        return value !== undefined ? { label: olabel ?? value, value } : null;
      })
      .filter((o): o is { label: string; value: string } => o !== null);
    return {
      name,
      label,
      type,
      ...(placeholder !== undefined ? { placeholder } : {}),
      ...(defaultValue !== undefined ? { defaultValue } : {}),
      ...(options.length > 0 ? { options } : {}),
    } as FormFieldSpec;
  });
  const actions = coerceActions(p.data['actions'] ?? p.config['actions']);
  const submitActions = actions.length > 0 ? actions : [{ label: 'Submit', actionId: 'submit', style: 'primary' as const }];
  if (fields.length === 0) return null;
  const description = asString(p.data['description']);
  return withTitle(
    {
      kind: 'form',
      id: p.id,
      a11yLabel,
      fields,
      actions: submitActions,
      ...(description !== undefined ? { description } : {}),
    },
    p,
  );
}

function buildApproval(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  // Approval fields may sit on `data` (ApprovalUiPayload) or the payload root.
  const src = Object.keys(p.data).length > 0 ? p.data : p.raw;
  const description =
    asString(src['description']) ?? asString(src['prompt']) ?? asString(src['message']) ?? p.title ?? '';
  const riskLevel = asString(src['riskLevel']) ?? asString(src['risk']);
  const actions = coerceActions(src['actions']);
  const resolved =
    actions.length > 0
      ? actions
      : [
          { label: 'Approve', actionId: 'approve', style: 'primary' as const },
          { label: 'Deny', actionId: 'deny', style: 'danger' as const },
        ];
  if (description === '' && p.title === undefined) return null;
  return withTitle(
    {
      kind: 'approval',
      id: p.id,
      a11yLabel,
      description,
      actions: resolved,
      ...(riskLevel !== undefined ? { riskLevel } : {}),
    },
    p,
  );
}

function buildCitation(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const list = asArray(p.data['citations'] ?? p.data['sources'] ?? p.data['items']);
  const single = Object.keys(p.data).length > 0 && list.length === 0 ? [p.data] : list;
  const citations = single
    .map((c, i) => {
      const rec = asRecord(c);
      if (!rec) return null;
      const text = asString(rec['text']) ?? asString(rec['quote']) ?? asString(rec['snippet']) ?? '';
      const source = asString(rec['source']) ?? asString(rec['title']) ?? asString(rec['name']) ?? '';
      const url = asString(rec['url']) ?? asString(rec['href']);
      const page = asNumber(rec['page']);
      if (text === '' && source === '') return null;
      return {
        id: asString(rec['id']) ?? `${p.id}-cite-${i}`,
        text,
        source,
        ...(url !== undefined ? { url } : {}),
        ...(page !== undefined ? { page } : {}),
      };
    })
    .filter((c): c is { id: string; text: string; source: string; url?: string; page?: number } => c !== null);
  if (citations.length === 0) return null;
  return withTitle({ kind: 'citation', id: p.id, a11yLabel, citations }, p);
}

function buildArtifact(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const src = Object.keys(p.data).length > 0 ? p.data : p.raw;
  const artifactType =
    asString(src['artifactType']) ?? asString(src['kind']) ?? asString(src['type']) ?? 'file';
  const mimeType = asString(src['mimeType']) ?? asString(src['contentType']) ?? 'application/octet-stream';
  const downloadable = asBool(src['downloadable']) || asString(src['url']) !== undefined;
  const preview = asString(src['preview']) ?? asString(src['description']);
  const name = asString(src['name']);
  if (p.title === undefined && name === undefined && preview === undefined) {
    // Title-less, preview-less artifacts read poorly — degrade to fallback.
    return null;
  }
  const titled: CoercedPayload =
    p.title !== undefined ? p : name !== undefined ? { ...p, title: name } : p;
  return withTitle(
    {
      kind: 'artifact',
      id: p.id,
      a11yLabel,
      artifactType,
      mimeType,
      downloadable,
      ...(preview !== undefined ? { preview } : {}),
    },
    titled,
  );
}

function buildProgress(p: CoercedPayload, a11yLabel: string): WidgetViewSpec | null {
  const src = Object.keys(p.data).length > 0 ? p.data : p.raw;
  const label = asString(src['label']) ?? asString(src['message']) ?? p.title ?? 'Working…';
  const current = asNumber(src['current']) ?? asNumber(src['completed']) ?? 0;
  const total = asNumber(src['total']) ?? asNumber(src['count']) ?? 0;
  const explicitPct = asNumber(src['percentage']) ?? asNumber(src['percent']);
  const percentage =
    explicitPct !== undefined
      ? Math.max(0, Math.min(100, explicitPct))
      : total > 0
        ? Math.max(0, Math.min(100, Math.round((current / total) * 100)))
        : 0;
  const status = asString(src['status']) ?? 'running';
  return withTitle({ kind: 'progress', id: p.id, a11yLabel, label, current, total, percentage, status }, p);
}

// ---------------------------------------------------------------------------
// Entry point.
// ---------------------------------------------------------------------------

const BUILDERS: Record<string, (p: CoercedPayload, a11y: string) => WidgetViewSpec | null> = {
  table: buildTable,
  chart: buildChart,
  code: buildCode,
  image: buildImage,
  map: buildMap,
  timeline: buildTimeline,
  form: buildForm,
  approval: buildApproval,
  citation: buildCitation,
  artifact: buildArtifact,
  progress: buildProgress,
};

/**
 * Resolve a streamed widget view into its render spec. Always returns a spec;
 * any unknown type, unsupported `schemaVersion`, `custom` widget, or unusable
 * structured data degrades to the `fallback` kind.
 */
export function buildWidgetSpec(view: WidgetInput): WidgetViewSpec {
  const p = coercePayload(view);
  const a11yLabel = deriveA11yLabel(p);
  const declaredVersion = view.schemaVersion ?? p.schemaVersion ?? 1;
  const supported = SUPPORTED_SCHEMA_VERSION[p.type];

  // Unknown type, open-ended custom, or a version we can't render → fallback.
  if (supported === undefined || p.type === 'custom' || declaredVersion > supported) {
    return buildFallback(p, a11yLabel);
  }

  const builder = BUILDERS[p.type];
  const spec = builder ? builder(p, a11yLabel) : null;
  return spec ?? buildFallback(p, a11yLabel);
}
