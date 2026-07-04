import { h } from './dom.js';
import {
  detailText,
  summarizeForDisplay,
  parseJsonMaybe,
} from './formatting.js';

function extractWorkerToolTrace(value: unknown): any[] {
  if (typeof value !== 'string') return [];
  const marker = '[WorkerToolTrace]';
  const traceIdx = value.indexOf(marker);
  if (traceIdx < 0) return [];
  const raw = value.slice(traceIdx + marker.length).trim();
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

function parseJsonMaybeLoose(value: unknown): any {
  if (typeof value !== 'string') return value;
  const trimmed = value.trim();
  if (!trimmed || (trimmed[0] !== '{' && trimmed[0] !== '[')) return value;
  try {
    return JSON.parse(trimmed);
  } catch {
    return value;
  }
}

function processStatusTone(status: string) {
  if (status === 'deny' || status === 'fail' || status === 'error') return 'deny';
  if (status === 'warn' || status === 'redacted') return 'warn';
  return 'ok';
}

function extractThoughtText(step: any) {
  if (!step) return '';
  if (step.type === 'thinking') return String(step.text || step.content || '').trim();
  const toolName = step?.toolCall?.name || step?.name || step?.toolName || '';
  if (toolName !== 'think') return '';
  const args = step?.toolCall?.arguments ?? step?.input;
  const result = step?.toolCall?.result ?? step?.result;
  if (typeof result === 'string' && result.trim()) {
    return result.replace(/^\[(PLANNING|REASONING|SYNTHESIS|REFLECTION)\]\s*/, '').trim();
  }
  if (typeof args === 'string' && args.trim()) return args.trim();
  if (args && typeof args === 'object') {
    const candidate = args.reasoning || args.thought || args.content || args.summary || args.prompt || args.goal;
    if (typeof candidate === 'string' && candidate.trim()) return candidate.trim();
  }
  return '';
}

function extractDelegatedWorkerName(value: any): string {
  if (!value) return '';
  if (typeof value === 'object') {
    const worker = value.worker || value.workerName || value.agent || value.name;
    return typeof worker === 'string' ? worker : '';
  }
  if (typeof value === 'string') {
    const parsed = parseJsonMaybe(value);
    if (parsed && typeof parsed === 'object') {
      const worker = (parsed as any).worker || (parsed as any).workerName || (parsed as any).agent || (parsed as any).name;
      return typeof worker === 'string' ? worker : '';
    }
  }
  return '';
}

function processStageMeta(stage: string) {
  if (stage === 'error') return { label: 'Error', icon: '!', tone: 'deny' };
  if (stage === 'completed') return { label: 'Completed', icon: '✓', tone: 'ok' };
  if (stage === 'validating') return { label: 'Validating', icon: '◉', tone: 'warn' };
  if (stage === 'tools') return { label: 'Using Tools', icon: '⚙', tone: 'ok' };
  if (stage === 'finalizing') return { label: 'Finalizing', icon: '↗', tone: 'ok' };
  return { label: 'Thinking', icon: '…', tone: 'ok' };
}

function ensureProcessUiState(msg: any) {
  if (!msg.processUi || typeof msg.processUi !== 'object') {
    msg.processUi = { detailExpanded: Object.create(null) };
  }
  if (!msg.processUi.detailExpanded || typeof msg.processUi.detailExpanded !== 'object') {
    msg.processUi.detailExpanded = Object.create(null);
  }
  return msg.processUi;
}

function buildTimelineItem(
  item: any,
  idx: number,
  processUi: any,
  message: any,
  options: { rerenderMessages: () => void; renderProcessDetailView: (value: any) => HTMLElement },
): HTMLElement {
  const dur = item.durationMs != null ? item.durationMs + 'ms' : '';
  const keyBase = item.key || ('timeline-' + idx);
  const showRaw = !!processUi.detailExpanded[keyBase + '-raw'];
  const showInput = !!processUi.detailExpanded[keyBase + '-input'];
  const showOutput = !!processUi.detailExpanded[keyBase + '-output'];
  const badgeEls = Array.isArray(item.badges) && item.badges.length
    ? h('div', { className: 'timeline-badges' }, ...item.badges.map((badge: any) => h('span', { className: 'timeline-badge ' + (badge.tone || 'ok') }, badge.label)))
    : null;

  const toggleDetail = (key: string) => {
    const ui = ensureProcessUiState(message);
    ui.detailExpanded[key] = !ui.detailExpanded[key];
    options.rerenderMessages();
  };

  return h('div', { className: 'timeline-item ' + item.kind + (item.isWorker ? ' worker' : '') },
    h('div', { className: 't-h' },
      h('span', null, item.title || ('Event ' + (idx + 1))),
      h('span', null, dur)
    ),
    badgeEls,
    item.summary ? h('div', { className: 't-summary' }, item.summary) : null,
    (item.raw || item.inputRaw || item.outputRaw) ? h('div', { className: 't-actions' },
      item.raw ? h('button', {
        className: 'detail-toggle',
        type: 'button',
        'aria-expanded': String(showRaw),
        onClick: () => { toggleDetail(keyBase + '-raw'); },
      }, showRaw ? 'Hide raw ' + (item.detailLabel || 'details') : 'View raw ' + (item.detailLabel || 'details')) : null,
      item.inputRaw ? h('button', {
        className: 'detail-toggle',
        type: 'button',
        'aria-expanded': String(showInput),
        onClick: () => { toggleDetail(keyBase + '-input'); },
      }, showInput ? 'Hide input' : 'View input') : null,
      item.outputRaw ? h('button', {
        className: 'detail-toggle',
        type: 'button',
        'aria-expanded': String(showOutput),
        onClick: () => { toggleDetail(keyBase + '-output'); },
      }, showOutput ? 'Hide output' : 'View output') : null
    ) : null,
    item.raw && showRaw ? h('div', { className: 't-raw' },
      h('div', { className: 't-raw-label' }, 'Raw ' + (item.detailLabel || 'details')),
      options.renderProcessDetailView(item.raw)
    ) : null,
    item.inputRaw && showInput ? h('div', { className: 't-raw' },
      h('div', { className: 't-raw-label' }, 'Tool input'),
      options.renderProcessDetailView(item.inputRaw)
    ) : null,
    item.outputRaw && showOutput ? h('div', { className: 't-raw' },
      h('div', { className: 't-raw-label' }, 'Tool output'),
      options.renderProcessDetailView(item.outputRaw)
    ) : null
  );
}

function buildProcessViewModel(msg: any, isStreamingCurrent: boolean) {
  const steps = Array.isArray(msg.steps) ? msg.steps : [];
  const thoughtHistory: Array<{ text: string; idx: number }> = [];
  const timeline: any[] = [];
  const workerTimeline: any[] = [];
  const cseBadges: Array<{ label: string; tone: string }> = [];
  const seenCseBadges = new Set<string>();
  const cseSessionMap = new Map<string, { sessionId: string; provider: string; runs: number; successes: number; errors: number }>();
  const skills = Array.isArray(msg.activeSkills) ? msg.activeSkills : [];
  const skillEffects: string[] = [];
  const validations: any[] = [];
  const reflectRevisions: Array<{ revision: number; feedback: string }> = [];
  const verifyAttempts: Array<{ attempt: number; reason: string }> = [];

  steps.forEach((s: any, idx: number) => {
    const stepType = s?.type || s?.kind || 'step';
    const thoughtText = extractThoughtText(s);

    // Classify thinking steps: reflection revision, verify failure, or regular thought
    if (stepType === 'thinking') {
      const raw = String(s?.content || s?.text || '').trim();
      const reflectMatch = raw.match(/^\[reflect:revision=(\d+)\]\s*([\s\S]*)/);
      const verifyMatch = raw.match(/^\[verify:failed attempt=(\d+)\]\s*([\s\S]*)/);
      if (reflectMatch) {
        reflectRevisions.push({ revision: parseInt(reflectMatch[1]!, 10), feedback: reflectMatch[2]!.trim() });
        return;
      }
      if (verifyMatch) {
        verifyAttempts.push({ attempt: parseInt(verifyMatch[1]!, 10), reason: verifyMatch[2]!.trim() });
        return;
      }
    }

    if (thoughtText) {
      thoughtHistory.push({ text: thoughtText, idx: idx + 1 });
      timeline.push({
        kind: 'thought',
        title: 'Thought update',
        summary: summarizeForDisplay(thoughtText),
        raw: detailText(thoughtText),
        detailLabel: 'thought',
        durationMs: s?.durationMs,
        key: 'thought-' + idx,
      });
      if (stepType === 'thinking' || (s?.toolCall?.name || s?.name || s?.toolName) === 'think') return;
    }

    if (stepType === 'thinking') return;

    if (s?.kind === 'tool_start' || stepType === 'tool_call') {
      const toolName = s?.name || s?.toolName || s?.toolCall?.name || 'tool';
      const input = s?.input ?? s?.toolCall?.arguments;
      const result = s?.result ?? s?.toolCall?.result;
      const delegatedWorker = toolName === 'delegate_to_worker' ? extractDelegatedWorkerName(input) : '';
      const toolBadges: Array<{ label: string; tone: string }> = [];
      if (toolName === 'cse_run_code' || toolName === 'cse_run_data_analysis') {
        toolBadges.push({ label: 'Code execution', tone: 'ok' });
      }
      if (delegatedWorker) {
        toolBadges.push({ label: 'Worker ' + delegatedWorker, tone: 'warn' });
      }
      timeline.push({
        kind: toolName === 'delegate_to_worker' ? 'delegation' : 'tool',
        title: toolName === 'delegate_to_worker'
          ? 'Delegated to: ' + (delegatedWorker || 'worker')
          : 'Tool: ' + toolName,
        summary: result != null
          ? 'Input: ' + summarizeForDisplay(input) + '\nOutput: ' + summarizeForDisplay(result)
          : 'Input: ' + summarizeForDisplay(input),
        inputRaw: detailText(input),
        outputRaw: detailText(result),
        durationMs: s?.durationMs,
        badges: toolBadges,
        key: 'tool-' + idx,
      });

      const workerTrace = extractWorkerToolTrace(result);
      workerTrace.forEach((entry: any, traceIdx: number) => {
        const parsedResult = parseJsonMaybeLoose(entry?.result);
        const resultRecord = parsedResult && typeof parsedResult === 'object' && !Array.isArray(parsedResult)
          ? parsedResult as Record<string, any>
          : null;
        const cseTone = resultRecord?.['status'] === 'error' ? 'deny' : resultRecord?.['status'] === 'success' ? 'ok' : 'warn';
        const badges: Array<{ label: string; tone: string }> = [];
        if (entry?.name === 'cse_run_code' || entry?.name === 'cse_run_data_analysis') {
          const provider = typeof resultRecord?.['provider'] === 'string' ? resultRecord['provider'] : 'local';
          const sessionId = typeof resultRecord?.['sessionId'] === 'string' ? resultRecord['sessionId'] : '';
          const shortSession = sessionId ? sessionId.slice(0, 8) : '';
          badges.push({ label: 'CSE ' + (resultRecord?.['status'] || 'run'), tone: cseTone });
          badges.push({ label: 'Provider ' + provider, tone: 'ok' });
          if (shortSession) badges.push({ label: 'Session ' + shortSession, tone: 'warn' });
          if (sessionId) {
            const current = cseSessionMap.get(sessionId) || { sessionId, provider, runs: 0, successes: 0, errors: 0 };
            current.runs += 1;
            if (resultRecord?.['status'] === 'success') current.successes += 1;
            if (resultRecord?.['status'] === 'error') current.errors += 1;
            cseSessionMap.set(sessionId, current);
          }
          badges.forEach((badge) => {
            const key = badge.label + ':' + badge.tone;
            if (!seenCseBadges.has(key)) {
              seenCseBadges.add(key);
              cseBadges.push(badge);
            }
          });
        }

        workerTimeline.push({
          kind: 'tool',
          title: 'Worker Tool: ' + String(entry?.name || 'tool'),
          summary: entry?.result != null
            ? 'Input: ' + summarizeForDisplay(entry?.arguments) + '\nOutput: ' + summarizeForDisplay(entry?.result)
            : 'Input: ' + summarizeForDisplay(entry?.arguments),
          inputRaw: detailText(entry?.arguments),
          outputRaw: detailText(entry?.result),
          durationMs: entry?.durationMs,
          badges,
          isWorker: true,
          key: 'tool-' + idx + '-worker-' + traceIdx,
        });
      });
      return;
    }

    if (stepType === 'delegation') {
      timeline.push({
        kind: 'delegation',
        title: 'Delegated to: ' + (s?.worker || s?.name || 'worker'),
        summary: summarizeForDisplay(s?.input || s?.message || s?.delegation || ''),
        raw: detailText(s?.input || s?.message || s?.delegation || ''),
        detailLabel: 'delegation',
        durationMs: s?.durationMs,
        key: 'delegation-' + idx,
      });
      return;
    }

    timeline.push({
      kind: stepType === 'response' ? 'response' : 'step',
      title: stepType,
      summary: summarizeForDisplay(s?.text || s?.content || s),
      raw: detailText(s?.text || s?.content || s),
      detailLabel: stepType === 'response' ? 'response' : 'event',
      durationMs: s?.durationMs,
      key: stepType + '-' + idx,
    });
  });

  const liveThought = thoughtHistory.length ? thoughtHistory[thoughtHistory.length - 1]!.text : '';
  if (msg?.skillPromptApplied) skillEffects.push('Prompt guidance injected');
  if (Array.isArray(msg?.skillTools) && msg.skillTools.length) {
    msg.skillTools.forEach((tool: string) => skillEffects.push('Enabled: ' + tool));
  }

  if (msg?.redaction) {
    const redactedCount = msg.redaction.count || msg.redaction.detections?.length || 0;
    validations.push({
      kind: 'redaction',
      label: 'Redaction',
      status: redactedCount > 0 ? 'warn' : 'ok',
      summary: redactedCount > 0 ? `Redacted ${redactedCount} item${redactedCount === 1 ? '' : 's'}` : 'No sensitive content flagged',
    });
  }

  if (msg?.evalResult) {
    const score = msg.evalResult.score != null ? Math.round(Number(msg.evalResult.score) * 100) : null;
    const passed = msg.evalResult.passed ?? msg.evalResult.score >= 1;
    validations.push({
      kind: 'eval',
      label: 'Evaluation',
      status: passed ? 'ok' : 'warn',
      summary: `Score ${score != null ? `${score}%` : 'n/a'} • Passed ${msg.evalResult.passed ?? 'n/a'} • Failed ${msg.evalResult.failed ?? 'n/a'}`,
    });
  }

  if (msg?.cognitive) {
    const confidence = Math.round((msg.cognitive.confidence || 0) * 100);
    const decision = msg.cognitive.decision || 'allow';
    const firstWarn = msg.cognitive.checks?.find((x: any) => x.decision !== 'allow');
    validations.push({
      kind: 'cognitive',
      label: 'Cognitive Check',
      status: decision,
      summary: `Confidence ${confidence}% • ${decision}${firstWarn?.explanation ? ` • ${firstWarn.explanation}` : ''}`,
    });
  }

  if (msg?.guardrail) {
    const guardrailDecision = msg.guardrail.decision || 'allow';
    validations.push({
      kind: 'guardrail',
      label: 'Guardrail',
      status: guardrailDecision,
      summary: `${guardrailDecision}${msg.guardrail.reason ? ` • ${msg.guardrail.reason}` : ''}`,
    });
  }

  let stage = 'thinking';
  if (msg?.processState === 'error') stage = 'error';
  else if (!isStreamingCurrent && (msg?.processState === 'completed' || !!msg?.content)) stage = 'completed';
  else if (isStreamingCurrent && msg?.content) stage = 'finalizing';
  else if (validations.length) stage = 'validating';
  else if (timeline.length) stage = 'tools';

  const ensembleCandidates: Array<{ agentName: string; output: string }> = Array.isArray(msg.ensembleCandidates) ? msg.ensembleCandidates : [];
  const ensembleWinner: string = msg.ensembleWinner ?? '';
  const ensembleRationale: string = msg.ensembleRationale ?? '';

  const toolCount = [...timeline, ...workerTimeline].filter((item: any) => item.kind === 'tool' || item.kind === 'delegation').length;
  const validationTone = validations.length
    ? validations.some((item: any) => processStatusTone(item.status) === 'deny')
      ? 'deny'
      : validations.some((item: any) => processStatusTone(item.status) === 'warn')
        ? 'warn'
        : 'ok'
    : null;

  const summaryChips: Array<{ label: string; tone: string | null }> = [];
  if (skills.length) summaryChips.push({ label: 'Skills: ' + skills.length, tone: 'ok' });
  if (toolCount) summaryChips.push({ label: 'Tools: ' + toolCount, tone: 'ok' });
  if (workerTimeline.length) summaryChips.push({ label: 'Worker Trace: ' + workerTimeline.length, tone: 'warn' });
  if (ensembleCandidates.length) summaryChips.push({ label: 'Ensemble: ' + ensembleCandidates.length + ' agents', tone: 'ok' });
  if (reflectRevisions.length) summaryChips.push({ label: 'Revised: ' + reflectRevisions.length + 'x', tone: 'warn' });
  if (verifyAttempts.length) summaryChips.push({ label: 'Evaluator: ' + (verifyAttempts.length + 1) + ' attempt' + (verifyAttempts.length + 1 === 1 ? '' : 's'), tone: 'warn' });
  if (cseBadges.length) summaryChips.push({ label: 'CSE', tone: 'ok' });
  if (validations.length) summaryChips.push({ label: 'Checks: ' + validationTone, tone: validationTone });
  if (msg?.latency_ms) summaryChips.push({ label: 'Duration: ' + msg.latency_ms + 'ms', tone: 'ok' });
  if (!summaryChips.length) summaryChips.push({ label: 'Events: ' + (timeline.length + workerTimeline.length), tone: 'ok' });

  const hasProcess = isStreamingCurrent || thoughtHistory.length > 0 || timeline.length > 0 || workerTimeline.length > 0 || skills.length > 0 || validations.length > 0 || ensembleCandidates.length > 0 || reflectRevisions.length > 0 || verifyAttempts.length > 0;
  const cseSessions = Array.from(cseSessionMap.values()).map((session) => ({
    ...session,
    shortSession: session.sessionId.slice(0, 8),
    reused: session.runs > 1,
  }));

  return {
    hasProcess,
    stage,
    liveThought,
    thoughtCount: thoughtHistory.length,
    timeline,
    workerTimeline,
    cseBadges,
    cseSessions,
    skills,
    skillEffects,
    validations,
    summaryChips,
    reflectRevisions,
    verifyAttempts,
    ensembleCandidates,
    ensembleWinner,
    ensembleRationale,
    expanded: typeof msg.processExpanded === 'boolean' ? msg.processExpanded : isStreamingCurrent,
  };
}

export function renderAssistantProcess(
  message: any,
  isStreamingCurrent: boolean,
  options: { rerenderMessages: () => void; renderProcessDetailView: (value: any) => HTMLElement },
): HTMLElement | null {
  const processUi = ensureProcessUiState(message);
  const process = buildProcessViewModel(message, isStreamingCurrent);
  if (!process.hasProcess) return null;

  const stageMeta = processStageMeta(process.stage);
  const stageLabel = stageMeta.label || 'Running';
  const summary = (process.timeline.length + process.workerTimeline.length) + ' events' + (process.thoughtCount ? ' • ' + process.thoughtCount + ' thought updates' : '');
  const toggleText = process.expanded ? 'Hide details' : 'Show details';

  const skillCards = process.skills.map((skill: any) => {
    const scorePct = Math.max(0, Math.min(100, Math.round(Number(skill.score || 0) * 100)));
    const skillTools = Array.isArray(skill.tools) ? skill.tools : [];
    return h('div', { className: 'skill-item' },
      h('div', { className: 'skill-item-top' },
        h('span', { className: 'skill-name' }, skill.name || skill.id || 'Unnamed skill'),
        h('span', { className: 'skill-score' }, scorePct + '% match')
      ),
      h('div', { className: 'skill-category' }, String(skill.category || 'general').replace(/_/g, ' ')),
      skillTools.length ? h('div', { className: 'skill-tags' }, ...skillTools.map((tool: string) => h('span', { className: 'skill-tag' }, tool))) : null
    );
  });

  const validationRows = process.validations.map((item: any) => {
    const tone = processStatusTone(item.status);
    const statusIcon = tone === 'deny' ? '✕' : tone === 'warn' ? '!' : '✓';
    return h('div', { className: 'validation-item ' + tone },
      h('div', { className: 'validation-item-top' },
        h('span', { className: 'validation-name' }, item.label),
        h('span', { className: 'validation-status ' + tone }, statusIcon + ' ' + String(item.status || 'ok'))
      ),
      h('div', { className: 'validation-body' }, item.summary || '')
    );
  });

  const ensembleSection = process.ensembleCandidates.length
    ? h('div', { className: 'process-section ensemble-section' },
        h('div', { className: 'process-section-title' }, '🎭 Ensemble Debate'),
        process.ensembleRationale ? h('div', { className: 'ensemble-rationale' }, process.ensembleRationale) : null,
        h('div', { className: 'ensemble-candidates' },
          ...process.ensembleCandidates.map((c: any) => {
            const isWinner = process.ensembleWinner && c.agentName === process.ensembleWinner;
            return h('div', { className: 'ensemble-candidate' + (isWinner ? ' winner' : '') },
              h('div', { className: 'ensemble-candidate-hdr' },
                h('span', { className: 'ensemble-agent-name' }, c.agentName || 'Agent'),
                isWinner ? h('span', { className: 'ensemble-winner-badge' }, '✓ Selected') : null,
              ),
              h('div', { className: 'ensemble-candidate-output' }, summarizeForDisplay(c.output, 300)),
            );
          })
        )
      )
    : null;

  const reflectSection = process.reflectRevisions.length
    ? h('div', { className: 'process-section reflect-section' },
        h('div', { className: 'process-section-title' }, '🔁 Reflection Revisions'),
        h('div', { className: 'reflect-list' },
          ...process.reflectRevisions.map((r: any) =>
            h('div', { className: 'reflect-item' },
              h('div', { className: 'reflect-item-hdr' }, 'Revision ' + r.revision),
              h('div', { className: 'reflect-feedback' }, r.feedback),
            )
          )
        )
      )
    : null;

  const verifySection = process.verifyAttempts.length
    ? h('div', { className: 'process-section verify-section' },
        h('div', { className: 'process-section-title' }, '✅ Evaluator Attempts'),
        h('div', { className: 'verify-list' },
          ...process.verifyAttempts.map((v: any) =>
            h('div', { className: 'verify-item' },
              h('div', { className: 'verify-item-hdr' },
                h('span', null, 'Attempt ' + v.attempt),
                h('span', { className: 'timeline-badge deny' }, 'Failed'),
              ),
              h('div', { className: 'verify-reason' }, v.reason || 'Did not pass quality threshold'),
            )
          ),
          h('div', { className: 'verify-item' },
            h('div', { className: 'verify-item-hdr' },
              h('span', null, 'Attempt ' + (process.verifyAttempts.length + 1)),
              h('span', { className: 'timeline-badge ok' }, 'Passed'),
            ),
          )
        )
      )
    : null;

  const processBody = h('div', { className: 'process-body' },
    process.cseBadges.length ? h('div', { className: 'process-badge-row' },
      ...process.cseBadges.map((badge: any) => h('span', { className: 'summary-chip ' + (badge.tone || 'ok') }, badge.label))
    ) : null,
    process.cseSessions.length ? h('div', { className: 'process-section cse-lifecycle-section' },
      h('div', { className: 'process-section-title' }, 'CSE Lifecycle'),
      h('div', { className: 'cse-session-list' },
        ...process.cseSessions.map((session: any) => h('div', { className: 'cse-session-item' },
          h('div', { className: 'cse-session-top' },
            h('span', { className: 'cse-session-id' }, 'Session ' + session.shortSession),
            h('span', { className: 'timeline-badge ' + (session.reused ? 'warn' : 'ok') }, session.reused ? 'Reused' : 'Single run')
          ),
          h('div', { className: 'cse-session-meta' }, `${session.provider} • ${session.runs} run${session.runs === 1 ? '' : 's'} • ${session.successes} ok • ${session.errors} error${session.errors === 1 ? '' : 's'}`)
        ))
      )
    ) : null,
    ensembleSection,
    reflectSection,
    verifySection,
    h('div', { className: 'live-thought' },
      h('div', { className: 'lbl' }, 'Current thought'),
      h('div', { className: 'txt' }, process.liveThought || (isStreamingCurrent ? 'Thinking...' : 'No thought trace captured.'))
    ),
    process.skills.length ? h('div', { className: 'process-section' },
      h('div', { className: 'process-section-title' }, '✨ Skills Invoked'),
      h('div', { className: 'skill-list' }, ...skillCards),
      process.skillEffects.length ? h('div', { className: 'skill-summary' }, ...process.skillEffects.map((effect: string) => h('span', { className: 'skill-tag' }, effect))) : null
    ) : null,
    process.timeline.length ? h('div', { className: 'process-section' },
      h('div', { className: 'process-section-title' }, 'Timeline'),
      h('div', { className: 'timeline' }, ...process.timeline.map((item: any, idx: number) => buildTimelineItem(item, idx, processUi, message, options)))
    ) : null,
    process.workerTimeline.length ? h('div', { className: 'process-section worker-trace-section' },
      h('div', { className: 'process-section-title' }, 'Worker Trace'),
      h('div', { className: 'worker-trace-summary' }, 'Nested worker execution details, including container code runs.'),
      h('div', { className: 'timeline worker-trace' }, ...process.workerTimeline.map((item: any, idx: number) => buildTimelineItem(item, idx, processUi, message, options)))
    ) : null,
    process.validations.length ? h('div', { className: 'process-section' },
      h('div', { className: 'process-section-title' }, 'Validation'),
      h('div', { className: 'validation-list' }, ...validationRows)
    ) : null
  );

  return h('div', { className: 'process-card ' + (message.processState || process.stage) },
    h('div', { className: 'process-hdr' },
      h('div', { className: 'process-hdr-main' },
        h('div', { className: 'process-title' },
          h('span', null, '🧠 Process'),
          h('span', { className: 'process-stage ' + stageMeta.tone, role: 'status', 'aria-live': 'polite', 'aria-atomic': 'true' },
            h('span', { className: 'process-stage-icon', 'aria-hidden': 'true' }, stageMeta.icon),
            h('span', null, stageLabel)
          )
        ),
        !process.expanded && process.summaryChips.length ? h('div', { className: 'process-meta' },
          ...process.summaryChips.map((chip: any) => h('span', { className: 'summary-chip ' + (chip.tone || 'ok') }, chip.label))
        ) : null
      ),
      h('button', {
        className: 'process-toggle',
        type: 'button',
        'aria-expanded': String(process.expanded),
        onClick: () => {
          message.processExpanded = !process.expanded;
          options.rerenderMessages();
        },
      }, toggleText)
    ),
    !process.expanded ? h('div', { className: 'process-summary' },
      h('div', null, summary || 'No process events'),
      process.summaryChips.length ? h('div', { className: 'process-meta' },
        ...process.summaryChips.map((chip: any) => h('span', { className: 'summary-chip ' + (chip.tone || 'ok') }, chip.label))
      ) : null
    ) : null,
    h('div', { className: 'process-body-wrap ' + (process.expanded ? 'expanded' : 'collapsed'), 'aria-hidden': String(!process.expanded) },
      h('div', { className: 'process-body-clip' }, processBody)
    )
  );
}
