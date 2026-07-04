/**
 * widget-fixtures.ts — canonical sample widgets covering every render kind.
 *
 * These doubles as (1) the data source for the dev-only widget gallery route and
 * (2) the inputs for the spec snapshot tests, so the gallery and the tests can
 * never drift from the same shapes. Each fixture mirrors the on-the-wire
 * `widget.update` payload the server emits, including the two degradation cases
 * the fallback contract must handle: an unknown type and an unsupported
 * `schemaVersion`.
 */
import type { WidgetInput } from './widget-spec.js';

/** A named widget fixture for the gallery + tests. */
export interface WidgetFixture {
  /** Short caption shown above the widget in the gallery. */
  caption: string;
  /** The streamed widget view input. */
  view: WidgetInput;
}

export const widgetFixtures: WidgetFixture[] = [
  {
    caption: 'table',
    view: {
      id: 'w-table',
      payload: {
        id: 'w-table',
        type: 'table',
        title: 'Top variants by impact',
        a11ySummary: 'Table of three gene variants ranked by impact score.',
        data: {
          columns: [
            { key: 'gene', label: 'Gene' },
            { key: 'variant', label: 'Variant' },
            { key: 'score', label: 'Score' },
          ],
          rows: [
            { gene: 'BRCA1', variant: 'c.68_69del', score: '0.94' },
            { gene: 'TP53', variant: 'R175H', score: '0.88' },
            { gene: 'EGFR', variant: 'L858R', score: '0.81' },
          ],
        },
      },
    },
  },
  {
    caption: 'chart',
    view: {
      id: 'w-chart',
      payload: {
        id: 'w-chart',
        type: 'chart',
        title: 'Expression by tissue',
        a11ySummary: 'Bar chart of expression levels across four tissues.',
        data: {
          chartType: 'bar',
          series: [
            { label: 'Liver', value: 42 },
            { label: 'Kidney', value: 31 },
            { label: 'Brain', value: 58 },
            { label: 'Lung', value: 24 },
          ],
        },
      },
    },
  },
  {
    caption: 'code',
    view: {
      id: 'w-code',
      payload: {
        id: 'w-code',
        type: 'code',
        title: 'Filter snippet',
        data: {
          language: 'python',
          code: "variants = [v for v in calls if v.score > 0.8]\nprint(len(variants))",
        },
      },
    },
  },
  {
    caption: 'image',
    view: {
      id: 'w-image',
      payload: {
        id: 'w-image',
        type: 'image',
        title: 'Protein fold',
        data: {
          uri: 'https://example.com/fold.png',
          caption: 'Predicted tertiary structure',
        },
      },
    },
  },
  {
    caption: 'map',
    view: {
      id: 'w-map',
      payload: {
        id: 'w-map',
        type: 'map',
        title: 'Sample origin',
        a11ySummary: 'Map centred on Cambridge, UK.',
        data: { summary: 'Cambridge, United Kingdom' },
        fallback: { kind: 'link', text: 'View interactive map', href: 'https://example.com/map' },
      },
    },
  },
  {
    caption: 'timeline',
    view: {
      id: 'w-timeline',
      payload: {
        id: 'w-timeline',
        type: 'timeline',
        title: 'Analysis steps',
        data: {
          events: [
            { label: 'Ingest', timestamp: '09:00', detail: 'Loaded 1.2M calls' },
            { label: 'Annotate', timestamp: '09:04' },
            { label: 'Rank', timestamp: '09:07', detail: 'Top 50 selected' },
          ],
        },
      },
    },
  },
  {
    caption: 'form',
    view: {
      id: 'w-form',
      payload: {
        id: 'w-form',
        type: 'form',
        title: 'Refine search',
        data: {
          description: 'Narrow the variant set before re-running.',
          fields: [
            { name: 'gene', label: 'Gene symbol', type: 'text', placeholder: 'e.g. BRCA1' },
            { name: 'minScore', label: 'Minimum score', type: 'number', defaultValue: '0.8' },
            {
              name: 'consequence',
              label: 'Consequence',
              type: 'select',
              options: [
                { label: 'Missense', value: 'missense' },
                { label: 'Nonsense', value: 'nonsense' },
              ],
            },
          ],
          actions: [{ label: 'Apply', value: 'apply', style: 'primary' }],
        },
      },
    },
  },
  {
    caption: 'approval',
    view: {
      id: 'w-approval',
      payload: {
        id: 'w-approval',
        type: 'approval',
        title: 'Run external BLAST query?',
        a11ySummary: 'Approval required to run an external BLAST query.',
        data: {
          description: 'This calls a third-party service and may incur cost.',
          riskLevel: 'external-side-effect',
          actions: [
            { label: 'Approve', value: 'approve', style: 'primary' },
            { label: 'Deny', value: 'deny', style: 'danger' },
          ],
        },
      },
    },
  },
  {
    caption: 'citation',
    view: {
      id: 'w-citation',
      payload: {
        id: 'w-citation',
        type: 'citation',
        title: 'Sources',
        data: {
          citations: [
            {
              id: 'c1',
              source: 'Nature Genetics, 2021',
              text: 'BRCA1 loss-of-function increases breast-cancer risk.',
              url: 'https://example.com/ng2021',
              page: 14,
            },
            {
              id: 'c2',
              source: 'NEJM, 2019',
              text: 'TP53 R175H is a recurrent hotspot mutation.',
            },
          ],
        },
      },
    },
  },
  {
    caption: 'artifact',
    view: {
      id: 'w-artifact',
      payload: {
        id: 'w-artifact',
        type: 'artifact',
        title: 'variants.vcf',
        data: {
          artifactType: 'file',
          mimeType: 'text/vcf',
          downloadable: true,
          preview: '3 filtered variants, 4.2 KB',
          url: 'https://example.com/variants.vcf',
        },
      },
    },
  },
  {
    caption: 'progress',
    view: {
      id: 'w-progress',
      payload: {
        id: 'w-progress',
        type: 'progress',
        data: {
          label: 'Annotating variants',
          current: 7,
          total: 10,
          status: 'running',
        },
      },
    },
  },
  {
    caption: 'fallback — unknown type',
    view: {
      id: 'w-unknown',
      payload: {
        id: 'w-unknown',
        type: 'molecular_viewer',
        title: '3D molecule',
        fallback: { kind: 'link', text: 'Open the 3D viewer', href: 'https://example.com/viewer' },
      },
    },
  },
  {
    caption: 'fallback — unsupported schemaVersion',
    view: {
      id: 'w-future',
      schemaVersion: 99,
      payload: {
        id: 'w-future',
        type: 'table',
        title: 'A v99 table',
        a11ySummary: 'A table from a newer app version.',
        data: { columns: [{ label: 'A' }], rows: [['1']] },
      },
    },
  },
];
