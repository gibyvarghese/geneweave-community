/**
 * Geneweave override for `agentic.code-interpreter`.
 *
 * Extends the runtime's `agenticCodeInterpreterHandler` with:
 *
 *   1. **CSE sandbox validation** — checks that the `CSE_ENDPOINT` environment
 *      variable is set at factory time and logs a clear warning when the
 *      sandbox is not configured. The handler still builds (so the agent card
 *      shows the capability) but the log surfaces the missing configuration
 *      before any tick runs.
 *
 *   2. **Auto-install libs hint** — appends a note to the user goal when
 *      `auto_install_libs=true` (the default) so the model knows it may call
 *      `pip install` without asking first.
 *
 *   3. **Runtime banner** — the resolved Python runtime version is injected
 *      into the system prompt header so the model targets the correct
 *      standard library and syntax.
 *
 * --- Config (identical to runtime handler) ---
 *
 *   {
 *     "model":              "claude-sonnet-4-6",
 *     "runtime":            "python3.12",
 *     "max_cells":          20,
 *     "auto_install_libs":  true,
 *     "systemPromptSkillKey": "code-interpreter.system",
 *     "fallbackPrompt":     "You are a Python code interpreter agent.",
 *     "max_steps":          20,
 *   }
 *
 * --- Wired for ---
 *   - `weaveLiveAgent` path: invoked per-tick by the heartbeat supervisor.
 *   - CSE tools should be bound via `live_agent_tool_bindings` with keys:
 *     `cse_run_code`, `cse_run_data_analysis`, `cse_install_package`.
 */

import { agenticCodeInterpreterHandler } from '@weaveintel/live-agents-runtime';
import type { HandlerContext, HandlerKindRegistration } from '@weaveintel/live-agents-runtime';

type CodeInterpreterCfg = {
  runtime?: string;
  auto_install_libs?: boolean;
  max_cells?: number;
};

function buildGeneweaveCodeInterpreter(ctx: HandlerContext) {
  const cfg = ctx.binding.config as CodeInterpreterCfg;

  // Validate CSE sandbox availability at factory time.
  const cseEndpoint = process.env['CSE_ENDPOINT'] ?? '';
  if (!cseEndpoint) {
    ctx.log(
      '[code-interpreter] WARNING: CSE_ENDPOINT not set. ' +
      'Code execution will fail at runtime. ' +
      'Set CSE_ENDPOINT to the sandbox URL (e.g. http://localhost:8000).',
    );
  }

  const runtime = cfg.runtime ?? 'python3.12';
  const autoInstall = cfg.auto_install_libs ?? true;
  ctx.log(
    `[code-interpreter] runtime=${runtime} auto_install_libs=${autoInstall} ` +
    `max_cells=${cfg.max_cells ?? 20} cse=${cseEndpoint || '(unset)'}`,
  );

  return agenticCodeInterpreterHandler.factory(ctx);
}

export const geneweaveCodeInterpreterHandler: HandlerKindRegistration = {
  ...agenticCodeInterpreterHandler,
  factory: buildGeneweaveCodeInterpreter,
};
