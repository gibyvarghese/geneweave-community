// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  validateScheduledAgent, DEFAULT_SCHEDULED_AGENT, SCHEDULE_RECIPES, RECIPE_CATALOG, recipeInfo,
} from './scheduled-agent-config.js';

describe('scheduled-agent config — validation', () => {
  it('accepts a valid config', () => {
    const { config, warnings } = validateScheduledAgent({ name: 'Morning digest', recipe: 'daily_digest', cron: '0 8 * * MON-FRI', timezone: 'America/New_York', lookbackDays: 3, tokenBudget: 12000, maxSteps: 6 });
    expect(config.recipe).toBe('daily_digest');
    expect(config.cron).toBe('0 8 * * MON-FRI');
    expect(config.timezone).toBe('America/New_York');
    expect(config.tokenBudget).toBe(12000);
    expect(warnings).toEqual([]);
  });
  it('rejects unknown recipe/scope (keeps base + warns)', () => {
    const r = validateScheduledAgent({ recipe: 'mine' as never, scope: 'galaxy' as never });
    expect(r.config.recipe).toBe(DEFAULT_SCHEDULED_AGENT.recipe);
    expect(r.config.scope).toBe(DEFAULT_SCHEDULED_AGENT.scope);
    expect(r.warnings.length).toBe(2);
  });
  it('rejects an invalid cron + bad timezone with warnings (delegates to @weaveintel/triggers)', () => {
    const r = validateScheduledAgent({ cron: 'not a cron', timezone: 'Mars/Phobos' });
    expect(r.config.cron).toBe(DEFAULT_SCHEDULED_AGENT.cron); // kept the valid base
    expect(r.config.timezone).toBe('UTC');
    expect(r.warnings.join(' ')).toMatch(/cron/i);
    expect(r.warnings.join(' ')).toMatch(/timezone/i);
  });
  it('clamps budgets/steps/lookback/maxNotes', () => {
    const c = validateScheduledAgent({ tokenBudget: 99999999, maxSteps: 999, lookbackDays: 0, maxNotes: 99999 }).config;
    expect(c.tokenBudget).toBe(200_000);
    expect(c.maxSteps).toBe(30);
    expect(c.lookbackDays).toBe(1);
    expect(c.maxNotes).toBe(200);
  });
  it('warns when a custom task has no instruction; never throws on junk', () => {
    expect(validateScheduledAgent({ recipe: 'custom', taskPrompt: '' }).warnings.join(' ')).toMatch(/custom/i);
    expect(() => validateScheduledAgent({ tokenBudget: 'x' as never, maxSteps: null as never })).not.toThrow();
    expect(SCHEDULE_RECIPES).toContain('daily_digest');
    expect(RECIPE_CATALOG.length).toBe(SCHEDULE_RECIPES.length);
    expect(recipeInfo('link_suggester').writes).toMatch(/link/i);
  });
});
