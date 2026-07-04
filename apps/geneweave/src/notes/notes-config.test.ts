// SPDX-License-Identifier: MIT
// weaveNotes capability config validator — positive, negative, security, and per-surface flag cases.
import { describe, it, expect } from 'vitest';
import { DEFAULT_WEAVENOTES_CONFIG, validateWeaveNotesConfig, WEAVENOTES_AI_TOOLS } from './notes-config.js';

describe('weaveNotes config validator', () => {
  it('accepts a valid partial and fills the rest from defaults', () => {
    const { config, warnings } = validateWeaveNotesConfig({ defaultTheme: 'creative', maxAiTokensPerEdit: 8000 });
    expect(config.defaultTheme).toBe('creative');
    expect(config.maxAiTokensPerEdit).toBe(8000);
    expect(config.activityRetentionDays).toBe(DEFAULT_WEAVENOTES_CONFIG.activityRetentionDays);
    expect(warnings).toHaveLength(0);
  });
  it('NEGATIVE: clamps out-of-range numbers + warns; rejects unknown theme + unknown tools', () => {
    const { config, warnings } = validateWeaveNotesConfig({
      defaultTheme: 'rainbow', activityRetentionDays: 99999, maxAiTokensPerEdit: 1,
      enabledAiTools: ['note_edit', 'rm -rf /', 'workspace_search', 'note_edit'],
    });
    expect(config.defaultTheme).toBe('pro');            // unknown theme rejected
    expect(config.activityRetentionDays).toBe(3650);    // clamped to max
    expect(config.maxAiTokensPerEdit).toBe(256);        // clamped to min
    expect(config.enabledAiTools.sort()).toEqual(['note_edit', 'workspace_search']); // unknown dropped + deduped
    expect(warnings.length).toBeGreaterThanOrEqual(3);
  });
  it('SECURITY: a hostile/garbage payload can never produce an invalid config', () => {
    const evil = { defaultTheme: { toString: () => 'pro' }, activityRetentionDays: 'NaN; DROP TABLE notes', maxAiTokensPerEdit: Infinity, enabledAiTools: 'not-an-array', agencyColorEnabled: 'yes-please' };
    const { config } = validateWeaveNotesConfig(evil as never);
    expect(['pro', 'creative']).toContain(config.defaultTheme);
    expect(Number.isInteger(config.activityRetentionDays)).toBe(true);
    expect(config.maxAiTokensPerEdit).toBeLessThanOrEqual(200_000);
    expect(Array.isArray(config.enabledAiTools)).toBe(true);
    expect(config.enabledAiTools.every((t) => (WEAVENOTES_AI_TOOLS as readonly string[]).includes(t))).toBe(true);
  });
  it('mobile flags validate (booleans coerced, note-cache limit clamped)', () => {
    expect(DEFAULT_WEAVENOTES_CONFIG.mobileOfflineEnabled).toBe(true);
    expect(DEFAULT_WEAVENOTES_CONFIG.mobileInkEnabled).toBe(true);
    const { config } = validateWeaveNotesConfig({ mobileOfflineEnabled: '0', mobileInkEnabled: 1, mobileOfflineNoteLimit: 999999 });
    expect(config.mobileOfflineEnabled).toBe(false);   // '0' → false
    expect(config.mobileInkEnabled).toBe(true);        // 1 → true
    expect(config.mobileOfflineNoteLimit).toBe(5000);  // clamped to max
    expect(validateWeaveNotesConfig({ mobileOfflineNoteLimit: 1 }).config.mobileOfflineNoteLimit).toBe(10); // clamped to min
  });
  it('desktop flags validate (booleans coerced, cache cap clamped)', () => {
    expect(DEFAULT_WEAVENOTES_CONFIG.desktopOfflineEnabled).toBe(true);
    expect(DEFAULT_WEAVENOTES_CONFIG.quickCaptureEnabled).toBe(true);
    const { config } = validateWeaveNotesConfig({ desktopOfflineEnabled: 'false', quickCaptureEnabled: '1', desktopOfflineNoteLimit: 999999 });
    expect(config.desktopOfflineEnabled).toBe(false);
    expect(config.quickCaptureEnabled).toBe(true);
    expect(config.desktopOfflineNoteLimit).toBe(10000); // clamped to max
    expect(validateWeaveNotesConfig({ desktopOfflineNoteLimit: 1 }).config.desktopOfflineNoteLimit).toBe(10); // min
  });
  it('export flags validate (allow-list filtered; bad list falls back to defaults)', () => {
    expect(DEFAULT_WEAVENOTES_CONFIG.exportEnabled).toBe(true);
    expect(DEFAULT_WEAVENOTES_CONFIG.allowedExportFormats).toEqual(['markdown', 'html', 'word', 'json']);
    const { config } = validateWeaveNotesConfig({ exportEnabled: '0', allowedExportFormats: ['markdown', 'pdf', 'json', 'evil'] });
    expect(config.exportEnabled).toBe(false);
    expect(config.allowedExportFormats).toEqual(['markdown', 'json']); // unknown (pdf/evil) dropped
    // An all-invalid list keeps the defaults rather than leaving zero formats.
    expect(validateWeaveNotesConfig({ allowedExportFormats: ['nope'] }).config.allowedExportFormats).toEqual(['markdown', 'html', 'word', 'json']);
  });
  it('null/undefined input returns the safe defaults', () => {
    expect(validateWeaveNotesConfig(null).config).toEqual(DEFAULT_WEAVENOTES_CONFIG);
    expect(validateWeaveNotesConfig(undefined).config).toEqual(DEFAULT_WEAVENOTES_CONFIG);
  });
});
