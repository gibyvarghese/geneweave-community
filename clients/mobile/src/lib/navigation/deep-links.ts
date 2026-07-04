/**
 * deep-links.ts — parse and build `geneweave://` deep links.
 *
 * Pure string logic, fully unit-testable with no router present. The three
 * launch link kinds map to navigation intents:
 *   - `geneweave://run/<id>`      → resume a run in the Chat tab
 *   - `geneweave://task/<id>`     → open a task in the Actions tab
 *   - `geneweave://reminder/<id>` → open a reminder in the Actions tab
 * Anything else resolves to `{ kind: 'unknown' }` so the router can fall back
 * to the default tab rather than crash on a malformed link.
 */

export const DEEP_LINK_SCHEME = 'geneweave';

/** A parsed navigation intent. */
export type RouteIntent =
  | { kind: 'run'; runId: string }
  | { kind: 'task'; taskId: string }
  | { kind: 'reminder'; reminderId: string }
  | { kind: 'unknown'; raw: string };

/** The Expo Router pathname an intent resolves to. */
export interface RouteTarget {
  pathname: string;
  params: Record<string, string>;
}

function decode(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/**
 * Parses a `geneweave://` URL (or a bare `kind/id` path) into a {@link RouteIntent}.
 * Tolerates `geneweave://host/path` forms (where the kind lands in the URL host)
 * as well as `geneweave:///path` forms. Never throws.
 */
export function parseDeepLink(url: string): RouteIntent {
  const raw = url.trim();
  if (raw.length === 0) return { kind: 'unknown', raw: url };

  // Strip the scheme, tolerating `scheme://`, `scheme:`, and bare paths.
  let rest = raw;
  const schemeMatch = /^([a-z][a-z0-9+.-]*):\/\//i.exec(raw);
  if (schemeMatch) {
    rest = raw.slice(schemeMatch[0].length);
  } else {
    const bareScheme = /^([a-z][a-z0-9+.-]*):/i.exec(raw);
    if (bareScheme) rest = raw.slice(bareScheme[0].length);
  }

  // Drop any query/fragment, then split into clean segments.
  const pathOnly = rest.split(/[?#]/, 1)[0] ?? '';
  const segments = pathOnly.split('/').filter((s) => s.length > 0).map(decode);
  if (segments.length < 2) return { kind: 'unknown', raw: url };

  const [kind, id] = segments;
  switch (kind) {
    case 'run':
      return { kind: 'run', runId: id! };
    case 'task':
      return { kind: 'task', taskId: id! };
    case 'reminder':
      return { kind: 'reminder', reminderId: id! };
    default:
      return { kind: 'unknown', raw: url };
  }
}

/** Builds a canonical `geneweave://kind/id` link for an intent. */
export function buildDeepLink(intent: Exclude<RouteIntent, { kind: 'unknown' }>): string {
  switch (intent.kind) {
    case 'run':
      return `${DEEP_LINK_SCHEME}://run/${encodeURIComponent(intent.runId)}`;
    case 'task':
      return `${DEEP_LINK_SCHEME}://task/${encodeURIComponent(intent.taskId)}`;
    case 'reminder':
      return `${DEEP_LINK_SCHEME}://reminder/${encodeURIComponent(intent.reminderId)}`;
  }
}

/** Maps an intent to the Expo Router target screen + params. */
export function intentToRoute(intent: RouteIntent): RouteTarget {
  switch (intent.kind) {
    case 'run':
      return { pathname: '/(tabs)', params: { runId: intent.runId } };
    case 'task':
      return { pathname: '/(tabs)/actions', params: { taskId: intent.taskId } };
    case 'reminder':
      return { pathname: '/(tabs)/actions', params: { reminderId: intent.reminderId } };
    case 'unknown':
      return { pathname: '/(tabs)', params: {} };
  }
}
