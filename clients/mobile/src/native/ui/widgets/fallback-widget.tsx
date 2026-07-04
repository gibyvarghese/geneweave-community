/**
 * fallback-widget.tsx — the mandatory degraded renderer.
 *
 * Shown whenever a widget can't be rendered natively (unknown type, unsupported
 * `schemaVersion`, the open-ended `custom` type, or unusable data). It always
 * shows `spec.text`, and when the server provided a link it offers an "open on
 * desktop" affordance — the user is never left with a blank space.
 */
import type { WidgetViewSpec } from '../../../lib';
import { WidgetCard, WidgetText, WidgetLink } from './widget-shell';

type FallbackSpec = Extract<WidgetViewSpec, { kind: 'fallback' }>;

export function FallbackWidget({ spec }: { spec: FallbackSpec }) {
  return (
    <WidgetCard a11yLabel={spec.a11yLabel}>
      <WidgetText>{spec.text}</WidgetText>
      {spec.href ? <WidgetLink href={spec.href} /> : null}
    </WidgetCard>
  );
}
