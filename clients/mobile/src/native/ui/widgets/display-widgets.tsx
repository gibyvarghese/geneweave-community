/**
 * display-widgets.tsx — the non-interactive widget renderers.
 *
 * Each is a thin, fully theme-token-driven map over its typed
 * {@link WidgetViewSpec} branch (all parsing already happened in
 * `buildWidgetSpec`). None scrolls horizontally in-stream — tables and code
 * wrap or clip rather than introduce a competing scroll axis.
 */
import { Image, View } from 'react-native';
import { useTheme } from '../../providers/theme-provider';
import type { WidgetViewSpec } from '../../../lib';
import { WidgetCard, WidgetHeading, WidgetText, WidgetMono, WidgetLink } from './widget-shell';

type Spec<K extends WidgetViewSpec['kind']> = Extract<WidgetViewSpec, { kind: K }>;

function Heading({ title }: { title?: string }) {
  return title ? <WidgetHeading>{title}</WidgetHeading> : null;
}

// ---------------------------------------------------------------------------
// Table
// ---------------------------------------------------------------------------

export function TableWidget({ spec }: { spec: Spec<'table'> }) {
  const { theme } = useTheme();
  const colWidth = spec.columns.length > 0 ? `${100 / spec.columns.length}%` : '100%';
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      {spec.columns.length > 0 ? (
        <View style={{ flexDirection: 'row', borderBottomColor: theme.colors.border, borderBottomWidth: 1, paddingBottom: theme.spacing.xs }}>
          {spec.columns.map((c, i) => (
            <View key={`h-${i}`} style={{ width: colWidth as `${number}%` }}>
              <WidgetText size="label" muted>
                {c}
              </WidgetText>
            </View>
          ))}
        </View>
      ) : null}
      {spec.rows.map((row, ri) => (
        <View key={`r-${ri}`} style={{ flexDirection: 'row', paddingVertical: theme.spacing.xs / 2 }}>
          {row.map((cell, ci) => (
            <View key={`c-${ri}-${ci}`} style={{ width: colWidth as `${number}%`, paddingRight: theme.spacing.xs }}>
              <WidgetText size="bodySmall">{cell}</WidgetText>
            </View>
          ))}
        </View>
      ))}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Code
// ---------------------------------------------------------------------------

export function CodeWidget({ spec }: { spec: Spec<'code'> }) {
  const { theme } = useTheme();
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      {spec.language ? (
        <WidgetText size="caption" muted>
          {spec.language}
        </WidgetText>
      ) : null}
      <View style={{ backgroundColor: theme.colors.surface, borderRadius: theme.radii.sm, padding: theme.spacing.sm }}>
        <WidgetMono>{spec.code}</WidgetMono>
      </View>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Chart — lightweight in-stream bars; no chart library, no horizontal scroll.
// ---------------------------------------------------------------------------

export function ChartWidget({ spec }: { spec: Spec<'chart'> }) {
  const { theme } = useTheme();
  const values = spec.series.map((s) => s.value ?? 0);
  const max = values.length > 0 ? Math.max(1, ...values) : 1;
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      {spec.summary ? <WidgetText size="bodySmall">{spec.summary}</WidgetText> : null}
      <View style={{ gap: theme.spacing.xs }}>
        {spec.series.map((s, i) => (
          <View key={`s-${i}`} style={{ gap: 2 }}>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <WidgetText size="caption">{s.label}</WidgetText>
              {s.value !== undefined ? (
                <WidgetText size="caption" muted>
                  {s.value}
                </WidgetText>
              ) : null}
            </View>
            <View style={{ height: 6, backgroundColor: theme.colors.surface, borderRadius: 3, overflow: 'hidden' }}>
              <View
                style={{
                  height: 6,
                  width: `${Math.round(((s.value ?? 0) / max) * 100)}%`,
                  backgroundColor: theme.colors.accent,
                  borderRadius: 3,
                }}
              />
            </View>
          </View>
        ))}
      </View>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Image
// ---------------------------------------------------------------------------

export function ImageWidget({ spec }: { spec: Spec<'image'> }) {
  const { theme } = useTheme();
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      <Image
        source={{ uri: spec.uri }}
        accessibilityLabel={spec.caption ?? spec.a11yLabel}
        resizeMode="cover"
        style={{ width: '100%', height: 180, borderRadius: theme.radii.sm, backgroundColor: theme.colors.surface }}
      />
      {spec.caption ? (
        <WidgetText size="caption" muted>
          {spec.caption}
        </WidgetText>
      ) : null}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Map — in-stream summary + open-on-desktop (no native map SDK in the bubble).
// ---------------------------------------------------------------------------

export function MapWidget({ spec }: { spec: Spec<'map'> }) {
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      <WidgetText>{spec.summary}</WidgetText>
      {spec.href ? <WidgetLink href={spec.href} label="Open map on desktop" /> : null}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Timeline
// ---------------------------------------------------------------------------

export function TimelineWidget({ spec }: { spec: Spec<'timeline'> }) {
  const { theme } = useTheme();
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      <View style={{ gap: theme.spacing.sm }}>
        {spec.events.map((e, i) => (
          <View key={`e-${i}`} style={{ flexDirection: 'row', gap: theme.spacing.sm }}>
            <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: theme.colors.accent, marginTop: 6 }} />
            <View style={{ flex: 1, gap: 2 }}>
              <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
                <WidgetText size="bodySmall">{e.label}</WidgetText>
                {e.timestamp ? (
                  <WidgetText size="caption" muted>
                    {e.timestamp}
                  </WidgetText>
                ) : null}
              </View>
              {e.detail ? (
                <WidgetText size="caption" muted>
                  {e.detail}
                </WidgetText>
              ) : null}
            </View>
          </View>
        ))}
      </View>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Citation
// ---------------------------------------------------------------------------

export function CitationWidget({ spec }: { spec: Spec<'citation'> }) {
  const { theme } = useTheme();
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <Heading title={spec.title} />
      <View style={{ gap: theme.spacing.sm }}>
        {spec.citations.map((c) => (
          <View key={c.id} style={{ borderLeftColor: theme.colors.border, borderLeftWidth: 2, paddingLeft: theme.spacing.sm, gap: 2 }}>
            {c.text ? <WidgetText size="bodySmall">“{c.text}”</WidgetText> : null}
            <WidgetText size="caption" muted>
              {c.source}
              {c.page !== undefined ? ` · p.${c.page}` : ''}
            </WidgetText>
            {c.url ? <WidgetLink href={c.url} label="View source" /> : null}
          </View>
        ))}
      </View>
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Artifact
// ---------------------------------------------------------------------------

export function ArtifactWidget({ spec }: { spec: Spec<'artifact'> }) {
  const { theme } = useTheme();
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: theme.spacing.sm }}>
        <View
          style={{
            width: 40,
            height: 40,
            borderRadius: theme.radii.sm,
            backgroundColor: theme.colors.accentSoft,
            alignItems: 'center',
            justifyContent: 'center',
          }}
        >
          <WidgetText size="caption">{spec.artifactType.slice(0, 3).toUpperCase()}</WidgetText>
        </View>
        <View style={{ flex: 1, gap: 2 }}>
          <Heading title={spec.title} />
          <WidgetText size="caption" muted>
            {spec.mimeType}
            {spec.downloadable ? ' · downloadable' : ''}
          </WidgetText>
        </View>
      </View>
      {spec.preview ? (
        <WidgetText size="bodySmall" muted>
          {spec.preview}
        </WidgetText>
      ) : null}
    </WidgetCard>
  );
}

// ---------------------------------------------------------------------------
// Progress
// ---------------------------------------------------------------------------

export function ProgressWidget({ spec }: { spec: Spec<'progress'> }) {
  const { theme } = useTheme();
  const done = spec.status === 'completed' || spec.status === 'done';
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <WidgetText size="bodySmall">{spec.label}</WidgetText>
        <WidgetText size="caption" muted>
          {spec.total > 0 ? `${spec.current}/${spec.total}` : `${spec.percentage}%`}
        </WidgetText>
      </View>
      <View style={{ height: 6, backgroundColor: theme.colors.surface, borderRadius: 3, overflow: 'hidden' }}>
        <View
          style={{
            height: 6,
            width: `${spec.percentage}%`,
            backgroundColor: done ? theme.colors.success : theme.colors.accent,
            borderRadius: 3,
          }}
        />
      </View>
    </WidgetCard>
  );
}
