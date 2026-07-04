import { describe, it, expect, beforeEach } from 'vitest';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { newUUIDv7, weaveContext, weaveRuntime } from '@weaveintel/core';
import { createDatabaseAdapter, type DatabaseAdapter } from './db.js';
import { geneweaveGuardrailsSlot } from './guardrails-slot.js';

describe('Phase E — geneweaveGuardrailsSlot ambient guardrails', () => {
  let db: DatabaseAdapter;

  beforeEach(async () => {
    const dir = mkdtempSync(join(tmpdir(), 'phaseE-'));
    db = await createDatabaseAdapter({ type: 'sqlite', path: join(dir, 'gw.db') });
  });

  // ── DB-driven pipeline (pre-existing behaviour) ──────────────────────────

  it('checkToolCall denies when a pre-execution blocklist matches the tool args', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'block-secrets',
      description: 'Phase E test',
      type: 'blocklist',
      stage: 'pre-execution',
      config: JSON.stringify({ words: ['supersecret'] }),
      priority: 100,
      enabled: 1,
    });
    const slot = geneweaveGuardrailsSlot(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });

    const denied = await slot.checkToolCall!(ctx, { name: 'web_search' }, { query: 'supersecret data' });
    expect(denied.allow).toBe(false);
    expect(denied.reason).toBeTruthy();

    const allowed = await slot.checkToolCall!(ctx, { name: 'web_search' }, { query: 'public news' });
    expect(allowed.allow).toBe(true);
  });

  it('checkOutput denies on a post-execution blocklist match', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'block-output',
      description: 'Phase E test',
      type: 'blocklist',
      stage: 'post-execution',
      config: JSON.stringify({ words: ['classified'] }),
      priority: 100,
      enabled: 1,
    });
    const slot = geneweaveGuardrailsSlot(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });

    const denied = await slot.checkOutput!(ctx, 'this contains classified information');
    expect(denied.allow).toBe(false);

    const allowed = await slot.checkOutput!(ctx, 'this is fine');
    expect(allowed.allow).toBe(true);
  });

  it('returns allow when no enabled guardrails match the stage (graceful)', async () => {
    const slot = geneweaveGuardrailsSlot(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const r1 = await slot.checkToolCall!(ctx, { name: 'calculator' }, { expr: '1+1' });
    const r2 = await slot.checkOutput!(ctx, 'hello');
    expect(r1.allow).toBe(true);
    expect(r2.allow).toBe(true);
  });

  it('disabled guardrails are skipped', async () => {
    await db.createGuardrail({
      id: newUUIDv7(),
      name: 'disabled-rule',
      description: 'should be skipped',
      type: 'blocklist',
      stage: 'pre-execution',
      config: JSON.stringify({ words: ['anything'] }),
      priority: 100,
      enabled: 0,
    });
    const slot = geneweaveGuardrailsSlot(db);
    const ctx = weaveContext({ runtime: weaveRuntime() });
    const r = await slot.checkToolCall!(ctx, { name: 't' }, { x: 'anything' });
    expect(r.allow).toBe(true);
  });

  // ── Built-in risk gate ───────────────────────────────────────────────────

  describe('built-in risk gate', () => {
    it('blocks critical-risk action strings by default', async () => {
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const r = await slot.checkToolCall!(ctx, { name: 'db_exec' }, { sql: 'DELETE FROM users' });
      expect(r.allow).toBe(false);
      expect(r.reason).toMatch(/critical/i);
      expect(r.reason).toMatch(/db_exec/);
    });

    it('allows high-risk actions when only critical is in denyOn (default)', async () => {
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // "update" → high risk; default denyOn is ['critical'] only
      const r = await slot.checkToolCall!(ctx, { name: 'db_exec' }, { sql: 'UPDATE users SET name = ?' });
      expect(r.allow).toBe(true);
    });

    it('denyOn: ["critical", "high"] blocks high-risk modification actions', async () => {
      const slot = geneweaveGuardrailsSlot(db, { riskGate: { denyOn: ['critical', 'high'] } });
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const r = await slot.checkToolCall!(ctx, { name: 'db_exec' }, { sql: 'UPDATE users SET active = 0' });
      expect(r.allow).toBe(false);
      expect(r.reason).toMatch(/high/i);
    });

    it('exemptTools bypasses the risk gate for named tools', async () => {
      const slot = geneweaveGuardrailsSlot(db, {
        riskGate: { exemptTools: ['admin_delete'] },
      });
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // Would be critical-risk without exemption
      const r = await slot.checkToolCall!(ctx, { name: 'admin_delete' }, { target: 'DROP TABLE logs' });
      expect(r.allow).toBe(true);
    });

    it('riskGate.enabled: false disables the built-in gate entirely', async () => {
      const slot = geneweaveGuardrailsSlot(db, { riskGate: { enabled: false } });
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // Would normally be blocked as critical-risk
      const r = await slot.checkToolCall!(ctx, { name: 'db_exec' }, { sql: 'TRUNCATE TABLE events' });
      expect(r.allow).toBe(true);
    });

    it('respects schema.riskLevel when declared on the tool schema', async () => {
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // Schema declares riskLevel:'critical' — should be blocked even for a
      // "safe" arg string that wouldn't trigger the action classifier alone.
      const denied = await slot.checkToolCall!(
        ctx,
        { name: 'safe_looking_tool', riskLevel: 'critical' },
        { key: 'totally_harmless_value' },
      );
      expect(denied.allow).toBe(false);
      expect(denied.reason).toMatch(/critical/i);

      // Schema declares riskLevel:'low' — should be allowed despite a scary
      // action string (the schema is trusted over the classifier).
      const allowed = await slot.checkToolCall!(
        ctx,
        { name: 'audited_delete', riskLevel: 'low' },
        { mode: 'soft-delete' },
      );
      expect(allowed.allow).toBe(true);
    });

    it('extraRules are evaluated before built-in verb patterns', async () => {
      const slot = geneweaveGuardrailsSlot(db, {
        riskGate: {
          denyOn: ['critical'],
          extraRules: [
            { pattern: 'nuke|wipe|purge', level: 'critical', explanation: 'Domain-specific destructive term' },
          ],
        },
      });
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // "purge" matches the extra rule → critical → denied
      const denied = await slot.checkToolCall!(ctx, { name: 'cleaner' }, { action: 'purge old records' });
      expect(denied.allow).toBe(false);
      expect(denied.reason).toMatch(/critical/i);

      // "read" → low via built-in rules → allowed
      const allowed = await slot.checkToolCall!(ctx, { name: 'cleaner' }, { action: 'read old records' });
      expect(allowed.allow).toBe(true);
    });

    it('risk gate and DB pipeline are both enforced — DB deny wins even when risk passes', async () => {
      await db.createGuardrail({
        id: newUUIDv7(),
        name: 'block-internal',
        description: 'Block any reference to internal tokens',
        type: 'blocklist',
        stage: 'pre-execution',
        config: JSON.stringify({ words: ['internal_token'] }),
        priority: 100,
        enabled: 1,
      });

      // Use a low-risk action so the risk gate passes, but the blocklist fires
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const r = await slot.checkToolCall!(ctx, { name: 'search' }, { q: 'internal_token value' });
      expect(r.allow).toBe(false);
      expect(r.reason).toBeTruthy();
    });

    it('risk gate does not affect checkOutput (post-execution only uses DB pipeline)', async () => {
      const slot = geneweaveGuardrailsSlot(db, { riskGate: { denyOn: ['critical', 'high', 'medium', 'low'] } });
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // Even with aggressive denyOn, checkOutput should pass through when no DB rules match
      const r = await slot.checkOutput!(ctx, 'DELETE FROM users — here is my response about that command');
      expect(r.allow).toBe(true);
    });
  });

  // ── Phase 0 — checkInput (pre-LLM gate) ─────────────────────────────────

  describe('checkInput (Phase 0 pre-LLM gate)', () => {
    it('allows clean input when no pre-execution guardrails are configured', async () => {
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const r = await slot.checkInput!(ctx, 'What is the weather today?');
      expect(r.allow).toBe(true);
    });

    it('denies input that matches a pre-execution blocklist', async () => {
      await db.createGuardrail({
        id: newUUIDv7(),
        name: 'block-pii-input',
        description: 'Phase 0 checkInput test',
        type: 'blocklist',
        stage: 'pre-execution',
        config: JSON.stringify({ words: ['credit_card_number'] }),
        priority: 100,
        enabled: 1,
      });
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const denied = await slot.checkInput!(ctx, 'Here is my credit_card_number 4111-1111-1111-1111');
      expect(denied.allow).toBe(false);
      expect(denied.reason).toBeTruthy();
    });

    it('allows input that does not match the blocklist', async () => {
      await db.createGuardrail({
        id: newUUIDv7(),
        name: 'block-secret-input',
        description: 'Phase 0 checkInput allow test',
        type: 'blocklist',
        stage: 'pre-execution',
        config: JSON.stringify({ words: ['supersecret'] }),
        priority: 100,
        enabled: 1,
      });
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const r = await slot.checkInput!(ctx, 'Tell me about the weather in Paris');
      expect(r.allow).toBe(true);
    });

    it('is fail-open — DB error returns allow:true', async () => {
      // Close the DB to force a failure
      const fakeDb = { ...db, listGuardrails: async () => { throw new Error('db gone'); } } as any;
      const slot = geneweaveGuardrailsSlot(fakeDb);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      const r = await slot.checkInput!(ctx, 'any input');
      expect(r.allow).toBe(true);
    });

    it('post-execution guardrails do not affect checkInput', async () => {
      await db.createGuardrail({
        id: newUUIDv7(),
        name: 'post-only',
        description: 'Should not affect checkInput',
        type: 'blocklist',
        stage: 'post-execution',
        config: JSON.stringify({ words: ['blocked_word'] }),
        priority: 100,
        enabled: 1,
      });
      const slot = geneweaveGuardrailsSlot(db);
      const ctx = weaveContext({ runtime: weaveRuntime() });

      // 'blocked_word' would trigger post-execution blocklist but not pre-execution
      const r = await slot.checkInput!(ctx, 'user says blocked_word');
      expect(r.allow).toBe(true);
    });
  });
});
