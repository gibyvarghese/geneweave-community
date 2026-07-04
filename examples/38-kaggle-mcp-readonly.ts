/**
 * 38 — Kaggle MCP server (Phase K1, read-only)
 *
 * Demonstrates the ../apps/geneweave/src/kaggle/index.js Phase K1 deliverables end-to-end:
 *   1. Boots `createKaggleMCPServer` with the deterministic fixture adapter.
 *   2. Connects an in-process MCP client through the fake transport.
 *   3. Lists the 13 read-only Kaggle MCP tools.
 *   4. Invokes a representative read-only tool from each catalog
 *      (competitions, datasets, kernels) and prints the parsed result.
 *   5. Confirms missing credentials are rejected.
 *
 * Run:
 *   npx tsx examples/38-kaggle-mcp-readonly.ts
 *
 * GeneWeave admin verification (separate manual step):
 *   - Start GeneWeave (`npx tsx examples/12-geneweave.ts`).
 *   - Open `/admin` → Tool Catalog tab. The 13 `kaggle.*` rows appear with
 *     `source=mcp`, `risk_level=read-only`, `enabled=0` (operator must
 *     enable after provisioning KAGGLE_USERNAME / KAGGLE_KEY env vars and
 *     starting the Kaggle MCP server).
 *   - Open `/admin` → Credentials tab. Row `Kaggle Default` is present
 *     pinning `KAGGLE_KEY` (and `KAGGLE_USERNAME` via config).
 *
 * Live API check (env-gated, optional):
 *   KAGGLE_USERNAME=... KAGGLE_KEY=... npx tsx examples/38-kaggle-mcp-readonly.ts
 *   When both env vars are set the script appends a single live read call
 *   (kaggle.competitions.list page=1) using the live REST adapter.
 */

import { weaveContext } from '@weaveintel/core';
import { weaveMCPClient } from '@weaveintel/mcp-client';
import { weaveFakeTransport } from '@weaveintel/testing';
import {
  createKaggleMCPServer,
  fixtureKaggleAdapter,
  liveKaggleAdapter,
} from '../apps/geneweave/src/kaggle/index.js';

async function main() {
  console.log('── Phase K1: Kaggle MCP server (read-only) ──\n');

  // 1. Boot server with fixture adapter
  const server = createKaggleMCPServer({ adapter: fixtureKaggleAdapter() });
  const { client: clientTransport, server: serverTransport } = weaveFakeTransport();
  await server.start(serverTransport);

  const mcp = weaveMCPClient();
  await mcp.connect(clientTransport);

  // 2. Verify all 13 read-only tools are discoverable
  const tools = await mcp.listTools();
  const names = tools.map((t) => t.name).sort();
  console.log(`Discovered ${names.length} Kaggle tools:`);
  for (const name of names) console.log(`  • ${name}`);

  const expected = [
    'kaggle.competitions.list',
    'kaggle.competitions.get',
    'kaggle.competitions.files.list',
    'kaggle.competitions.leaderboard.get',
    'kaggle.competitions.submissions.list',
    'kaggle.datasets.list',
    'kaggle.datasets.get',
    'kaggle.datasets.files.list',
    'kaggle.kernels.list',
    'kaggle.kernels.get',
    'kaggle.kernels.pull',
    'kaggle.kernels.status',
    'kaggle.kernels.output',
  ];
  const missing = expected.filter((e) => !names.includes(e));
  if (missing.length > 0) throw new Error(`Missing tools: ${missing.join(', ')}`);
  console.log(`✓ All ${expected.length} read-only tools registered\n`);

  // 3. Invoke representative read-only tools
  const ctx = weaveContext({ metadata: { kaggleUsername: 'demo-user', kaggleKey: 'demo-key' } });

  async function call(name: string, args: Record<string, unknown>) {
    const result = await mcp.callTool(ctx, { name, arguments: args }) as { content: Array<{ type: string; text: string }> };
    return JSON.parse(result.content[0]!.text);
  }

  console.log('▸ kaggle.competitions.list (search="titanic")');
  const comps = await call('kaggle.competitions.list', { search: 'titanic' });
  console.log(`  → ${comps.length} competition(s); first: ${comps[0].title} (metric=${comps[0].evaluationMetric})`);

  console.log('\n▸ kaggle.competitions.leaderboard.get (ref="titanic")');
  const board = await call('kaggle.competitions.leaderboard.get', { ref: 'titanic' });
  console.log(`  → top entry: rank ${board[0].rank} ${board[0].teamName} score=${board[0].score}`);

  console.log('\n▸ kaggle.datasets.get (ref="kaggle/sample-dataset")');
  const ds = await call('kaggle.datasets.get', { ref: 'kaggle/sample-dataset' });
  console.log(`  → ${ds.title} (owner=${ds.ownerName}, downloads=${ds.downloadCount})`);

  console.log('\n▸ kaggle.kernels.pull (ref="alice/sample-notebook")');
  const k = await call('kaggle.kernels.pull', { ref: 'alice/sample-notebook' });
  console.log(`  → language=${k.metadata.language}, source preview: ${k.source.split('\n')[0]}`);

  // 4. Missing credentials must be rejected
  console.log('\n▸ Negative check: call without credentials');
  try {
    const ctxNoCreds = weaveContext({});
    await mcp.callTool(ctxNoCreds, { name: 'kaggle.competitions.list', arguments: {} });
    throw new Error('Expected credentials check to throw');
  } catch (err) {
    const msg = (err as Error).message;
    if (!msg.includes('credentials missing')) throw err;
    console.log(`  → rejected as expected: "${msg}"`);
  }

  console.log('\n✓ Phase K1 fixture validation complete.\n');

  // 5. Optional live REST sanity check (env-gated)
  const username = process.env['KAGGLE_USERNAME'];
  const key = process.env['KAGGLE_KEY'];
  if (username && key) {
    console.log('── Live Kaggle REST check (KAGGLE_USERNAME + KAGGLE_KEY detected) ──');
    try {
      const liveComps = await liveKaggleAdapter.listCompetitions({ username, key }, { page: 1 });
      console.log(`✓ Live API returned ${liveComps.length} competitions; first: ${liveComps[0]?.title ?? '(none)'}`);
    } catch (err) {
      console.error(`✗ Live API call failed: ${(err as Error).message}`);
      process.exitCode = 1;
    }
  } else {
    console.log('(Skipping live API check — set KAGGLE_USERNAME and KAGGLE_KEY to enable.)');
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
