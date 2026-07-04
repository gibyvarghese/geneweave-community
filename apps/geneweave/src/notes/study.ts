// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — the STUDY model: flashcards + spaced repetition (weaveNotes Phase 5 + 2).
 *
 * The most effective way to remember a note is ACTIVE RECALL on a SPACED schedule: turn the note
 * into question→answer flashcards, then review each card just before you'd forget it. This module
 * is the single source of truth for that — the flashcard shape, the strict validator over (AI- or
 * user-supplied) cards, and the scheduler that decides WHEN each card is next due.
 *
 * Two schedulers ship here; the app picks one by config (`fsrsEnabled`):
 *
 *   • **FSRS** (Free Spaced Repetition Scheduler — the default, Phase 2). The accurate, modern
 *     scheduler that powers today's Anki. It models your memory of each card with two numbers —
 *     *stability* (≈ days until your recall chance drops to the target) and *difficulty* (1–10) —
 *     and the forgetting curve R(t)=(1+FACTOR·t/S)^DECAY, then schedules the next review for the
 *     moment your predicted recall falls to the target retention (default 0.90). This is FSRS-6
 *     with the published default weights, implemented as the clean "long-term" subset (day-grained,
 *     no sub-day learning steps) that fits a notes app. See `fsrs()`.
 *
 *   • **SM-2** (the SuperMemo-2 algorithm — the classic transparent baseline, kept as a fallback
 *     when FSRS is turned off). Each card carries an *ease factor*, a *repetition count*, and an
 *     *interval*; the interval grows when you remember and resets when you forget. See `sm2()`.
 *
 * The 4 review buttons map to both: Again → forgot · Hard → just passed · Good → passed · Easy → easy.
 *
 * Pure + zero-dependency (browser- and server-safe; the time source is injected for testability).
 */

/** The 4 review ratings (the buttons a learner taps), in increasing recall quality. */
export type ReviewRating = 'again' | 'hard' | 'good' | 'easy';

/**
 * A card's scheduling state. `dueAt`/`lastReviewedAt` are epoch-ms. The SM-2 fields
 * (`easeFactor`/`intervalDays`/`repetitions`) are always present; the FSRS memory state
 * (`stability`/`difficulty`) is filled in on a card's first FSRS review (null/undefined before).
 */
export interface CardSchedule {
  /** SM-2 ease factor (≥1.3; starts at 2.5). Higher = the card is easy for you → longer intervals. */
  easeFactor: number;
  /** Current interval in days until the next review. */
  intervalDays: number;
  /** How many times in a row you've passed this card (resets to 0 on "Again"). */
  repetitions: number;
  /** Epoch-ms when the card is next due. A new card is due immediately. */
  dueAt: number;
  /** Epoch-ms of the last review, or null if never reviewed. */
  lastReviewedAt: number | null;
  /** FSRS stability (memory half-life, in days). Null/undefined until the first FSRS review. */
  stability?: number | null;
  /** FSRS difficulty (1–10, how hard the card is for you). Null/undefined until the first FSRS review. */
  difficulty?: number | null;
}

/** A flashcard: a question (front), its answer (back), and its schedule. */
export interface Flashcard {
  front: string;
  back: string;
  schedule: CardSchedule;
}

export const MIN_EASE = 1.3;
export const INITIAL_EASE = 2.5;
const DAY_MS = 86_400_000;
const MAX_FRONT = 400;
const MAX_BACK = 2000;
const MAX_CARDS = 200;

/** Map a review button to the SM-2 quality grade q (0–5). "again" is a fail (q<3). */
export function ratingToQuality(rating: ReviewRating): number {
  switch (rating) {
    case 'again': return 2;
    case 'hard': return 3;
    case 'good': return 4;
    case 'easy': return 5;
    default: return 3;
  }
}

/** A fresh card's schedule — new, due immediately, with the default ease. */
export function initialSchedule(now = Date.now()): CardSchedule {
  return { easeFactor: INITIAL_EASE, intervalDays: 0, repetitions: 0, dueAt: now, lastReviewedAt: null };
}

function round2(n: number): number { return Math.round(n * 100) / 100; }

/**
 * Apply ONE SM-2 review to a card schedule and return the NEW schedule. Textbook SM-2:
 *   - the ease factor is nudged by `EF + (0.1 − (5−q)·(0.08 + (5−q)·0.02))`, floored at 1.3;
 *   - on a FAIL (q < 3, i.e. "Again") repetitions reset to 0 and the card is due again today;
 *   - on a PASS the interval grows: 1 day → 6 days → previous × ease (rounded);
 *   - the new due date = now + interval days.
 */
export function sm2(schedule: CardSchedule, rating: ReviewRating, now = Date.now()): CardSchedule {
  const q = ratingToQuality(rating);
  const ease = Math.max(MIN_EASE, round2(schedule.easeFactor + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02))));

  let repetitions: number;
  let intervalDays: number;
  if (q < 3) {
    // Forgot → relearn: reset the streak and re-queue for today.
    repetitions = 0;
    intervalDays = 0;
  } else {
    repetitions = schedule.repetitions + 1;
    if (repetitions === 1) intervalDays = 1;
    else if (repetitions === 2) intervalDays = 6;
    else intervalDays = Math.max(1, Math.round(schedule.intervalDays * ease));
  }
  return { easeFactor: ease, intervalDays, repetitions, dueAt: now + intervalDays * DAY_MS, lastReviewedAt: now };
}

// ────────────────────────────────────────────────────────────────────────────
// FSRS-6 (Free Spaced Repetition Scheduler) — the accurate default scheduler.
//
// Transcribed from the official FSRS-6 reference implementations (open-spaced-repetition's
// ts-fsrs + py-fsrs, which agree). We implement the **long-term subset**: every grade schedules a
// whole-day interval via the forgetting curve, with no sub-day "learning steps" and no fuzz — the
// right fit for a day-grained notes app, and fully deterministic for testing.
// ────────────────────────────────────────────────────────────────────────────

/** The 4 FSRS grades. Again=1, Hard=2, Good=3, Easy=4. */
export type FsrsGrade = 1 | 2 | 3 | 4;

/** Map a review button to an FSRS grade (1–4). */
export function ratingToGrade(rating: ReviewRating): FsrsGrade {
  switch (rating) {
    case 'again': return 1;
    case 'hard': return 2;
    case 'good': return 3;
    case 'easy': return 4;
    default: return 3;
  }
}

/**
 * The published FSRS-6 default weights (21 of them), verbatim from the reference libraries. These
 * are sensible population defaults; a deployment could later train per-user weights, but these work
 * well out of the box. `w[20]` is the learnable decay (default 0.1542).
 */
export const FSRS_DEFAULT_WEIGHTS: readonly number[] = [
  0.212, 1.2931, 2.3065, 8.2956, 6.4133, 0.8334, 3.0194, 0.001,
  1.8722, 0.1666, 0.796, 1.4835, 0.0614, 0.2629, 1.6483, 0.6014,
  1.8729, 0.5425, 0.0912, 0.0658, 0.1542,
];

/** Default recall probability FSRS aims for at review time (0.90 = review at ~90% recall). */
export const FSRS_DEFAULT_RETENTION = 0.9;
const S_MIN = 0.001;          // stability floor (days)
const S_MAX = 36_500;         // stability ceiling (~100 years)
const INIT_S_MAX = 100;       // initial stability is additionally capped here

export interface FsrsOptions {
  /** Override the 21 FSRS-6 weights (defaults to FSRS_DEFAULT_WEIGHTS). */
  weights?: readonly number[];
  /** Target recall probability at review time (0.70–0.97; defaults to 0.90). Higher = more reviews. */
  targetRetention?: number;
}

function clamp(n: number, lo: number, hi: number): number { return Math.min(hi, Math.max(lo, n)); }
/** Read weight i (treats a missing weight as 0, so a short/over-ridden vector can't crash the maths). */
function wAt(w: readonly number[], i: number): number { return w[i] ?? 0; }

/** The forgetting-curve decay/factor pair for a weight vector. R(t,S)=(1+FACTOR·t/S)^DECAY. */
function curveConsts(w: readonly number[]): { decay: number; factor: number } {
  const decay = -wAt(w, 20);
  const factor = Math.pow(0.9, 1 / decay) - 1; // makes R(S,S)=0.9 by definition
  return { decay, factor };
}

/** Predicted probability of recalling a card now, given its stability and elapsed days. */
export function retrievability(stability: number, elapsedDays: number, weights: readonly number[] = FSRS_DEFAULT_WEIGHTS): number {
  const { decay, factor } = curveConsts(weights);
  const t = Math.max(0, elapsedDays);
  return Math.pow(1 + (factor * t) / Math.max(S_MIN, stability), decay);
}

/** The next interval (whole days, ≥1) that lets recall decay to `targetRetention` for a stability. */
export function fsrsInterval(stability: number, targetRetention = FSRS_DEFAULT_RETENTION, weights: readonly number[] = FSRS_DEFAULT_WEIGHTS): number {
  const { decay, factor } = curveConsts(weights);
  const raw = (stability / factor) * (Math.pow(targetRetention, 1 / decay) - 1);
  return clamp(Math.round(raw), 1, S_MAX);
}

/** Initial stability for a brand-new card given the first grade. */
function initialStability(g: FsrsGrade, w: readonly number[]): number {
  return clamp(Math.max(wAt(w, g - 1), 0.1), S_MIN, INIT_S_MAX);
}

/** Initial difficulty for a brand-new card given the first grade (unclamped form used for mean-reversion). */
function difficulty0(g: number, w: readonly number[]): number {
  return wAt(w, 4) - Math.exp(wAt(w, 5) * (g - 1)) + 1;
}

/**
 * Apply ONE FSRS-6 review to a card schedule and return the NEW schedule.
 *
 * On a card's first-ever review it seeds stability + difficulty from the grade; afterwards it
 * updates them from the DSR model (difficulty mean-reverts; stability grows on recall and is
 * re-derived — never increased — on a lapse), then schedules the next review for when predicted
 * recall reaches the target retention. Pure: identical inputs → identical output (no fuzz).
 */
export function fsrs(schedule: CardSchedule, rating: ReviewRating, now = Date.now(), opts: FsrsOptions = {}): CardSchedule {
  const w = opts.weights ?? FSRS_DEFAULT_WEIGHTS;
  const target = clamp(opts.targetRetention ?? FSRS_DEFAULT_RETENTION, 0.7, 0.97);
  const g = ratingToGrade(rating);

  const prevS = typeof schedule.stability === 'number' && schedule.stability > 0 ? schedule.stability : null;
  const prevD = typeof schedule.difficulty === 'number' && schedule.difficulty > 0 ? schedule.difficulty : null;

  let stability: number;
  let difficulty: number;

  if (prevS === null || prevD === null) {
    // First review of this card: seed memory state straight from the grade.
    stability = initialStability(g, w);
    difficulty = clamp(difficulty0(g, w), 1, 10);
  } else {
    // Elapsed time since the last review, floored to whole days (≥0).
    const elapsedDays = schedule.lastReviewedAt != null ? Math.max(0, Math.floor((now - schedule.lastReviewedAt) / DAY_MS)) : 0;
    const r = retrievability(prevS, elapsedDays, w);

    // Difficulty update (FSRS-6: linear damping + mean reversion toward D0(Easy)).
    const deltaD = -wAt(w, 6) * (g - 3);
    const nextD = prevD + deltaD * (10 - prevD) / 9;
    difficulty = clamp(wAt(w, 7) * difficulty0(4, w) + (1 - wAt(w, 7)) * nextD, 1, 10);

    if (g === 1) {
      // Lapse: re-derive stability from the forget curve, capped so it can never increase.
      const sForget = wAt(w, 11) * Math.pow(prevD, -wAt(w, 12)) * (Math.pow(prevS + 1, wAt(w, 13)) - 1) * Math.exp(wAt(w, 14) * (1 - r));
      stability = clamp(Math.min(sForget, prevS), S_MIN, S_MAX);
    } else {
      // Recall: stability grows; the increment shrinks for already-stable cards (diminishing returns).
      const hard = g === 2 ? wAt(w, 15) : 1;
      const easy = g === 4 ? wAt(w, 16) : 1;
      const inc = Math.exp(wAt(w, 8)) * (11 - prevD) * Math.pow(prevS, -wAt(w, 9)) * (Math.exp(wAt(w, 10) * (1 - r)) - 1) * hard * easy;
      stability = clamp(prevS * (1 + inc), S_MIN, S_MAX);
    }
  }

  const intervalDays = fsrsInterval(stability, target, w);
  const repetitions = g === 1 ? 0 : schedule.repetitions + 1;
  return {
    easeFactor: schedule.easeFactor, // unused by FSRS; preserved for SM-2 fallback continuity
    intervalDays,
    repetitions,
    dueAt: now + intervalDays * DAY_MS,
    lastReviewedAt: now,
    stability,
    difficulty,
  };
}

/** The predicted next interval (whole days) for each of the 4 buttons — for the review UI. */
export function fsrsPreview(schedule: CardSchedule, now = Date.now(), opts: FsrsOptions = {}): Record<ReviewRating, number> {
  const r: ReviewRating[] = ['again', 'hard', 'good', 'easy'];
  return r.reduce((acc, rating) => { acc[rating] = fsrs(schedule, rating, now, opts).intervalDays; return acc; }, {} as Record<ReviewRating, number>);
}

/** Is this card due for review at `now`? */
export function isDue(schedule: CardSchedule, now = Date.now()): boolean {
  return schedule.dueAt <= now;
}

/** The cards due at `now`, soonest-due first (oldest due date first). */
export function dueCards<T extends { schedule: CardSchedule }>(cards: readonly T[], now = Date.now()): T[] {
  return cards.filter((c) => isDue(c.schedule, now)).sort((a, b) => a.schedule.dueAt - b.schedule.dueAt);
}

export interface StudyStats { total: number; due: number; fresh: number; learning: number; mature: number }

/**
 * Summarise a deck: how many cards total, due now, FRESH (never reviewed), LEARNING (reviewed but
 * interval < 21 days), and MATURE (interval ≥ 21 days — well-remembered). Mirrors the Anki view.
 */
export function studyStats<T extends { schedule: CardSchedule }>(cards: readonly T[], now = Date.now()): StudyStats {
  let due = 0, fresh = 0, learning = 0, mature = 0;
  for (const c of cards) {
    if (isDue(c.schedule, now)) due += 1;
    if (c.schedule.lastReviewedAt === null) fresh += 1;
    else if (c.schedule.intervalDays >= 21) mature += 1;
    else learning += 1;
  }
  return { total: cards.length, due, fresh, learning, mature };
}

/**
 * Validate + normalise a (possibly AI- or client-supplied) list of `{front, back}` cards into safe
 * Flashcards: trim, cap lengths, drop empties, de-duplicate by front, cap the count, and stamp each
 * with a fresh schedule. Accepts a few common shapes (`front/back`, `question/answer`, `q/a`).
 */
export function validateFlashcards(input: unknown, now = Date.now()): Flashcard[] {
  if (!Array.isArray(input)) return [];
  const out: Flashcard[] = [];
  const seen = new Set<string>();
  for (const raw of input.slice(0, MAX_CARDS * 2)) {
    if (!raw || typeof raw !== 'object') continue;
    const r = raw as Record<string, unknown>;
    const frontRaw = r['front'] ?? r['question'] ?? r['q'] ?? r['term'];
    const backRaw = r['back'] ?? r['answer'] ?? r['a'] ?? r['definition'];
    if (typeof frontRaw !== 'string' || typeof backRaw !== 'string') continue;
    const front = frontRaw.trim().slice(0, MAX_FRONT);
    const back = backRaw.trim().slice(0, MAX_BACK);
    if (!front || !back) continue;
    const key = front.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ front, back, schedule: initialSchedule(now) });
    if (out.length >= MAX_CARDS) break;
  }
  return out;
}
