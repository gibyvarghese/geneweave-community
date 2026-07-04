/**
 * widget-action-context.tsx — ambient handler for interactive widget taps.
 *
 * Interactive widgets (approval, form) need to post a `widget.action` back to
 * the run, but the {@link createWidgetRendererRegistry} renderers are pure
 * `(spec) => element` maps. Rather than thread a callback through every layer,
 * the assistant bubble provides this context (run-bound), and the interactive
 * renderers pull `submit` + the `pending` map from it. Outside a provider the
 * default is an inert no-op, so a widget rendered in isolation (e.g. the dev
 * gallery) never crashes.
 */
import { createContext, useContext, type ReactNode } from 'react';

export interface WidgetActionContextValue {
  /** Post a widget action ("a tap is a turn"). */
  submit: (widgetId: string, actionId: string, value?: unknown) => void;
  /** Widget ids with an action in flight → the submitted action id. */
  pending: Record<string, string>;
}

const INERT: WidgetActionContextValue = { submit: () => {}, pending: {} };

const WidgetActionCtx = createContext<WidgetActionContextValue>(INERT);

export function WidgetActionProvider({
  value,
  children,
}: {
  value: WidgetActionContextValue;
  children: ReactNode;
}) {
  return <WidgetActionCtx.Provider value={value}>{children}</WidgetActionCtx.Provider>;
}

export function useWidgetAction(): WidgetActionContextValue {
  return useContext(WidgetActionCtx);
}
