import type BetterSqlite3 from 'better-sqlite3';
import { safeExec } from './helpers.js';

/**
 * m128 — weaveNotes Phase 2: image licence/provenance "Content Credentials".
 *
 * One Builder dial: embed licence + provenance metadata with every AI/web image — where a web image
 * came from (licence, author, source) or, for an AI image, the generator + prompt. Embedded directly
 * in SVG illustration bytes, and stored as a manifest with raster assets. Idempotent ALTER.
 */
export function applyM128ImageProvenance(db: BetterSqlite3.Database): void {
  safeExec(db, 'ALTER TABLE weavenotes_settings ADD COLUMN image_provenance_enabled INTEGER NOT NULL DEFAULT 1');
}
