/**
 * Example 80 — Kaggle Discussion Bot (Phase K6)
 *
 * Exercises the privileged kaggle.discussions.create MCP tool end-to-end
 * against the in-memory fixture adapter and validates the three layers of
 * defence-in-depth that ship with the discussion bot:
 *
 *   1. The tool is registered and discoverable via MCP.
 *   2. A draft → human-approval → post flow produces a topic id + URL.
 *   3. A reply (parentTopicId) is distinguishable from a top-level topic.
 *
 * The example deliberately does NOT exercise the GeneWeave-side governance
 * (kill switch + tool policy + skill enable). Those gates are wired in
 * GeneWeave admin (Kaggle → Discussion Kill Switch + Tool Policies →
 * kaggle_discussion_post_gate + Skills → kaggle_communicator) and verified
 * by the Phase K6 API tests in `apps/geneweave/src/api.test.ts`.
 *
 * Run:  npx tsx examples/80-kaggle-discussion-bot.ts
 */

import { weaveFakeTransport } from '@weaveintel/testing';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveContext } from '@weaveintel/core';
import { createKaggleMCPServer, fixtureKaggleAdapter } from '../apps/geneweave/src/kaggle/index.js';

async function main(): Promise<void> {
  console.log('━━━ Phase K6: Kaggle Discussion Bot ━━━\n');

  const adapter = fixtureKaggleAdapter();
  const server = createKaggleMCPServer({ adapter });
  const { client, server: transport } = weaveFakeTransport();
  await server.start(transport);
  const mcp = weaveMCPClient();
  await mcp.connect(client);

  const ctx = weaveContext({
    metadata: { kaggleUsername: 'demo-user', kaggleKey: 'fake-key' },
  });

  // ─── 1. Discoverability ───────────────────────────────────────────
  const tools = await mcp.listTools();
  const discussionTool = tools.find((t) => t.name === 'kaggle.discussions.create');
  if (!discussionTool) throw new Error('kaggle.discussions.create not registered');
  console.log('✓ Tool registered:', discussionTool.name);
  console.log('  description:', discussionTool.description?.slice(0, 80) + '...\n');

  // ─── 2. Draft → approve → post a top-level topic ─────────────────
  // In production, the kaggle_communicator skill drafts the message, the
  // approval gate (kaggle_discussion_post_gate, requires_approval=1) holds
  // execution until a human approves via /api/admin/tool-approval-requests,
  // and ONLY THEN does this tool actually fire.
  console.log('→ Posting top-level topic to "titanic"…');
  const topicResult = await mcp.callTool(ctx, {
    name: 'kaggle.discussions.create',
    arguments: {
      competitionRef: 'titanic',
      title: 'Sharing a starter LightGBM baseline (CV=0.83)',
      body: 'I trained a LightGBM baseline with 5-fold CV. Notebook attached. Happy to discuss feature engineering choices.',
    },
  });
  const topicText = topicResult.content[0];
  if (topicText?.type !== 'text') throw new Error('Expected text content from topic post');
  const topic = JSON.parse(topicText.text);
  console.log('  topic id:', topic.topicId);
  console.log('  url:', topic.url);
  console.log('  status:', topic.status, '\n');

  if (!topic.topicId || topic.status !== 'posted') {
    throw new Error('Top-level topic post failed');
  }

  // ─── 3. Reply to the topic ────────────────────────────────────────
  console.log('→ Replying to topic', topic.topicId);
  const replyResult = await mcp.callTool(ctx, {
    name: 'kaggle.discussions.create',
    arguments: {
      competitionRef: 'titanic',
      title: 'Re: starter LightGBM baseline',
      body: 'Thanks! The age-imputation strategy is what moved the score most for me.',
      parentTopicId: topic.topicId,
    },
  });
  const replyText = replyResult.content[0];
  if (replyText?.type !== 'text') throw new Error('Expected text content from reply post');
  const reply = JSON.parse(replyText.text);
  console.log('  reply id:', reply.topicId);
  console.log('  url:', reply.url);
  console.log('  message:', reply.message, '\n');

  if (!reply.topicId || reply.topicId === topic.topicId) {
    throw new Error('Reply did not produce a distinct id');
  }

  console.log('✓ Phase K6 fixture flow OK');
  console.log('\nGovernance reminder — to enable in GeneWeave you must:');
  console.log('  1. tool_catalog: enable kaggle.discussions.create');
  console.log('  2. tool_policies: enable kaggle_discussion_post_gate');
  console.log('  3. skills: enable kaggle_communicator');
  console.log('  4. kaggle-discussion-settings: set discussion_enabled=1 for the tenant');
}

main().catch((err) => {
  console.error('✗ Example 80 failed:', err);
  process.exit(1);
});
