// SPDX-License-Identifier: MIT
/**
 * geneWeave UI rebuild — per-tenant Appearance / branding service (white-label).
 *
 * A tenant admin re-brands the workspace: display name, logo, default colour-scheme (system/light/dark),
 * Pro/Creative default, corner style, density, and an optional brand accent colour. The result is served
 * as CSS custom properties + flags the web client applies at runtime, so the whole app re-brands with NO
 * flash. Accessibility is enforced by @weaveintel/tokens: a brand accent that fails WCAG-AA on a theme's
 * background is dropped (that theme keeps the accessible default) — a tenant can never ship an
 * inaccessible re-brand. The AI-agency colours (mint/emerald as AI presence) are NEVER re-branded; only
 * the primary-action accent + neutral shell chrome respond to the brand.
 *
 * Reuses the `@weaveintel/tokens` ENGINE (tenantThemeVars + the AA audit) fed with the geneWeave brand
 * themes (from the app's own brand, not baked into the framework) — the single source of truth shared
 * with the native app. Owner = the tenant; edited in the Builder Appearance surface; the assistant can
 * also apply it via the set_workspace_appearance tool.
 */
import { tenantThemeVars, type TenantThemeOverride } from '@weaveintel/tokens';
import { geneweaveThemes, GENEWEAVE_CSS_PREFIX } from '@weaveintel/geneweave-ui/brand';
import type { DatabaseAdapter } from './db-types/adapter.js';
import type { TenantAppearanceRow } from './db-types/adapter-me.js';

const SCHEMES = new Set(['system', 'light', 'dark']);
const VARIANTS = new Set(['pro', 'creative']);
const CORNERS = new Set(['soft', 'sharp', 'round']);
const DENSITIES = new Set(['comfortable', 'compact']);
const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;

/** Corner style → radii override (px) the brand applies to cards/bubbles/pills. */
const CORNER_RADII: Record<string, { sm: number; md: number; lg: number; xl: number }> = {
  soft: { sm: 8, md: 12, lg: 16, xl: 24 },       // default
  sharp: { sm: 3, md: 4, lg: 6, xl: 8 },
  round: { sm: 14, md: 18, lg: 22, xl: 28 },
};

/** Map the changed `--gw-*` vars to the legacy `--*` vars the shipped web UI actually consumes. */
const GW_TO_LEGACY: Record<string, string[]> = {
  '--gw-color-accent': ['--accent'],
  '--gw-color-accent-strong': ['--accent2'],
  '--gw-font-display': ['--font-display'],
  '--gw-font-body': ['--font'],
  '--gw-radius-sm': ['--radius-sm'],
  '--gw-radius-md': ['--radius'],
  '--gw-radius-lg': ['--radius-lg'],
};

function toStr(v: unknown): string | null { return typeof v === 'string' && v.trim() ? v.trim() : null; }

/** The default (no-op) appearance for a tenant with no row. */
function defaults(tenantId: string): TenantAppearanceRow {
  return { tenant_id: tenantId, enabled: 1, brand_name: null, logo_svg: null, color_scheme: 'system', variant: 'pro', accent: null, on_accent: null, corner_style: 'soft', font_display: null, font_body: null, density: 'comfortable', updated_at: '' };
}

export function createTenantAppearanceService(db: DatabaseAdapter, opts: { now?: () => number } = {}) {
  const now = opts.now ?? (() => Date.now());

  /** Build the accessibility-enforced token override from a stored row. */
  function toOverride(row: TenantAppearanceRow): TenantThemeOverride {
    const o: TenantThemeOverride = {};
    const colors: NonNullable<TenantThemeOverride['colors']> = {};
    if (row.accent && HEX.test(row.accent)) { colors.accent = row.accent; colors.accentStrong = row.accent; }
    if (row.on_accent && HEX.test(row.on_accent)) colors.onAccent = row.on_accent;
    if (Object.keys(colors).length) o.colors = colors;
    const fam: Record<string, string> = {};
    if (row.font_display) fam['display'] = row.font_display;
    if (row.font_body) fam['body'] = row.font_body;
    if (Object.keys(fam).length) o.typography = { families: fam as never };
    if (row.corner_style !== 'soft' && CORNER_RADII[row.corner_style]) o.radii = CORNER_RADII[row.corner_style];
    return o;
  }

  /**
   * The effective appearance for a tenant: the stored brand fields + the resolved, AA-safe legacy CSS
   * variables the web client applies (per light/dark), + `degraded` when a brand colour was dropped for
   * accessibility. Falls back to sane defaults when nothing is configured.
   */
  async function getEffective(tenantId: string): Promise<{
    tenantId: string; enabled: boolean; brandName: string | null; logoSvg: string | null;
    colorScheme: string; variant: string; density: string; cornerStyle: string;
    vars: { light: Record<string, string>; dark: Record<string, string> }; degraded: boolean;
  }> {
    const row = (await db.getTenantAppearance?.(tenantId)) ?? defaults(tenantId);
    const override = toOverride(row);
    const resolved = Object.keys(override).length
      ? tenantThemeVars(geneweaveThemes, override, { prefix: GENEWEAVE_CSS_PREFIX })
      : { light: {}, dark: {}, degraded: false };
    const mapLegacy = (gw: Record<string, string>): Record<string, string> => {
      const out: Record<string, string> = {};
      for (const [k, v] of Object.entries(gw)) for (const legacy of (GW_TO_LEGACY[k] ?? [])) out[legacy] = v;
      return out;
    };
    return {
      tenantId, enabled: row.enabled !== 0, brandName: row.brand_name, logoSvg: row.logo_svg,
      colorScheme: SCHEMES.has(row.color_scheme) ? row.color_scheme : 'system',
      variant: VARIANTS.has(row.variant) ? row.variant : 'pro',
      density: DENSITIES.has(row.density) ? row.density : 'comfortable',
      cornerStyle: CORNERS.has(row.corner_style) ? row.corner_style : 'soft',
      vars: { light: mapLegacy(resolved.light), dark: mapLegacy(resolved.dark) },
      degraded: resolved.degraded,
    };
  }

  /** Validate + persist a (partial) appearance update. Returns the effective appearance + warnings. */
  async function update(tenantId: string, patch: Record<string, unknown>): Promise<{ ok: boolean; error?: string; warnings: string[]; effective?: Awaited<ReturnType<typeof getEffective>> }> {
    if (!tenantId) return { ok: false, error: 'tenantId required', warnings: [] };
    const cur = (await db.getTenantAppearance?.(tenantId)) ?? defaults(tenantId);
    const warnings: string[] = [];
    const clampEnum = (v: unknown, set: Set<string>, fallback: string): string => (typeof v === 'string' && set.has(v) ? v : fallback);
    const accent = patch['accent'] !== undefined ? toStr(patch['accent']) : cur.accent;
    if (accent && !HEX.test(accent)) { warnings.push('Brand accent must be a hex colour like #2563EB — ignored.'); }
    const onAccent = patch['on_accent'] !== undefined ? toStr(patch['on_accent']) : cur.on_accent;
    // Sanitise brand name / logo (logo is inline SVG — strip scripts/handlers defensively).
    const brandName = patch['brand_name'] !== undefined ? (toStr(patch['brand_name'])?.slice(0, 60) ?? null) : cur.brand_name;
    let logoSvg = patch['logo_svg'] !== undefined ? (toStr(patch['logo_svg']) ?? null) : cur.logo_svg;
    if (logoSvg && (/<script|on\w+\s*=|javascript:/i.test(logoSvg) || !/^<svg[\s>]/i.test(logoSvg.trim()) || logoSvg.length > 20000)) { logoSvg = cur.logo_svg; warnings.push('Logo must be a plain inline <svg> (no scripts) under 20 KB — ignored.'); }
    const fontOk = (f: string | null): string | null => (f && /^[\w .,'-]{1,48}$/.test(f) ? f : null);

    const row: TenantAppearanceRow = {
      tenant_id: tenantId,
      enabled: patch['enabled'] !== undefined ? (patch['enabled'] ? 1 : 0) : cur.enabled,
      brand_name: brandName,
      logo_svg: logoSvg,
      color_scheme: clampEnum(patch['color_scheme'] ?? cur.color_scheme, SCHEMES, 'system'),
      variant: clampEnum(patch['variant'] ?? cur.variant, VARIANTS, 'pro'),
      accent: accent && HEX.test(accent) ? accent : (patch['accent'] !== undefined && !accent ? null : cur.accent),
      on_accent: onAccent && HEX.test(onAccent) ? onAccent : (patch['on_accent'] !== undefined && !onAccent ? null : cur.on_accent),
      corner_style: clampEnum(patch['corner_style'] ?? cur.corner_style, CORNERS, 'soft'),
      font_display: patch['font_display'] !== undefined ? fontOk(toStr(patch['font_display'])) : cur.font_display,
      font_body: patch['font_body'] !== undefined ? fontOk(toStr(patch['font_body'])) : cur.font_body,
      density: clampEnum(patch['density'] ?? cur.density, DENSITIES, 'comfortable'),
      updated_at: new Date(now()).toISOString(),
    };
    await db.upsertTenantAppearance?.(row);
    const effective = await getEffective(tenantId);
    if (effective.degraded) warnings.push('Your brand accent doesn’t meet accessibility contrast in one theme — the accessible default is used there.');
    return { ok: true, warnings, effective };
  }

  return {
    getEffective,
    update,
    async list(): Promise<TenantAppearanceRow[]> { return (await db.listTenantAppearance?.()) ?? []; },

    /** Agent-tool entry: the assistant changes workspace appearance (admin-gated by the caller). */
    async agentSetAppearance(args: { tenantId: string; colorScheme?: string; variant?: string; accent?: string; cornerStyle?: string; density?: string }): Promise<{ ok: boolean; error?: string; applied?: Record<string, string>; degraded?: boolean }> {
      const patch: Record<string, unknown> = {};
      if (args.colorScheme) patch['color_scheme'] = args.colorScheme;
      if (args.variant) patch['variant'] = args.variant;
      if (args.accent) patch['accent'] = args.accent;
      if (args.cornerStyle) patch['corner_style'] = args.cornerStyle;
      if (args.density) patch['density'] = args.density;
      if (!Object.keys(patch).length) return { ok: false, error: 'Nothing to change — specify a colour scheme, variant, accent, corner style, or density.' };
      const r = await update(args.tenantId, patch);
      if (!r.ok) return { ok: false, error: r.error };
      return { ok: true, applied: { colorScheme: r.effective!.colorScheme, variant: r.effective!.variant, cornerStyle: r.effective!.cornerStyle, density: r.effective!.density }, degraded: r.effective!.degraded };
    },
  };
}

export type TenantAppearanceService = ReturnType<typeof createTenantAppearanceService>;
