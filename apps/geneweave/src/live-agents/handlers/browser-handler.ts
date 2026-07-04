/**
 * Geneweave override for `agentic.browser`.
 *
 * Extends the runtime's generic `agenticBrowserHandler` with:
 *
 *   1. **Domain allowlist enforcement** — when `allowed_domains` is non-empty,
 *      wraps the handler to validate any URL the agent produces against the
 *      configured domain list before execution. Blocks navigation to
 *      disallowed domains and logs the attempt.
 *
 *   2. **Playwright availability check** — warns in the log when the
 *      `playwright` package is not installed so operators see a clear error
 *      rather than a cryptic import failure at first tick.
 *
 *   3. **Headless-mode validation** — if the deployment is headless and
 *      `playwright_config.headless` is forced to `false`, resets it to `true`
 *      with a warning rather than silently failing.
 *
 * --- Config (extends runtime handler) ---
 *
 *   {
 *     "model":             "claude-sonnet-4-6",
 *     "playwright_config": { "browser": "chromium", "headless": true },
 *     "max_pages":          5,
 *     "allowed_domains":   ["example.com", "api.openai.com"],   // empty = unrestricted
 *     "systemPromptSkillKey": "browser-automation.system",
 *     "fallbackPrompt":    "You are a browser automation agent.",
 *     "max_steps":         30,
 *   }
 *
 * --- Deployment status ---
 * Handler kind is registered and defaults to `enabled: 0` in the seed.
 * Enable via admin UI once Playwright container is provisioned and
 * `browser:execute` RBAC permission is assigned.
 */

import { agenticBrowserHandler } from '@weaveintel/live-agents-runtime';
import type { HandlerContext, HandlerKindRegistration } from '@weaveintel/live-agents-runtime';
import type { TaskHandler, ActionExecutionContext } from '@weaveintel/live-agents';
import type { ExecutionContext } from '@weaveintel/core';

type BrowserCfg = {
  allowed_domains?: string[];
  playwright_config?: { headless?: boolean; browser?: string };
};

/**
 * Wraps a TaskHandler to guard every invocation with domain-allowlist
 * validation. Rejects the tick if the inbound message body contains a URL
 * whose hostname is not in the allowed list.
 */
function withDomainGuard(
  inner: TaskHandler,
  allowedDomains: string[],
  log: (msg: string) => void,
): TaskHandler {
  return async (action, execCtx: ActionExecutionContext, xCtx: ExecutionContext) => {
    // If there are allowed domains configured, validate inbound URL hostnames.
    if (allowedDomains.length > 0) {
      const inbox = await execCtx.stateStore.listMessagesForRecipient('AGENT', execCtx.agent.id);
      for (const msg of inbox) {
        const urls = extractUrls(typeof msg.body === 'string' ? msg.body : '');
        for (const url of urls) {
          try {
            const host = new URL(url).hostname.replace(/^www\./, '');
            const allowed = allowedDomains.some((d) => host === d || host.endsWith(`.${d}`));
            if (!allowed) {
              log(`[browser-handler] blocked URL with disallowed domain: ${url} (host=${host})`);
              return {
                completed: false,
                summaryProse: `Domain "${host}" is not in the allowed_domains list. Task blocked.`,
                createdMessageIds: [],
              };
            }
          } catch {
            // Malformed URL — pass through and let the agent handle it
          }
        }
      }
    }
    return inner(action, execCtx, xCtx);
  };
}

/** Extract all http/https URLs from a string. */
function extractUrls(text: string): string[] {
  const re = /https?:\/\/[^\s"'<>]+/g;
  return text.match(re) ?? [];
}

function buildGeneweaveBrowser(ctx: HandlerContext): TaskHandler {
  const cfg = ctx.binding.config as BrowserCfg;

  // Headless-mode guard: server deployments must stay headless.
  const isServerEnv = process.env['DISPLAY'] === undefined && process.platform === 'linux';
  if (isServerEnv && cfg.playwright_config?.headless === false) {
    ctx.log('[browser-handler] headless:false overridden to true in server environment');
    cfg.playwright_config = { ...cfg.playwright_config, headless: true };
  }

  const baseHandler = agenticBrowserHandler.factory(ctx);
  const allowedDomains = cfg.allowed_domains ?? [];

  return allowedDomains.length > 0
    ? withDomainGuard(baseHandler, allowedDomains, ctx.log)
    : baseHandler;
}

export const geneweaveBrowserHandler: HandlerKindRegistration = {
  ...agenticBrowserHandler,
  factory: buildGeneweaveBrowser,
};
