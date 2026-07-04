/**
 * widget-block.tsx — the widget dispatcher.
 *
 * Resolves a streamed widget view into its render spec (`buildWidgetSpec`, the
 * pure brain) and dispatches to the matching native renderer via a small
 * renderer registry with a **mandatory fallback** — mirroring the framework's
 * `createWidgetRendererRegistry` contract, but local to the mobile client so it
 * stays free of the server `@weaveintel/ui-primitives` dependency. Unknown
 * types, unsupported schema versions, and `custom` already resolve to the
 * `fallback` spec upstream, so the registry only ever sees a known kind.
 */
import type { ReactElement } from 'react';
import {
  buildWidgetSpec,
  type WidgetInput,
  type WidgetViewSpec,
  type WidgetRenderKind,
} from '../../../lib';
import { FallbackWidget } from './fallback-widget';
import {
  TableWidget,
  CodeWidget,
  ChartWidget,
  ImageWidget,
  MapWidget,
  TimelineWidget,
  CitationWidget,
  ArtifactWidget,
  ProgressWidget,
} from './display-widgets';
import { ApprovalWidget, FormWidget } from './interactive-widgets';

type Spec<K extends WidgetViewSpec['kind']> = Extract<WidgetViewSpec, { kind: K }>;
type SpecRenderer = (spec: WidgetViewSpec) => ReactElement;

interface WidgetRendererRegistry {
  register(kind: WidgetRenderKind, renderer: SpecRenderer): void;
  resolve(kind: WidgetRenderKind): SpecRenderer;
  render(spec: WidgetViewSpec): ReactElement;
}

function createWidgetRendererRegistry(fallback: SpecRenderer): WidgetRendererRegistry {
  const map = new Map<WidgetRenderKind, SpecRenderer>();
  return {
    register(kind, renderer) {
      map.set(kind, renderer);
    },
    resolve(kind) {
      return map.get(kind) ?? fallback;
    },
    render(spec) {
      return (map.get(spec.kind) ?? fallback)(spec);
    },
  };
}

// One registry for the whole app: renderers are pure, theme-aware components.
const registry = createWidgetRendererRegistry((spec) => (
  <FallbackWidget spec={spec as Spec<'fallback'>} />
));
registry.register('table', (s) => <TableWidget spec={s as Spec<'table'>} />);
registry.register('chart', (s) => <ChartWidget spec={s as Spec<'chart'>} />);
registry.register('code', (s) => <CodeWidget spec={s as Spec<'code'>} />);
registry.register('image', (s) => <ImageWidget spec={s as Spec<'image'>} />);
registry.register('map', (s) => <MapWidget spec={s as Spec<'map'>} />);
registry.register('timeline', (s) => <TimelineWidget spec={s as Spec<'timeline'>} />);
registry.register('citation', (s) => <CitationWidget spec={s as Spec<'citation'>} />);
registry.register('artifact', (s) => <ArtifactWidget spec={s as Spec<'artifact'>} />);
registry.register('progress', (s) => <ProgressWidget spec={s as Spec<'progress'>} />);
registry.register('approval', (s) => <ApprovalWidget spec={s as Spec<'approval'>} />);
registry.register('form', (s) => <FormWidget spec={s as Spec<'form'>} />);
registry.register('fallback', (s) => <FallbackWidget spec={s as Spec<'fallback'>} />);

/** Render a single streamed widget view into its themed native card. */
export function WidgetBlock({ view }: { view: WidgetInput }) {
  return registry.render(buildWidgetSpec(view));
}
