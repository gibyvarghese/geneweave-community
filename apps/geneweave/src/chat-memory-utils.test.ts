import { describe, it, expect } from 'vitest';

import { sanitizeExtractedEntities, resolveIdentityRecallFromMemory } from './chat-memory-utils.js';
import type { DatabaseAdapter } from './db.js';

function makeStubDb(opts: {
  entities?: Array<{ entity_name: string; entity_type: string }>;
  semantic?: Array<{ content: string; memory_type?: string; source?: string }>;
}): DatabaseAdapter {
  return {
    listEntities: async () => (opts.entities ?? []).map((e, i) => ({
      id: `ent-${i}`,
      user_id: 'u',
      chat_id: null,
      tenant_id: null,
      entity_name: e.entity_name,
      entity_type: e.entity_type,
      facts: '{}',
      confidence: 1,
      source: 'test',
      created_at: '',
      updated_at: '',
    })),
    listSemanticMemory: async () => (opts.semantic ?? []).map((m, i) => ({
      id: `sem-${i}`,
      user_id: 'u',
      chat_id: null,
      tenant_id: null,
      content: m.content,
      memory_type: m.memory_type ?? 'user_fact',
      source: m.source ?? 'user',
      embedding: null,
      created_at: '',
      updated_at: '',
    })),
  } as unknown as DatabaseAdapter;
}

describe('sanitizeExtractedEntities — role/title rejection', () => {
  it('drops "Solution Architect" as a person, demotes to general', () => {
    const out = sanitizeExtractedEntities([
      { name: 'Solution Architect', type: 'person', facts: {} },
      { name: 'Fonterra', type: 'organization', facts: {} },
    ]);
    const personRow = out.find((e) => e.type === 'person');
    expect(personRow, 'no person row should remain').toBeUndefined();
    const fonterra = out.find((e) => e.type === 'organization');
    expect(fonterra?.name).toBe('Fonterra');
    const generalRow = out.find((e) => e.type === 'general' && e.name === 'Solution Architect');
    expect(generalRow, 'role title should be demoted to general').toBeDefined();
  });

  it('drops "VP of Engineering" / "Backend Engineer" / "Data Scientist" / "doctor" as persons', () => {
    const cases = ['VP of Engineering', 'Backend Engineer', 'Data Scientist', 'doctor', 'a consultant', 'the manager'];
    for (const name of cases) {
      const out = sanitizeExtractedEntities([{ name, type: 'person', facts: {} }]);
      const personRow = out.find((e) => e.type === 'person');
      expect(personRow, `"${name}" should not be type=person`).toBeUndefined();
    }
  });

  it('keeps real proper-noun names like Sarah, John Smith, Mike', () => {
    const cases = ['Sarah', 'John Smith', 'Mike', 'Alice O\'Brien'];
    for (const name of cases) {
      const out = sanitizeExtractedEntities([{ name, type: 'person', facts: {} }]);
      const personRow = out.find((e) => e.type === 'person');
      expect(personRow?.name, `"${name}" should be kept as type=person`).toBe(name);
    }
  });

  it('drops role-shaped names misclassified as organization or location', () => {
    const out = sanitizeExtractedEntities([
      { name: 'Solution Architect', type: 'organization', facts: {} },
      { name: 'data scientist', type: 'location', facts: {} },
    ]);
    expect(out.length).toBe(0);
  });

  it('preserves preference/topic/general rows untouched', () => {
    const out = sanitizeExtractedEntities([
      { name: 'matcha tea', type: 'preference', facts: {} },
      { name: 'kubernetes', type: 'topic', facts: {} },
      { name: 'backend engineer', type: 'general', facts: { role: true } },
    ]);
    expect(out.map((e) => e.name).sort()).toEqual(['backend engineer', 'kubernetes', 'matcha tea']);
  });

  it('clamps over-long names and rejects non-array input', () => {
    const long = 'A'.repeat(200);
    expect(sanitizeExtractedEntities([{ name: long, type: 'person', facts: {} }]).length).toBe(0);
    expect(sanitizeExtractedEntities(null).length).toBe(0);
    expect(sanitizeExtractedEntities('not-an-array').length).toBe(0);
  });
});

describe('resolveIdentityRecallFromMemory — fallback regex on semantic memory', () => {
  const NAME_PROBES: Array<[string, string | null]> = [
    ['I am a solution architect from Fonterra',          null],
    ['I am Sarah, a data scientist from Google',         'Sarah'],
    ['I am the VP of Engineering at Snowflake',          null],
    ['I am a doctor from Sydney',                        null],
    ['I am John, a consultant',                          'John'],
    ['My name is John and I am a consultant',            'John'],
    ['Call me Mike, I am a lead designer at Figma',      'Mike'],
    ['I am a backend engineer from Acme',                null],
    ['I am John Smith from Microsoft',                   'John Smith'],
    ['I am Mary',                                        'Mary'],
    ["I'm called Bob",                                   'Bob'],
    ['My name is Alice Wong and I work at Stripe',       'Alice Wong'],
  ];

  for (const [utterance, expectedName] of NAME_PROBES) {
    it(`recall reply matches expected name for "${utterance}"`, async () => {
      const db = makeStubDb({ entities: [], semantic: [{ content: utterance }] });
      const reply = await resolveIdentityRecallFromMemory(db, 'u', 'who am i?');
      if (expectedName === null) {
        // Either null (nothing matched) or reply must NOT mention a role title
        if (reply !== null) {
          expect(reply).not.toMatch(/architect|engineer|manager|consultant|developer|designer|doctor|vp|ceo/i);
        }
      } else {
        expect(reply).not.toBeNull();
        expect(reply!).toContain(expectedName);
      }
    });
  }

  it('person entity with a role-title name is ignored as the name source', async () => {
    const db = makeStubDb({
      entities: [{ entity_name: 'Solution Architect', entity_type: 'person' }],
      semantic: [{ content: 'I am a solution architect from Fonterra' }],
    });
    const reply = await resolveIdentityRecallFromMemory(db, 'u', 'who am i?');
    if (reply !== null) {
      expect(reply).not.toContain('Solution Architect');
    }
  });

  it('real person entity is returned as the user identity', async () => {
    const db = makeStubDb({
      entities: [{ entity_name: 'Alice', entity_type: 'person' }],
      semantic: [],
    });
    const reply = await resolveIdentityRecallFromMemory(db, 'u', 'who am i?');
    expect(reply).toContain('Alice');
  });
});
