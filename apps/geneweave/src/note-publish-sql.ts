// SPDX-License-Identifier: MIT
/**
 * geneWeave note PUBLISHING — emit a note as a shareable artifact (weaveNotes Phase 4).
 *
 * Phases 1–3 made a note a co-editable, AI-assisted living document. Phase 4 lets you
 * PUBLISH it: turn the note into a typed, versioned **artifact** (Markdown or HTML) and
 * — optionally — mint a public, read-only **share link** anyone can open. It deliberately
 * reuses what already exists: the Phase 1 `blocksToMarkdown`/`blocksToHtml` serializers,
 * the artifacts store (`db.saveArtifact`), and the artifact share-token + public viewer
 * (`/share/artifacts/:token`). The NEW, Phase-4 piece is the safety layer:
 *
 *   - **Sensitivity gating** — a `restricted` note is refused outright (it can never
 *     become a public artifact); `confidential`/`normal` are allowed but…
 *   - **Redaction before publish** — the content is scrubbed for secrets (always) and,
 *     for confidential notes, PII too (the `@weaveintel/artifacts` `redactText` helper),
 *     so a stray API key or email in a note never leaks the moment it is shared.
 *
 * The same service powers the `POST /api/me/notes/:id/emit-artifact` endpoint and the
 * `note_publish` agent tool, so a human and the agent publish through one audited path.
 */
import { BlockDoc, pmToBlocks, blocksToMarkdown, blocksToHtml } from '@weaveintel/collab';
import { redactText, publishPolicyForSensitivity, type PublishSensitivity } from '@weaveintel/artifacts';
import { resolveNoteAccess, type NoteAccess } from './note-coedit-sql.js';
import { signShareToken } from './routes/artifacts.js';
import { roleAtLeast } from '@weaveintel/collab';
import type { DatabaseAdapter } from './db-types.js';

export type PublishFormat = 'markdown' | 'html';

export interface PublishResult {
  ok: boolean;
  code?: number;        // suggested HTTP status when !ok (403 refused, 404 not found, 400 bad)
  error?: string;
  artifactId?: string;
  type?: PublishFormat;
  /** How many secret/PII spans were redacted before publishing. */
  redactions?: number;
  sourceSensitivity?: PublishSensitivity;
  /** Present only when a share link was requested. */
  shareUrl?: string;
  shareToken?: string;
}

type NotePublishDb = DatabaseAdapter;

export function createNotePublishService(
  db: NotePublishDb,
  opts: { jwtSecret?: string; publicBaseUrl?: string; now?: () => number } = {},
) {
  const now = opts.now ?? (() => Date.now());
  const secret = opts.jwtSecret ?? process.env['JWT_SECRET'] ?? 'insecure-dev-secret';

  /** Render a note's CURRENT content to Markdown + HTML (via the Phase 1 block serializers). */
  async function renderNote(noteId: string, ownerId: string): Promise<{ markdown: string; html: string; title: string; sensitivity: PublishSensitivity } | null> {
    const note = await db.getNote(noteId, ownerId) as { title?: string; doc_json?: string; sensitivity?: string } | null;
    if (!note) return null;
    let pm: unknown = { type: 'doc', content: [] };
    try { pm = JSON.parse(note.doc_json ?? '') as unknown; } catch { /* keep empty */ }
    const blocks = BlockDoc.fromBlocks(`u:${ownerId}`, pmToBlocks(pm)).blocks();
    const sensitivity = (['normal', 'confidential', 'restricted'].includes(String(note.sensitivity)) ? note.sensitivity : 'normal') as PublishSensitivity;
    return { markdown: blocksToMarkdown(blocks), html: blocksToHtml(blocks), title: note.title || 'Untitled note', sensitivity };
  }

  /**
   * Publish a note as an artifact. Gates on sensitivity (restricted → refused), redacts
   * per policy, saves the artifact, and — when `share` is set — mints a public link.
   */
  async function emit(input: {
    noteId: string;
    access: NoteAccess;
    format?: PublishFormat;
    publishedBy?: 'user' | 'agent';
    share?: boolean;
    password?: string;
    expiresInDays?: number;
  }): Promise<PublishResult> {
    if (!db.saveArtifact) return { ok: false, code: 501, error: 'artifact storage not available' };
    const rendered = await renderNote(input.noteId, input.access.ownerId);
    if (!rendered) return { ok: false, code: 404, error: 'note not found' };

    // 1. Sensitivity gate.
    const policy = publishPolicyForSensitivity(rendered.sensitivity);
    if (!policy.allowed) return { ok: false, code: 403, error: policy.reason ?? 'this note cannot be published', sourceSensitivity: rendered.sensitivity };

    // 2. Tenant artifact settings (emit toggle + allowed types), when configured.
    const type: PublishFormat = input.format === 'html' ? 'html' : 'markdown';
    // Feature-detect the tenant artifact settings (present on the SQLite adapter, optional
    // on the interface) and enforce the emit toggle + allowed-types gate when configured.
    const getSettings = (db as { getEffectiveTenantArtifactSettings?: (t: string) => Promise<{ emit_enabled: number; allowed_types: string | null } | null> }).getEffectiveTenantArtifactSettings?.bind(db);
    if (input.access.tenantId && getSettings) {
      const settings = await getSettings(input.access.tenantId);
      if (settings) {
        if (settings.emit_enabled === 0) return { ok: false, code: 403, error: 'artifact emission is disabled for this tenant' };
        if (settings.allowed_types) {
          try { const allowed = JSON.parse(settings.allowed_types) as string[]; if (Array.isArray(allowed) && !allowed.includes(type)) return { ok: false, code: 403, error: `artifact type "${type}" is not permitted for this tenant` }; } catch { /* ignore */ }
        }
      }
    }

    // 3. Redact, then save the artifact.
    const raw = type === 'html' ? rendered.html : rendered.markdown;
    const redacted = redactText(raw, policy.redactionLevel);
    const mimeType = type === 'html' ? 'text/html' : 'text/markdown';
    const saved = await db.saveArtifact!({
      name: rendered.title,
      type,
      mimeType,
      data: redacted.text,
      userId: input.access.ownerId,
      ...(input.access.tenantId ? { tenantId: input.access.tenantId } : {}),
      scope: 'user',
      tags: ['note', `sensitivity:${rendered.sensitivity}`],
      metadata: {
        source: 'note',
        noteId: input.noteId,
        sourceSensitivity: rendered.sensitivity,
        redactionLevel: policy.redactionLevel,
        redactions: redacted.redactions,
        redactedKinds: redacted.kinds,
        publishedBy: input.publishedBy ?? 'user',
        publishedAt: now(),
      },
    });

    // 4. Optionally mint a public share link (reuses the artifact share token + viewer).
    let shareUrl: string | undefined;
    let shareToken: string | undefined;
    if (input.share) {
      shareToken = signShareToken(saved.id, secret, {
        ...(input.expiresInDays ? { expiresInSeconds: input.expiresInDays * 86400 } : {}),
        ...(input.password ? { password: input.password } : {}),
      });
      shareUrl = `${(opts.publicBaseUrl ?? '').replace(/\/$/, '')}/share/artifacts/${shareToken}`;
    }

    return {
      ok: true, artifactId: saved.id, type,
      redactions: redacted.redactions, sourceSensitivity: rendered.sensitivity,
      ...(shareUrl ? { shareUrl, shareToken } : {}),
    };
  }

  /**
   * The `note_publish` agent-tool entry point. Resolves the user's note access itself
   * (collaborator+; viewers refused — publishing is a write-class action), so a
   * prompt-injected agent cannot publish a note the user cannot.
   */
  async function agentPublish(args: { userId: string; noteId: string; format?: PublishFormat; share?: boolean }): Promise<PublishResult> {
    const access = await resolveNoteAccess(db, args.noteId, args.userId);
    if (!access) return { ok: false, code: 404, error: 'note not found or not accessible' };
    if (!roleAtLeast(access.role, 'collaborator')) return { ok: false, code: 403, error: 'forbidden: this note is read-only for you' };
    // Security default: the agent creates the artifact but does NOT auto-mint a PUBLIC
    // link (a prompt-injected agent must not publish your note to the open web) — a human
    // opts into public sharing via the endpoint/UI. `share` defaults to false here.
    return emit({ noteId: args.noteId, access, ...(args.format ? { format: args.format } : {}), publishedBy: 'agent', share: args.share === true });
  }

  return { emit, agentPublish };
}

export type NotePublishService = ReturnType<typeof createNotePublishService>;
