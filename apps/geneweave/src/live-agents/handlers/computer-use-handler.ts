/**
 * Geneweave override for `agentic.computer-use`.
 *
 * Extends the runtime's generic `agenticComputerUseHandler` with two
 * geneweave-specific additions:
 *
 *   1. **CUA model wrapping** — when the resolved `HandlerContext.model` is
 *      an Anthropic model, wraps it with `wrapModelForCua()` so every
 *      `.generate()` / `.stream()` call includes the `computerUseTools`
 *      metadata field and the `computer-use-2024-10-22` beta header.
 *      Non-Anthropic models (OpenAI, Ollama, …) pass through unchanged so
 *      the bash + file tools still work in the standard ReAct loop.
 *
 *   2. **CUA tool injection** — when `HandlerContext.tools` is absent (agent
 *      has no tool bindings in `live_agent_tool_bindings`), automatically
 *      creates a `CuaToolRegistry` with the three Anthropic CUA tools
 *      (`computer`, `bash`, `str_replace_editor`) so operators don't have to
 *      pre-bind tools for basic CUA agents.
 *
 * Wiring:
 *   This export is registered in `handler-registry-boot.ts` AFTER
 *   `createDefaultHandlerRegistry()` using `registry.registerOrReplace()` so
 *   it supersedes the base runtime registration without breaking other kinds.
 *
 * --- Config (identical to runtime handler) ---
 *
 *   {
 *     "model":                 "claude-opus-4-8",
 *     "screenshot_interval_ms": 1000,
 *     "max_steps":              50,
 *     "allowed_actions":        ["screenshot","click","type","scroll","key","mouse_move"],
 *     "systemPromptSkillKey":   "computer-use.system",
 *     "fallbackPrompt":         "You are a computer use agent.",
 *     "display_width":          1280,
 *     "display_height":         800,
 *   }
 *
 * --- Wired for ---
 *   - `weaveLiveAgent` path: invoked per-tick by the heartbeat supervisor.
 *   - `weaveAgent` path: `createCuaWeaveAgent()` provides the one-shot path.
 */

import {
  agenticComputerUseHandler,
  wrapModelForCua,
  createCuaToolRegistry,
} from '@weaveintel/live-agents-runtime';
import type { HandlerKindRegistration } from '@weaveintel/live-agents-runtime';

function isAnthropicModel(model: { info?: { provider?: string } }): boolean {
  return model.info?.provider === 'anthropic';
}

export const geneweaveComputerUseHandler: HandlerKindRegistration = {
  ...agenticComputerUseHandler,
  factory: (ctx) => {
    const cfg = ctx.binding.config as {
      display_width?: number;
      display_height?: number;
      cwd?: string;
      bash_timeout_ms?: number;
    };

    // Wrap model with CUA metadata injection for Anthropic providers.
    const model = ctx.model && isAnthropicModel(ctx.model)
      ? wrapModelForCua(ctx.model, {
          displayWidth:  cfg.display_width  ?? 1280,
          displayHeight: cfg.display_height ?? 800,
        })
      : ctx.model;

    // Auto-inject CUA tools when no tool bindings are configured.
    const tools = ctx.tools ?? createCuaToolRegistry({
      cwd:          cfg.cwd,
      bashTimeoutMs: cfg.bash_timeout_ms,
      displayWidth:  cfg.display_width  ?? 1280,
      displayHeight: cfg.display_height ?? 800,
    });

    return agenticComputerUseHandler.factory({ ...ctx, model, tools });
  },
};
