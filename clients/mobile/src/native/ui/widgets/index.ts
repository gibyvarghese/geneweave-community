/**
 * Widgets — native rendering layer for streamed widget views.
 *
 * `WidgetBlock` resolves a view into its render spec and dispatches to a themed
 * renderer; `WidgetActionProvider`/`useWidgetAction` carry the optimistic
 * action contract (a tap is a turn) down to interactive cards.
 */
export { WidgetBlock } from './widget-block';
export { WidgetActionProvider, useWidgetAction } from './widget-action-context';
export type { WidgetActionContextValue } from './widget-action-context';
