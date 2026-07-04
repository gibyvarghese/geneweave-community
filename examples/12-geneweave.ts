/**
 * Example 12 — geneWeave: AI chatbot + observability dashboard
 *
 * Run:
 *   ANTHROPIC_API_KEY=sk-… npx tsx examples/12-geneweave.ts
 *
 * Then open http://localhost:3000 in your browser.
 *  - Register an account (or sign in with Google via OAuth)
 *  - Start chatting (supports streaming + multiple models)
 *  - Switch between Direct / Agent / Supervisor chat modes
 *  - Switch to the Dashboard tab to see token usage, costs, and latency
 *  - Click your profile icon (top-right) → Preferences to change the theme
 *  - Open the Traces tab to see per-tool-call observability spans
 *
 * WeaveIntel packages used:
 *   @weaveintel/geneweave — The full-stack reference application that wires together:
 *     • @weaveintel/provider-openai & provider-anthropic — LLM adapters (auto-discovered)
 *     • @weaveintel/core       — ExecutionContext, EventBus, ToolRegistry, Model interface
 *     • @weaveintel/agents     — ReAct agent loop (used in Agent Mode chat)
 *     • @weaveintel/agents     — weaveSupervisor() (used in Supervisor Mode — routes to
 *                                researcher/analyst/writer workers)
 *     • @weaveintel/memory     — Conversation history per chat session
 *     • @weaveintel/redaction  — PII masking (if enabled in settings)
 *     • @weaveintel/evals      — Post-response quality evaluation
 *     • @weaveintel/observability — Trace recording for the Traces admin tab
 *     • @weaveintel/tools/search  — Web search via DuckDuckGo HTML fallback, Brave, Tavily
 *     • @weaveintel/oauth         — Google OAuth 2.0 SSO sign-in
 *
 *   createGeneWeave() is the single entry point. It:
 *     1. Initializes a SQLite database (users, sessions, chats, messages, metrics,
 *        traces, settings, user_preferences, and model pricing data)
 *     2. Creates a ChatEngine that dynamically imports provider packages
 *     3. Seeds default admin data (default admin user, default settings)
 *     4. Spins up an HTTP server with auth, chat, dashboard, and admin API routes
 *     5. Serves a single-page app (SPA) with:
 *          - Chat UI with streaming, multi-model selection, and mode switching
 *          - Dashboard charts (token usage, cost, latency)
 *          - Traces tab — per-span tool-call observability (tool_call.web_search, etc.)
 *          - Admin panel
 *          - Preferences screen for theme switching (light / dark)
 *
 * NEW FEATURES (recent additions):
 *
 *   1. Theme system (light / dark)
 *      The SPA ships a full CSS token theme system. Users can switch between
 *      "light" and "dark" via Preferences (profile icon → Preferences).
 *      The selected theme is persisted to the user_preferences table via
 *      PATCH /api/users/preferences and restored on next login.
 *      CSS token families: --bg, --bg2, --surface, --border, --text, --text2,
 *        --accent, --accent-hover, --solid, --solid-hover, --solid-contrast.
 *
 *   2. Tool-call observability (SQLite traces)
 *      The ChatEngine now subscribes to the event bus (tool.call.start/end/error)
 *      during every chat turn. Each completed tool invocation is persisted as a
 *      separate row in the traces table with name = "tool_call.<toolName>" and the
 *      full payload (agent, provider, result snippet, latency) in attributes JSON.
 *      This provides per-tool visibility in the Traces tab, separate from the
 *      coarser "step.*" spans. Covers any tool that runs through the agent pipeline
 *      — including web_search, delegate_to_worker, plan, think, calculator, etc.
 *
 *   3. Web search with DuckDuckGo HTML fallback
 *      The built-in web_search tool uses @weaveintel/tools/search with the
 *      DuckDuckGoProvider. Previously, the Instant Answer API was used — it often
 *      returns zero results for real-world queries (e.g. event tickets, tour dates).
 *      Now the provider automatically falls back to parsing DuckDuckGo's public HTML
 *      SERP when the Instant Answer API returns no results. This makes web_search
 *      reliable for arbitrary queries with no API key required.
 *      Additional providers (Brave, Tavily, Bing, SearXNG, Jina, Exa, Serper) can
 *      be enabled via environment variables.
 *
 *   4. Google OAuth 2.0 SSO
 *      Set OAUTH_GOOGLE_CLIENT_ID and OAUTH_GOOGLE_CLIENT_SECRET to enable
 *      "Sign in with Google" on the login screen. The /api/oauth/google flow
 *      exchanges the authorization code, creates or retrieves the user account,
 *      and issues a JWT session cookie identical to email/password auth.
 *
 *   5. Supervisor multi-agent mode
 *      In Supervisor chat mode the ChatEngine creates a weaveSupervisor() with
 *      researcher / analyst / writer worker agents. Each worker has its own tool
 *      set (web_search for researcher, etc.). Delegation is traced as
 *      tool_call.delegate_to_worker spans.
 */

import { createGeneWeave } from '@weaveintel/geneweave-api';
import { shutdownCSE } from '../apps/geneweave/src/cse.js';

async function main() {
  const port = Number(process.env['PORT'] ?? '3500');

  // createGeneWeave() accepts a config object and returns a GeneWeaveApp handle.
  // The config wires together:
  //   • port/host     — HTTP server binding
  //   • jwtSecret     — Used by auth.ts (signJWT/verifyJWT) for session cookies
  //   • database      — SQLite path (auto-creates tables on first boot)
  //   • providers     — API keys keyed by provider name; ChatEngine dynamically
  //                      imports @weaveintel/provider-openai or provider-anthropic
  //   • defaultModel  — The model used when the user hasn't picked one yet
  const app = await createGeneWeave({
    port,
    // In production, use a strong secret (e.g. from env: process.env.JWT_SECRET)
    jwtSecret: process.env['JWT_SECRET'] ?? 'change-me-in-production-' + Math.random().toString(36).slice(2),
    // SQLite database file — stores users, sessions, chats, messages, metrics,
    // evals, traces, user_preferences, settings, and model pricing data.
    // Honors DATABASE_PATH from env (.env) so dev and deploy stay aligned.
    database: { type: 'sqlite', path: process.env['DATABASE_PATH'] ?? './geneweave.db' },
    // provider keys — only providers with valid API keys are registered;
    // ChatEngine.getAvailableModels() returns models from all active providers
    providers: {
      ...(process.env['ANTHROPIC_API_KEY'] ? { anthropic: { apiKey: process.env['ANTHROPIC_API_KEY'] } } : {}),
      ...(process.env['OPENAI_API_KEY'] ? { openai: { apiKey: process.env['OPENAI_API_KEY'] } } : {}),
    },
    // DEFAULT_PROVIDER / DEFAULT_MODEL env vars let you explicitly choose the
    // active model without touching code (e.g. when one provider has no credits).
    // When both keys are present and no override is set, OpenAI is preferred so
    // that a depleted Anthropic account does not break the app silently.
    defaultProvider: process.env['DEFAULT_PROVIDER']
      ?? (process.env['OPENAI_API_KEY'] ? 'openai' : 'anthropic'),
    defaultModel: process.env['DEFAULT_MODEL']
      ?? (process.env['OPENAI_API_KEY'] ? 'gpt-4o-mini' : 'claude-sonnet-4-6'),

    // Google OAuth 2.0 — optional: enables "Sign in with Google" on the login screen.
    // The callback URL must be registered in your Google Cloud Console:
    //   http://localhost:<port>/api/oauth/google/callback
    ...(process.env['OAUTH_GOOGLE_CLIENT_ID'] ? {
      oauth: {
        google: {
          clientId: process.env['OAUTH_GOOGLE_CLIENT_ID']!,
          clientSecret: process.env['OAUTH_GOOGLE_CLIENT_SECRET']!,
          redirectUri: `http://localhost:${port}/api/oauth/google/callback`,
        },
      },
    } : {}),
  });

  // app.chatEngine.getAvailableModels() queries each registered provider
  // for its model catalog and returns a combined list.
  console.log(`  Models available: ${(await app.chatEngine.getAvailableModels()).map(m => m.provider + '/' + m.id).join(', ')}`);
  console.log(`  URL: http://localhost:${port}`);
  console.log('  Press Ctrl+C to stop\n');

  // Graceful shutdown: close HTTP server, SQLite, and terminate all CSE Docker containers.
  const gracefulShutdown = async (signal: string) => {
    console.log(`\n[geneweave] ${signal} received — shutting down…`);
    await Promise.allSettled([app.stop(), shutdownCSE()]);
    process.exit(0);
  };
  process.on('SIGINT',  () => gracefulShutdown('SIGINT'));
  process.on('SIGTERM', () => gracefulShutdown('SIGTERM'));
}

main().catch(console.error);
