import type { ChatAttachment } from './chat-runtime.js';

export function shouldForceWorkerDataAnalysis(userContent: string, attachments?: ChatAttachment[]): boolean {
  const lower = userContent.toLowerCase();
  const analysisIntent = /\b(analy[sz]e|analysis|insight|dataset|csv|table|trend|summary|summarize|statistics|statistical)\b/.test(lower);
  const hasAttachments = Array.isArray(attachments) && attachments.length > 0;

  if (hasAttachments && analysisIntent) return true;

  const codeExecutionIntent = /\b(run(?!\s+me\b)|execut(e|ing)|python|script|code)\b/.test(lower);
  const dataRetrievalIntent = /\b(data|extracted|retrieve|retrieval|economy|gdp|spending|region|age|ethnicity|historical|trend|stats|statistics|stats\s*nz|new zealand)\b/.test(lower);
  return codeExecutionIntent && dataRetrievalIntent;
}
