import { describe, it, expect } from 'vitest';
import { weaveRuntime, weaveTool, weaveToolRegistry } from '@weaveintel/core';
import { BUILTIN_TOOLS, createToolRegistry } from './tools.js';

describe('Phase D — tool requires:[...] annotations', () => {
  it('annotates web_search with net.egress and secrets capabilities', () => {
    const t = BUILTIN_TOOLS['web_search'];
    expect(t).toBeDefined();
    expect(t!.schema.requires).toEqual(
      expect.arrayContaining(['runtime.net.egress', 'runtime.secrets']),
    );
  });

  it('does NOT annotate pure-utility tools (calculator, json_format)', () => {
    expect(BUILTIN_TOOLS['calculator']?.schema.requires ?? []).toEqual([]);
    expect(BUILTIN_TOOLS['json_format']?.schema.requires ?? []).toEqual([]);
  });

  it('weaveToolRegistry({ runtime }) asserts requires at register() time', () => {
    const runtime = weaveRuntime();
    const registry = weaveToolRegistry({ runtime });
    const bogusTool = weaveTool({
      name: 'needs_persistence',
      description: 'fake tool that requires a persistence slot the runtime does not have',
      parameters: { type: 'object', properties: {} },
      execute: async () => 'ok',
      requires: ['runtime.persistence'],
    });
    expect(() => registry.register(bogusTool)).toThrow(/runtime\.persistence/);
  });

  it('createToolRegistry({ runtime }) wires through to the underlying registry', async () => {
    const runtime = weaveRuntime();
    const registry = await createToolRegistry(['calculator'], undefined, { runtime, actorPersona: 'tenant_admin' });
    expect(registry.list().some((t) => t.schema.name === 'calculator')).toBe(true);
  });
});
