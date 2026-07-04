// SPDX-License-Identifier: MIT
/**
 * geneWeave (weaveNotes) — the SYSTEM TEMPLATES.
 *
 * A new note shouldn't start as a blank page. weaveNotes ships a set of ready-made starting points
 * matching the proven note-taking methods — Cornell, meeting minutes, a study/revision sheet, an
 * active-recall planner, an outline, a mind-map, a comparison sheet, a Zettelkasten "smart note",
 * a "start messy" action board, a daily planner, a project brief, and a blank page. This module is
 * the SINGLE SOURCE OF TRUTH for them, as plain data: each template is just a `doc_json`
 * (ProseMirror/Tiptap) document built from the SAME blocks the editor renders, so the app's seed
 * migration, the template gallery, and the AI's `new_from_template` tool all share one definition
 * and can never drift.
 *
 * --- For someone new to this ---
 * A "template" here is a pre-filled note: pick "Meeting minutes" and you get a page already laid
 * out with an objective, attendees, an agenda, and an action-items checklist — you just fill in
 * the blanks. The action items are a real to-do list, so they flow into your tasks automatically.
 *
 * Pure data + pure helpers (no DOM, no framework). Zero-dependency.
 */

// The generic ProseMirror doc types live in the framework's note-doc module now.
import type { PMNode, PMDoc } from '@weaveintel/notes';

export type TemplateCategory =
  | 'Blank' | 'Engineering' | 'Product' | 'Design' | 'Planning' | 'Meetings'
  | 'Knowledge' | 'Thinking' | 'Study' | 'Personal';

/** One system template: its stable key, label, icon, category, one-line description + the doc. */
export interface NoteTemplate {
  key: string;
  title: string;
  icon: string;
  category: TemplateCategory;
  description: string;
  doc: PMDoc;
}

// ─── tiny ProseMirror builders (keep the template docs readable) ────────────────────────────────
const t = (text: string, marks?: PMNode['marks']): PMNode => ({ type: 'text', text, ...(marks ? { marks } : {}) });
const bold = (text: string): PMNode => t(text, [{ type: 'bold' }]);
const p = (...inline: Array<PMNode | string>): PMNode => ({ type: 'paragraph', content: inline.map((x) => (typeof x === 'string' ? t(x) : x)) });
const empty = (): PMNode => ({ type: 'paragraph' });
const h = (level: number, text: string): PMNode => ({ type: 'heading', attrs: { level }, content: [t(text)] });
const bullets = (...items: string[]): PMNode => ({ type: 'bulletList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const ordered = (...items: string[]): PMNode => ({ type: 'orderedList', content: items.map((i) => ({ type: 'listItem', content: [p(i)] })) });
const todos = (...items: string[]): PMNode => ({ type: 'taskList', content: items.map((i) => ({ type: 'taskItem', attrs: { checked: false }, content: [p(i)] })) });
const callout = (tone: string, ...inline: Array<PMNode | string>): PMNode => ({ type: 'callout', attrs: { tone }, content: [p(...inline)] });
const toggle = (summary: string, ...body: PMNode[]): PMNode => ({ type: 'toggle', attrs: { summary, open: true }, content: body.length ? body : [empty()] });
const quote = (text: string): PMNode => ({ type: 'blockquote', content: [p(text)] });
const code = (text: string): PMNode => ({ type: 'codeBlock', content: [t(text)] });
const hr = (): PMNode => ({ type: 'horizontalRule' });
/** A table with a header row + body rows (each a list of plain-text cells). Used for grids like SWOT / journeys. */
const table = (headers: string[], rows: string[][]): PMNode => ({
  type: 'table',
  content: [
    { type: 'tableRow', content: headers.map((cell) => ({ type: 'tableHeader', content: [p(cell)] })) },
    ...rows.map((r) => ({ type: 'tableRow', content: r.map((cell) => ({ type: 'tableCell', content: [p(cell)] })) })),
  ],
});
const doc = (...content: PMNode[]): PMDoc => ({ type: 'doc', content });

// ─── The templates ──────────────────────────────────────────────────────────────────────────────
export const SYSTEM_TEMPLATES: readonly NoteTemplate[] = [
  {
    key: 'blank', title: 'Blank note', icon: '📄', category: 'Blank',
    description: 'A clean page — start however you like.',
    doc: doc(h(1, 'Untitled'), empty()),
  },
  {
    key: 'cornell', title: 'Cornell notes', icon: '📓', category: 'Study',
    description: 'The classic cue / notes / summary layout for lectures + study.',
    doc: doc(
      h(1, 'Cornell notes'),
      p(bold('Topic: '), '…', t('   ·   '), bold('Date: '), '…'),
      callout('tip', 'Take notes on the right while you read or listen. Afterwards, write CUE questions on the left, and a short SUMMARY at the bottom — then quiz yourself with the cues covered.'),
      h(2, 'Cues / questions'),
      bullets('What is …?', 'Why does … matter?', 'How does … work?'),
      h(2, 'Notes'),
      bullets('Key point …', 'Detail …', 'Example …'),
      h(2, 'Summary'),
      callout('note', 'In one or two sentences, what is the main idea?'),
    ),
  },
  {
    key: 'meeting-minutes', title: 'Meeting minutes', icon: '🗒️', category: 'Meetings',
    description: 'Objective, attendees, agenda, discussion + an action-items checklist that feeds your tasks.',
    doc: doc(
      h(1, 'Meeting minutes'),
      p(bold('Objective: '), '…'),
      p(bold('Date / time: '), '…', t('   ·   '), bold('Location: '), '…'),
      h(2, 'Attendees'),
      bullets('You', 'Name — role', 'Name — role'),
      h(2, 'Agenda'),
      ordered('Item one', 'Item two', 'Item three'),
      h(2, 'Discussion'),
      bullets('Point discussed …', 'Decision made …'),
      h(2, 'Action items'),
      callout('tip', 'Tick these off as to-dos — they become tasks you can track.'),
      todos('Owner — do … by <date>', 'Owner — do … by <date>'),
      h(2, 'Parking lot'),
      bullets('Idea to revisit later …'),
      h(2, 'Next meeting'),
      p(bold('When: '), '…', t('   ·   '), bold('Agenda: '), '…'),
    ),
  },
  {
    key: 'study-sheet', title: 'Study / revision sheet', icon: '📚', category: 'Study',
    description: 'Definitions, key concepts, important questions + formulas — built for revision.',
    doc: doc(
      h(1, 'Study sheet — <topic>'),
      callout('note', 'Definition: …'),
      h(2, 'Key concepts'),
      ordered('Concept one — …', 'Concept two — …', 'Concept three — …'),
      h(2, 'Important questions'),
      bullets('Q: … ?', 'Q: … ?'),
      h(2, 'Formulas / facts'),
      code('formula = …'),
      callout('tip', 'When this is ready, open Study (flashcards) to quiz yourself with spaced repetition.'),
    ),
  },
  {
    key: 'active-recall', title: 'Active-recall planner', icon: '🧠', category: 'Study',
    description: 'A spaced-repetition schedule + recall checklist that turns into flashcards.',
    doc: doc(
      h(1, 'Active-recall planner — <topic>'),
      h(2, 'Spaced-repetition schedule'),
      callout('tip', 'Review on a widening schedule so it sticks with the least effort.'),
      todos('Day 1 — first review', 'Day 3 — second review', 'Day 7 — third review', 'Day 14 — fourth review'),
      h(2, 'Recall checklist'),
      todos('Can I explain … from memory?', 'Can I give an example of …?', 'Can I answer the tricky question about …?'),
      callout('note', 'Use Study → Make flashcards to generate a deck from your notes and review it here.'),
    ),
  },
  {
    key: 'outline', title: 'Outline', icon: '🪜', category: 'Thinking',
    description: 'A clean hierarchical outline for structured writing or lectures.',
    doc: doc(
      h(1, 'Outline'),
      { type: 'bulletList', content: [
        { type: 'listItem', content: [p('Main point I'), { type: 'bulletList', content: [
          { type: 'listItem', content: [p('Supporting detail')] },
          { type: 'listItem', content: [p('Example')] },
        ] }] },
        { type: 'listItem', content: [p('Main point II'), { type: 'bulletList', content: [
          { type: 'listItem', content: [p('Supporting detail')] },
        ] }] },
        { type: 'listItem', content: [p('Main point III')] },
      ] },
    ),
  },
  {
    key: 'mind-map', title: 'Mind-map', icon: '🕸️', category: 'Thinking',
    description: 'A central idea with branches — and a tip to turn it into a real diagram.',
    doc: doc(
      h(1, '<central idea>'),
      callout('tip', 'Select this and use ✦ Visualize → diagram (mind-map) to draw it as a real, colour-coded map.'),
      h(2, 'Branch 1'),
      bullets('sub-idea', 'sub-idea'),
      h(2, 'Branch 2'),
      bullets('sub-idea', 'sub-idea'),
      h(2, 'Branch 3'),
      bullets('sub-idea'),
    ),
  },
  {
    key: 'comparison', title: 'Comparison / charting', icon: '📊', category: 'Thinking',
    description: 'Compare options side by side — or spin up a real table with Databases.',
    doc: doc(
      h(1, 'Comparison — A vs B'),
      callout('tip', 'For a sortable table with typed columns, use 🗃 Databases. This page is the quick version.'),
      h(2, 'Option A'),
      bullets('Pro: …', 'Pro: …', 'Con: …'),
      h(2, 'Option B'),
      bullets('Pro: …', 'Con: …', 'Con: …'),
      h(2, 'Verdict'),
      callout('success', 'Recommendation: …'),
    ),
  },
  {
    key: 'zettelkasten', title: 'Zettelkasten / smart note', icon: '🗃️', category: 'Thinking',
    description: 'A single linked idea — fleeting/permanent/literature/project — with retrieval cues.',
    doc: doc(
      h(1, '<one idea, in your own words>'),
      callout('note', 'Note type: fleeting · permanent · literature · project   (delete the rest)'),
      h(2, 'The idea'),
      p('State ONE idea clearly and atomically — small enough to link, big enough to matter.'),
      h(2, 'Links'),
      bullets('Builds on [[another note]]', 'Contrasts with [[another note]]', 'Leads to [[a new question]]'),
      h(2, 'Source'),
      p(bold('Reference: '), '…'),
      h(2, 'Retrieval cues'),
      bullets('Keyword …', 'When would I reach for this? …'),
    ),
  },
  {
    key: 'action-board', title: 'Action board (start messy)', icon: '🚀', category: 'Planning',
    description: 'Pick one idea → smallest version → ship → adjust → repeat. Beat the blank page.',
    doc: doc(
      h(1, 'Action board'),
      callout('tip', 'Momentum beats perfection. Pick ONE idea, ship the smallest version, then adjust.'),
      toggle('1 · Pick one idea', bullets('Idea …', 'Idea …'), p('→ The one I’ll do now: …')),
      toggle('2 · Smallest version', todos('The tiniest shippable step', 'And the next tiny step')),
      toggle('3 · Ship', p('What “done for now” looks like: …')),
      toggle('4 · Adjust', p('What I learned · what changes next round: …')),
      hr(),
      quote('Repeat. Done is better than perfect.'),
    ),
  },
  {
    key: 'daily-planner', title: 'Daily planner', icon: '📅', category: 'Planning',
    description: 'Top priorities, schedule, and notes for the day.',
    doc: doc(
      h(1, 'Daily plan — <date>'),
      h(2, 'Top 3 priorities'),
      todos('Most important thing', 'Second', 'Third'),
      h(2, 'Schedule'),
      bullets('09:00 — …', '11:00 — …', '14:00 — …'),
      h(2, 'To-dos'),
      todos('…', '…'),
      h(2, 'Notes'),
      empty(),
    ),
  },
  {
    key: 'project-brief', title: 'Project brief', icon: '📋', category: 'Planning',
    description: 'Objective, scope, milestones, risks + stakeholders for a new project.',
    doc: doc(
      h(1, 'Project brief — <name>'),
      callout('note', 'One-line summary: …'),
      h(2, 'Objective'),
      p('What success looks like: …'),
      h(2, 'Scope'),
      bullets('In scope: …', 'Out of scope: …'),
      h(2, 'Milestones'),
      todos('Milestone 1 — <date>', 'Milestone 2 — <date>'),
      h(2, 'Risks'),
      bullets('Risk … → mitigation …'),
      h(2, 'Stakeholders'),
      bullets('Owner — …', 'Reviewer — …'),
    ),
  },

  // ─── Engineering ───────────────────────────────────────────────────────────────
  {
    key: 'solution-architecture', title: 'Solution architecture document', icon: '🏛️', category: 'Engineering',
    description: 'The end-to-end technical design of a system — context, components, data, and the key decisions.',
    doc: doc(
      h(1, 'Solution architecture — <system>'),
      callout('note', 'One-paragraph summary: what this system does and the shape of the solution.'),
      p(bold('Author: '), '…', t('   ·   '), bold('Status: '), 'Draft', t('   ·   '), bold('Last updated: '), '…'),
      h(2, '1. Context & goals'),
      p('The business problem, who it serves, and what “good” looks like.'),
      bullets('Goal: …', 'Goal: …', 'Non-goal: …'),
      h(2, '2. Requirements'),
      bullets('Functional: …', 'Non-functional (scale, latency, availability): …', 'Constraints (budget, compliance, tech): …'),
      h(2, '3. High-level architecture'),
      callout('tip', 'Sketch the components with ✦ Visualize → Diagram, or drop an image. Then describe each below.'),
      bullets('Client / UI …', 'API / services …', 'Data stores …', 'Integrations / third parties …'),
      h(2, '4. Components'),
      table(['Component', 'Responsibility', 'Tech', 'Notes'], [
        ['…', '…', '…', '…'],
        ['…', '…', '…', '…'],
      ]),
      h(2, '5. Data model & flow'),
      bullets('Key entities: …', 'How data moves through the system: …', 'Storage + retention: …'),
      h(2, '6. Cross-cutting concerns'),
      bullets('Security & authz: …', 'Scalability & performance: …', 'Observability (logs/metrics/traces): …', 'Reliability & failure modes: …'),
      h(2, '7. Key decisions & trade-offs'),
      table(['Decision', 'Options considered', 'Choice + why'], [['…', '…', '…']]),
      h(2, '8. Risks & open questions'),
      bullets('Risk … → mitigation …', 'Open question … → owner …'),
      h(2, '9. Rollout & milestones'),
      todos('Milestone 1 — <date>', 'Milestone 2 — <date>'),
    ),
  },
  {
    key: 'technical-design', title: 'Technical design document', icon: '📐', category: 'Engineering',
    description: 'A focused design doc for a feature or service: problem, approach, API, testing, rollout.',
    doc: doc(
      h(1, 'Technical design — <feature>'),
      p(bold('Author: '), '…', t('   ·   '), bold('Reviewers: '), '…', t('   ·   '), bold('Status: '), 'Draft'),
      callout('note', 'TL;DR: the problem and the proposed approach in three sentences.'),
      h(2, 'Background & problem'),
      p('What exists today and why it needs to change.'),
      h(2, 'Goals / non-goals'),
      bullets('Goal: …', 'Non-goal: …'),
      h(2, 'Proposed approach'),
      p('The design in prose. Reference the diagram and the components involved.'),
      h(2, 'API / interface'),
      code('POST /api/… → { … }'),
      h(2, 'Alternatives considered'),
      bullets('Alternative … — rejected because …'),
      h(2, 'Testing strategy'),
      bullets('Unit: …', 'Integration / e2e: …', 'Edge cases: …'),
      h(2, 'Rollout & monitoring'),
      todos('Feature-flag + gradual rollout', 'Dashboards / alerts to add', 'Rollback plan'),
    ),
  },
  {
    key: 'adr', title: 'Architecture decision record (ADR)', icon: '⚖️', category: 'Engineering',
    description: 'Capture one significant decision — context, the choice, and its consequences.',
    doc: doc(
      h(1, 'ADR-000 — <decision title>'),
      p(bold('Status: '), 'Proposed · Accepted · Superseded', t('   ·   '), bold('Date: '), '…'),
      h(2, 'Context'),
      p('The forces at play — technical, business, and team — that make a decision necessary.'),
      h(2, 'Decision'),
      callout('success', 'We will …'),
      h(2, 'Consequences'),
      bullets('Positive: …', 'Negative / trade-off: …', 'Follow-ups this creates: …'),
      h(2, 'Alternatives considered'),
      bullets('Option … — not chosen because …'),
    ),
  },
  {
    key: 'postmortem', title: 'Incident postmortem', icon: '🚨', category: 'Engineering',
    description: 'A blameless write-up of an incident: timeline, impact, root cause, and action items.',
    doc: doc(
      h(1, 'Postmortem — <incident>'),
      callout('warning', 'Blameless. We analyse systems and processes, not people.'),
      p(bold('Severity: '), '…', t('   ·   '), bold('Duration: '), '…', t('   ·   '), bold('Author: '), '…'),
      h(2, 'Summary'),
      p('What happened, in a few sentences.'),
      h(2, 'Impact'),
      bullets('Who / what was affected: …', 'For how long: …', 'Customer / revenue impact: …'),
      h(2, 'Timeline'),
      bullets('HH:MM — detection …', 'HH:MM — mitigation …', 'HH:MM — resolution …'),
      h(2, 'Root cause'),
      p('The underlying cause (use the “5 whys”).'),
      h(2, 'What went well / what didn’t'),
      bullets('Went well: …', 'Didn’t: …'),
      h(2, 'Action items'),
      todos('Owner — prevent recurrence by <date>', 'Owner — improve detection by <date>'),
    ),
  },
  {
    key: 'runbook', title: 'Runbook / playbook', icon: '📗', category: 'Engineering',
    description: 'Step-by-step operational instructions for a recurring or on-call task.',
    doc: doc(
      h(1, 'Runbook — <task or alert>'),
      callout('note', 'When to use this runbook: …'),
      h(2, 'Prerequisites'),
      bullets('Access / permissions needed: …', 'Tools: …'),
      h(2, 'Steps'),
      ordered('Check … ', 'If X, then … ', 'Verify … ', 'If it still fails, escalate to …'),
      h(2, 'Verification'),
      todos('Confirm the service is healthy', 'Confirm alerts have cleared'),
      h(2, 'Rollback'),
      p('How to undo the change safely: …'),
      h(2, 'Escalation'),
      bullets('Primary on-call: …', 'Secondary / owner: …'),
    ),
  },

  // ─── Product ───────────────────────────────────────────────────────────────────
  {
    key: 'prd', title: 'Product requirements document (PRD)', icon: '📦', category: 'Product',
    description: 'The problem, users, requirements, and success metrics for a product or feature.',
    doc: doc(
      h(1, 'PRD — <product / feature>'),
      p(bold('Author: '), '…', t('   ·   '), bold('Status: '), 'Draft', t('   ·   '), bold('Target release: '), '…'),
      callout('note', 'Problem statement: what user problem are we solving, and why now?'),
      h(2, 'Background & opportunity'),
      p('Context, market, and the size of the opportunity.'),
      h(2, 'Goals & success metrics'),
      bullets('Goal: … — measured by …', 'Non-goal: …'),
      h(2, 'Target users & use cases'),
      bullets('Persona … wants to … so that …'),
      h(2, 'Requirements'),
      table(['Priority', 'Requirement', 'Notes'], [
        ['P0', 'Must have: …', '…'],
        ['P1', 'Should have: …', '…'],
        ['P2', 'Nice to have: …', '…'],
      ]),
      h(2, 'User stories'),
      todos('As a …, I can … so that …', 'As a …, I can … so that …'),
      h(2, 'Out of scope'),
      bullets('Not doing … (for now)'),
      h(2, 'Open questions'),
      bullets('…'),
    ),
  },
  {
    key: 'roadmap', title: 'Product roadmap', icon: '🗺️', category: 'Product',
    description: 'What you’re building now, next, and later — grouped by horizon with themes.',
    doc: doc(
      h(1, 'Roadmap — <product>'),
      callout('tip', 'Roadmaps are about outcomes, not dates. Group by Now / Next / Later and revisit often.'),
      h(2, 'Now'),
      todos('Theme — the outcome we want …', '…'),
      h(2, 'Next'),
      bullets('Theme — why it matters …', '…'),
      h(2, 'Later'),
      bullets('Idea — under consideration …'),
      h(2, 'Recently shipped'),
      bullets('… (with the impact it had)'),
    ),
  },
  {
    key: 'customer-journey', title: 'Customer journey map', icon: '🧭', category: 'Product',
    description: 'Map each stage of a customer’s experience — their actions, thoughts, pains, and your opportunities.',
    doc: doc(
      h(1, 'Customer journey — <persona / scenario>'),
      callout('note', 'Persona: …   ·   Scenario / goal: …'),
      h(2, 'Journey stages'),
      table(['Stage', 'Doing', 'Thinking / feeling', 'Pain points', 'Opportunities'], [
        ['Awareness', '…', '…', '…', '…'],
        ['Consideration', '…', '…', '…', '…'],
        ['Onboarding', '…', '…', '…', '…'],
        ['Usage', '…', '…', '…', '…'],
        ['Support / renewal', '…', '…', '…', '…'],
      ]),
      h(2, 'Moments that matter'),
      bullets('The make-or-break moment: …', 'The moment of delight: …'),
      h(2, 'Top opportunities'),
      todos('Fix the biggest pain: …', 'Amplify the delight: …'),
    ),
  },
  {
    key: 'user-research', title: 'User research / interview', icon: '🔬', category: 'Product',
    description: 'Plan and capture a user interview — questions, verbatim notes, and the insights you draw.',
    doc: doc(
      h(1, 'User interview — <participant>'),
      p(bold('Date: '), '…', t('   ·   '), bold('Segment: '), '…', t('   ·   '), bold('Goal of this study: '), '…'),
      h(2, 'Questions'),
      ordered('Tell me about the last time you … ', 'What was hardest about … ?', 'What did you do next?'),
      h(2, 'Notes (verbatim)'),
      quote('“…” — the participant’s own words'),
      bullets('Observation …', 'Surprise …'),
      h(2, 'Insights'),
      callout('success', 'Insight: … (backed by what they said/did)'),
      h(2, 'Follow-ups'),
      todos('Share clip / quote with the team', 'Update the persona if needed'),
    ),
  },
  {
    key: 'personas', title: 'User persona', icon: '🧑', category: 'Product',
    description: 'A grounded profile of a target user — goals, frustrations, and how they’d use your product.',
    doc: doc(
      h(1, 'Persona — <name, the archetype>'),
      callout('note', 'A short bio: who they are and their context.'),
      h(2, 'Goals'),
      bullets('Wants to …', 'Cares most about …'),
      h(2, 'Frustrations'),
      bullets('Struggles with …', 'Gets blocked by …'),
      h(2, 'Behaviours & context'),
      bullets('Tools they use today: …', 'How tech-savvy: …', 'When / where they’d use us: …'),
      h(2, 'How we help'),
      p('The one sentence that makes this persona choose us: …'),
    ),
  },
  {
    key: 'competitive-analysis', title: 'Competitive analysis', icon: '🥊', category: 'Product',
    description: 'Compare competitors on the dimensions that matter, and find your wedge.',
    doc: doc(
      h(1, 'Competitive analysis — <market>'),
      h(2, 'Landscape'),
      table(['Competitor', 'Strengths', 'Weaknesses', 'Price', 'Our angle'], [
        ['…', '…', '…', '…', '…'],
        ['…', '…', '…', '…', '…'],
      ]),
      h(2, 'Where we win'),
      callout('success', 'Our wedge: …'),
      h(2, 'Where we’re behind'),
      bullets('Gap … → plan …'),
    ),
  },

  // ─── Design ────────────────────────────────────────────────────────────────────
  {
    key: 'design-doc', title: 'Design document', icon: '🎨', category: 'Design',
    description: 'Frame a design problem, explore directions, and record the rationale behind the chosen design.',
    doc: doc(
      h(1, 'Design doc — <feature / flow>'),
      p(bold('Designer: '), '…', t('   ·   '), bold('Status: '), 'Exploring'),
      callout('note', 'Problem: what are we designing, and for whom?'),
      h(2, 'Principles & constraints'),
      bullets('Must respect …', 'Brand / accessibility: …', 'Platform constraints: …'),
      h(2, 'Explorations'),
      toggle('Direction A', p('Idea …'), bullets('Pro …', 'Con …')),
      toggle('Direction B', p('Idea …'), bullets('Pro …', 'Con …')),
      h(2, 'Chosen design & rationale'),
      callout('success', 'We’re going with … because …'),
      h(2, 'Flows & states'),
      bullets('Happy path: …', 'Empty / loading / error states: …'),
      h(2, 'Open questions'),
      bullets('…'),
    ),
  },
  {
    key: 'design-critique', title: 'Design critique', icon: '🗣️', category: 'Design',
    description: 'Run a focused critique — what’s working, what’s not, and clear next steps.',
    doc: doc(
      h(1, 'Design critique — <what’s being reviewed>'),
      callout('tip', 'Critique the work, not the person. Ask questions before giving prescriptions.'),
      p(bold('Presenter: '), '…', t('   ·   '), bold('Goal for feedback: '), '…'),
      h(2, 'What’s working'),
      bullets('…'),
      h(2, 'What’s not / questions'),
      bullets('…'),
      h(2, 'Suggestions'),
      bullets('…'),
      h(2, 'Decisions & next steps'),
      todos('Owner — change … by <date>'),
    ),
  },

  // ─── Meetings ──────────────────────────────────────────────────────────────────
  {
    key: 'one-on-one', title: '1:1 meeting', icon: '🤝', category: 'Meetings',
    description: 'A recurring 1:1 agenda — wins, challenges, feedback both ways, and follow-ups.',
    doc: doc(
      h(1, '1:1 — <names>'),
      p(bold('Date: '), '…'),
      h(2, 'Wins since last time'),
      bullets('…'),
      h(2, 'Challenges / blockers'),
      bullets('…'),
      h(2, 'Feedback'),
      bullets('For you: …', 'For me: …'),
      h(2, 'Growth & goals'),
      bullets('…'),
      h(2, 'Action items'),
      todos('Owner — … by <date>'),
    ),
  },
  {
    key: 'retro', title: 'Retrospective', icon: '🔄', category: 'Meetings',
    description: 'A team retro — what went well, what didn’t, and the actions to improve next time.',
    doc: doc(
      h(1, 'Retro — <sprint / period>'),
      callout('tip', 'Keep it safe + specific. Turn learnings into a small number of owned actions.'),
      h(2, 'What went well 🟢'),
      bullets('…'),
      h(2, 'What didn’t 🔴'),
      bullets('…'),
      h(2, 'Ideas to try 💡'),
      bullets('…'),
      h(2, 'Action items'),
      todos('Owner — … by <date>', 'Owner — … by <date>'),
    ),
  },
  {
    key: 'standup', title: 'Standup notes', icon: '☀️', category: 'Meetings',
    description: 'A quick daily log — yesterday, today, and any blockers for the team.',
    doc: doc(
      h(1, 'Standup — <date>'),
      h(2, 'Yesterday'),
      bullets('…'),
      h(2, 'Today'),
      bullets('…'),
      h(2, 'Blockers'),
      callout('warning', 'Anything blocking you? Flag it here.'),
      bullets('…'),
    ),
  },
  {
    key: 'brainstorm', title: 'Brainstorm', icon: '💡', category: 'Meetings',
    description: 'Diverge then converge — capture every idea, then cluster and pick what to pursue.',
    doc: doc(
      h(1, 'Brainstorm — <topic>'),
      callout('note', 'The question we’re answering: …'),
      h(2, '1 · Go wide (no bad ideas)'),
      bullets('Idea …', 'Idea …', 'Idea …', 'Wild idea …'),
      h(2, '2 · Cluster'),
      bullets('Theme A: …', 'Theme B: …'),
      h(2, '3 · Pick + commit'),
      todos('The idea we’ll pursue: …', 'Owner + first step: …'),
    ),
  },

  // ─── Planning ──────────────────────────────────────────────────────────────────
  {
    key: 'okrs', title: 'OKRs / goals', icon: '🎯', category: 'Planning',
    description: 'Set an ambitious objective with measurable key results, and track progress.',
    doc: doc(
      h(1, 'OKRs — <quarter / team>'),
      callout('tip', 'One inspiring Objective; 3–5 measurable Key Results. Aim high — ~70% is a great score.'),
      h(2, 'Objective'),
      callout('note', 'Objective: … (qualitative, ambitious, time-bound)'),
      h(2, 'Key results'),
      table(['Key result', 'Start', 'Target', 'Progress'], [
        ['KR1 — …', '…', '…', '0%'],
        ['KR2 — …', '…', '…', '0%'],
        ['KR3 — …', '…', '…', '0%'],
      ]),
      h(2, 'Initiatives'),
      todos('What we’ll do to move the KRs: …'),
    ),
  },
  {
    key: 'swot', title: 'SWOT analysis', icon: '🧮', category: 'Planning',
    description: 'A 2×2 of Strengths, Weaknesses, Opportunities, and Threats to inform strategy.',
    doc: doc(
      h(1, 'SWOT — <subject>'),
      table(['Strengths (internal +)', 'Weaknesses (internal −)'], [
        ['• …', '• …'],
        ['• …', '• …'],
      ]),
      table(['Opportunities (external +)', 'Threats (external −)'], [
        ['• …', '• …'],
        ['• …', '• …'],
      ]),
      h(2, 'So what?'),
      callout('success', 'The strategy this points to: …'),
    ),
  },

  // ─── Knowledge ─────────────────────────────────────────────────────────────────
  {
    key: 'how-to', title: 'How-to guide', icon: '📘', category: 'Knowledge',
    description: 'A clear, numbered guide that gets someone from zero to done.',
    doc: doc(
      h(1, 'How to <do the thing>'),
      callout('note', 'Who this is for + what they’ll have at the end.'),
      h(2, 'Before you start'),
      bullets('You’ll need: …', 'Time required: …'),
      h(2, 'Steps'),
      ordered('First, … ', 'Then, … ', 'Next, … ', 'Finally, …'),
      h(2, 'Troubleshooting'),
      toggle('It didn’t work?', bullets('If you see …, try …', 'Still stuck? Ask …')),
      h(2, 'See also'),
      bullets('[[related note]]'),
    ),
  },
  {
    key: 'faq', title: 'FAQ', icon: '❓', category: 'Knowledge',
    description: 'Frequently asked questions with short, clear answers.',
    doc: doc(
      h(1, 'FAQ — <topic>'),
      toggle('What is …?', p('…')),
      toggle('How do I …?', p('…')),
      toggle('Why does …?', p('…')),
      toggle('Where can I find …?', p('…')),
      callout('tip', 'Add a new toggle for each question people actually ask.'),
    ),
  },

  // ─── Personal ──────────────────────────────────────────────────────────────────
  {
    key: 'journal', title: 'Daily journal', icon: '🌱', category: 'Personal',
    description: 'A gentle daily reflection — gratitude, highlights, and one thing for tomorrow.',
    doc: doc(
      h(1, 'Journal — <date>'),
      h(2, 'Grateful for'),
      bullets('…', '…', '…'),
      h(2, 'Today’s highlight'),
      p('…'),
      h(2, 'On my mind'),
      empty(),
      h(2, 'One thing for tomorrow'),
      todos('…'),
    ),
  },
  {
    key: 'book-notes', title: 'Book / reading notes', icon: '📖', category: 'Personal',
    description: 'Capture the big ideas, favourite quotes, and your takeaways from what you read.',
    doc: doc(
      h(1, '<title> — <author>'),
      p(bold('Type: '), 'Book · Article · Paper', t('   ·   '), bold('Rating: '), '★★★★☆'),
      h(2, 'One-line summary'),
      callout('note', '…'),
      h(2, 'Big ideas'),
      bullets('…', '…', '…'),
      h(2, 'Favourite quotes'),
      quote('“…” (p. …)'),
      h(2, 'My takeaways / how I’ll use this'),
      todos('Try … ', 'Share the idea about … with …'),
    ),
  },
] as const;

const BY_KEY = new Map(SYSTEM_TEMPLATES.map((tpl) => [tpl.key, tpl]));

/** Look up a system template by its stable key. */
export function templateByKey(key: string): NoteTemplate | undefined { return BY_KEY.get(key); }

/** All template categories, in display order, each non-empty. */
export function templateCategories(): TemplateCategory[] {
  const order: TemplateCategory[] = ['Blank', 'Engineering', 'Product', 'Design', 'Planning', 'Meetings', 'Knowledge', 'Thinking', 'Study', 'Personal'];
  return order.filter((c) => SYSTEM_TEMPLATES.some((t2) => t2.category === c));
}

/** The full template list (optionally filtered to a category). */
export function listSystemTemplates(category?: TemplateCategory): NoteTemplate[] {
  return SYSTEM_TEMPLATES.filter((tpl) => !category || tpl.category === category);
}

/** The set of ProseMirror node types a template doc may use (must all be editor-renderable). */
export const TEMPLATE_NODE_TYPES = new Set([
  'doc', 'paragraph', 'text', 'heading', 'bulletList', 'orderedList', 'listItem',
  'taskList', 'taskItem', 'blockquote', 'codeBlock', 'horizontalRule', 'callout', 'toggle',
  'table', 'tableRow', 'tableHeader', 'tableCell',
]);
