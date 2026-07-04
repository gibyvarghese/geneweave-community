// SPDX-License-Identifier: MIT
import type { IncomingMessage, ServerResponse } from 'node:http';
import { newUUIDv7, weaveContext } from '@weaveintel/core';
import { emitCacheEvent } from '../../cache-invalidator.js';
import {
  renderPromptRecord,
  resolvePromptRecordForExecution,
  evaluatePromptDatasetForRecord,
  comparePromptDatasetResults,
  createConstraintAppenderOptimizer,
  runPromptOptimization,
  createPromptCapabilityTelemetry,
} from '@weaveintel/prompts';
import {
  capabilityTelemetryToEvent,
  capabilityTelemetryToSpanAttributes,
} from '@weaveintel/observability';
import type { DatabaseAdapter } from '../../db.js';
import { getOrCreateModel } from '../../chat.js';
import {
  normalizePromptVariables,
  normalizeJsonField,
  parseJsonValue,
  validateDetailedDescription,
  clearDefaultPromptExcept,
  safeParsePromptVariables,
  toDbUpdate,
} from '../api/admin-route-helpers.js';
import type { RouterLike } from '../api/types.js';

export function registerAdminPromptRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  json: (res: ServerResponse, status: number, data: unknown) => void,
  readBody: (req: IncomingMessage) => Promise<string>,
): void {
  function requireDetailedDescription(
    description: unknown,
    kind: 'prompt' | 'tool' | 'skill' | 'agent',
    res: ServerResponse,
  ): string | null {
    const validation = validateDetailedDescription(description, kind);
    if (!validation.valid) {
      json(res, 400, { error: validation.error });
      return null;
    }
    return validation.description;
  }

  router.get('/api/admin/prompts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prompts = await db.listPrompts();
    json(res, 200, { prompts });
  });

  router.get('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const prompt = await db.getPrompt(params['id']!);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }
    json(res, 200, { prompt });
  });

  router.post('/api/admin/prompts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['name'] || !body['template']) { json(res, 400, { error: 'name and template required' }); return; }
    const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
    if (!validatedDescription) return;
    const id = newUUIDv7();
    const isDefault = body['is_default'] ? 1 : 0;
    await db.createPrompt({
      id, key: (body['key'] as string) ?? id, name: body['name'] as string, description: validatedDescription,
      category: (body['category'] as string) ?? null, prompt_type: (body['prompt_type'] as string) ?? 'template', owner: (body['owner'] as string) ?? null, status: (body['status'] as string) ?? 'published', tags: normalizeJsonField(body['tags']), template: body['template'] as string,
      variables: normalizePromptVariables(body['variables']),
      version: (body['version'] as string) ?? '1.0', model_compatibility: normalizeJsonField(body['model_compatibility']), execution_defaults: normalizeJsonField(body['execution_defaults']), framework: normalizeJsonField(body['framework']), metadata: normalizeJsonField(body['metadata']), is_default: isDefault, enabled: body['enabled'] !== false ? 1 : 0,
    });
    if (isDefault) await clearDefaultPromptExcept(db, id);
    const prompt = await db.getPrompt(id);
    json(res, 201, { prompt });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPrompt(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['prompt_type'] !== undefined) fields['prompt_type'] = body['prompt_type'];
    if (body['owner'] !== undefined) fields['owner'] = body['owner'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['tags'] !== undefined) fields['tags'] = normalizeJsonField(body['tags']);
    if (body['template'] !== undefined) fields['template'] = body['template'];
    if (body['variables'] !== undefined) fields['variables'] = normalizePromptVariables(body['variables']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['model_compatibility'] !== undefined) fields['model_compatibility'] = normalizeJsonField(body['model_compatibility']);
    if (body['execution_defaults'] !== undefined) fields['execution_defaults'] = normalizeJsonField(body['execution_defaults']);
    if (body['framework'] !== undefined) fields['framework'] = normalizeJsonField(body['framework']);
    if (body['metadata'] !== undefined) fields['metadata'] = normalizeJsonField(body['metadata']);
    if (body['is_default'] !== undefined) fields['is_default'] = body['is_default'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePrompt(params['id']!, toDbUpdate(fields));
    if (body['is_default']) await clearDefaultPromptExcept(db, params['id']!);
    // Phase 5: a prompt-template change invalidates cached responses (event-driven).
    await emitCacheEvent('prompt_update', { promptId: params['id'] });
    const prompt = await db.getPrompt(params['id']!);
    json(res, 200, { prompt });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePrompt(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Frameworks (Phase 2) ────────────────────

  router.get('/api/admin/prompt-frameworks', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const frameworks = await db.listPromptFrameworks();
    json(res, 200, { frameworks });
  });

  router.get('/api/admin/prompt-frameworks/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const f = await db.getPromptFramework(params['id']!);
    if (!f) { json(res, 404, { error: 'Prompt framework not found' }); return; }
    json(res, 200, { framework: f });
  });

  router.post('/api/admin/prompt-frameworks', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name']) { json(res, 400, { error: 'key and name required' }); return; }
    const id = newUUIDv7();
    await db.createPromptFramework({
      id, key: body['key'] as string, name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      sections: body['sections'] ? JSON.stringify(body['sections']) : '[]',
      section_separator: (body['section_separator'] as string) ?? '\n\n',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const framework = await db.getPromptFramework(id);
    json(res, 201, { framework });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-frameworks/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptFramework(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt framework not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['sections'] !== undefined) fields['sections'] = typeof body['sections'] === 'string' ? body['sections'] : JSON.stringify(body['sections']);
    if (body['section_separator'] !== undefined) fields['section_separator'] = body['section_separator'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptFramework(params['id']!, toDbUpdate(fields));
    const framework = await db.getPromptFramework(params['id']!);
    json(res, 200, { framework });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-frameworks/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptFramework(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Fragments (Phase 2) ─────────────────────

  router.get('/api/admin/prompt-fragments', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const fragments = await db.listPromptFragments();
    json(res, 200, { fragments });
  });

  router.get('/api/admin/prompt-fragments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const f = await db.getPromptFragment(params['id']!);
    if (!f) { json(res, 404, { error: 'Prompt fragment not found' }); return; }
    json(res, 200, { fragment: f });
  });

  router.post('/api/admin/prompt-fragments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name'] || !body['content']) {
      json(res, 400, { error: 'key, name, and content required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptFragment({
      id, key: body['key'] as string, name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      category: (body['category'] as string) ?? null,
      content: body['content'] as string,
      variables: body['variables'] ? JSON.stringify(body['variables']) : null,
      tags: body['tags'] ? JSON.stringify(body['tags']) : null,
      version: (body['version'] as string) ?? '1.0',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const fragment = await db.getPromptFragment(id);
    json(res, 201, { fragment });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-fragments/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptFragment(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt fragment not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['category'] !== undefined) fields['category'] = body['category'];
    if (body['content'] !== undefined) fields['content'] = body['content'];
    if (body['variables'] !== undefined) fields['variables'] = typeof body['variables'] === 'string' ? body['variables'] : JSON.stringify(body['variables']);
    if (body['tags'] !== undefined) fields['tags'] = typeof body['tags'] === 'string' ? body['tags'] : JSON.stringify(body['tags']);
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptFragment(params['id']!, toDbUpdate(fields));
    const fragment = await db.getPromptFragment(params['id']!);
    json(res, 200, { fragment });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-fragments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptFragment(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Contracts ────────────────────────────────

  router.get('/api/admin/prompt-contracts', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const contracts = await db.listPromptContracts();
    json(res, 200, { contracts });
  });

  router.get('/api/admin/prompt-contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const c = await db.getPromptContract(params['id']!);
    if (!c) { json(res, 404, { error: 'Prompt contract not found' }); return; }
    json(res, 200, { contract: c });
  });

  router.post('/api/admin/prompt-contracts', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name'] || !body['contract_type'] || !body['config']) {
      json(res, 400, { error: 'key, name, contract_type, and config required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptContract({
      id, key: body['key'] as string, name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      contract_type: body['contract_type'] as string,
      schema: body['schema'] ? (typeof body['schema'] === 'string' ? body['schema'] : JSON.stringify(body['schema'])) : null,
      config: typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']),
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const contract = await db.getPromptContract(id);
    json(res, 201, { contract });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-contracts/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptContract(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt contract not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['contract_type'] !== undefined) fields['contract_type'] = body['contract_type'];
    if (body['schema'] !== undefined) fields['schema'] = typeof body['schema'] === 'string' ? body['schema'] : JSON.stringify(body['schema']);
    if (body['config'] !== undefined) fields['config'] = typeof body['config'] === 'string' ? body['config'] : JSON.stringify(body['config']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptContract(params['id']!, toDbUpdate(fields));
    const contract = await db.getPromptContract(params['id']!);
    json(res, 200, { contract });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-contracts/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptContract(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Strategies (Phase 4) ───────────────────

  router.get('/api/admin/prompt-strategies', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const strategies = await db.listPromptStrategies();
    json(res, 200, { strategies });
  });

  router.get('/api/admin/prompt-strategies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const strategy = await db.getPromptStrategy(params['id']!);
    if (!strategy) { json(res, 404, { error: 'Prompt strategy not found' }); return; }
    json(res, 200, { strategy });
  });

  router.post('/api/admin/prompt-strategies', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name']) {
      json(res, 400, { error: 'key and name required' }); return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
    if (!validatedDescription) return;

    const id = newUUIDv7();
    await db.createPromptStrategy({
      id,
      key: body['key'] as string,
      name: body['name'] as string,
      description: validatedDescription,
      instruction_prefix: (body['instruction_prefix'] as string) ?? null,
      instruction_suffix: (body['instruction_suffix'] as string) ?? null,
      config: normalizeJsonField(body['config']) ?? '{}',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const strategy = await db.getPromptStrategy(id);
    json(res, 201, { strategy });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-strategies/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptStrategy(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt strategy not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['instruction_prefix'] !== undefined) fields['instruction_prefix'] = body['instruction_prefix'];
    if (body['instruction_suffix'] !== undefined) fields['instruction_suffix'] = body['instruction_suffix'];
    if (body['config'] !== undefined) fields['config'] = normalizeJsonField(body['config']) ?? '{}';
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updatePromptStrategy(params['id']!, toDbUpdate(fields));
    const strategy = await db.getPromptStrategy(params['id']!);
    json(res, 200, { strategy });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-strategies/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptStrategy(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Versions (Phase 5) ─────────────────────

  router.get('/api/admin/prompt-versions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const versions = await db.listPromptVersions(promptId);
    json(res, 200, { versions });
  });

  router.get('/api/admin/prompt-versions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const version = await db.getPromptVersion(params['id']!);
    if (!version) { json(res, 404, { error: 'Prompt version not found' }); return; }
    json(res, 200, { version });
  });

  router.post('/api/admin/prompt-versions', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['version'] || !body['template']) {
      json(res, 400, { error: 'prompt_id, version, and template required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptVersion({
      id,
      prompt_id: body['prompt_id'] as string,
      version: body['version'] as string,
      status: (body['status'] as string) ?? 'draft',
      template: body['template'] as string,
      variables: normalizePromptVariables(body['variables']),
      model_compatibility: normalizeJsonField(body['model_compatibility']),
      execution_defaults: normalizeJsonField(body['execution_defaults']),
      framework: normalizeJsonField(body['framework']),
      metadata: normalizeJsonField(body['metadata']),
      is_active: body['is_active'] ? 1 : 0,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const version = await db.getPromptVersion(id);
    json(res, 201, { version });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-versions/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptVersion(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt version not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['version'] !== undefined) fields['version'] = body['version'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['template'] !== undefined) fields['template'] = body['template'];
    if (body['variables'] !== undefined) fields['variables'] = normalizePromptVariables(body['variables']);
    if (body['model_compatibility'] !== undefined) fields['model_compatibility'] = normalizeJsonField(body['model_compatibility']);
    if (body['execution_defaults'] !== undefined) fields['execution_defaults'] = normalizeJsonField(body['execution_defaults']);
    if (body['framework'] !== undefined) fields['framework'] = normalizeJsonField(body['framework']);
    if (body['metadata'] !== undefined) fields['metadata'] = normalizeJsonField(body['metadata']);
    if (body['is_active'] !== undefined) fields['is_active'] = body['is_active'] ? 1 : 0;
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptVersion(params['id']!, toDbUpdate(fields));
    const version = await db.getPromptVersion(params['id']!);
    json(res, 200, { version });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-versions/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptVersion(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Experiments (Phase 5) ───────────────────

  router.get('/api/admin/prompt-experiments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const experiments = await db.listPromptExperiments(promptId);
    json(res, 200, { experiments });
  });

  router.get('/api/admin/prompt-experiments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const experiment = await db.getPromptExperiment(params['id']!);
    if (!experiment) { json(res, 404, { error: 'Prompt experiment not found' }); return; }
    json(res, 200, { experiment });
  });

  router.post('/api/admin/prompt-experiments', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['name'] || !body['variants_json']) {
      json(res, 400, { error: 'prompt_id, name, and variants_json required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptExperiment({
      id,
      prompt_id: body['prompt_id'] as string,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      status: (body['status'] as string) ?? 'draft',
      variants_json: typeof body['variants_json'] === 'string' ? body['variants_json'] : JSON.stringify(body['variants_json']),
      assignment_key_template: (body['assignment_key_template'] as string) ?? null,
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const experiment = await db.getPromptExperiment(id);
    json(res, 201, { experiment });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-experiments/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptExperiment(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt experiment not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['variants_json'] !== undefined) fields['variants_json'] = typeof body['variants_json'] === 'string' ? body['variants_json'] : JSON.stringify(body['variants_json']);
    if (body['assignment_key_template'] !== undefined) fields['assignment_key_template'] = body['assignment_key_template'];
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;
    await db.updatePromptExperiment(params['id']!, toDbUpdate(fields));
    const experiment = await db.getPromptExperiment(params['id']!);
    json(res, 200, { experiment });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-experiments/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptExperiment(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Eval Datasets (Phase 7) ────────────────

  router.get('/api/admin/prompt-eval-datasets', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const datasets = await db.listPromptEvalDatasets(promptId);
    json(res, 200, { datasets });
  });

  router.get('/api/admin/prompt-eval-datasets/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const dataset = await db.getPromptEvalDataset(params['id']!);
    if (!dataset) { json(res, 404, { error: 'Prompt eval dataset not found' }); return; }
    json(res, 200, { dataset });
  });

  router.post('/api/admin/prompt-eval-datasets', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['name'] || !body['cases_json']) {
      json(res, 400, { error: 'prompt_id, name, and cases_json required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptEvalDataset({
      id,
      prompt_id: body['prompt_id'] as string,
      name: body['name'] as string,
      description: (body['description'] as string) ?? null,
      prompt_version: (body['prompt_version'] as string) ?? null,
      status: (body['status'] as string) ?? 'draft',
      pass_threshold: typeof body['pass_threshold'] === 'number' ? body['pass_threshold'] as number : 0.75,
      cases_json: typeof body['cases_json'] === 'string' ? body['cases_json'] : JSON.stringify(body['cases_json']),
      rubric_json: normalizeJsonField(body['rubric_json']),
      metadata: normalizeJsonField(body['metadata']),
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const dataset = await db.getPromptEvalDataset(id);
    json(res, 201, { dataset });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-eval-datasets/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptEvalDataset(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt eval dataset not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) fields['description'] = body['description'];
    if (body['prompt_version'] !== undefined) fields['prompt_version'] = body['prompt_version'];
    if (body['status'] !== undefined) fields['status'] = body['status'];
    if (body['pass_threshold'] !== undefined) fields['pass_threshold'] = body['pass_threshold'];
    if (body['cases_json'] !== undefined) fields['cases_json'] = typeof body['cases_json'] === 'string' ? body['cases_json'] : JSON.stringify(body['cases_json']);
    if (body['rubric_json'] !== undefined) fields['rubric_json'] = normalizeJsonField(body['rubric_json']);
    if (body['metadata'] !== undefined) fields['metadata'] = normalizeJsonField(body['metadata']);
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updatePromptEvalDataset(params['id']!, toDbUpdate(fields));
    const dataset = await db.getPromptEvalDataset(params['id']!);
    json(res, 200, { dataset });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-eval-datasets/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptEvalDataset(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Eval Runs (Phase 7) ────────────────────

  router.get('/api/admin/prompt-eval-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const datasetId = url.searchParams.get('dataset_id') ?? undefined;
    const runs = await db.listPromptEvalRuns(datasetId);
    json(res, 200, { runs });
  });

  router.get('/api/admin/prompt-eval-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getPromptEvalRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Prompt eval run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/admin/prompt-eval-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['dataset_id'] || !body['prompt_id'] || !body['prompt_version'] || body['results_json'] === undefined) {
      json(res, 400, { error: 'dataset_id, prompt_id, prompt_version, and results_json required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptEvalRun({
      id,
      dataset_id: body['dataset_id'] as string,
      prompt_id: body['prompt_id'] as string,
      prompt_version: body['prompt_version'] as string,
      status: (body['status'] as string) ?? 'completed',
      avg_score: typeof body['avg_score'] === 'number' ? body['avg_score'] as number : 0,
      passed_cases: typeof body['passed_cases'] === 'number' ? body['passed_cases'] as number : 0,
      failed_cases: typeof body['failed_cases'] === 'number' ? body['failed_cases'] as number : 0,
      total_cases: typeof body['total_cases'] === 'number' ? body['total_cases'] as number : 0,
      results_json: typeof body['results_json'] === 'string' ? body['results_json'] : JSON.stringify(body['results_json']),
      summary_json: normalizeJsonField(body['summary_json']),
      metadata: normalizeJsonField(body['metadata']),
      completed_at: (body['completed_at'] as string) ?? null,
    });
    const run = await db.getPromptEvalRun(id);
    json(res, 201, { run });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-eval-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptEvalRun(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Optimizers (Phase 7) ───────────────────

  router.get('/api/admin/prompt-optimizers', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const optimizers = await db.listPromptOptimizers();
    json(res, 200, { optimizers });
  });

  router.get('/api/admin/prompt-optimizers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const optimizer = await db.getPromptOptimizer(params['id']!);
    if (!optimizer) { json(res, 404, { error: 'Prompt optimizer not found' }); return; }
    json(res, 200, { optimizer });
  });

  router.post('/api/admin/prompt-optimizers', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['key'] || !body['name']) {
      json(res, 400, { error: 'key and name required' }); return;
    }
    const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
    if (!validatedDescription) return;

    const id = newUUIDv7();
    await db.createPromptOptimizer({
      id,
      key: body['key'] as string,
      name: body['name'] as string,
      description: validatedDescription,
      implementation_kind: (body['implementation_kind'] as string) ?? 'rule',
      config: normalizeJsonField(body['config']) ?? '{}',
      enabled: body['enabled'] !== false ? 1 : 0,
    });
    const optimizer = await db.getPromptOptimizer(id);
    json(res, 201, { optimizer });
  }, { auth: true, csrf: true });

  router.put('/api/admin/prompt-optimizers/:id', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const existing = await db.getPromptOptimizer(params['id']!);
    if (!existing) { json(res, 404, { error: 'Prompt optimizer not found' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const fields: Record<string, unknown> = {};
    if (body['key'] !== undefined) fields['key'] = body['key'];
    if (body['name'] !== undefined) fields['name'] = body['name'];
    if (body['description'] !== undefined) {
      const validatedDescription = requireDetailedDescription(body['description'], 'prompt', res);
      if (!validatedDescription) return;
      fields['description'] = validatedDescription;
    }
    if (body['implementation_kind'] !== undefined) fields['implementation_kind'] = body['implementation_kind'];
    if (body['config'] !== undefined) fields['config'] = normalizeJsonField(body['config']) ?? '{}';
    if (body['enabled'] !== undefined) fields['enabled'] = body['enabled'] ? 1 : 0;

    await db.updatePromptOptimizer(params['id']!, toDbUpdate(fields));
    const optimizer = await db.getPromptOptimizer(params['id']!);
    json(res, 200, { optimizer });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-optimizers/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptOptimizer(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Prompt Optimization Runs (Phase 7) ────────────

  router.get('/api/admin/prompt-optimization-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const url = new URL(req.url ?? '/', 'http://localhost');
    const promptId = url.searchParams.get('prompt_id') ?? undefined;
    const runs = await db.listPromptOptimizationRuns(promptId);
    json(res, 200, { runs });
  });

  router.get('/api/admin/prompt-optimization-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const run = await db.getPromptOptimizationRun(params['id']!);
    if (!run) { json(res, 404, { error: 'Prompt optimization run not found' }); return; }
    json(res, 200, { run });
  });

  router.post('/api/admin/prompt-optimization-runs', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['prompt_id'] || !body['source_version'] || !body['candidate_version'] || !body['objective'] || !body['source_template'] || !body['candidate_template'] || body['diff_json'] === undefined) {
      json(res, 400, { error: 'prompt_id, source_version, candidate_version, objective, source_template, candidate_template, and diff_json required' }); return;
    }
    const id = newUUIDv7();
    await db.createPromptOptimizationRun({
      id,
      prompt_id: body['prompt_id'] as string,
      source_version: body['source_version'] as string,
      candidate_version: body['candidate_version'] as string,
      optimizer_id: (body['optimizer_id'] as string) ?? null,
      objective: body['objective'] as string,
      source_template: body['source_template'] as string,
      candidate_template: body['candidate_template'] as string,
      diff_json: typeof body['diff_json'] === 'string' ? body['diff_json'] : JSON.stringify(body['diff_json']),
      eval_baseline_json: normalizeJsonField(body['eval_baseline_json']),
      eval_candidate_json: normalizeJsonField(body['eval_candidate_json']),
      status: (body['status'] as string) ?? 'completed',
      metadata: normalizeJsonField(body['metadata']),
    });
    const run = await db.getPromptOptimizationRun(id);
    json(res, 201, { run });
  }, { auth: true, csrf: true });

  router.del('/api/admin/prompt-optimization-runs/:id', async (_req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    await db.deletePromptOptimizationRun(params['id']!);
    json(res, 200, { ok: true });
  }, { auth: true, csrf: true });

  // ── Admin: Phase 7 Runtime Execution Helpers ─────────────

  router.post('/api/admin/prompt-eval-datasets/:id/run', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const dataset = await db.getPromptEvalDataset(params['id']!);
    if (!dataset) { json(res, 404, { error: 'Prompt eval dataset not found' }); return; }

    const prompt = await db.getPrompt(dataset.prompt_id);
    if (!prompt) { json(res, 404, { error: 'Prompt not found for dataset.prompt_id' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown> = {};
    if (raw.trim()) {
      try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    }

    const versions = await db.listPromptVersions(prompt.id);
    const experiments = await db.listPromptExperiments(prompt.id);
    const requestedVersion = (body['requested_version'] as string) ?? dataset.prompt_version ?? undefined;

    const resolved = resolvePromptRecordForExecution({
      prompt,
      versions,
      experiments,
      options: {
        requestedVersion,
        assignmentKey: (body['assignment_key'] as string) ?? undefined,
        experimentId: (body['experiment_id'] as string) ?? undefined,
      },
    });

    const evalDataset = {
      id: dataset.id,
      name: dataset.name,
      description: dataset.description ?? 'Prompt evaluation dataset',
      promptId: dataset.prompt_id,
      promptVersion: dataset.prompt_version ?? undefined,
      cases: parseJsonValue(dataset.cases_json, [] as Array<Record<string, unknown>>),
      rubric: dataset.rubric_json ? parseJsonValue(dataset.rubric_json, [] as Array<Record<string, unknown>>) : undefined,
    };

    const result = await evaluatePromptDatasetForRecord(resolved.record, evalDataset as unknown as Parameters<typeof evaluatePromptDatasetForRecord>[1], {
      passThreshold: typeof body['pass_threshold'] === 'number'
        ? body['pass_threshold'] as number
        : dataset.pass_threshold,
    });

    const runId = newUUIDv7();
    await db.createPromptEvalRun({
      id: runId,
      dataset_id: dataset.id,
      prompt_id: prompt.id,
      prompt_version: result.promptVersion,
      status: 'completed',
      avg_score: result.averageScore,
      passed_cases: result.passedCases,
      failed_cases: result.failedCases,
      total_cases: result.totalCases,
      results_json: JSON.stringify(result.results),
      summary_json: JSON.stringify({
        datasetName: result.datasetName,
        passThreshold: result.passThreshold,
        durationMs: result.durationMs,
      }),
      metadata: JSON.stringify({ resolution: resolved.meta }),
      completed_at: new Date().toISOString(),
    });

    const run = await db.getPromptEvalRun(runId);
    json(res, 200, { run, result, resolution: resolved.meta });
  }, { auth: true, csrf: true });

  router.post('/api/admin/prompts/:id/optimize', async (req, res, params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const prompt = await db.getPrompt(params['id']!);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    if (!body['objective']) { json(res, 400, { error: 'objective required' }); return; }

    const versions = await db.listPromptVersions(prompt.id);
    const experiments = await db.listPromptExperiments(prompt.id);
    const resolved = resolvePromptRecordForExecution({
      prompt,
      versions,
      experiments,
      options: {
        requestedVersion: (body['source_version'] as string) ?? undefined,
      },
    });

    const optimizerKey = (body['optimizer_key'] as string) ?? 'constraintAppender';
    const optimizerRecord = await db.getPromptOptimizerByKey(optimizerKey);
    const optimizerConfig = parseJsonValue<Record<string, unknown>>(optimizerRecord?.config ?? '{}', {});
    const optimizer = createConstraintAppenderOptimizer({
      key: optimizerKey,
      name: optimizerRecord?.name ?? 'Constraint Appender',
      description: optimizerRecord?.description ?? 'Deterministic optimizer profile for prompt constraints and format checks.',
      suffix: typeof optimizerConfig['suffix'] === 'string'
        ? optimizerConfig['suffix'] as string
        : 'Return output that follows the required format exactly and explains key decisions clearly.',
    });

    const optResult = await runPromptOptimization({
      prompt: resolved.record,
      optimizer,
      objective: body['objective'] as string,
      constraints: Array.isArray(body['constraints'])
        ? body['constraints'].filter((item): item is string => typeof item === 'string')
        : undefined,
      targetVersion: (body['candidate_version'] as string) ?? undefined,
    });

    let evalBaselineJson: string | null = null;
    let evalCandidateJson: string | null = null;
    if (typeof body['dataset_id'] === 'string') {
      const dataset = await db.getPromptEvalDataset(body['dataset_id']);
      if (dataset) {
        const datasetObj = {
          id: dataset.id,
          name: dataset.name,
          description: dataset.description ?? 'Prompt optimization dataset',
          promptId: dataset.prompt_id,
          promptVersion: dataset.prompt_version ?? undefined,
          cases: parseJsonValue(dataset.cases_json, [] as Array<Record<string, unknown>>),
          rubric: dataset.rubric_json ? parseJsonValue(dataset.rubric_json, [] as Array<Record<string, unknown>>) : undefined,
        };

        const candidateRecord = {
          ...resolved.record,
          version: optResult.candidate.version,
          template: optResult.candidate.template,
          variables: optResult.candidate.variables ?? resolved.record.variables,
        };

        const comparison = await comparePromptDatasetResults({
          baselineRecord: resolved.record,
          candidateRecord,
          dataset: datasetObj as unknown as Parameters<typeof comparePromptDatasetResults>[0]['dataset'],
          options: { passThreshold: dataset.pass_threshold },
        });
        evalBaselineJson = JSON.stringify(comparison.baseline);
        evalCandidateJson = JSON.stringify(comparison.candidate);
      }
    }

    const runId = newUUIDv7();
    await db.createPromptOptimizationRun({
      id: runId,
      prompt_id: prompt.id,
      source_version: optResult.source.version,
      candidate_version: optResult.candidate.version,
      optimizer_id: optimizerRecord?.id ?? null,
      objective: optResult.objective,
      source_template: optResult.source.template,
      candidate_template: optResult.candidate.template,
      diff_json: JSON.stringify(optResult.diff),
      eval_baseline_json: evalBaselineJson,
      eval_candidate_json: evalCandidateJson,
      status: 'completed',
      metadata: JSON.stringify({
        optimizerKey: optResult.optimizerKey,
        optimizerName: optResult.optimizerName,
        reasoning: optResult.reasoning,
        resolution: resolved.meta,
      }),
    });

    const run = await db.getPromptOptimizationRun(runId);
    json(res, 200, { run, optimization: optResult });
  }, { auth: true, csrf: true });

  // ── Prompt resolution ──────────────────────────────────────

  router.post('/api/prompts/resolve', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }
    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }
    const promptId = body['promptId'] as string;
    if (!promptId) { json(res, 400, { error: 'promptId required' }); return; }
    const prompt = await db.getPrompt(promptId);
    if (!prompt) { json(res, 404, { error: 'Prompt not found' }); return; }
    const variables = (body['variables'] as Record<string, unknown>) ?? {};
    try {
      let telemetry = undefined;
      const renderedResult = renderPromptRecord(prompt, variables, {
        evaluations: [
          {
            id: 'prompt_not_empty',
            description: 'Rendered prompt previews should produce non-empty content for operators.',
            evaluate: ({ content }) => ({
              passed: content.trim().length > 0,
              score: content.trim().length > 0 ? 1 : 0,
              reason: content.trim().length > 0 ? undefined : 'Rendered prompt preview is empty',
            }),
          },
        ],
        hooks: {
          onTelemetry: ({ telemetry: emitted }) => {
            telemetry = emitted;
          },
        },
      });

      const traceId = newUUIDv7();
      const rootSpanId = newUUIDv7();
      const capability = telemetry ?? createPromptCapabilityTelemetry(renderedResult, { source: 'db' });
      await db.saveTrace({
        id: newUUIDv7(),
        userId: auth.userId,
        traceId,
        spanId: rootSpanId,
        name: 'admin.prompt.resolve',
        startTime: Date.now() - renderedResult.durationMs,
        endTime: Date.now(),
        status: 'ok',
        attributes: JSON.stringify({
          route: '/api/prompts/resolve',
          promptId,
          renderedCharacters: renderedResult.content.length,
        }),
      });
      await db.saveTrace({
        id: newUUIDv7(),
        userId: auth.userId,
        traceId,
        spanId: newUUIDv7(),
        parentSpanId: rootSpanId,
        name: `capability.prompt.${capability.key}`,
        startTime: Date.now() - renderedResult.durationMs,
        endTime: Date.now(),
        status: 'ok',
        attributes: JSON.stringify(capabilityTelemetryToSpanAttributes(capability)),
        events: JSON.stringify([capabilityTelemetryToEvent(capability, 'success')]),
      });

      json(res, 200, {
        rendered: renderedResult.content,
        template: prompt.template,
        variables: safeParsePromptVariables(prompt.variables),
        telemetry: capability,
        evaluations: renderedResult.evaluations,
        traceId,
      });
    } catch (e: unknown) {
      json(res, 400, { error: e instanceof Error ? e.message : 'Render error' });
    }
  }, { auth: true, csrf: true });
}
