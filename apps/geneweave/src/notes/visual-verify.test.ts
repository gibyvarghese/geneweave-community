// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  buildDiagramJudge, parseDiagramVerdict, diagramRegenFeedback, diagramAccept,
  buildImageVerify, parseImageVerdict, imageAccept,
  DIAGRAM_WEIGHTS, DEFAULT_DIAGRAM_THRESHOLD, DEFAULT_IMAGE_MIN_CONFIDENCE,
} from './visual-verify.js';

describe('diagram structural judge', () => {
  it('builds a judge prompt containing the request + the scene', () => {
    const { system, user } = buildDiagramJudge('flow of photosynthesis', '{"nodes":[{"label":"Sun"}]}');
    expect(system).toMatch(/semantic/i);
    expect(system).toMatch(/missing_entities/);
    expect(user).toContain('photosynthesis');
    expect(user).toContain('"Sun"');
  });

  it('parses a verdict and RECOMPUTES overall from the parts (ignores the model\'s arithmetic)', () => {
    // Model claims overall 0.99 but the parts say otherwise — we recompute and ignore the claim.
    const reply = 'noise { "entity_f1": 1.0, "edge_f1": 1.0, "direction_correctness": 1.0, "intent_fit": 1.0, "overall": 0.01, "reasoning": "good" } trailing';
    const v = parseDiagramVerdict(reply);
    expect(v.overall).toBeCloseTo(1.0, 5);
    expect(v.verdict).toBe('accept');
  });

  it('overall is the documented weighted blend', () => {
    const reply = JSON.stringify({ entity_f1: 0.8, edge_f1: 0.6, direction_correctness: 1.0, intent_fit: 0.0 });
    const v = parseDiagramVerdict(reply);
    const expected = DIAGRAM_WEIGHTS.entity * 0.8 + DIAGRAM_WEIGHTS.edge * 0.6 + DIAGRAM_WEIGHTS.direction * 1.0 + DIAGRAM_WEIGHTS.intent * 0.0;
    expect(v.overall).toBeCloseTo(expected, 4);
  });

  it('clamps out-of-range / garbage and treats unparseable as a 0 (retry)', () => {
    expect(parseDiagramVerdict('{ "entity_f1": 5, "edge_f1": -2 }').entityF1).toBe(1);
    expect(parseDiagramVerdict('{ "entity_f1": 5, "edge_f1": -2 }').edgeF1).toBe(0);
    const junk = parseDiagramVerdict('not json at all');
    expect(junk.overall).toBe(0);
    expect(junk.verdict).toBe('retry');
  });

  it('retry feedback names the missing + extra items so the redraw can fix them', () => {
    const v = parseDiagramVerdict(JSON.stringify({ entity_f1: 0.4, edge_f1: 0.3, missing_entities: ['Chlorophyll'], missing_edges: ['Sun -> Leaf'], extra_entities: ['Banana'] }));
    const fb = diagramRegenFeedback(v);
    expect(fb).toContain('Chlorophyll');
    expect(fb).toContain('Sun -> Leaf');
    expect(fb).toContain('Banana');
    expect(fb).toMatch(/ADD|REMOVE/);
  });

  it('a near-zero intent_fit (boxes-for-anatomy) advises returning an empty diagram (misroute signal)', () => {
    const v = parseDiagramVerdict(JSON.stringify({ entity_f1: 0.2, edge_f1: 0.1, intent_fit: 0.0 }));
    expect(diagramRegenFeedback(v)).toMatch(/wrong format|empty diagram/i);
  });

  it('diagramAccept respects the threshold', () => {
    const good = parseDiagramVerdict(JSON.stringify({ entity_f1: 1, edge_f1: 1, direction_correctness: 1, intent_fit: 1 }));
    const bad = parseDiagramVerdict(JSON.stringify({ entity_f1: 0.3, edge_f1: 0.2, direction_correctness: 0.5, intent_fit: 0.5 }));
    expect(diagramAccept(good, DEFAULT_DIAGRAM_THRESHOLD)).toBe(true);
    expect(diagramAccept(bad, DEFAULT_DIAGRAM_THRESHOLD)).toBe(false);
  });
});

describe('image vision judge', () => {
  it('builds a describe-then-verdict prompt that fights sycophancy', () => {
    const { system, user } = buildImageVerify('the human heart');
    expect(system).toMatch(/observed/);
    expect(system).toMatch(/expected to answer "no"/i); // anti-sycophancy line
    expect(user).toContain('the human heart');
  });

  it('accepts only when depicts + confident + quality + safe', () => {
    const ok = parseImageVerdict(JSON.stringify({ observed: 'an anatomical heart', depicts_subject: true, confidence: 0.9, quality_ok: true, safe: true, reason: 'clear' }));
    expect(imageAccept(ok)).toBe(true);
    // depicts but low confidence → reject
    expect(imageAccept(parseImageVerdict(JSON.stringify({ depicts_subject: true, confidence: 0.5, quality_ok: true, safe: true })))).toBe(false);
    // depicts + confident but unsafe → reject
    expect(imageAccept(parseImageVerdict(JSON.stringify({ depicts_subject: true, confidence: 0.95, quality_ok: true, safe: false })))).toBe(false);
    // depicts + confident but poor quality → reject
    expect(imageAccept(parseImageVerdict(JSON.stringify({ depicts_subject: true, confidence: 0.95, quality_ok: false, safe: true })))).toBe(false);
  });

  it('FAILS CLOSED: an unparseable / missing-fields verdict is never accepted', () => {
    expect(imageAccept(parseImageVerdict('the model refused to answer'))).toBe(false);
    // missing quality_ok/safe default to false → reject even if depicts+confident present
    expect(imageAccept(parseImageVerdict(JSON.stringify({ depicts_subject: true, confidence: 0.99 })))).toBe(false);
  });

  it('respects a custom minimum confidence', () => {
    const v = parseImageVerdict(JSON.stringify({ depicts_subject: true, confidence: 0.65, quality_ok: true, safe: true }));
    expect(imageAccept(v, DEFAULT_IMAGE_MIN_CONFIDENCE)).toBe(false); // 0.65 < 0.7
    expect(imageAccept(v, 0.6)).toBe(true);
  });
});
