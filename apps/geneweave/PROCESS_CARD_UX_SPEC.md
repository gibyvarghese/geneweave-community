# GeneWeave Chat Process Card UX Specification

## Goal
Replace fragmented step-card rendering with a single, persistent Process Card per assistant turn that:
- Streams live reasoning/progress in one place.
- Shows skills, tool activity, and safeguards coherently.
- Auto-collapses when final response is ready.
- Remains fully inspectable on demand.

This design reduces cognitive load and makes agent behavior understandable for both casual and power users.

---

## Current UX Problems (Observed)
1. Multiple thinking cards appear incrementally, creating visual noise.
2. Reasoning and tools are fragmented across separate cards rather than one narrative.
3. Transition from "thinking" to final response feels jumpy.
4. Users must scroll and reconstruct chronology manually.

---

## Target Interaction Model

### A. One Process Card Per Assistant Message
Each assistant message owns exactly one process card.
- Never spawn multiple thinking cards for one assistant turn.
- Append or replace content inside the same card.

### B. Lifecycle
1. Running
- Card appears immediately when assistant turn starts.
- Status label evolves (Thinking, Using tools, Validating, Finalizing).
- Body updates live.

2. Completed
- Final response bubble is shown prominently.
- Process card auto-collapses to compact summary.

3. Inspectable
- User can expand collapsed card to see complete timeline.
- Timeline includes thought updates, skills, tools, checks, and durations.

---

## UI Architecture

### Component Tree (per assistant turn)
- AssistantMessage
  - ProcessCard (single)
    - Header
      - StatusBadge
      - ElapsedTime
      - SummaryChips (on complete)
      - ExpandCollapseToggle
    - Body (expanded)
      - LiveThoughtRow (single, replace-in-place)
      - SkillsSection
      - ToolTimelineSection
      - ValidationSection (guardrail/eval/cognitive)
      - ErrorSection (if any)
  - FinalResponseBubble

### Header States
- Thinking
- Using Tools
- Validating
- Finalizing
- Completed
- Error

### Summary Chips (collapsed)
- Skills: N
- Tools: N
- Checks: pass/warn/deny
- Duration: 12.4s

---

## State Machine

### ProcessCardState
- idle (not yet shown)
- running
- completed
- error

### ExpansionState
- expanded (default while running)
- collapsed (default after completed)

### Internal Substate
- stage: thinking | tools | validating | finalizing | completed | error

### Transitions
1. idle -> running
- Trigger: assistant placeholder message created.

2. running(stage=thinking) -> running(stage=tools)
- Trigger: first tool-related event or step tool_call.

3. running -> running(stage=validating)
- Trigger: guardrail/eval/cognitive event arrives.

4. running -> completed
- Trigger: done event received.
- Action: auto-collapse card after final bubble appears.

5. running -> error
- Trigger: error event.

6. completed/error <-> expanded/collapsed
- Trigger: user toggle.

---

## Event-to-UI Mapping

The following maps current runtime event types (from chat streaming and metadata) to Process Card behavior.

### Stream Events
1. text
- Appends to final response buffer.
- Does not create new process rows.
- Stage can remain finalizing once response text begins.

2. reasoning
- Updates LiveThoughtRow text in place.
- Replace with subtle transition animation (not append as new row).
- Set stage to thinking.

3. step
- If step.type=thinking:
  - Update LiveThoughtRow with latest content.
  - Keep only latest visible thought in primary row.
  - Store historical thought entries in hidden timeline history.
- If step.type=tool_call:
  - Upsert tool timeline item for tool name + input/output/duration.
  - Set stage to tools.
- If step.type=delegation:
  - Add delegation entry in timeline.
  - Set stage to tools.

4. tool_start / tool_end
- Upsert the same timeline item by tool correlation key.
- tool_start: status=running.
- tool_end: status=done and attach result/duration.

5. redaction
- Add validation chip/row in ValidationSection.

6. guardrail
- Add guardrail row and decision badge.
- Set stage to validating.

7. cognitive
- Add cognitive summary row and confidence.
- Set stage to validating.

8. eval
- Add eval summary row and score.
- Set stage to validating.

9. done
- Finalize elapsed metrics.
- Mark state completed.
- Collapse card automatically (unless user is actively inspecting it).

10. error
- Mark state error and show concise error row.
- Keep card expanded by default.

### Metadata (History Load)
When loading persisted messages, construct Process Card model from metadata:
- activeSkills
- skillTools
- enabledTools
- skillPromptApplied
- steps
- eval
- cognitive
- guardrail

If only historical steps exist (no stream events), render identical process timeline from metadata.

---

## Data Model (Frontend)

### Per Assistant Message Runtime Shape (proposed)
- process: {
  - state: 'running' | 'completed' | 'error'
  - stage: 'thinking' | 'tools' | 'validating' | 'finalizing' | 'completed' | 'error'
  - expanded: boolean
  - startedAtMs: number
  - finishedAtMs?: number
  - liveThought?: {
    - text: string
    - updatedAtMs: number
  }
  - thoughtHistory: Array<{
    - text: string
    - atMs: number
  }>
  - skills: Array<{
    - id: string
    - name: string
    - category?: string
    - score?: number
    - tools?: string[]
  }>
  - skillEffects: {
    - promptInjected: boolean
    - skillTools: string[]
  }
  - tools: Array<{
    - id: string
    - name: string
    - status: 'running' | 'done' | 'error'
    - inputSummary?: string
    - outputSummary?: string
    - startedAtMs?: number
    - endedAtMs?: number
    - durationMs?: number
  }>
  - validations: {
    - redaction?: any
    - guardrail?: any
    - cognitive?: any
    - eval?: any
  }
  - errors: Array<{ message: string; atMs: number }>
  - summary: {
    - skillCount: number
    - toolCount: number
    - elapsedMs: number
  }
- }

Notes:
- This can live only in UI state; no DB schema changes required initially.
- Persisted metadata already contains sufficient data for hydrated history.

---

## Visual/Motion Specification

### Motion
1. Live thought replacement
- 160-220ms fade/translate between old/new text.

2. Tool row add/update
- New row: 140ms slide/fade in.
- Status change running->done: color + icon transition.

3. Auto-collapse on completion
- 180-240ms height transition.
- Respect prefers-reduced-motion.

### Hierarchy
- Final response remains primary visual focus.
- Process card is secondary but discoverable.
- Collapsed summary should be one-line readable.

### Density Rules
- Max 1 live thought row visible in running state.
- Tool timeline entries scroll internally if long.
- Long JSON payloads collapsed behind "view input/output" toggles.

---

## Copy Guidelines

### Stage labels
- Interpreting request
- Running tools
- Validating output
- Finalizing answer
- Completed

### Tool summaries
- Use plain language summaries, not raw JSON by default.
- Provide raw details only in expandable sub-panels.

### Skills copy
- "Skills Invoked" with confidence badges.
- "Applied effects" row:
  - Prompt guidance injected
  - Enabled tools: calculator, ...

---

## Accessibility
1. Process card header toggle is keyboard accessible and has aria-expanded.
2. Stage label updates announced via polite live region.
3. Color is not sole channel for status (icons + text labels required).
4. Motion disabled/reduced when prefers-reduced-motion is set.

---

## Implementation Plan

### Phase 1: Behavior consolidation (no visual redesign risk)
1. Introduce per-message process state container in chat renderer.
2. Stop rendering multiple thinking cards; replace in-place thought content.
3. Normalize tool events into a single timeline list.
4. Add completion auto-collapse.

### Phase 2: Skills/tools/validation integration
1. Integrate skills section into process card body.
2. Merge guardrail/eval/cognitive/redaction into validation section.
3. Build collapsed summary chips.

### Phase 3: Polish
1. Add micro-animations.
2. Add expanded detailed view and JSON reveal controls.
3. Add reduced-motion and keyboard polish.

---

## File-Level Change Plan

Primary UI logic lives in:
- [apps/geneweave/src/ui.ts](apps/geneweave/src/ui.ts)

Primary stream event source lives in:
- [apps/geneweave/src/chat.ts](apps/geneweave/src/chat.ts)

Likely touch points in UI file:
1. Assistant message runtime update loop in sendMessage stream handler.
2. normalizeLoadedMessage hydration.
3. renderMessages assistant extras block.
4. CSS sections for step cards / badges.

No required backend DB schema changes for this UX refactor.

---

## Acceptance Criteria

1. Exactly one process card per assistant turn while running.
2. Thinking updates do not create new cards; they replace current live thought.
3. Tool activity appears in the same process card timeline.
4. Skills are shown inside process card, not detached as separate flow elements.
5. On completion, process card auto-collapses and final response remains primary.
6. User can expand collapsed process card and inspect complete chronology.
7. Historical messages render equivalent process timeline from metadata.
8. No visual regressions for direct mode responses without steps.

---

## E2E Test Scenarios (Playwright)

1. Supervisor mode, dataset prompt
- Assert one process card while streaming.
- Assert live thought content changes over time but card count stays 1.
- Assert tools appear inside same process card timeline.
- Assert auto-collapse on done.
- Expand and assert full history visible.

2. Agent mode prompt with tool calls
- Same assertions as above.

3. Direct mode prompt
- No process card or minimal "no process events" card depending on policy.

4. Error path
- Process card shows error state and remains expandable.

5. Accessibility
- Keyboard toggle works.
- aria-expanded updates.

---

## Product Decision Toggles (recommended)

Add two optional user preferences:
1. Process details default
- Auto-collapse (default)
- Always expanded

2. Detail depth
- Compact (default)
- Verbose (shows raw tool payloads inline)

---

## Why This Works
This model gives novice users a clear and calm narrative while preserving deep inspectability for advanced users. It aligns with modern agent UX patterns: transparent, progressive, and non-disruptive.
