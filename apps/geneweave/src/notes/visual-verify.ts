// SPDX-License-Identifier: MIT
/**
 * @weaveintel/notes — VISUAL VERIFICATION (weaveNotes Phase 1: "the right perfect image").
 *
 * --- For someone new to this ---
 * When the assistant DRAWS a diagram or FINDS a picture, we don't just trust it — we CHECK it before
 * showing it to you, then retry if it's wrong. Two checks:
 *
 *   1. DIAGRAM check (text): a second AI "judge" compares your request with the diagram the first AI
 *      drew, and scores how well the boxes + arrows actually cover what you asked for (it lists what's
 *      MISSING and what's EXTRA). If the score is too low, we hand that feedback back and redraw —
 *      up to a couple of times — keeping the best attempt. (Research: Flowchart2Mermaid entity-F1
 *      ≈ 0.99; VisCoder execution-feedback; "How many tries" — 2 retries capture 76–95% of the gain.)
 *
 *   2. IMAGE check (vision): a vision model actually LOOKS at the fetched picture and says whether it
 *      really depicts the subject (and is good quality + appropriate). If not, we try the next
 *      candidate. The prompt forces the model to DESCRIBE what it sees first, which stops it from just
 *      agreeing because you asked for that thing (VLM "sycophancy" is the #1 failure mode).
 *
 * This module is PURE: it builds the judge prompts, parses the verdicts, and decides accept/retry.
 * The actual model calls live in the app (which owns the model router). So it is fully unit-testable
 * with fixed fake replies — no network, no LLM.
 */

// ─── Diagram structural judge ───────────────────────────────────────────────

export interface DiagramVerdict {
  entityF1: number;            // 0..1 — coverage of the requested NODES
  edgeF1: number;              // 0..1 — coverage of the requested RELATIONSHIPS
  directionCorrectness: number;// 0..1 — fraction of matched edges pointing the right way
  intentFit: number;           // 0..1 — is this even the right KIND of diagram for the request?
  overall: number;             // 0..1 — weighted blend (recomputed from the parts, never trusted raw)
  missingEntities: string[];   // requested but absent → fed back into the redraw
  missingEdges: string[];
  extraEntities: string[];     // present but not requested → asked to remove on redraw
  extraEdges: string[];
  verdict: 'accept' | 'retry';
  reasoning: string;
}

/** overall = 0.45·entityF1 + 0.35·edgeF1 + 0.10·direction + 0.10·intentFit (research-recommended blend). */
export const DIAGRAM_WEIGHTS = { entity: 0.45, edge: 0.35, direction: 0.10, intent: 0.10 } as const;
export const DEFAULT_DIAGRAM_THRESHOLD = 0.7;   // accept overall ≥ this (Builder-tunable; research strict bar = 0.85)
export const DEFAULT_MAX_VERIFY_RETRIES = 2;    // 3 attempts total; gains plateau after this
export const VERIFY_EARLY_STOP_DELTA = 0.03;    // stop retrying if a redraw improves < this (avoids oscillation)
export const DEFAULT_IMAGE_MIN_CONFIDENCE = 0.7;

const clamp01 = (n: unknown): number => {
  const x = Number(n);
  return Number.isFinite(x) ? Math.max(0, Math.min(1, x)) : 0;
};
const strArr = (v: unknown): string[] =>
  Array.isArray(v) ? v.map((x) => String(x)).filter(Boolean).slice(0, 40) : [];

/** Build the LLM-as-judge prompt that scores how well a diagram covers the request (semantic, not string-exact). */
export function buildDiagramJudge(request: string, sceneJson: string): { system: string; user: string } {
  const system = `You are a strict diagram-quality judge. Compare a USER REQUEST against a GENERATED DIAGRAM (JSON of nodes + edges) and score how completely and correctly the diagram captures the entities and relationships the request asks for.

Match SEMANTICALLY, not string-exact: ignore node ids (A/B/C), shapes, colours and arrow style; treat an entity/edge as matched if it aligns in meaning even if worded differently. For entities AND edges, count TP (in both), FP (generated but not requested), FN (requested but missing); precision=TP/(TP+FP), recall=TP/(TP+FN), f1=2PR/(P+R) (0/0 = 1 only if both sets empty, else 0).

Score four dimensions 0.0–1.0: entity_f1 (node coverage), edge_f1 (relationship coverage), direction_correctness (fraction of matched edges pointing the right way), intent_fit (is this the right KIND of diagram — e.g. a flow for a process — and NOT, say, boxes-and-arrows for an anatomy request? if the request is to depict a physical object rather than a process, intent_fit is LOW). List missing_entities/missing_edges (the FN sets) and extra_entities/extra_edges (the FP sets) so a redraw can fix them.

Return ONLY JSON: {"entity_f1":0,"edge_f1":0,"direction_correctness":0,"intent_fit":0,"missing_entities":[],"missing_edges":[],"extra_entities":[],"extra_edges":[],"reasoning":"one sentence"}`;
  const user = `USER REQUEST:\n"""\n${request.slice(0, 1500)}\n"""\n\nGENERATED DIAGRAM (JSON):\n"""\n${sceneJson.slice(0, 4000)}\n"""`;
  return { system, user };
}

/** Parse a judge reply into a DiagramVerdict. Robust to extra prose; recomputes `overall` from parts. */
export function parseDiagramVerdict(reply: string, threshold = DEFAULT_DIAGRAM_THRESHOLD): DiagramVerdict {
  let obj: Record<string, unknown> = {};
  try {
    const m = reply.match(/\{[\s\S]*\}/); // first JSON object
    if (m) obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch { /* fall through to zeros */ }
  const entityF1 = clamp01(obj['entity_f1']);
  const edgeF1 = clamp01(obj['edge_f1']);
  const directionCorrectness = clamp01(obj['direction_correctness']);
  const intentFit = clamp01(obj['intent_fit']);
  // Never trust the model's own arithmetic — recompute the blended score from the parts.
  const overall = +(DIAGRAM_WEIGHTS.entity * entityF1 + DIAGRAM_WEIGHTS.edge * edgeF1 +
    DIAGRAM_WEIGHTS.direction * directionCorrectness + DIAGRAM_WEIGHTS.intent * intentFit).toFixed(4);
  return {
    entityF1, edgeF1, directionCorrectness, intentFit, overall,
    missingEntities: strArr(obj['missing_entities']),
    missingEdges: strArr(obj['missing_edges']),
    extraEntities: strArr(obj['extra_entities']),
    extraEdges: strArr(obj['extra_edges']),
    verdict: overall >= threshold ? 'accept' : 'retry',
    reasoning: typeof obj['reasoning'] === 'string' ? obj['reasoning'].slice(0, 280) : '',
  };
}

/** Feedback message for the next redraw — the concrete FN/FP deltas (research: content matters more than the loop). */
export function diagramRegenFeedback(v: DiagramVerdict): string {
  const lines: string[] = [`Your previous diagram scored too low (entity coverage ${v.entityF1.toFixed(2)}, relationship coverage ${v.edgeF1.toFixed(2)}).`];
  if (v.missingEntities.length) lines.push(`ADD these missing items: ${v.missingEntities.join(', ')}.`);
  if (v.missingEdges.length) lines.push(`ADD these missing relationships: ${v.missingEdges.join(', ')}.`);
  if (v.extraEntities.length || v.extraEdges.length) lines.push(`REMOVE these unrequested items: ${[...v.extraEntities, ...v.extraEdges].join(', ')}.`);
  if (v.intentFit < 0.4) lines.push('If the request is to DEPICT a physical object (not a process), a boxes-and-arrows diagram is the wrong format — say so by returning an empty diagram.');
  lines.push('Redraw the FULL diagram, adding every missing item and removing every extra one, keeping what was already correct.');
  return lines.join(' ');
}

/** True if the verdict clears the accept threshold. */
export function diagramAccept(v: DiagramVerdict, threshold = DEFAULT_DIAGRAM_THRESHOLD): boolean {
  return v.overall >= threshold;
}

// ─── Image (vision) relevance judge ─────────────────────────────────────────

export interface ImageVerdict {
  observed: string;        // what the model actually SEES (forced before the verdict → less sycophancy)
  depictsSubject: boolean; // is the requested subject the main content?
  confidence: number;      // 0..1 calibrated
  qualityOk: boolean;      // not blurry / tiny / watermarked placeholder / screenshot
  safe: boolean;           // appropriate for a general-audience document
  reason: string;
}

/** Build the describe-then-verdict VLM prompt. The TEXT part of a multimodal message; the image is attached separately. */
export function buildImageVerify(subject: string): { system: string; user: string } {
  const system = `You are a strict image-relevance verifier. You are shown ONE image and a SUBJECT. Decide whether the image clearly and correctly depicts that SPECIFIC subject, well enough to insert into a document.

Steps IN ORDER: (1) observed — list ONLY what is actually visible (objects, text, setting); do not assume anything not visibly present. (2) Compare the observed content to the SUBJECT — it must be the SPECIFIC subject, not merely something related or in the same category. (3) Decide: depicts_subject (true only if the specific subject is clearly the MAIN content); confidence (0.0–1.0 calibrated — if guessing, stay below 0.7); quality_ok (false if blurry/tiny/watermarked placeholder/stock overlay/screenshot/error); safe (false if nudity/sexual/graphic violence/gore/inappropriate for a general audience); reason (one sentence).

Judge ONLY from what is visible. The fact that the SUBJECT was requested is NOT evidence the image matches — it is correct and expected to answer "no" when it does not match.

Return ONLY JSON: {"observed":"…","depicts_subject":true,"confidence":0.0,"quality_ok":true,"safe":true,"reason":"…"}`;
  const user = `SUBJECT: "${subject.slice(0, 300)}"`;
  return { system, user };
}

/** Parse a VLM reply into an ImageVerdict. Conservative defaults (treat unparseable as a reject). */
export function parseImageVerdict(reply: string): ImageVerdict {
  let obj: Record<string, unknown> = {};
  try {
    const m = reply.match(/\{[\s\S]*\}/);
    if (m) obj = JSON.parse(m[0]) as Record<string, unknown>;
  } catch { /* reject on parse failure */ }
  const asBool = (v: unknown, dflt: boolean): boolean => (typeof v === 'boolean' ? v : dflt);
  return {
    observed: typeof obj['observed'] === 'string' ? obj['observed'].slice(0, 400) : '',
    depictsSubject: asBool(obj['depicts_subject'], false),
    confidence: clamp01(obj['confidence']),
    // quality/safe default to FALSE when absent → unparseable reply can never be accepted.
    qualityOk: asBool(obj['quality_ok'], false),
    safe: asBool(obj['safe'], false),
    reason: typeof obj['reason'] === 'string' ? obj['reason'].slice(0, 280) : '',
  };
}

/** Accept an image only if it depicts the subject with enough confidence AND is good quality AND safe. */
export function imageAccept(v: ImageVerdict, minConfidence = DEFAULT_IMAGE_MIN_CONFIDENCE): boolean {
  return v.depictsSubject && v.confidence >= minConfidence && v.qualityOk && v.safe;
}
