import type { AgentResult } from '@weaveintel/core';

export function containsSandboxArtifactPath(text: string): boolean {
  if (!text) return false;
  // Only block raw sandbox file paths — not base64 data URIs or JSON that embeds
  // chart content. A reference like "/workspace/output/foo.png" as a bare path in
  // the response (not inside a data: URI) indicates the agent forgot to embed the chart.
  if (text.includes('data:image/') || text.includes('data:application/')) return false;
  return /\/workspace\/output\/[^\s)"']+\.png/iu.test(text)
    || /"img_path"\s*:\s*"\/workspace\/output\//iu.test(text);
}

export function indicatesIncompleteAttachmentAnalysis(text: string): boolean {
  if (!text) return false;
  const lower = text.toLowerCase();
  return lower.includes('insight summary was blank')
    || lower.includes('summary was blank')
    || lower.includes('would you like me to') && lower.includes('re-run the analysis');
}

export function hasRenderableAttachmentAnalysisOutput(result: AgentResult, goal: string): boolean {
  const output = String(result.output || '').trim();
  if (!output) return false;
  if (containsSandboxArtifactPath(output)) return false;
  if (indicatesIncompleteAttachmentAnalysis(output)) return false;

  const expectsRenderableChart = /\b(chart|charts|graph|graphs|visuali[sz]ation|plot|plots)\b/i.test(goal);
  if (!expectsRenderableChart) return true;

  // Accept any of: explicit chart JSON, ```json block, Plotly data array, base64 image embed,
  // or a substantial output (>500 chars) that the agent produced after real CSE execution —
  // the strict "must contain chart JSON" requirement causes false guard failures when the
  // agent correctly embeds charts in an HTML artifact or produces Plotly inline JS instead.
  const hasChartJson = output.includes('"chart"') || output.includes('```json')
    || output.includes('"data":[') || output.includes('"layout":{')
    || output.includes('data:image/png;base64');
  return hasChartJson || output.length > 500;
}
