/**
 * GeneWeave — Admin Tool Simulation routes (Phase 5)
 *
 * Operators can test tool invocations directly from admin before enabling
 * in production. Returns full policy resolution trace and optional tool output.
 *
 * Endpoints:
 *   GET  /api/admin/tool-simulation/tools   — list tools available for simulation
 *   POST /api/admin/tool-simulation          — run a simulation (dryRun or full exec)
 */

import { newUUIDv7 } from '@weaveintel/core';
import { weaveContext } from '@weaveintel/core';
import { weaveRunToolTests } from '@weaveintel/tools';
import type { ToolRiskLevel, ToolAuditOutcome, ToolPolicyViolationReason } from '@weaveintel/core';
import type { DatabaseAdapter } from '../../db.js';
import type { ToolCatalogRow } from '../../db-types.js';
import type { RouterLike, AdminHelpers } from './types.js';
import { DbToolPolicyResolver } from '../../tool-policy-resolver.js';
import { DbToolAuditEmitter } from '../../tool-audit-emitter.js';
import { BUILTIN_TOOLS } from '../../tools.js';

function truncatePreview(s: string, max = 500): string {
  return s.length > max ? s.slice(0, max) + '…' : s;
}

function sampleStringForKey(key: string, schema: Record<string, unknown> | undefined): string {
  const normalized = key.toLowerCase();
  const description = typeof schema?.['description'] === 'string' ? schema['description'].toLowerCase() : '';

  if (normalized.includes('url') || description.includes('url')) return 'https://example.com';
  if (normalized.includes('query') || normalized.includes('search')) return 'example search query';
  if (normalized.includes('expression')) return '2 + 2';
  if (normalized === 'json' || normalized.endsWith('_json')) return '{"hello":"world"}';
  if (normalized.includes('text') || normalized.includes('content') || normalized.includes('message')) return 'Example text';
  if (normalized.includes('name')) return 'example-name';
  if (normalized.includes('title')) return 'Example Title';
  if (normalized.includes('path') || normalized.includes('file')) return '/tmp/example.txt';
  if (normalized.includes('email')) return 'user@example.com';
  if (normalized.includes('model')) return 'gpt-4o-mini';
  if (normalized.includes('provider')) return 'openai';
  if (normalized.includes('timezone')) return 'UTC';
  return 'example';
}

function buildFallbackSampleInput(toolKey: string, description: string): Record<string, unknown> {
  const normalizedKey = toolKey.toLowerCase();
  const normalizedDescription = description.toLowerCase();

  if (normalizedKey === 'api_caller') {
    return {
      url: 'https://example.com/api/health',
      method: 'GET',
      headers: { Accept: 'application/json' },
    };
  }

  if (normalizedKey === 'database_query') {
    return {
      connection: 'default',
      query: 'SELECT 1 AS ok',
    };
  }

  if (normalizedKey === 'calculator') {
    return { expression: '2 + 2' };
  }

  if (normalizedKey === 'web_search') {
    return { query: 'example search query' };
  }

  if (normalizedKey === 'json_format') {
    return { json: '{"hello":"world"}' };
  }

  if (normalizedKey === 'cse_run_code') {
    return { code: "print('hello world')" };
  }

  if (normalizedKey === 'cse_run_data_analysis') {
    return {
      code: "import pandas as pd\ndf = pd.DataFrame({'value': [1, 2, 3]})\nprint(df.describe())",
    };
  }

  if (normalizedKey.startsWith('browser_')) {
    if (normalizedKey.includes('scrape')) {
      return {
        url: 'https://example.com',
        selectors: { title: 'title' },
      };
    }
    return { url: 'https://example.com' };
  }

  if (normalizedKey.startsWith('statsnz_')) {
    return { query: 'estimated resident population new zealand 2023' };
  }

  if (normalizedDescription.includes('sql')) {
    return { query: 'SELECT 1 AS ok' };
  }
  if (normalizedDescription.includes('http') || normalizedDescription.includes('api')) {
    return { url: 'https://example.com/api/health', method: 'GET' };
  }
  if (normalizedDescription.includes('web page') || normalizedDescription.includes('url')) {
    return { url: 'https://example.com' };
  }
  if (normalizedDescription.includes('search')) {
    return { query: 'example search query' };
  }

  return { input: 'example' };
}

function isEmptySample(sample: unknown): boolean {
  return Boolean(sample) && typeof sample === 'object' && !Array.isArray(sample) && Object.keys(sample as Record<string, unknown>).length === 0;
}

function buildSampleValueFromSchema(
  schema: Record<string, unknown> | undefined,
  key = '',
  depth = 0,
): unknown {
  if (!schema || depth > 4) return null;

  const enumValues = Array.isArray(schema['enum']) ? schema['enum'] : null;
  if (enumValues && enumValues.length > 0) return enumValues[0];

  const explicitDefault = schema['default'];
  if (explicitDefault !== undefined) return explicitDefault;

  const type = typeof schema['type'] === 'string' ? schema['type'] : undefined;
  switch (type) {
    case 'object': {
      const properties = schema['properties'];
      const required = new Set(Array.isArray(schema['required']) ? schema['required'].filter((v): v is string => typeof v === 'string') : []);
      const propertyEntries = properties && typeof properties === 'object'
        ? Object.entries(properties as Record<string, unknown>)
        : [];
      const keysToInclude = required.size > 0
        ? propertyEntries.filter(([propertyKey]) => required.has(propertyKey))
        : propertyEntries;
      const out: Record<string, unknown> = {};
      for (const [propertyKey, value] of keysToInclude) {
        out[propertyKey] = buildSampleValueFromSchema((value as Record<string, unknown>) ?? undefined, propertyKey, depth + 1);
      }
      return out;
    }
    case 'array': {
      const items = schema['items'];
      return [buildSampleValueFromSchema((items as Record<string, unknown>) ?? undefined, key, depth + 1)];
    }
    case 'number':
    case 'integer':
      return 1;
    case 'boolean':
      return true;
    case 'string':
    default:
      return sampleStringForKey(key, schema);
  }
}

function buildSampleInputJson(toolKey: string, tool: { schema: { parameters?: Record<string, unknown>; description: string } }): string {
  let sample = buildSampleValueFromSchema(tool.schema.parameters);
  if (sample == null || isEmptySample(sample)) {
    sample = buildFallbackSampleInput(toolKey, tool.schema.description ?? '');
  }
  return JSON.stringify(sample ?? {}, null, 2);
}

export function registerToolSimulationRoutes(
  router: RouterLike,
  db: DatabaseAdapter,
  helpers: AdminHelpers,
): void {
  const { json, readBody } = helpers;

  /** List all tools available for simulation — builtins that are enabled in the catalog + custom. */
  router.get('/api/admin/tool-simulation/tools', async (_req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    // Only show builtin tools that are present AND enabled in the tool catalog.
    // This prevents operators seeing tools they cannot actually simulate due to
    // catalog policy, and keeps the list consistent with what simulation will permit.
    const catalogEntries = await db.listEnabledToolCatalog();
    const enabledBuiltinKeys = new Set(
      catalogEntries
        .filter(e => e.source === 'builtin' && e.enabled)
        .map(e => e.tool_key ?? e.name),
    );

    const builtinTools = Object.entries(BUILTIN_TOOLS)
      .filter(([key]) => enabledBuiltinKeys.has(key))
      .map(([key, tool]) => ({
        key,
        name: tool.schema.name,
        description: tool.schema.description,
        tags: tool.schema.tags ?? [],
        source: 'builtin',
        sampleInputJson: buildSampleInputJson(key, tool),
      }));

    const customTools = catalogEntries
      .filter(e => e.source !== 'builtin' && e.enabled)
      .map(e => ({
        key: e.tool_key ?? e.name,
        name: e.name,
        description: e.description ?? '',
        tags: [] as string[],
        source: e.source ?? 'custom',
        sampleInputJson: JSON.stringify(buildFallbackSampleInput(e.tool_key ?? e.name, e.description ?? ''), null, 2),
      }));

    json(res, 200, { tools: [...builtinTools, ...customTools] });
  }, { auth: true });

  /**
   * Run a tool simulation.
   *
   * Request body:
   *   toolName   string          — name of the tool to simulate
   *   inputJson  string|object   — tool arguments as JSON string or object
   *   dryRun     boolean         — if true, only resolve policy (no execution)
   *   chatContext object         — optional { agentPersona, skillPolicyKey, chatId, userId }
   *
   * Response:
   *   simulationId  UUID
   *   toolName      string
   *   dryRun        boolean
   *   policy        EffectiveToolPolicy
   *   policyTrace   Array<{ step, passed, detail }>
   *   allowed       boolean
   *   violationReason? string
   *   result?       { content: string, isError?: boolean }
   *   durationMs    number
   *   auditEventId  UUID
   */
  router.post('/api/admin/tool-simulation', async (req, res, _params, auth) => {
    if (!auth) { json(res, 401, { error: 'Not authenticated' }); return; }

    const raw = await readBody(req);
    let body: Record<string, unknown>;
    try { body = JSON.parse(raw); } catch { json(res, 400, { error: 'Invalid JSON' }); return; }

    const toolName = body['toolName'];
    if (!toolName || typeof toolName !== 'string') {
      json(res, 400, { error: 'toolName is required' }); return;
    }

    const inputJsonRaw = body['inputJson'] ?? '{}';
    const dryRun = body['dryRun'] === true;
    const chatContext = (body['chatContext'] as Record<string, unknown>) ?? {};

    // Parse tool input arguments
    let parsedInput: Record<string, unknown>;
    try {
      parsedInput = typeof inputJsonRaw === 'string'
        ? JSON.parse(inputJsonRaw) as Record<string, unknown>
        : inputJsonRaw as Record<string, unknown>;
    } catch {
      json(res, 400, { error: 'inputJson must be valid JSON' }); return;
    }

    const simulationId = newUUIDv7();
    const auditEventId = newUUIDv7();
    const startMs = Date.now();

    const resolutionContext = {
      agentPersona: typeof chatContext['agentPersona'] === 'string' ? chatContext['agentPersona'] : undefined,
      skillPolicyKey: typeof chatContext['skillPolicyKey'] === 'string' ? chatContext['skillPolicyKey'] : undefined,
      chatId: typeof chatContext['chatId'] === 'string' ? chatContext['chatId'] : simulationId,
      userId: typeof chatContext['userId'] === 'string' ? chatContext['userId'] : auth.userId,
    };

    // 1. Resolve effective policy via DB-backed resolver
    const resolver = new DbToolPolicyResolver(db);
    let policy;
    try {
      policy = await resolver.resolve(toolName, resolutionContext);
    } catch (err) {
      json(res, 500, { error: `Policy resolution failed: ${(err as Error).message}` }); return;
    }

    // 2. Build policy trace — step through each enforcement check without side effects
    const policyTrace: Array<{ step: string; passed: boolean; detail: string }> = [];
    let allowed = true;
    let violationReason: ToolPolicyViolationReason | undefined;
    let catalogEntry: ToolCatalogRow | null | undefined;

    // Step 1: Enabled check
    const enabledPassed = !!policy.enabled;
    policyTrace.push({
      step: 'enabled_check',
      passed: enabledPassed,
      detail: enabledPassed
        ? 'Tool is enabled in catalog'
        : 'Tool is disabled — set enabled=true in Tool Catalog to allow invocations',
    });
    if (!enabledPassed) {
      allowed = false;
      violationReason = 'disabled';
    }

    // Step 2: Risk level gate
    if (allowed) {
      catalogEntry = await db.getToolCatalogByKey(toolName);
      const toolRiskLevel = (catalogEntry?.risk_level ?? 'read-only') as ToolRiskLevel;
      const allowedRisks = policy.allowedRiskLevels ?? [];
      const riskPassed = allowedRisks.length === 0 || allowedRisks.includes(toolRiskLevel);
      policyTrace.push({
        step: 'risk_level_gate',
        passed: riskPassed,
        detail: riskPassed
          ? `Risk level '${toolRiskLevel}' is permitted by the active policy`
          : `Risk level '${toolRiskLevel}' is blocked — policy allows only [${allowedRisks.join(', ')}]`,
      });
      if (!riskPassed) {
        allowed = false;
        violationReason = 'risk_level_blocked';
      }
    }

    // Step 3: Approval gate — note if required (simulation bypasses actual gate)
    if (allowed) {
      const approvalRequired = !!policy.requiresApproval;
      policyTrace.push({
        step: 'approval_gate',
        passed: true,
        detail: approvalRequired
          ? 'Approval required — production invocations will be gated (simulation bypasses this check)'
          : 'No approval required',
      });
    }

    // Step 4: Rate limit — show configuration without incrementing
    if (allowed) {
      if (policy.rateLimitPerMinute && policy.rateLimitPerMinute > 0) {
        policyTrace.push({
          step: 'rate_limit',
          passed: true,
          detail: `Rate limit configured: ${policy.rateLimitPerMinute} invocations/min (simulation does not consume quota)`,
        });
      } else {
        policyTrace.push({
          step: 'rate_limit',
          passed: true,
          detail: 'No rate limit configured',
        });
      }
    }

    // Step 5: Timeout
    if (allowed) {
      policyTrace.push({
        step: 'timeout',
        passed: true,
        detail: policy.timeoutMs && policy.timeoutMs > 0
          ? `Execution timeout: ${policy.timeoutMs}ms`
          : 'No execution timeout configured',
      });
    }

    // 3. Execute tool if allowed and not dryRun
    let result: { content: string; isError?: boolean } | undefined;
    let errorMessage: string | undefined;

    if (allowed && !dryRun) {
      // Defense-in-depth: always do a fresh catalog fetch at execution time, independent
      // of the stale `catalogEntry` variable from the risk-level check above.
      // `policy.enabled` (step 1) may lag a DB write by the time execution is reached;
      // this ensures we see the current enabled state before touching any tool.
      const execCatalogEntry = await db.getToolCatalogByKey(toolName);
      if (!execCatalogEntry?.enabled) {
        json(res, 403, { error: `Tool '${toolName}' is not enabled in the tool catalog.` });
        return;
      }
      const tool = BUILTIN_TOOLS[toolName];
      if (!tool) {
        // Custom/MCP/A2A tools: not executable in sandbox simulation mode
        json(res, 404, {
          error: `Tool '${toolName}' is not a builtin tool. MCP and A2A tools cannot be executed in simulation mode — use dryRun:true for policy inspection only.`,
        });
        return;
      }

      const execCtx = weaveContext({
        executionId: simulationId,
        userId: resolutionContext.userId,
        metadata: { simulationMode: true, adminSimulation: true },
      });

      const testResults = await weaveRunToolTests(tool, execCtx, [{
        name: 'simulation',
        input: { name: toolName, arguments: parsedInput },
      }]);

      const testResult = testResults[0];
      if (testResult) {
        if (testResult.error) {
          result = { content: testResult.error, isError: true };
          errorMessage = testResult.error;
        } else if (testResult.actual) {
          const output = testResult.actual;
          const rawContent = output.content;
          result = {
            content: typeof rawContent === 'string' ? rawContent : JSON.stringify(rawContent),
            isError: !!output.isError,
          };
        }
      }
    }

    const durationMs = Date.now() - startMs;
    const outcome: ToolAuditOutcome = !allowed ? 'denied_policy' : result?.isError ? 'error' : 'simulation';

    // 4. Emit audit event — best-effort, non-blocking
    const auditEmitter = new DbToolAuditEmitter(db);
    void auditEmitter.emit({
      toolName,
      chatId: resolutionContext.chatId,
      userId: resolutionContext.userId,
      agentPersona: resolutionContext.agentPersona,
      skillKey: resolutionContext.skillPolicyKey,
      policyId: policy.policyId,
      outcome,
      violationReason,
      durationMs,
      inputPreview: truncatePreview(JSON.stringify(parsedInput)),
      outputPreview: result ? truncatePreview(result.content) : undefined,
      errorMessage,
      createdAt: new Date().toISOString(),
    });

    json(res, 200, {
      simulationId,
      auditEventId,
      toolName,
      dryRun,
      policy,
      policyTrace,
      allowed,
      violationReason,
      result,
      durationMs,
    });
  }, { auth: true, csrf: true });
}
