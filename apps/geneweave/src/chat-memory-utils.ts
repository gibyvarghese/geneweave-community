import { newUUIDv7, createLogger } from '@weaveintel/core';
import type { ExecutionContext, Model, ModelRequest, RuntimeMemorySlot } from '@weaveintel/core';
import { fusedMemorySearch } from '@weaveintel/memory';

const logger = createLogger('chat-memory');
import { runHybridMemoryExtraction, weaveGovernancePolicy, type ExtractedEntity, type MemoryExtractionRule, type GovernanceRule } from '@weaveintel/memory';
import type { DatabaseAdapter } from './db.js';
import { getActiveGuardrailEmbeddingModel } from './guardrail-judge.js';
import { getActiveSemanticMemoryBackend } from './memory-pgvector.js';

// Local JSON parse helper (mirrors chat.ts safeParseJson, kept internal to this module)
function safeParseJson(text: string): unknown {
  const trimmed = text.trim();
  const fenced = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/i);
  const raw = fenced?.[1] ?? trimmed;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

export async function loadExtractionRules(db: DatabaseAdapter): Promise<MemoryExtractionRule[]> {
  const rows = await db.listMemoryExtractionRules();
  return rows.map((r) => {
    let factsTemplate: Record<string, unknown> | null = null;
    try {
      factsTemplate = r.facts_template ? JSON.parse(r.facts_template) as Record<string, unknown> : null;
    } catch {
      factsTemplate = null;
    }
    return {
      id: r.id,
      ruleType: r.rule_type as MemoryExtractionRule['ruleType'],
      entityType: r.entity_type,
      pattern: r.pattern,
      flags: r.flags,
      factsTemplate,
      priority: r.priority,
      enabled: !!r.enabled,
    };
  });
}

// Role / title / profession tokens that must never be stored as a person's
// NAME. The LLM extractor sometimes returns rows like
// { name: "Solution Architect", type: "person" } for utterances like
// "I am a solution architect from Fonterra". Drop those at the sanitizer
// boundary regardless of what the model claims.
const ROLE_TITLE_TOKENS = new Set<string>([
  'architect', 'engineer', 'manager', 'consultant', 'developer', 'designer',
  'analyst', 'scientist', 'lead', 'director', 'officer', 'specialist',
  'researcher', 'doctor', 'nurse', 'teacher', 'professor', 'student',
  'intern', 'associate', 'principal', 'senior', 'junior', 'staff',
  'founder', 'partner', 'owner', 'admin', 'administrator', 'operator',
  'vp', 'ceo', 'cto', 'cfo', 'coo', 'cmo', 'cio', 'svp', 'evp',
  'devops', 'sre', 'qa', 'pm',
  'head', 'chief', 'president', 'vice',
]);

function nameLooksLikeRoleTitle(name: string): boolean {
  const lower = name.toLowerCase().trim();
  if (!lower) return true;
  // Reject leading article ("a solution architect", "the VP").
  if (/^(?:a|an|the)\s+/i.test(lower)) return true;
  // Reject names that begin with a lowercase letter — real person names are
  // proper nouns. This catches "solution architect" but not "Sarah".
  if (!/^[A-Z]/.test(name.trim())) return true;
  const tokens = lower.split(/[\s\-]+/).filter(Boolean);
  return tokens.some((t) => ROLE_TITLE_TOKENS.has(t));
}

export function sanitizeExtractedEntities(raw: unknown): Array<{ name: string; type: string; facts: Record<string, unknown> }> {
  if (!Array.isArray(raw)) return [];
  const allowedTypes = new Set(['person', 'location', 'organization', 'preference', 'topic', 'general']);
  const out: Array<{ name: string; type: string; facts: Record<string, unknown> }> = [];
  for (const item of raw.slice(0, 8)) {
    if (!item || typeof item !== 'object') continue;
    const row = item as { name?: unknown; type?: unknown; facts?: unknown };
    const name = typeof row.name === 'string' ? row.name.trim() : '';
    if (!name || name.length > 120) continue;
    const typeRaw = typeof row.type === 'string' ? row.type.toLowerCase().trim() : 'general';
    let type = allowedTypes.has(typeRaw) ? typeRaw : 'general';
    // Reclassify obvious role-title rows that came back as person/organization/location.
    // "Solution Architect" is a role, not a person; demote to topic so it's still
    // remembered as a fact about the user without polluting identity recall.
    if ((type === 'person' || type === 'organization' || type === 'location') && nameLooksLikeRoleTitle(name)) {
      if (type === 'person') type = 'general';
      else continue; // drop a role-shaped name claiming to be an org/location
    }
    const facts = (row.facts && typeof row.facts === 'object' && !Array.isArray(row.facts))
      ? (row.facts as Record<string, unknown>)
      : {};
    out.push({ name, type, facts });
  }
  return out;
}

export async function extractEntitiesWithModel(
  ctx: ExecutionContext,
  model: Model,
  userContent: string,
  assistantContent: string,
): Promise<ExtractedEntity[]> {
  const request: ModelRequest = {
    messages: [
      {
        role: 'system',
        content: [
          'You extract durable user profile entities from a conversation turn.',
          'Think carefully about stable facts, but output JSON only.',
          'Return a JSON array, each item as: {"name": string, "type": "person|location|organization|preference|topic|general", "facts": object}.',
          'IMPORTANT distinctions:',
          '- type=person is ONLY for a real human NAME (a proper noun like "Alice", "John Smith"). NEVER use type=person for job titles, roles, or professions.',
          '- Job titles, roles, and professions (e.g. "solution architect", "VP of Engineering", "data scientist", "doctor", "consultant", "backend engineer") are NOT names. If you want to remember them, use type=topic or type=general — never type=person.',
          '- type=organization is for companies / institutions / teams (proper-noun org names like "Fonterra", "Google"). Not for job titles.',
          '- A self-introduction "I am a <role> from <company>" discloses an organization and an occupation, but does NOT disclose the user\'s personal name. Do not invent one.',
          'Only include entities that are explicitly stated or strongly implied by the user.',
          'Do not include temporary tasks or speculative details.',
          'If nothing durable is present, return [].',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `User message: ${userContent}`,
          `Assistant response: ${assistantContent.slice(0, 600)}`,
          'Return JSON array only.',
        ].join('\n\n'),
      },
    ],
    maxTokens: 500,
    temperature: 0,
  };
  const res = await model.generate(ctx, request);
  const parsed = safeParseJson(res.content);
  return sanitizeExtractedEntities(parsed).map((e) => ({
    ...e,
    confidence: 0.78,
    source: 'llm' as const,
  }));
}

export async function classifyIdentityRecallIntent(
  ctx: ExecutionContext,
  model: Model,
  query: string,
): Promise<boolean> {
  const regexSignal = /\b(name|who\s+am\s+i|who\s+i\s+am|what\s+am\s+i\s+called|what'?s\s+my\s+name|remember\s+my\s+name|do\s+you\s+know\s+who\s+i\s+am)\b/i.test(query);
  if (regexSignal) return true;

  // Avoid model classification for long prompts where identity intent is unlikely.
  if (query.length > 180) return false;

  try {
    const request: ModelRequest = {
      messages: [
        {
          role: 'system',
          content: [
            'Classify whether the user is asking the assistant to recall who the user is based on prior memory.',
            'Return ONLY one token: YES or NO.',
            'Use YES for questions about identity, name, personal profile, or remembered user details from prior chats.',
          ].join('\n'),
        },
        {
          role: 'user',
          content: query,
        },
      ],
      maxTokens: 3,
      temperature: 0,
    };
    const res = await model.generate(ctx, request);
    return /^\s*yes\b/i.test(res.content);
  } catch {
    return false;
  }
}

export function isIdentityRecallQuery(query: string): boolean {
  return /\b(do\s+you\s+know\s+who\s+i\s+am|who\s+am\s+i|who\s+i\s+am|do\s+you\s+remember\s+me|do\s+you\s+know\s+my\s+name|what(?:'|\s+)?s\s+my\s+name|remember\s+my\s+name)\b/i.test(query);
}

export async function resolveIdentityRecallFromMemory(
  db: DatabaseAdapter,
  userId: string,
  query: string,
): Promise<string | null> {
  if (!isIdentityRecallQuery(query)) return null;

  const backend = getActiveSemanticMemoryBackend();
  const [entities, semanticRows] = await Promise.all([
    db.listEntities(userId),
    backend ? backend.list(userId, 24) : db.listSemanticMemory(userId, 24),
  ]);

  let name: string | null = null;
  let location: string | null = null;

  const personEntity = entities.find((e) => e.entity_type.toLowerCase() === 'person');
  if (personEntity?.entity_name && !nameLooksLikeRoleTitle(personEntity.entity_name)) {
    name = personEntity.entity_name.trim();
  }
  const locationEntity = entities.find((e) => e.entity_type.toLowerCase() === 'location');
  if (locationEntity?.entity_name) {
    location = locationEntity.entity_name.trim();
  }

  const semanticPriority = semanticRows
    .filter((m) => m.memory_type === 'user_fact' || m.source === 'user')
    .concat(semanticRows.filter((m) => !(m.memory_type === 'user_fact' || m.source === 'user')));

  for (const m of semanticPriority) {
    if (!name) {
      // Two regexes feed a uniform `nameLooksLikeRoleTitle` post-filter that
      // rejects lowercase tokens, leading articles ("a"/"an"/"the"), and
      // role/title words. This prevents "I am a solution architect ..." from
      // yielding name="a" and "I am the VP" from yielding name="the", while
      // still capturing "I am Sarah, ..." and "My name is John ...". The
      // optional second-word capture skips conjunctions ("and"/"but") so
      // "My name is John and ..." captures "John", not "John and".
      const nm = m.content.match(/\b(?:my\s+name\s+is|i'?m\s+called|call\s+me)\s+([A-Za-z][A-Za-z\-']{1,39}(?:\s+(?!and\b|but\b|or\b)[A-Za-z][A-Za-z\-']{1,39})?)\b/i);
      if (nm?.[1] && !nameLooksLikeRoleTitle(nm[1])) {
        name = nm[1].trim();
      } else {
        const nm2 = m.content.match(/\bi\s+am\s+([A-Za-z][A-Za-z\-']{1,39}(?:\s+(?!and\b|but\b|or\b)[A-Za-z][A-Za-z\-']{1,39})?)(?=[\s,.!?]|\s+and\b|$)/i);
        if (nm2?.[1] && !nameLooksLikeRoleTitle(nm2[1])) name = nm2[1].trim();
      }
    }
    if (!location) {
      const lm = m.content.match(/\b(?:i\s+live\s+in|i'?m\s+from|i\s+am\s+from|i\s+reside\s+in)\s+([A-Za-z][A-Za-z\s\-']{1,50}?)(?=\s+(?:and|but)\b|[,.!?]|$)/i);
      if (lm?.[1]) location = lm[1].trim();
    }
    if (name && location) break;
  }

  if (name && location) {
    return `From our previous chats, you are ${name} and you live in ${location}.`;
  }
  if (name) {
    return `From our previous chats, you are ${name}.`;
  }
  if (location) {
    return `From our previous chats, I remember that you live in ${location}.`;
  }
  return null;
}

export async function buildMemoryContext(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  model: Model,
  userId: string,
  query: string,
): Promise<string | null> {
  // SQLite LIKE/GLOB pattern complexity is bounded by the length of the operand.
  // Truncate at 2000 chars before any DB search to avoid 'pattern too complex' errors
  // on very large inputs (e.g. 100K-char stress tests or document uploads).
  const queryForSearch = query.length > 2000 ? query.slice(0, 2000) : query;
  try {
    const identityQuery = await classifyIdentityRecallIntent(ctx, model, queryForSearch);
    const entityPromise = identityQuery
      ? db.listEntities(userId).then((rows) => rows.slice(0, 10))
      : db.searchEntities(userId, queryForSearch);
    // Generate a query embedding for vector-aware semantic search when available
    const embeddingModel = getActiveGuardrailEmbeddingModel();
    let queryEmbedding: number[] | undefined;
    if (embeddingModel) {
      try {
        const res = await embeddingModel.embed(ctx, { input: [query.slice(0, 2000)] });
        queryEmbedding = res.embeddings[0] as number[] | undefined;
      } catch { /* fallback to keyword search */ }
    }

    const memoryBackend = getActiveSemanticMemoryBackend();
    const semanticSearchP = memoryBackend
      ? memoryBackend.search(ctx, { userId, query: queryForSearch, limit: 5, queryEmbedding })
      : db.searchSemanticMemory({ userId, query: queryForSearch, limit: 5, queryEmbedding });
    const recentSemanticP = identityQuery
      ? (memoryBackend ? memoryBackend.list(userId, 12) : db.listSemanticMemory(userId, 12))
      : Promise.resolve([] as Array<{ content: string; memory_type: string; source: string }>);

    const [semanticMatches, entityMatches, recentSemantic] = await Promise.all([
      semanticSearchP,
      entityPromise,
      recentSemanticP,
    ]);

    const semanticForContext = semanticMatches.length > 0
      ? semanticMatches
      : (identityQuery
        ? recentSemantic.filter((m) => m.memory_type === 'user_fact' || m.source === 'user').slice(0, 5)
        : []);

    if (semanticForContext.length === 0 && entityMatches.length === 0) return null;
    const parts: string[] = ['[Long-term memory from past conversations]'];

    let inferredIdentityName: string | null = null;
    if (identityQuery) {
      const person = entityMatches.find((e) => e.entity_type.toLowerCase() === 'person');
      if (person?.entity_name) {
        inferredIdentityName = person.entity_name;
      } else {
        for (const m of semanticForContext) {
          const nameMatch = m.content.match(/\bmy\s+name\s+is\s+([A-Za-z][A-Za-z\-']{1,39})\b/i);
          if (nameMatch?.[1]) {
            inferredIdentityName = nameMatch[1];
            break;
          }
        }
      }
    }

    if (identityQuery) {
      parts.push('Identity recall request detected. Use these memories to identify the user when possible.');
      parts.push('If a name or identity fact is present below, answer directly from memory and do not claim you lack memory.');
      if (inferredIdentityName) {
        parts.push(`Most likely user name from memory: "${inferredIdentityName}".`);
      }
    }
    if (entityMatches.length > 0) {
      parts.push('Known facts about this user:');
      for (const e of entityMatches) {
        let factsObj: Record<string, unknown> = {};
        try { factsObj = JSON.parse(e.facts) as Record<string, unknown>; } catch { /* malformed row — skip facts */ }
        const factsStr = Object.entries(factsObj)
          .filter(([k]) => !k.startsWith('noted_'))
          .map(([k, v]) => `${k}: ${v}`)
          .join(', ');
        parts.push(`  • ${e.entity_type} "${e.entity_name}"${factsStr ? ' — ' + factsStr : ''}`);
      }
    }
    if (semanticForContext.length > 0) {
      parts.push('Relevant memories:');
      for (const m of semanticForContext) {
        const label = m.source === 'user' ? 'User stated' : 'Previously discussed';
        parts.push(`  • [${label}] ${m.content.slice(0, 200)}`);
      }
    }
    return parts.join('\n');
  } catch (err) {
    logger.warn('buildMemoryContext failed — skipping memory context', { err });
    return null;
  }
}

/** Convert MemoryGovernanceRow fields to the GovernanceRule expected by weaveGovernancePolicy. */
function toGovernanceRules(rows: Awaited<ReturnType<DatabaseAdapter['listMemoryGovernance']>>): GovernanceRule[] {
  return rows.map((r) => ({
    id: r.id,
    name: r.name,
    types: r.memory_types ? tryParseJson<string[]>(r.memory_types) ?? undefined : undefined,
    tenantId: r.tenant_id ?? undefined,
    blockPatterns: r.block_patterns ? tryParseJson<string[]>(r.block_patterns) ?? undefined : undefined,
    redactPatterns: r.redact_patterns ? tryParseJson<string[]>(r.redact_patterns) ?? undefined : undefined,
    maxAge: r.max_age ?? undefined,
    maxEntries: r.max_entries ?? undefined,
    enabled: r.enabled === 1,
  }));
}

function tryParseJson<T>(s: string): T | null {
  try { return JSON.parse(s) as T; } catch { return null; }
}

/**
 * Run `content` through the memory governance policy for `memType`.
 *
 * - Calls `shouldStore()` unless `redactOnly` is true (episodic turns must
 *   always be captured — only redaction is applied there).
 * - Calls `beforeStore()` to scrub any redact-pattern matches.
 *
 * Returns `{ blocked: true }` when a block rule matched, or
 * `{ blocked: false, content: redactedContent }` otherwise.
 */
export async function applyGovernanceCheck(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  content: string,
  memType: 'semantic' | 'episodic' | 'entity' | 'working' | 'procedural' | 'conversation',
  options?: { redactOnly?: boolean },
): Promise<{ blocked: boolean; content: string }> {
  const govRows = await db.listMemoryGovernance();
  const govRules = toGovernanceRules(govRows);
  const policy = weaveGovernancePolicy(govRules);
  const entry = { id: 'gov-check', type: memType as 'semantic', content, metadata: {} as Record<string, unknown>, createdAt: new Date().toISOString() };
  if (!options?.redactOnly) {
    const allowed = await policy.shouldStore(ctx, entry);
    if (!allowed) return { blocked: true, content };
  }
  const redacted = policy.beforeStore
    ? (await policy.beforeStore(ctx, entry)).content
    : content;
  return { blocked: false, content: redacted };
}

/** Parse ISO 8601 duration (e.g. P180D) to milliseconds. Returns undefined if unparseable. */
function parseIsoDurationMs(duration: string | undefined): number | undefined {
  if (!duration) return undefined;
  const match = /P(?:(\d+)Y)?(?:(\d+)M)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?/.exec(duration);
  if (!match) return undefined;
  const years = Number(match[1] ?? 0);
  const months = Number(match[2] ?? 0);
  const days = Number(match[3] ?? 0);
  const hours = Number(match[4] ?? 0);
  const minutes = Number(match[5] ?? 0);
  const seconds = Number(match[6] ?? 0);
  return (
    years * 365.25 * 24 * 3600 * 1000 +
    months * 30.437 * 24 * 3600 * 1000 +
    days * 24 * 3600 * 1000 +
    hours * 3600 * 1000 +
    minutes * 60 * 1000 +
    seconds * 1000
  );
}

export async function saveToMemory(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  model: Model,
  userId: string,
  chatId: string,
  userContent: string,
  assistantContent: string,
  tenantId?: string,
): Promise<void> {
  const memBackend = getActiveSemanticMemoryBackend();

  // ── Load settings, extraction rules and governance policy ───────────────
  const [settings, rules, govRows] = await Promise.all([
    db.getMemorySettings(tenantId),
    loadExtractionRules(db),
    db.listMemoryGovernance(),
  ]);

  // Short-circuit if all extraction is disabled for this tenant
  if (settings && !settings.auto_extract_on_turn) return;

  const govRules = toGovernanceRules(govRows);
  const policy = weaveGovernancePolicy(govRules);

  // ── Save episodic events (raw turn log) ──────────────────────────────────
  if (!settings || settings.enable_episodic) {
    try {
      if (userContent.length > 2) {
        // Redact PII/secrets before persisting — never block episodic turns
        const rawUser = userContent.slice(0, 1200);
        const userEntry = { id: 'ep', type: 'episodic' as const, content: rawUser, metadata: {} as Record<string, unknown>, createdAt: new Date().toISOString() };
        const redactedUser = policy.beforeStore ? (await policy.beforeStore(ctx, userEntry)).content : rawUser;
        await db.saveEpisodicMemory({
          id: newUUIDv7(),
          userId,
          chatId,
          tenantId,
          messageRole: 'user',
          content: redactedUser,
          importance: 0.5,
          tags: ['turn'],
        });
      }
      if (assistantContent.length > 10) {
        const rawAssistant = assistantContent.slice(0, 1200);
        const assistantEntry = { id: 'ep', type: 'episodic' as const, content: rawAssistant, metadata: {} as Record<string, unknown>, createdAt: new Date().toISOString() };
        const redactedAssistant = policy.beforeStore ? (await policy.beforeStore(ctx, assistantEntry)).content : rawAssistant;
        await db.saveEpisodicMemory({
          id: newUUIDv7(),
          userId,
          chatId,
          tenantId,
          messageRole: 'assistant',
          content: redactedAssistant,
          importance: 0.4,
          tags: ['turn'],
        });
      }
      // Enforce episodic retention cap
      const maxEpisodic = settings?.max_episodic_per_user ?? 200;
      await db.trimEpisodicMemoryForUser(userId, maxEpisodic);
    } catch { /* episodic save is non-critical */ }
  }

  // Skip entity + semantic extraction if disabled
  if (settings && (!settings.enable_semantic && !settings.enable_entity)) {
    return;
  }

  const extraction = await runHybridMemoryExtraction({
    ctx,
    input: { userContent, assistantContent },
    rules,
    llmExtractor: async (innerCtx, input) =>
      extractEntitiesWithModel(innerCtx, model, input.userContent, input.assistantContent ?? ''),
  });

  // ── Embedding model — optional, may not be configured ───────────────────
  const embeddingModel = getActiveGuardrailEmbeddingModel();

  async function genEmbedding(text: string): Promise<number[] | undefined> {
    if (!embeddingModel) return undefined;
    try {
      const res = await embeddingModel.embed(ctx, { input: [text.slice(0, 2000)] });
      return res.embeddings[0] as number[] | undefined;
    } catch {
      return undefined;
    }
  }

  // ── Save semantic memories with governance gating ────────────────────────
  if (!settings || settings.enable_semantic) {
    if (extraction.selfDisclosure && userContent.length > 5) {
      const rawContent = userContent.slice(0, 600);
      const entryId = newUUIDv7();
      const govEntry = { id: entryId, type: 'semantic' as const, content: rawContent, metadata: {}, createdAt: new Date().toISOString(), userId };
      const allowed = await policy.shouldStore(ctx, govEntry);
      if (allowed) {
        const finalContent = policy.beforeStore
          ? (await policy.beforeStore(ctx, govEntry)).content
          : rawContent;
        const embedding = await genEmbedding(finalContent);
        const saveOpts = { id: entryId, userId, chatId, content: finalContent, memoryType: 'user_fact', source: 'user', embedding };
        await (memBackend ? memBackend.save(ctx, saveOpts) : db.saveSemanticMemory(saveOpts));
      }
    }
    if (assistantContent.length > 100) {
      const rawContent = assistantContent.slice(0, 600);
      const entryId = newUUIDv7();
      const govEntry = { id: entryId, type: 'episodic' as const, content: rawContent, metadata: {}, createdAt: new Date().toISOString(), userId };
      const allowed = await policy.shouldStore(ctx, govEntry);
      if (allowed) {
        const finalContent = policy.beforeStore
          ? (await policy.beforeStore(ctx, govEntry)).content
          : rawContent;
        const embedding = await genEmbedding(finalContent);
        const saveOpts = { id: entryId, userId, chatId, content: finalContent, memoryType: 'summary', source: 'assistant', embedding };
        await (memBackend ? memBackend.save(ctx, saveOpts) : db.saveSemanticMemory(saveOpts));
      }
    }
  }

  // ── Save entity memories ─────────────────────────────────────────────────
  if (!settings || settings.enable_entity) {
    for (const e of extraction.entities) {
      // Governance block check: skip entities whose content matches block rules
      // (e.g. "No Secrets in Entity Memory" blocks api_key/password/bearer patterns;
      // "Entity PII Block" blocks SSN/credit-card patterns seeded by m37).
      const entityContent = `${e.name} ${e.type} ${JSON.stringify(e.facts ?? {})}`;
      const entityEntry = { id: 'eg', type: 'entity' as const, content: entityContent, metadata: {} as Record<string, unknown>, createdAt: new Date().toISOString() };
      const entityAllowed = await policy.shouldStore(ctx, entityEntry);
      if (!entityAllowed) continue;

      await db.upsertEntity({
        userId,
        entityName: e.name,
        entityType: e.type,
        facts: e.facts,
        confidence: e.confidence,
        source: e.source,
        chatId,
      });
    }
  }

  const regexEntitiesCount = extraction.entities.filter((e) => e.source === 'regex').length;
  const llmEntitiesCount = extraction.entities.filter((e) => e.source === 'llm').length;
  await db.recordMemoryExtractionEvent({
    id: newUUIDv7(),
    userId,
    chatId,
    selfDisclosure: extraction.selfDisclosure,
    regexEntitiesCount,
    llmEntitiesCount,
    mergedEntitiesCount: extraction.entities.length,
    events: JSON.stringify(extraction.events),
  });

  // ── Enforce retention limits (async, non-blocking on errors) ─────────────
  const retentionPolicy = policy.retentionPolicy;
  const maxSemantic = settings?.max_semantic_per_user;
  const maxEntity = settings?.max_entity_per_user;
  try {
    if (retentionPolicy?.maxEntries || maxSemantic) {
      const cap = Math.min(retentionPolicy?.maxEntries ?? Infinity, maxSemantic ?? Infinity);
      if (isFinite(cap)) {
        await db.trimSemanticMemoryForUser(userId, cap);
      }
    }
    // Entity trimming is independent of semantic cap: run whenever a per-user entity limit is set.
    if (maxEntity) {
      await db.trimEntityMemoryForUser(userId, maxEntity);
    }
    if (retentionPolicy?.maxAge) {
      const cutoffMs = parseIsoDurationMs(retentionPolicy.maxAge);
      if (cutoffMs !== undefined) {
        await db.purgeSemanticMemoryOlderThan(userId, Date.now() - cutoffMs);
      }
    }
  } catch { /* retention enforcement is best-effort */ }
}

/**
 * Load the latest working memory snapshot for a user+agent and format it for
 * system-prompt injection. Working memory is per-chat scratch state written by
 * the agent's memory_snapshot tool during multi-step tasks. Loading it at the
 * start of each turn gives the agent continuity across tool-call boundaries.
 */
export async function buildWorkingMemoryContext(
  db: DatabaseAdapter,
  userId: string,
  agentId = 'default',
): Promise<string | null> {
  try {
    const snapshot = await db.getLatestWorkingMemory(userId, agentId);
    if (!snapshot) return null;
    let parsed: unknown;
    try { parsed = JSON.parse(snapshot.content); } catch { parsed = snapshot.content; }
    const preview = JSON.stringify(parsed, null, 2).slice(0, 1200);
    return `[Working memory — agent scratch state from previous step]\nSnapshot ID: ${snapshot.id}\nSaved: ${snapshot.created_at}\n${preview}`;
  } catch (err) {
    logger.warn('buildWorkingMemoryContext failed — skipping', { err });
    return null;
  }
}

/**
 * Load applied procedural memory instruction deltas for a user+agent.
 * Returns a string to prepend to the system prompt, or null if none.
 */
export async function loadProceduralInstructions(
  db: DatabaseAdapter,
  userId: string,
  agentId = 'default',
): Promise<string | null> {
  try {
    const entries = await db.listAppliedProcedural(userId, agentId);
    if (entries.length === 0) return null;
    const deltas = entries.map((e) => `• ${e.instruction_delta}`).join('\n');
    return `[Personalised agent instructions for this user]\n${deltas}`;
  } catch (err) {
    logger.warn('loadProceduralInstructions failed — skipping', { err });
    return null;
  }
}

/**
 * Phase 5 — Multi-signal memory retrieval using `fusedMemorySearch`.
 *
 * When `runtime.memory` is present (Phase 5 wired), runs a three-signal
 * fused search (semantic + keyword + entity) over the store and formats the
 * results for system-prompt injection. Falls back gracefully to the existing
 * `buildMemoryContext` when the slot is not wired.
 *
 * Use this in place of `buildMemoryContext` when you want richer retrieval:
 *
 *   const ctx = buildCtx({ runtime });
 *   const memCtx = await buildFusedMemoryContext(db, ctx, model, userId, query, runtime.memory);
 */
export async function buildFusedMemoryContext(
  db: DatabaseAdapter,
  ctx: ExecutionContext,
  model: Model,
  userId: string,
  query: string,
  memorySlot?: RuntimeMemorySlot | null,
): Promise<string | null> {
  if (!memorySlot) {
    return buildMemoryContext(db, ctx, model, userId, query);
  }

  try {
    // Generate a query embedding when the store was created with an embedding model
    const embeddingModel = getActiveGuardrailEmbeddingModel();
    let queryEmbedding: number[] | undefined;
    if (embeddingModel) {
      try {
        const res = await embeddingModel.embed(ctx, { input: [query.slice(0, 2000)] });
        queryEmbedding = res.embeddings[0] as number[] | undefined;
      } catch { /* fall through */ }
    }

    const results = await fusedMemorySearch(memorySlot.store, ctx, {
      query,
      embedding: queryEmbedding,
      topK: 8,
      userId,
    });

    if (results.length === 0) return null;

    const parts: string[] = ['[Long-term memory from past conversations]'];
    for (const { entry, signals } of results) {
      const signalTag = [
        signals.semantic !== undefined ? 'vec' : null,
        signals.keyword !== undefined ? 'kw' : null,
        signals.entity !== undefined ? 'ent' : null,
      ].filter(Boolean).join('+');
      const label = entry.type === 'entity'
        ? `Entity "${entry.content}"`
        : entry.type === 'episodic'
          ? 'Episode'
          : 'Memory';
      parts.push(`  • [${label}${signalTag ? ' (' + signalTag + ')' : ''}] ${entry.content.slice(0, 200)}${entry.content.length > 200 ? '…' : ''}`);
    }
    return parts.join('\n');
  } catch (err) {
    logger.warn('buildFusedMemoryContext failed — falling back to buildMemoryContext', { err });
    return buildMemoryContext(db, ctx, model, userId, query);
  }
}

/**
 * Build a compact episodic context snippet for inclusion in the system prompt.
 * Returns the N most recent episodes as a brief timeline.
 */
export async function buildEpisodicContext(
  db: DatabaseAdapter,
  userId: string,
  limit = 6,
): Promise<string | null> {
  try {
    const episodes = await db.listEpisodicMemory(userId, limit * 2);
    if (episodes.length === 0) return null;
    // Take the most recent episodes up to limit
    const recent = episodes.slice(0, limit);
    const lines = recent.reverse().map((ep) => {
      const role = ep.message_role === 'user' ? 'User' : 'Assistant';
      return `  [${ep.created_at.slice(0, 16)}] ${role}: ${ep.content.slice(0, 120)}${ep.content.length > 120 ? '…' : ''}`;
    });
    return `[Recent conversation history]\n${lines.join('\n')}`;
  } catch (err) {
    logger.warn('buildEpisodicContext failed — skipping', { err });
    return null;
  }
}
