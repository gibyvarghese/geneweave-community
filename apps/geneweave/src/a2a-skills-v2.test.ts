/**
 * Phase 2 — A2A Skills Taxonomy Expansion (mid-2026) comprehensive test suite
 *
 * Positive:   12 new skills seeded, modes, MIME types, security scopes, agent_workers
 * Negative:   disabled skills, duplicate IDs rejected, invalid modes
 * Security:   SQL injection via skill_id, scope validation, MIME allowlist checks
 * Stress:     all 15 skills enumerable, concurrent lookups, mode/enabled distribution
 * Examples:   representative real-world use cases exercising the skill catalog
 */

import { randomUUID } from 'node:crypto';
import { describe, it, expect, beforeAll } from 'vitest';
import { SQLiteAdapter } from './db-sqlite.js';
import {
  A2A_SKILL_CATALOG,
  A2A_NEW_SKILLS_V2,
  SUPERVISOR_V2_WORKERS,
  M69_NEW_INPUT_MIME_TYPES,
} from '@weaveintel/skills';
import type { A2ASkillDef, A2AWorkerDef } from '@weaveintel/skills';

// ── Test DB helpers ──────────────────────────────────────────────────────────

function makeTempDbPath(): string {
  return `/tmp/geneweave-a2a-skills-v2-test-${Date.now()}-${randomUUID()}.db`;
}

/**
 * Create a fresh DB and run all migrations (including m69).
 * a2a_skills are fully migration-seeded so no extra seeding is required.
 */
async function newA2ASkillsDb(): Promise<SQLiteAdapter> {
  const db = new SQLiteAdapter(makeTempDbPath());
  await db.initialize(); // runs m60 → m61 → … → m69
  return db;
}

function parseJsonArray(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return JSON.parse(raw) as string[];
}

function parseWorkers(raw: string | null | undefined): A2AWorkerDef[] {
  if (!raw) return [];
  return JSON.parse(raw) as A2AWorkerDef[];
}

// ── Shared DB instance (shared across describe blocks for read-only checks) ──
let db: SQLiteAdapter;

beforeAll(async () => {
  db = await newA2ASkillsDb();
});

// ═══════════════════════════════════════════════════════════════════════════════
// POSITIVE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Phase 2] A2A Skills — Positive: total seed count', () => {
  it('must have exactly 15 a2a_skills after m69', async () => {
    const all = await db.listA2ASkills();
    expect(all).toHaveLength(15);
  });

  it('all 12 new skill IDs must be present', async () => {
    const all = await db.listA2ASkills();
    const ids = new Set(all.map(s => s.id));
    for (const skill of A2A_NEW_SKILLS_V2) {
      expect(ids.has(skill.id), `${skill.id} must be seeded`).toBe(true);
    }
  });

  it('the 3 existing skills must still be present', async () => {
    const ids = new Set((await db.listA2ASkills()).map(s => s.id));
    expect(ids.has('general-chat')).toBe(true);
    expect(ids.has('supervisor-orchestration')).toBe(true);
    expect(ids.has('ensemble-reasoning')).toBe(true);
  });

  it('all catalog IDs are in the DB (catalog ↔ DB parity)', async () => {
    const dbIds = new Set((await db.listA2ASkills()).map(s => s.id));
    for (const skill of A2A_SKILL_CATALOG) {
      expect(dbIds.has(skill.id), `catalog skill ${skill.id} must be in DB`).toBe(true);
    }
  });
});

describe('[Phase 2] A2A Skills — Positive: mode assignments', () => {
  it('code-execution mode is agent', async () => {
    const s = await db.getA2ASkill('code-execution');
    expect(s?.mode).toBe('agent');
  });

  it('data-pipeline mode is supervisor', async () => {
    const s = await db.getA2ASkill('data-pipeline');
    expect(s?.mode).toBe('supervisor');
  });

  it('workflow-orchestration mode is supervisor', async () => {
    const s = await db.getA2ASkill('workflow-orchestration');
    expect(s?.mode).toBe('supervisor');
  });

  it('research-synthesis mode is supervisor', async () => {
    const s = await db.getA2ASkill('research-synthesis');
    expect(s?.mode).toBe('supervisor');
  });

  it('hypothesis-validation mode is ensemble', async () => {
    const s = await db.getA2ASkill('hypothesis-validation');
    expect(s?.mode).toBe('ensemble');
  });

  it('computer-use mode is agent', async () => {
    const s = await db.getA2ASkill('computer-use');
    expect(s?.mode).toBe('agent');
  });

  it('image-analysis mode is agent', async () => {
    const s = await db.getA2ASkill('image-analysis');
    expect(s?.mode).toBe('agent');
  });

  it('total mode distribution: ≥8 agent, ≥3 supervisor, ≥1 ensemble', async () => {
    const all = await db.listA2ASkills();
    const modes = all.map(s => s.mode);
    const agentCount = modes.filter(m => m === 'agent').length;
    const supervisorCount = modes.filter(m => m === 'supervisor').length;
    const ensembleCount = modes.filter(m => m === 'ensemble').length;
    expect(agentCount).toBeGreaterThanOrEqual(8);
    expect(supervisorCount).toBeGreaterThanOrEqual(3);
    expect(ensembleCount).toBeGreaterThanOrEqual(1);
  });
});

describe('[Phase 2] A2A Skills — Positive: MIME types', () => {
  it('general-chat input_modes now includes video/* after m69', async () => {
    const s = await db.getA2ASkill('general-chat');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('video/*');
  });

  it('general-chat input_modes now includes text/html', async () => {
    const s = await db.getA2ASkill('general-chat');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('text/html');
  });

  it('general-chat input_modes includes openxmlformats DOCX', async () => {
    const s = await db.getA2ASkill('general-chat');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain(
      'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
    );
  });

  it('supervisor-orchestration input_modes includes all 3 openxmlformats types', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(modes).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(modes).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('ensemble-reasoning input_modes includes video/mp4', async () => {
    const s = await db.getA2ASkill('ensemble-reasoning');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('video/mp4');
  });

  it('document-intelligence accepts PDF, DOCX, XLSX, PPTX', async () => {
    const s = await db.getA2ASkill('document-intelligence');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('application/pdf');
    expect(modes).toContain('application/vnd.openxmlformats-officedocument.wordprocessingml.document');
    expect(modes).toContain('application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
    expect(modes).toContain('application/vnd.openxmlformats-officedocument.presentationml.presentation');
  });

  it('code-execution accepts text/csv and text/x-python', async () => {
    const s = await db.getA2ASkill('code-execution');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('text/csv');
    expect(modes).toContain('text/x-python');
  });

  it('voice-interaction accepts audio/* wildcard', async () => {
    const s = await db.getA2ASkill('voice-interaction');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('audio/*');
  });

  it('voice-interaction produces audio output (audio/wav)', async () => {
    const s = await db.getA2ASkill('voice-interaction');
    const out = parseJsonArray(s?.output_modes);
    expect(out).toContain('audio/wav');
  });

  it('image-generation output_modes contains only image/* types', async () => {
    const s = await db.getA2ASkill('image-generation');
    const out = parseJsonArray(s?.output_modes);
    expect(out.every(m => m.startsWith('image/'))).toBe(true);
    expect(out).toContain('image/png');
  });

  it('image-analysis accepts image/* wildcard', async () => {
    const s = await db.getA2ASkill('image-analysis');
    const modes = parseJsonArray(s?.input_modes);
    expect(modes).toContain('image/*');
  });

  it('supervisor-orchestration output_modes now includes application/json', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const out = parseJsonArray(s?.output_modes);
    expect(out).toContain('application/json');
    expect(out).toContain('text/plain'); // backward-compat preserved
  });

  it('ensemble-reasoning output_modes now includes application/json', async () => {
    const s = await db.getA2ASkill('ensemble-reasoning');
    const out = parseJsonArray(s?.output_modes);
    expect(out).toContain('application/json');
  });

  it('general-chat output_modes stays text/plain only (no mutation)', async () => {
    const s = await db.getA2ASkill('general-chat');
    const out = parseJsonArray(s?.output_modes);
    expect(out).toContain('text/plain');
    // general-chat is conversational — structured JSON output not expected
    expect(out).not.toContain('application/json');
  });

  it('M69_NEW_INPUT_MIME_TYPES are all present in general-chat input_modes', async () => {
    const s = await db.getA2ASkill('general-chat');
    const modes = new Set(parseJsonArray(s?.input_modes));
    for (const mime of M69_NEW_INPUT_MIME_TYPES) {
      expect(modes.has(mime), `general-chat must accept ${mime}`).toBe(true);
    }
  });
});

describe('[Phase 2] A2A Skills — Positive: security scopes', () => {
  it('code-execution has a2a:code-execution scope', async () => {
    const s = await db.getA2ASkill('code-execution');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:code-execution');
  });

  it('document-intelligence has a2a:document scope', async () => {
    const s = await db.getA2ASkill('document-intelligence');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:document');
  });

  it('image-analysis has a2a:image:read scope (read only)', async () => {
    const s = await db.getA2ASkill('image-analysis');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:image:read');
  });

  it('image-generation has a2a:image:write scope (mutation)', async () => {
    const s = await db.getA2ASkill('image-generation');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:image:write');
  });

  it('voice-interaction has a2a:voice scope', async () => {
    const s = await db.getA2ASkill('voice-interaction');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:voice');
  });

  it('memory-retrieval has a2a:memory:read scope', async () => {
    const s = await db.getA2ASkill('memory-retrieval');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:memory:read');
  });

  it('data-pipeline has a2a:data-pipeline scope', async () => {
    const s = await db.getA2ASkill('data-pipeline');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:data-pipeline');
  });

  it('research-synthesis has a2a:research scope', async () => {
    const s = await db.getA2ASkill('research-synthesis');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:research');
  });

  it('hypothesis-validation has a2a:science scope', async () => {
    const s = await db.getA2ASkill('hypothesis-validation');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:science');
  });

  it('computer-use has a2a:computer-use scope', async () => {
    const s = await db.getA2ASkill('computer-use');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:computer-use');
  });

  it('browser-automation has a2a:browser scope', async () => {
    const s = await db.getA2ASkill('browser-automation');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:browser');
  });

  it('workflow-orchestration has a2a:workflow scope', async () => {
    const s = await db.getA2ASkill('workflow-orchestration');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:workflow');
  });

  it('all 15 skills have at least one security scope', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const scopes = parseJsonArray(s.security_scopes);
      expect(scopes.length, `${s.id} must have ≥1 security scope`).toBeGreaterThan(0);
    }
  });
});

describe('[Phase 2] A2A Skills — Positive: agent_workers', () => {
  it('supervisor-orchestration now has 6 workers (3 original + 3 new)', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    expect(workers.length).toBeGreaterThanOrEqual(6);
  });

  it('supervisor-orchestration includes computer_use_worker', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('computer_use_worker');
  });

  it('supervisor-orchestration includes document_worker', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('document_worker');
  });

  it('supervisor-orchestration includes image_worker', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('image_worker');
  });

  it('supervisor-orchestration retains original 3 workers after m69', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('code_executor');
    expect(names).toContain('analyst');
    expect(names).toContain('researcher');
  });

  it('data-pipeline has code_executor, data_validator, analyst workers', async () => {
    const s = await db.getA2ASkill('data-pipeline');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('code_executor');
    expect(names).toContain('data_validator');
    expect(names).toContain('analyst');
  });

  it('research-synthesis has researcher, analyst, writer workers', async () => {
    const s = await db.getA2ASkill('research-synthesis');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('researcher');
    expect(names).toContain('analyst');
    expect(names).toContain('writer');
  });

  it('hypothesis-validation has statistician, domain_expert, critic workers', async () => {
    const s = await db.getA2ASkill('hypothesis-validation');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('statistician');
    expect(names).toContain('domain_expert');
    expect(names).toContain('critic');
  });

  it('workflow-orchestration has orchestrator and executor workers', async () => {
    const s = await db.getA2ASkill('workflow-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const names = workers.map(w => w.name);
    expect(names).toContain('orchestrator');
    expect(names).toContain('executor');
  });

  it('every worker has required fields: name, description, tools, persona', async () => {
    const all = await db.listA2ASkills();
    for (const skill of all) {
      const workers = parseWorkers(skill.agent_workers);
      for (const w of workers) {
        expect(typeof w.name, `${skill.id} worker name must be string`).toBe('string');
        expect(typeof w.description, `${skill.id} worker description must be string`).toBe('string');
        expect(Array.isArray(w.tools), `${skill.id} worker tools must be array`).toBe(true);
        expect(typeof w.persona, `${skill.id} worker persona must be string`).toBe('string');
      }
    }
  });

  it('SUPERVISOR_V2_WORKERS catalog matches the 3 workers added to supervisor-orchestration', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const addedWorkers = workers.filter(w =>
      SUPERVISOR_V2_WORKERS.some(sv => sv.name === w.name),
    );
    expect(addedWorkers).toHaveLength(SUPERVISOR_V2_WORKERS.length);
  });
});

describe('[Phase 2] A2A Skills — Positive: required_permission', () => {
  it('code-execution required_permission is null (open to all authenticated users)', async () => {
    const s = await db.getA2ASkill('code-execution');
    expect(s?.required_permission).toBeNull();
  });

  it('memory-retrieval required_permission is null', async () => {
    const s = await db.getA2ASkill('memory-retrieval');
    expect(s?.required_permission).toBeNull();
  });

  it('document-intelligence required_permission is null', async () => {
    const s = await db.getA2ASkill('document-intelligence');
    expect(s?.required_permission).toBeNull();
  });

  it('computer-use required_permission is computer_use:execute', async () => {
    const s = await db.getA2ASkill('computer-use');
    expect(s?.required_permission).toBe('computer_use:execute');
  });

  it('browser-automation required_permission is browser:execute', async () => {
    const s = await db.getA2ASkill('browser-automation');
    expect(s?.required_permission).toBe('browser:execute');
  });

  it('image-generation required_permission is image_gen:create', async () => {
    const s = await db.getA2ASkill('image-generation');
    expect(s?.required_permission).toBe('image_gen:create');
  });

  it('data-pipeline required_permission is agents:delegate', async () => {
    const s = await db.getA2ASkill('data-pipeline');
    expect(s?.required_permission).toBe('agents:delegate');
  });

  it('workflow-orchestration required_permission is workflows:execute', async () => {
    const s = await db.getA2ASkill('workflow-orchestration');
    expect(s?.required_permission).toBe('workflows:execute');
  });
});

describe('[Phase 2] A2A Skills — Positive: sort_order', () => {
  it('all sort_orders are unique', async () => {
    const all = await db.listA2ASkills();
    const orders = all.map(s => s.sort_order);
    const unique = new Set(orders);
    expect(unique.size).toBe(all.length);
  });

  it('new skills have sort_order ≥ 10 (existing skills keep 0-2)', async () => {
    for (const skill of A2A_NEW_SKILLS_V2) {
      const s = await db.getA2ASkill(skill.id);
      expect(s?.sort_order, `${skill.id} sort_order must be ≥10`).toBeGreaterThanOrEqual(10);
    }
  });

  it('listA2ASkills() returns skills in sort_order ASC', async () => {
    const all = await db.listA2ASkills();
    for (let i = 1; i < all.length; i++) {
      expect(all[i]!.sort_order).toBeGreaterThanOrEqual(all[i - 1]!.sort_order);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// NEGATIVE TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Phase 2] A2A Skills — Negative: disabled skills', () => {
  it('computer-use is disabled (enabled=0): requires CUA infra', async () => {
    const s = await db.getA2ASkill('computer-use');
    expect(s?.enabled).toBe(0);
  });

  it('browser-automation is disabled (enabled=0): requires Playwright', async () => {
    const s = await db.getA2ASkill('browser-automation');
    expect(s?.enabled).toBe(0);
  });

  it('image-generation is disabled (enabled=0): no gen model configured', async () => {
    const s = await db.getA2ASkill('image-generation');
    expect(s?.enabled).toBe(0);
  });

  it('listEnabledA2ASkills() excludes the 3 disabled skills', async () => {
    const enabled = await db.listEnabledA2ASkills();
    const ids = enabled.map(s => s.id);
    expect(ids).not.toContain('computer-use');
    expect(ids).not.toContain('browser-automation');
    expect(ids).not.toContain('image-generation');
  });

  it('listEnabledA2ASkills() returns exactly 12 enabled skills (15 - 3 disabled)', async () => {
    const enabled = await db.listEnabledA2ASkills();
    expect(enabled).toHaveLength(12);
  });

  it('all disabled skills have a non-null required_permission', async () => {
    const all = await db.listA2ASkills();
    const disabled = all.filter(s => s.enabled === 0);
    expect(disabled).toHaveLength(3);
    for (const s of disabled) {
      expect(
        s.required_permission,
        `disabled skill ${s.id} must have required_permission`,
      ).not.toBeNull();
    }
  });

  it('getA2ASkill() on unknown ID returns null (no error)', async () => {
    const s = await db.getA2ASkill('non-existent-skill-id');
    expect(s).toBeNull();
  });
});

describe('[Phase 2] A2A Skills — Negative: duplicate and constraint violations', () => {
  it('duplicate INSERT on existing skill ID throws (UNIQUE constraint)', async () => {
    const freshDb = await newA2ASkillsDb();
    await expect(
      freshDb.createA2ASkill({
        id: 'code-execution',
        name: 'Duplicate Code Execution',
        description: 'This should not be inserted',
        tags: null, examples: null, input_modes: null,
        output_modes: null,
        security_scopes: '["a2a:chat"]',
        mode: 'agent',
        required_permission: null,
        sort_order: 999,
        enabled: 1,
        agent_tools: null, agent_workers: null,
      }),
    ).rejects.toThrow();
  });

  it('all skills have non-empty id, name, description', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      expect(s.id.length, `${s.id}: id must be non-empty`).toBeGreaterThan(0);
      expect(s.name.length, `${s.id}: name must be non-empty`).toBeGreaterThan(0);
      expect(s.description.length, `${s.id}: description must be non-empty`).toBeGreaterThan(0);
    }
  });

  it('all skills have a valid mode (agent|supervisor|ensemble)', async () => {
    const VALID_MODES = new Set(['agent', 'supervisor', 'ensemble']);
    const all = await db.listA2ASkills();
    for (const s of all) {
      expect(VALID_MODES.has(s.mode), `${s.id} mode '${s.mode}' must be valid`).toBe(true);
    }
  });

  it('sort_order 999 (hypothetical new skill) would not conflict with existing 0-21 range', async () => {
    const all = await db.listA2ASkills();
    const orders = all.map(s => s.sort_order);
    expect(orders).not.toContain(999);
  });

  it('agent_workers for agent-mode skills is null (workers not applicable)', async () => {
    const agentSkills = ['memory-retrieval', 'image-analysis', 'voice-interaction'];
    for (const id of agentSkills) {
      const s = await db.getA2ASkill(id);
      // agent_workers null means "use default agent flow" — no delegation
      // (Some agent skills DO have agent_tools but not agent_workers)
      const workers = parseWorkers(s?.agent_workers);
      expect(
        workers.length,
        `${id} (agent mode) should not have multi-worker topology`,
      ).toBe(0);
    }
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// SECURITY TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Phase 2] A2A Skills — Security: SQL injection', () => {
  it('SQL injection in skill ID returns null safely', async () => {
    const injections = [
      "'; DROP TABLE a2a_skills; --",
      "' OR '1'='1",
      '1; SELECT * FROM a2a_skills',
      "code-execution' UNION SELECT id,'','','','','','','',0,0,0,'','' FROM a2a_skills--",
      '\x00\x01\x02',
    ];
    for (const payload of injections) {
      const result = await db.getA2ASkill(payload);
      expect(result, `SQL injection "${payload}" should return null`).toBeNull();
    }
  });

  it('a2a_skills table still intact after injection attempts', async () => {
    const all = await db.listA2ASkills();
    expect(all).toHaveLength(15);
  });

  it('security_scopes never contain empty string', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const scopes = parseJsonArray(s.security_scopes);
      for (const scope of scopes) {
        expect(scope.trim().length, `${s.id} scope must not be empty`).toBeGreaterThan(0);
      }
    }
  });

  it('security_scopes follow a2a: namespace convention', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const scopes = parseJsonArray(s.security_scopes);
      for (const scope of scopes) {
        expect(
          scope.startsWith('a2a:') || scope.startsWith('agents:'),
          `${s.id} scope '${scope}' must use a2a: or agents: namespace`,
        ).toBe(true);
      }
    }
  });

  it('input_modes do not include dangerous executable MIME types', async () => {
    const DANGEROUS_MIME_TYPES = [
      'application/x-msdownload',
      'application/x-executable',
      'application/x-dosexec',
      'application/x-msdos-program',
      'application/x-sh',
      'application/x-bat',
    ];
    const all = await db.listA2ASkills();
    for (const s of all) {
      const modes = parseJsonArray(s.input_modes);
      for (const dangerous of DANGEROUS_MIME_TYPES) {
        expect(
          modes.includes(dangerous),
          `${s.id} must not accept ${dangerous}`,
        ).toBe(false);
      }
    }
  });

  it('image-analysis only reads images (no write scope)', async () => {
    const s = await db.getA2ASkill('image-analysis');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).not.toContain('a2a:image:write');
    expect(scopes).toContain('a2a:image:read');
  });

  it('image-generation requires write scope (controlled mutation)', async () => {
    const s = await db.getA2ASkill('image-generation');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:image:write');
    expect(scopes).not.toContain('a2a:image:read'); // write implies generation, not analysis
  });

  it('required_permission for high-risk skills is always set', async () => {
    const HIGH_RISK = ['computer-use', 'browser-automation', 'image-generation', 'workflow-orchestration'];
    for (const id of HIGH_RISK) {
      const s = await db.getA2ASkill(id);
      expect(
        s?.required_permission,
        `${id} is high-risk and must have required_permission`,
      ).not.toBeNull();
    }
  });

  it('agent_workers JSON is parseable as an array (no injection in stored JSON)', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      if (!s.agent_workers) continue;
      expect(() => JSON.parse(s.agent_workers!)).not.toThrow();
      const parsed = JSON.parse(s.agent_workers!);
      expect(Array.isArray(parsed)).toBe(true);
    }
  });

  it('all JSON fields are valid JSON (not raw strings)', async () => {
    const all = await db.listA2ASkills();
    const jsonFields = ['tags', 'examples', 'input_modes', 'output_modes', 'security_scopes'] as const;
    for (const s of all) {
      for (const field of jsonFields) {
        const raw = s[field];
        if (!raw) continue;
        expect(
          () => JSON.parse(raw),
          `${s.id}.${field} must be valid JSON`,
        ).not.toThrow();
        const parsed = JSON.parse(raw);
        expect(Array.isArray(parsed), `${s.id}.${field} must be a JSON array`).toBe(true);
      }
    }
  });

  it('memory-retrieval scope is read-only (a2a:memory:read, not write)', async () => {
    const s = await db.getA2ASkill('memory-retrieval');
    const scopes = parseJsonArray(s?.security_scopes);
    expect(scopes).toContain('a2a:memory:read');
    expect(scopes).not.toContain('a2a:memory:write');
  });
});

// ═══════════════════════════════════════════════════════════════════════════════
// STRESS TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Phase 2] A2A Skills — Stress: throughput and coverage', () => {
  it('1000× getA2ASkill() on varied IDs completes within 2s', async () => {
    const ids = A2A_SKILL_CATALOG.map(s => s.id);
    const start = Date.now();
    for (let i = 0; i < 1000; i++) {
      await db.getA2ASkill(ids[i % ids.length]!);
    }
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2000);
  });

  it('500× listAl2ASkills() returns 15 skills each time', async () => {
    for (let i = 0; i < 500; i++) {
      const all = await db.listA2ASkills();
      expect(all).toHaveLength(15);
    }
  });

  it('500× listEnabledA2ASkills() returns 12 enabled skills each time', async () => {
    for (let i = 0; i < 500; i++) {
      const enabled = await db.listEnabledA2ASkills();
      expect(enabled).toHaveLength(12);
    }
  });

  it('concurrent getA2ASkill() calls resolve correctly (no race condition)', async () => {
    const ids = A2A_SKILL_CATALOG.map(s => s.id);
    const results = await Promise.all(
      Array.from({ length: 100 }, (_, i) => db.getA2ASkill(ids[i % ids.length]!)),
    );
    expect(results.filter(r => r !== null)).toHaveLength(100);
  });

  it('all 15 skills have at least 1 example prompt', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const examples = parseJsonArray(s.examples);
      expect(examples.length, `${s.id} must have ≥1 example`).toBeGreaterThan(0);
    }
  });

  it('all 15 skills have at least 1 tag', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const tags = parseJsonArray(s.tags);
      expect(tags.length, `${s.id} must have ≥1 tag`).toBeGreaterThan(0);
    }
  });

  it('all 15 skills have at least 1 input_mode', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const modes = parseJsonArray(s.input_modes);
      expect(modes.length, `${s.id} must accept ≥1 input mode`).toBeGreaterThan(0);
    }
  });

  it('all 15 skills have at least 1 output_mode', async () => {
    const all = await db.listA2ASkills();
    for (const s of all) {
      const modes = parseJsonArray(s.output_modes);
      expect(modes.length, `${s.id} must produce ≥1 output mode`).toBeGreaterThan(0);
    }
  });

  it('catalog coverage: every catalog entry has a DB row (no orphan)', async () => {
    const dbIds = new Set((await db.listA2ASkills()).map(s => s.id));
    for (const skill of A2A_SKILL_CATALOG) {
      expect(dbIds.has(skill.id), `catalog entry ${skill.id} must be in DB`).toBe(true);
    }
    expect(dbIds.size).toBe(A2A_SKILL_CATALOG.length);
  });

  it('all supervisor-mode skills have agent_workers defined', async () => {
    const all = await db.listA2ASkills();
    const supervisors = all.filter(s => s.mode === 'supervisor');
    for (const s of supervisors) {
      const workers = parseWorkers(s.agent_workers);
      expect(
        workers.length,
        `${s.id} (supervisor) must have ≥1 worker defined`,
      ).toBeGreaterThan(0);
    }
  });

  it('hypothesis-validation (ensemble with workers) has agent_workers defined', async () => {
    // hypothesis-validation explicitly defines 3 judge workers; ensemble-reasoning
    // uses the platform default ensemble flow (agent_workers=null is intentional).
    const s = await db.getA2ASkill('hypothesis-validation');
    const workers = parseWorkers(s?.agent_workers);
    expect(workers.length).toBeGreaterThanOrEqual(3);
  });

  it('ensemble-reasoning agent_workers is null (uses default ensemble flow)', async () => {
    const s = await db.getA2ASkill('ensemble-reasoning');
    // Intentional: ensemble-reasoning relies on the platform's default ensemble
    // routing rather than a fixed worker topology — agent_workers stays null.
    expect(parseWorkers(s?.agent_workers)).toHaveLength(0);
  });

  it('m69 migration is idempotent: running db.initialize() on existing DB does not duplicate skills', async () => {
    // Re-initialize same DB (simulates server restart with migrations re-applied)
    await db.initialize();
    const all = await db.listA2ASkills();
    expect(all).toHaveLength(15);
  });

  // Spins up 15 fresh DBs (each runs full migrations) in parallel — ~5 s of real work
  // that has no headroom against the default 5 s timeout when the suite runs under load.
  // Give it an explicit generous ceiling so it stays a data-integrity check, not a race.
  it('DB correctly handles 15 parallel INITs without data corruption', async () => {
    const dbs = await Promise.all(Array.from({ length: 15 }, () => newA2ASkillsDb()));
    for (const freshDb of dbs) {
      const all = await freshDb.listA2ASkills();
      expect(all).toHaveLength(15);
    }
  }, 30000);
});

// ═══════════════════════════════════════════════════════════════════════════════
// EXAMPLE / INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════════════

describe('[Phase 2] A2A Skills — Examples: real-world use case validation', () => {
  it('A2A agent card query: Python CSV analysis → routes to code-execution', async () => {
    // Simulates an A2A client picking the right skill for "run Python on this CSV"
    const enabled = await db.listEnabledA2ASkills();
    const cseSkill = enabled.find(s => s.id === 'code-execution');
    expect(cseSkill).toBeDefined();
    expect(cseSkill?.mode).toBe('agent');
    const inputs = parseJsonArray(cseSkill?.input_modes);
    expect(inputs).toContain('text/csv');
  });

  it('A2A agent card query: PDF contract review → document-intelligence is available', async () => {
    const enabled = await db.listEnabledA2ASkills();
    const docSkill = enabled.find(s => s.id === 'document-intelligence');
    expect(docSkill).toBeDefined();
    const inputs = parseJsonArray(docSkill?.input_modes);
    expect(inputs).toContain('application/pdf');
  });

  it('A2A agent card query: statistical hypothesis test → hypothesis-validation is enabled', async () => {
    const enabled = await db.listEnabledA2ASkills();
    const hvSkill = enabled.find(s => s.id === 'hypothesis-validation');
    expect(hvSkill).toBeDefined();
    expect(hvSkill?.mode).toBe('ensemble');
    const inputs = parseJsonArray(hvSkill?.input_modes);
    expect(inputs).toContain('text/csv'); // for dataset input
  });

  it('A2A agent card query: voice transcription → voice-interaction is available', async () => {
    const enabled = await db.listEnabledA2ASkills();
    const voiceSkill = enabled.find(s => s.id === 'voice-interaction');
    expect(voiceSkill).toBeDefined();
    const inputs = parseJsonArray(voiceSkill?.input_modes);
    expect(inputs).toContain('audio/wav');
    const outputs = parseJsonArray(voiceSkill?.output_modes);
    expect(outputs).toContain('text/plain');
  });

  it('A2A agent card: computer-use NOT in enabled list (infra not ready)', async () => {
    const enabled = await db.listEnabledA2ASkills();
    expect(enabled.find(s => s.id === 'computer-use')).toBeUndefined();
  });

  it('supervisor-orchestration code_executor worker has CSE tools wired', async () => {
    const s = await db.getA2ASkill('supervisor-orchestration');
    const workers = parseWorkers(s?.agent_workers);
    const cseWorker = workers.find(w => w.name === 'code_executor');
    expect(cseWorker).toBeDefined();
    expect(cseWorker?.tools).toContain('cse_run_code');
    expect(cseWorker?.tools).toContain('cse_run_data_analysis');
  });

  it('research-synthesis researcher worker has web_search tool', async () => {
    const s = await db.getA2ASkill('research-synthesis');
    const workers = parseWorkers(s?.agent_workers);
    const researcher = workers.find(w => w.name === 'researcher');
    expect(researcher).toBeDefined();
    expect(researcher?.tools).toContain('web_search');
    expect(researcher?.tools).toContain('memory_recall');
  });

  it('hypothesis-validation statistician worker has cse_run_code for computations', async () => {
    const s = await db.getA2ASkill('hypothesis-validation');
    const workers = parseWorkers(s?.agent_workers);
    const stat = workers.find(w => w.name === 'statistician');
    expect(stat).toBeDefined();
    expect(stat?.tools).toContain('cse_run_code');
    expect(stat?.tools).toContain('calculator');
  });

  it('data-pipeline data_validator worker validates schema conformance', async () => {
    const s = await db.getA2ASkill('data-pipeline');
    const workers = parseWorkers(s?.agent_workers);
    const validator = workers.find(w => w.name === 'data_validator');
    expect(validator).toBeDefined();
    expect(validator?.description).toContain('schema');
  });

  it('A2A_NEW_SKILLS_V2 has exactly 12 entries', () => {
    expect(A2A_NEW_SKILLS_V2).toHaveLength(12);
  });

  it('A2A_SKILL_CATALOG has exactly 15 entries', () => {
    expect(A2A_SKILL_CATALOG).toHaveLength(15);
  });

  it('catalog skill IDs are globally unique', () => {
    const ids = A2A_SKILL_CATALOG.map(s => s.id);
    const unique = new Set(ids);
    expect(unique.size).toBe(ids.length);
  });

  it('catalog sort_orders are monotonically increasing', () => {
    const orders = A2A_SKILL_CATALOG.map(s => s.sort_order);
    for (let i = 1; i < orders.length; i++) {
      expect(orders[i]).toBeGreaterThan(orders[i - 1]!);
    }
  });

  it('enabled skills all have text/plain in input_modes (universal compat)', async () => {
    const enabled = await db.listEnabledA2ASkills();
    for (const s of enabled) {
      const modes = parseJsonArray(s.input_modes);
      expect(
        modes.includes('text/plain'),
        `${s.id} must accept text/plain for universal A2A compat`,
      ).toBe(true);
    }
  });

  it('enabled skills all produce text/plain in output_modes (universal compat)', async () => {
    const enabled = await db.listEnabledA2ASkills();
    for (const s of enabled) {
      const modes = parseJsonArray(s.output_modes);
      // Image-generation is disabled so this applies to all enabled skills
      expect(
        modes.includes('text/plain'),
        `${s.id} must produce text/plain for universal A2A compat`,
      ).toBe(true);
    }
  });
});
