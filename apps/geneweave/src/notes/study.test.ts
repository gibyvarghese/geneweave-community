// SPDX-License-Identifier: MIT
import { describe, it, expect } from 'vitest';
import {
  ratingToQuality, initialSchedule, sm2, isDue, dueCards, studyStats, validateFlashcards,
  ratingToGrade, fsrs, fsrsInterval, fsrsPreview, retrievability,
  FSRS_DEFAULT_WEIGHTS, FSRS_DEFAULT_RETENTION,
  MIN_EASE, INITIAL_EASE, type CardSchedule, type ReviewRating,
} from './study.js';

const T0 = 1_700_000_000_000; // a fixed "now" for deterministic dates
const DAY = 86_400_000;

describe('study — SM-2 scheduler', () => {
  it('a fresh card starts new, due now, with the default ease', () => {
    const s = initialSchedule(T0);
    expect(s).toMatchObject({ easeFactor: INITIAL_EASE, intervalDays: 0, repetitions: 0, dueAt: T0, lastReviewedAt: null });
    expect(isDue(s, T0)).toBe(true);
  });

  it('maps the 4 buttons to SM-2 quality grades', () => {
    expect(ratingToQuality('again')).toBeLessThan(3); // a fail
    expect(ratingToQuality('hard')).toBe(3);
    expect(ratingToQuality('good')).toBe(4);
    expect(ratingToQuality('easy')).toBe(5);
  });

  it('grows the interval 1 → 6 → ×ease on consecutive passes (the classic ladder)', () => {
    let s = initialSchedule(T0);
    s = sm2(s, 'good', T0);            // 1st pass
    expect(s.repetitions).toBe(1); expect(s.intervalDays).toBe(1);
    expect(s.dueAt).toBe(T0 + 1 * DAY);
    s = sm2(s, 'good', s.dueAt);       // 2nd pass
    expect(s.repetitions).toBe(2); expect(s.intervalDays).toBe(6);
    const efAfter2 = s.easeFactor;
    s = sm2(s, 'good', s.dueAt);       // 3rd pass → 6 × ease
    expect(s.repetitions).toBe(3);
    expect(s.intervalDays).toBe(Math.round(6 * efAfter2));
  });

  it('"Again" resets the streak + re-queues the card for today', () => {
    let s = initialSchedule(T0);
    s = sm2(s, 'good', T0); s = sm2(s, 'good', s.dueAt); // interval = 6, reps = 2
    const before = s.easeFactor;
    s = sm2(s, 'again', s.dueAt);
    expect(s.repetitions).toBe(0);
    expect(s.intervalDays).toBe(0);
    expect(s.dueAt).toBe(s.lastReviewedAt); // due again now
    expect(s.easeFactor).toBeLessThan(before); // a fail lowers ease
  });

  it('"Easy" raises ease, "Hard" lowers it; ease never drops below 1.3', () => {
    expect(sm2(initialSchedule(T0), 'easy', T0).easeFactor).toBeGreaterThan(INITIAL_EASE);
    expect(sm2(initialSchedule(T0), 'hard', T0).easeFactor).toBeLessThan(INITIAL_EASE);
    // hammer a card with "again" many times — ease floors at 1.3, never below.
    let s = initialSchedule(T0);
    for (let i = 0; i < 50; i++) s = sm2(s, 'again', T0 + i * 1000);
    expect(s.easeFactor).toBe(MIN_EASE);
  });

  it('matches the canonical SM-2 ease formula for q=5 and q=3', () => {
    // q=5: EF + 0.1 ; q=3: EF + (0.1 - 2*(0.08+2*0.02)) = EF - 0.14
    expect(sm2(initialSchedule(T0), 'easy', T0).easeFactor).toBeCloseTo(2.6, 5);
    expect(sm2(initialSchedule(T0), 'hard', T0).easeFactor).toBeCloseTo(2.36, 5);
  });
});

describe('study — FSRS-6 scheduler', () => {
  const W = FSRS_DEFAULT_WEIGHTS;

  it('maps the 4 buttons to FSRS grades 1–4', () => {
    expect(ratingToGrade('again')).toBe(1);
    expect(ratingToGrade('hard')).toBe(2);
    expect(ratingToGrade('good')).toBe(3);
    expect(ratingToGrade('easy')).toBe(4);
  });

  it('forgetting curve: recall is 1 at t=0 and equals the target when t=stability', () => {
    const S = 12;
    expect(retrievability(S, 0)).toBeCloseTo(1, 6);
    // By the FACTOR definition, R(S, S) = 0.9 exactly (the curve anchor).
    expect(retrievability(S, S)).toBeCloseTo(0.9, 6);
    // Recall decays monotonically with elapsed time.
    expect(retrievability(S, 30)).toBeLessThan(retrievability(S, 5));
  });

  it('next interval ≈ stability at 0.9 retention, and shrinks as target retention rises', () => {
    const S = 20;
    expect(fsrsInterval(S, 0.9)).toBe(Math.round(S)); // I == S at the anchor retention
    expect(fsrsInterval(S, 0.97)).toBeLessThan(fsrsInterval(S, 0.9)); // want more recall → review sooner
    expect(fsrsInterval(S, 0.8)).toBeGreaterThan(fsrsInterval(S, 0.9));
    expect(fsrsInterval(S)).toBeGreaterThanOrEqual(1); // floored at 1 day
  });

  it('first review seeds stability + difficulty straight from the grade', () => {
    const easy = fsrs(initialSchedule(T0), 'easy', T0);
    const again = fsrs(initialSchedule(T0), 'again', T0);
    // Initial stability = w[grade-1]: Easy (w[3]) ≫ Again (w[0]).
    expect(easy.stability).toBeCloseTo(W[3]!, 6);
    expect(again.stability).toBeCloseTo(Math.max(W[0]!, 0.1), 6);
    // Easy seeds a much longer first interval than Again.
    expect(easy.intervalDays).toBeGreaterThan(again.intervalDays);
    // Difficulty within [1,10]; Again is harder than Easy.
    expect(again.difficulty!).toBeGreaterThan(easy.difficulty!);
    expect(easy.difficulty!).toBeGreaterThanOrEqual(1);
    expect(again.difficulty!).toBeLessThanOrEqual(10);
    expect(easy.lastReviewedAt).toBe(T0);
    expect(easy.dueAt).toBe(T0 + easy.intervalDays * DAY);
  });

  it('a recall grows stability; the next interval lengthens each successful review', () => {
    let s = fsrs(initialSchedule(T0), 'good', T0);
    const intervals = [s.intervalDays];
    const stabilities = [s.stability!];
    for (let i = 0; i < 5; i++) {
      s = fsrs(s, 'good', s.dueAt); // review exactly when due
      intervals.push(s.intervalDays);
      stabilities.push(s.stability!);
    }
    // Stability strictly increases on consecutive recalls.
    for (let i = 1; i < stabilities.length; i++) expect(stabilities[i]).toBeGreaterThan(stabilities[i - 1]!);
    // So do the intervals (monotonic, non-decreasing — and overall it stretches out).
    expect(intervals[intervals.length - 1]!).toBeGreaterThan(intervals[0]!);
  });

  it('a lapse ("Again") NEVER increases stability and shortens the interval', () => {
    // Build up a well-learned card.
    let s = fsrs(initialSchedule(T0), 'good', T0);
    for (let i = 0; i < 4; i++) s = fsrs(s, 'good', s.dueAt);
    const before = s.stability!;
    const lapsed = fsrs(s, 'again', s.dueAt);
    expect(lapsed.stability!).toBeLessThanOrEqual(before); // capped: a forget can't raise stability
    expect(lapsed.intervalDays).toBeLessThan(s.intervalDays); // and the next review comes sooner
    expect(lapsed.repetitions).toBe(0); // streak resets
  });

  it('harder grades give shorter intervals than easier ones (Again ≤ Hard ≤ Good ≤ Easy)', () => {
    let s = fsrs(initialSchedule(T0), 'good', T0);
    for (let i = 0; i < 3; i++) s = fsrs(s, 'good', s.dueAt);
    const p = fsrsPreview(s, s.dueAt);
    expect(p.again).toBeLessThanOrEqual(p.hard);
    expect(p.hard).toBeLessThanOrEqual(p.good);
    expect(p.good).toBeLessThanOrEqual(p.easy);
  });

  it('respects the target-retention option end to end (higher retention → sooner due)', () => {
    const seed = fsrs(initialSchedule(T0), 'good', T0);
    const high = fsrs(seed, 'good', seed.dueAt, { targetRetention: 0.95 });
    const low = fsrs(seed, 'good', seed.dueAt, { targetRetention: 0.85 });
    expect(high.intervalDays).toBeLessThan(low.intervalDays);
    // Out-of-range retention is clamped to the FSRS sane band (0.70–0.97), never throws.
    expect(() => fsrs(seed, 'good', seed.dueAt, { targetRetention: 5 })).not.toThrow();
  });

  it('is deterministic — identical inputs produce identical output (no fuzz)', () => {
    const s = fsrs(initialSchedule(T0), 'good', T0);
    const a = fsrs(s, 'good', s.dueAt);
    const b = fsrs(s, 'good', s.dueAt);
    expect(a).toEqual(b);
  });

  it('STRESS: 2,000 random reviews of 50 cards stay finite + in-bounds, never NaN', () => {
    const ratings: ReviewRating[] = ['again', 'hard', 'good', 'easy'];
    // A simple deterministic PRNG so the stress run is reproducible.
    let seed = 12345;
    const rnd = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
    for (let card = 0; card < 50; card++) {
      let s = initialSchedule(T0);
      let now = T0;
      for (let i = 0; i < 40; i++) {
        const rating = ratings[Math.floor(rnd() * 4)]!;
        s = fsrs(s, rating, now);
        expect(Number.isFinite(s.stability!)).toBe(true);
        expect(Number.isFinite(s.difficulty!)).toBe(true);
        expect(Number.isFinite(s.intervalDays)).toBe(true);
        expect(s.stability!).toBeGreaterThanOrEqual(0.001);
        expect(s.stability!).toBeLessThanOrEqual(36_500);
        expect(s.difficulty!).toBeGreaterThanOrEqual(1);
        expect(s.difficulty!).toBeLessThanOrEqual(10);
        expect(s.intervalDays).toBeGreaterThanOrEqual(1);
        now = s.dueAt; // review when due
      }
    }
  });

  it('tolerates corrupt prior state (NaN/negative/missing stability) by reseeding', () => {
    const corrupt: CardSchedule = { ...initialSchedule(T0), stability: -5, difficulty: NaN, lastReviewedAt: T0 - DAY };
    const out = fsrs(corrupt, 'good', T0);
    expect(Number.isFinite(out.stability!)).toBe(true);
    expect(out.stability!).toBeGreaterThan(0);
    expect(out.difficulty!).toBeGreaterThanOrEqual(1);
  });

  it('FSRS_DEFAULT_RETENTION is the published 0.90 anchor', () => {
    expect(FSRS_DEFAULT_RETENTION).toBe(0.9);
    expect(FSRS_DEFAULT_WEIGHTS).toHaveLength(21);
  });
});

describe('study — due filter + stats', () => {
  const mk = (over: Partial<CardSchedule>): { schedule: CardSchedule } => ({ schedule: { ...initialSchedule(T0), ...over } });
  it('filters + sorts due cards soonest-first', () => {
    const cards = [mk({ dueAt: T0 + DAY }), mk({ dueAt: T0 - DAY }), mk({ dueAt: T0 - 2 * DAY })];
    const due = dueCards(cards, T0);
    expect(due).toHaveLength(2);
    expect(due[0]!.schedule.dueAt).toBeLessThan(due[1]!.schedule.dueAt); // oldest-due first
  });
  it('classifies fresh / learning / mature', () => {
    const cards = [
      mk({ lastReviewedAt: null }),                       // fresh
      mk({ lastReviewedAt: T0, intervalDays: 6 }),        // learning (<21d)
      mk({ lastReviewedAt: T0, intervalDays: 40, dueAt: T0 + 40 * DAY }), // mature, not due
    ];
    const st = studyStats(cards, T0);
    expect(st).toMatchObject({ total: 3, fresh: 1, learning: 1, mature: 1 });
    expect(st.due).toBeGreaterThanOrEqual(2); // the two with dueAt ≤ now
  });
});

describe('study — validateFlashcards (robust + secure)', () => {
  it('accepts front/back and common aliases, stamps a fresh schedule', () => {
    const cards = validateFlashcards([
      { front: 'What pumps blood?', back: 'The heart' },
      { question: 'How many chambers?', answer: 'Four' },
      { q: 'Term', a: 'Definition' },
    ], T0);
    expect(cards).toHaveLength(3);
    expect(cards[0]).toMatchObject({ front: 'What pumps blood?', back: 'The heart' });
    expect(cards[1]!.front).toBe('How many chambers?');
    expect(cards.every((c) => c.schedule.dueAt === T0 && c.schedule.repetitions === 0)).toBe(true);
  });
  it('trims, drops empties, de-duplicates by front', () => {
    const cards = validateFlashcards([
      { front: '  A  ', back: ' x ' }, { front: 'A', back: 'y' }, { front: '', back: 'z' }, { front: 'B', back: '' },
    ], T0);
    expect(cards.map((c) => c.front)).toEqual(['A']); // dupe + empties dropped; trimmed
    expect(cards[0]!.back).toBe('x');
  });
  it('STRESS/SECURITY: caps count + lengths; never throws on junk', () => {
    expect(validateFlashcards(null)).toEqual([]);
    expect(validateFlashcards('cards')).toEqual([]);
    expect(validateFlashcards([1, 'x', null, {}, { front: 5, back: 6 }])).toEqual([]);
    const huge = Array.from({ length: 500 }, (_, i) => ({ front: `F${i} ${'x'.repeat(2000)}`, back: 'y'.repeat(9000) }));
    const v = validateFlashcards(huge, T0);
    expect(v.length).toBeLessThanOrEqual(200);
    expect(v[0]!.front.length).toBeLessThanOrEqual(400);
    expect(v[0]!.back.length).toBeLessThanOrEqual(2000);
  });
});
