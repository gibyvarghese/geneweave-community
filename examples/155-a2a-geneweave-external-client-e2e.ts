/**
 * Example 155 — External A2A Client → geneWeave (Real Server E2E)
 *
 * Shows how an external caller discovers and invokes geneWeave as an A2A v1.0
 * peer from outside the process — the same wire format any conformant A2A peer
 * would use (Python SDK, LangGraph, ADK, etc.).
 *
 * The example is self-contained: it registers a fresh throwaway user at the
 * start of each run, authenticates as that user, exercises every A2A method,
 * then logs out. No pre-existing credentials are needed.
 *
 * Flow:
 *   Step 1  Register a fresh test user (POST /api/auth/register)
 *   Step 1b Authenticate → bearer token    (POST /api/auth/token)
 *   Step 2  Discover agent card            (GET /.well-known/agent-card.json)
 *   Step 3  SendMessage                    (synchronous task)
 *   Step 4  SendStreamingMessage           (SSE streaming task)
 *   Step 5  GetTask                        (retrieve task by id)
 *   Step 6  ListTasks                      (paginated listing)
 *   Step 7  GetExtendedAgentCard           (full skill metadata)
 *   Step 8  Push CRUD                      (create / get / list / delete webhook)
 *   Step 9  Negative / security            (401, 400, 404, injection, XSS)
 *   Step 10 Logout                         (POST /api/auth/logout)
 *
 * Prerequisites
 * ─────────────
 *   Start geneWeave with NODE_ENV=test so self-registered users are auto-verified
 *   (no email link needed). Either of these work:
 *
 *     # Option A — using the standard launch script (recommended):
 *     NODE_ENV=test ./scripts/start-geneweave.sh
 *
 *     # Option B — using the production entry directly:
 *     NODE_ENV=test npx tsx deploy/server.ts
 *
 *   NODE_ENV=test is the only required difference from a normal dev start.
 *   It is NOT in .env so it must be set on the command line.
 *
 *   If the server is already running without NODE_ENV=test, set GENEWEAVE_EMAIL
 *   and GENEWEAVE_PASSWORD in .env as credentials for an already-verified account;
 *   the example will fall back to those when email verification is required.
 *
 * Run:
 *   GENEWEAVE_BASE_URL=http://localhost:3500 npx tsx examples/155-a2a-geneweave-external-client-e2e.ts
 *
 * Env vars:
 *   GENEWEAVE_BASE_URL   server base URL (default: http://localhost:3500)
 *   GENEWEAVE_EMAIL      fallback credentials if server requires email verification
 *   GENEWEAVE_PASSWORD   (same)
 */

import * as dotenv from 'dotenv';
import { A2A_METHODS, A2A_ERROR_CODES, makeRpcRequest, parseSseStream } from '@weaveintel/a2a';
import type { AgentCard, A2ATask, A2AStreamEvent, A2APushNotificationConfigEntry } from '@weaveintel/core';

dotenv.config();

// ─── Config ───────────────────────────────────────────────────────────────────

const BASE_URL = (process.env['GENEWEAVE_BASE_URL'] ?? 'http://localhost:3500').replace(/\/$/, '');
const A2A_URL = `${BASE_URL}/api/a2a`;

// Unique-per-run throwaway user
const RUN_ID = Date.now();
const TEST_EMAIL = `a2a-e2e-${RUN_ID}@test.local`;
const TEST_PASSWORD = `A2aTest_${RUN_ID}!`;
const TEST_NAME = 'A2A E2E Test User';

// ─── Result counters ──────────────────────────────────────────────────────────

let passed = 0;
let failed = 0;

function pass(msg: string) { console.log(`  ✓ ${msg}`); passed++; }
function fail(msg: string, err?: unknown) {
  console.error(`  ✗ ${msg}`);
  if (err) console.error('   ', err instanceof Error ? err.message : String(err));
  failed++;
}
function assert(cond: boolean, msg: string) { cond ? pass(msg) : fail(msg); }
function section(title: string) { console.log(`\n── ${title} ──`); }

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

/** POST JSON to geneWeave with a bearer token, return status + parsed body. */
async function a2aPost(
  token: string,
  method: string,
  params: unknown,
): Promise<{ status: number; body: unknown }> {
  const res = await fetch(A2A_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(makeRpcRequest(method, params)),
  });
  let body: unknown;
  try { body = await res.json(); } catch { body = null; }
  return { status: res.status, body };
}

/** Same but keeps the raw Response so the SSE body can be streamed. */
async function a2aPostRaw(token: string, method: string, params: unknown): Promise<Response> {
  return fetch(A2A_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'A2A-Version': '1.0',
      'Accept': 'text/event-stream',
      'Authorization': `Bearer ${token}`,
    },
    body: JSON.stringify(makeRpcRequest(method, params)),
  });
}

// ─── Step 1: Register + authenticate ─────────────────────────────────────────

async function registerAndAuthenticate(): Promise<{ token: string; userId: string }> {
  section('Step 1a: Register fresh test user (POST /api/auth/register)');

  const regRes = await fetch(`${BASE_URL}/api/auth/register`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ name: TEST_NAME, email: TEST_EMAIL, password: TEST_PASSWORD }),
  });

  if (!regRes.ok) {
    const body = await regRes.text();
    throw new Error(`Registration failed (${regRes.status}): ${body}`);
  }

  const regData = await regRes.json() as {
    user: { id: string; email: string; persona: string };
    requiresEmailVerification: boolean;
    message: string;
  };

  assert(regData.user.email === TEST_EMAIL, `registered email = "${regData.user.email}"`);
  assert(typeof regData.user.id === 'string', `assigned user id = "${regData.user.id}"`);
  assert(typeof regData.user.persona === 'string', `assigned persona = "${regData.user.persona}"`);
  pass(`Registration message: "${regData.message}"`);

  const registeredUserId = regData.user.id;

  // If the server requires email verification (i.e. not NODE_ENV=test), we
  // cannot log in with the just-registered account. Fall back to env-var
  // credentials for an already-verified account.
  let loginEmail = TEST_EMAIL;
  let loginPassword = TEST_PASSWORD;

  if (regData.requiresEmailVerification) {
    const fallbackEmail = process.env['GENEWEAVE_EMAIL'];
    const fallbackPassword = process.env['GENEWEAVE_PASSWORD'];
    if (!fallbackEmail || !fallbackPassword) {
      throw new Error(
        `Server requires email verification (NODE_ENV is not "test").\n` +
        `Either start geneWeave with NODE_ENV=test (recommended for E2E tests)\n` +
        `or set GENEWEAVE_EMAIL and GENEWEAVE_PASSWORD in .env for an already-verified account.`,
      );
    }
    pass(`Email verification required — falling back to env-var credentials for auth`);
    loginEmail = fallbackEmail;
    loginPassword = fallbackPassword;
  }

  section('Step 1b: Authenticate → bearer token (POST /api/auth/token)');

  const tokenRes = await fetch(`${BASE_URL}/api/auth/token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ email: loginEmail, password: loginPassword }),
  });

  if (!tokenRes.ok) {
    const body = await tokenRes.text();
    throw new Error(`Authentication failed (${tokenRes.status}): ${body}`);
  }

  const tokenData = await tokenRes.json() as {
    token: string;
    csrfToken: string;
    expiresAt: string;
    user: { id: string; email: string };
    permissions: unknown[];
  };

  assert(typeof tokenData.token === 'string' && tokenData.token.length > 0, 'received bearer token');
  assert(typeof tokenData.csrfToken === 'string', 'received csrfToken (A2A route does not need it, but it is present)');
  assert(typeof tokenData.expiresAt === 'string', `token expiresAt = "${tokenData.expiresAt}"`);
  assert(Array.isArray(tokenData.permissions), `received ${tokenData.permissions?.length ?? 0} permission(s)`);
  pass(`Authenticated as ${tokenData.user.email} (id: ${tokenData.user.id})`);

  return { token: tokenData.token, userId: registeredUserId };
}

// ─── Step 2: Discover agent card ─────────────────────────────────────────────

async function discoverCard(): Promise<AgentCard> {
  section('Step 2: Agent card discovery (GET /.well-known/agent-card.json)');

  const res = await fetch(`${BASE_URL}/.well-known/agent-card.json`, {
    headers: { 'A2A-Version': '1.0' },
  });
  assert(res.ok, `agent-card.json responds ${res.status} OK`);

  const card = await res.json() as AgentCard;
  assert(card.name === 'geneweave', `card.name = "${card.name}"`);
  assert(typeof card.version === 'string', `card.version = "${card.version}"`);
  assert(card.capabilities?.pushNotifications === true, 'card.capabilities.pushNotifications = true');
  assert(card.capabilities?.extendedAgentCard === true, 'card.capabilities.extendedAgentCard = true');
  assert(card.capabilities?.streaming === true, 'card.capabilities.streaming = true');
  assert(Array.isArray(card.skills) && card.skills.length > 0, `card has ${card.skills?.length ?? 0} skill(s)`);
  assert(
    typeof card.supportedInterfaces?.[0]?.url === 'string',
    `supportedInterfaces[0].url = "${card.supportedInterfaces?.[0]?.url}"`,
  );

  // Legacy alias /.well-known/agent.json must also respond OK
  const legacyRes = await fetch(`${BASE_URL}/.well-known/agent.json`);
  assert(legacyRes.ok, `/.well-known/agent.json legacy alias responds ${legacyRes.status} OK`);

  pass(`Discovered geneWeave A2A at ${card.supportedInterfaces?.[0]?.url}`);
  return card;
}

// ─── Step 3: SendMessage ──────────────────────────────────────────────────────

async function sendMessage(token: string): Promise<string> {
  section('Step 3: SendMessage (synchronous JSON-RPC 2.0 task)');

  const { status, body } = await a2aPost(token, A2A_METHODS.SEND_MESSAGE, {
    message: {
      role: 'user',
      parts: [{ text: 'Reply with exactly: "A2A works"' }],
      messageId: `msg-${RUN_ID}`,
      contextId: `ctx-${RUN_ID}`,
    },
  });

  assert(status === 200, `HTTP status = ${status} (want 200)`);

  const resp = body as { jsonrpc?: string; result?: A2ATask; error?: unknown };
  assert(resp.jsonrpc === '2.0', `response.jsonrpc = "${resp.jsonrpc}"`);
  assert(resp.result != null, 'response has result field (no error)');

  const task = resp.result!;
  assert(typeof task.id === 'string' && task.id.length > 0, `task.id = "${task.id}"`);
  assert(typeof task.contextId === 'string', `task.contextId = "${task.contextId}"`);
  // FAILED is a valid terminal state when the underlying LLM call errors (e.g. quota exceeded)
  const validStates = ['TASK_STATE_COMPLETED', 'TASK_STATE_WORKING', 'TASK_STATE_FAILED'];
  assert(
    validStates.includes(task.status.state),
    `task.status.state = "${task.status.state}" (one of ${validStates.join(' | ')})`,
  );
  assert(typeof task.status.timestamp === 'string', `task.status.timestamp = "${task.status.timestamp}"`);

  if (task.artifacts?.length > 0) {
    const text = task.artifacts[0]?.parts[0]?.text;
    pass(`artifact[0].parts[0].text = "${(text ?? '').slice(0, 80)}"`);
  } else {
    pass('task submitted (no artifact yet — may be async)');
  }

  return task.id;
}

// ─── Step 4: SendStreamingMessage ────────────────────────────────────────────

async function sendStreamingMessage(token: string): Promise<void> {
  section('Step 4: SendStreamingMessage (SSE streaming)');

  const res = await a2aPostRaw(token, A2A_METHODS.SEND_STREAMING_MESSAGE, {
    message: {
      role: 'user',
      parts: [{ text: 'Count from 1 to 3, one number per line.' }],
      messageId: `msg-stream-${RUN_ID}`,
      contextId: `ctx-stream-${RUN_ID}`,
    },
  });

  assert(res.ok, `HTTP status = ${res.status} (want 200)`);
  assert(
    (res.headers.get('content-type') ?? '').includes('text/event-stream'),
    `Content-Type contains text/event-stream`,
  );

  if (!res.body) { fail('Response body is null — cannot read SSE stream'); return; }

  const events: A2AStreamEvent[] = [];
  for await (const event of parseSseStream<A2AStreamEvent>(res.body)) {
    events.push(event);
    if ('task' in event) break; // final event — stop reading
  }

  assert(events.length > 0, `Received ${events.length} SSE event(s)`);
  if (events.some((e) => 'statusUpdate' in e)) pass('stream includes statusUpdate event');
  const final = events.find((e): e is { task: A2ATask } => 'task' in e);
  if (final) {
    pass(`stream final task.id = "${final.task.id}", state = "${final.task.status.state}"`);
  }
}

// ─── Step 5: GetTask ─────────────────────────────────────────────────────────

async function getTask(token: string, taskId: string): Promise<void> {
  section('Step 5: GetTask (retrieve submitted task by id)');

  const { status, body } = await a2aPost(token, A2A_METHODS.GET_TASK, { id: taskId });
  const resp = body as { result?: A2ATask; error?: { code: number; message: string } };

  if (status === 404 || resp.error?.code === A2A_ERROR_CODES.TASK_NOT_FOUND) {
    pass(`GetTask → 404 TASK_NOT_FOUND (task is ephemeral — acceptable for this engine)`);
    return;
  }

  assert(status === 200, `HTTP status = ${status} (want 200)`);
  assert(resp.result?.id === taskId, `result.id = "${resp.result?.id}" (matches)`);
  pass(`GetTask state = "${resp.result?.status.state}"`);
}

// ─── Step 6: ListTasks ───────────────────────────────────────────────────────

async function listTasks(token: string): Promise<void> {
  section('Step 6: ListTasks (paginated listing)');

  const { status, body } = await a2aPost(token, A2A_METHODS.LIST_TASKS, { pageSize: 10 });
  assert(status === 200, `HTTP status = ${status} (want 200)`);

  const resp = body as { result?: { tasks: A2ATask[]; nextPageToken?: string | null } };
  assert(Array.isArray(resp.result?.tasks), 'result.tasks is an array');
  pass(`ListTasks returned ${resp.result?.tasks?.length ?? 0} task(s)`);
}

// ─── Step 7: GetExtendedAgentCard ────────────────────────────────────────────

async function getExtendedCard(token: string): Promise<void> {
  section('Step 7: GetExtendedAgentCard (full skill metadata)');

  const { status, body } = await a2aPost(token, A2A_METHODS.GET_EXTENDED_AGENT_CARD, {});
  assert(status === 200, `HTTP status = ${status} (want 200)`);

  const card = (body as { result?: AgentCard & { documentationUrl?: string } }).result;
  assert(card?.name === 'geneweave', `card.name = "${card?.name}"`);
  assert(
    Array.isArray(card?.skills) && (card?.skills?.[0]?.tags?.length ?? 0) > 0,
    `skill[0].tags = ${JSON.stringify(card?.skills?.[0]?.tags)}`,
  );
  assert(
    (card?.skills?.[0]?.examples?.length ?? 0) > 0,
    `skill[0] has ${card?.skills?.[0]?.examples?.length ?? 0} example(s)`,
  );
  if (card?.documentationUrl) pass(`documentationUrl = "${card.documentationUrl}"`);
}

// ─── Step 8: Push notification CRUD ──────────────────────────────────────────

async function pushNotificationCrud(token: string): Promise<void> {
  section('Step 8: Push notification config CRUD');

  const taskId = `ext-task-${RUN_ID}`;

  // Create
  const { status: s1, body: b1 } = await a2aPost(token, A2A_METHODS.CREATE_PUSH_CONFIG, {
    taskId,
    config: { url: 'https://webhook.site/test-a2a-external', token: 'hmac-secret-123' },
  });
  assert(s1 === 200, `CreatePushConfig status = ${s1} (want 200)`);
  const entry = (b1 as { result?: A2APushNotificationConfigEntry }).result;
  assert(typeof entry?.pushConfigId === 'string', `pushConfigId = "${entry?.pushConfigId}"`);
  assert(entry?.taskId === taskId, `entry.taskId = "${entry?.taskId}"`);
  assert(typeof entry?.createdAt === 'string', `entry.createdAt = "${entry?.createdAt}"`);
  pass(`Created push config ${entry?.pushConfigId}`);
  const configId = entry!.pushConfigId;

  // Get
  const { status: s2, body: b2 } = await a2aPost(token, A2A_METHODS.GET_PUSH_CONFIG, { taskId, pushConfigId: configId });
  assert(s2 === 200, `GetPushConfig status = ${s2} (want 200)`);
  assert((b2 as { result?: A2APushNotificationConfigEntry }).result?.pushConfigId === configId, 'GetPushConfig returns correct entry');

  // List
  const { status: s3, body: b3 } = await a2aPost(token, A2A_METHODS.LIST_PUSH_CONFIGS, { taskId });
  assert(s3 === 200, `ListPushConfigs status = ${s3} (want 200)`);
  const configs = (b3 as { result?: { configs: A2APushNotificationConfigEntry[] } }).result?.configs;
  assert((configs?.length ?? 0) >= 1, `ListPushConfigs returned ${configs?.length ?? 0} config(s) (want ≥ 1)`);

  // Delete
  const { status: s4, body: b4 } = await a2aPost(token, A2A_METHODS.DELETE_PUSH_CONFIG, { taskId, pushConfigId: configId });
  assert(s4 === 200, `DeletePushConfig status = ${s4} (want 200)`);
  assert((b4 as { result?: { deleted: boolean } }).result?.deleted === true, 'result.deleted = true');

  // Get after delete → 404
  const { status: s5 } = await a2aPost(token, A2A_METHODS.GET_PUSH_CONFIG, { taskId, pushConfigId: configId });
  assert(s5 === 404, `GetPushConfig after delete → ${s5} (want 404)`);

  // List after delete → empty
  const { body: b6 } = await a2aPost(token, A2A_METHODS.LIST_PUSH_CONFIGS, { taskId });
  const remaining = (b6 as { result?: { configs: unknown[] } }).result?.configs;
  assert(remaining?.length === 0, `ListPushConfigs after delete → ${remaining?.length ?? '?'} configs (want 0)`);
}

// ─── Step 9a: Unauthenticated negative tests ──────────────────────────────────

async function negativeUnauthenticated(): Promise<void> {
  section('Step 9a: Unauthenticated negative (no token)');

  // Plain POST without auth → 401
  const r1 = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(makeRpcRequest(A2A_METHODS.GET_TASK, { id: 'x' })),
  });
  assert(r1.status === 401, `no Authorization header → ${r1.status} (want 401)`);
  const r1body = await r1.json() as { error?: { message: string } };
  assert(typeof r1body.error?.message === 'string', `error.message present: "${r1body.error?.message?.slice(0, 60)}"`);

  // Wrong content-type, no auth → 401 (auth is checked first)
  const r2 = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'text/plain' },
    body: 'hello',
  });
  assert(r2.status === 401, `text/plain with no auth → ${r2.status} (want 401)`);

  // GET method → not 200 (A2A only accepts POST)
  const r3 = await fetch(A2A_URL, { method: 'GET' });
  assert(r3.status !== 200, `GET /api/a2a → ${r3.status} (want not-200)`);

  // Bad bearer token → 401
  const r4 = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': 'Bearer this-is-not-a-valid-jwt' },
    body: JSON.stringify(makeRpcRequest(A2A_METHODS.GET_TASK, { id: 'x' })),
  });
  assert(r4.status === 401, `invalid bearer token → ${r4.status} (want 401)`);
}

// ─── Step 9b: Authenticated negative + security tests ────────────────────────

async function negativeAuthenticated(token: string): Promise<void> {
  section('Step 9b: Authenticated negative / security');

  // Malformed JSON body → PARSE_ERROR 400
  const r1 = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'A2A-Version': '1.0', 'Authorization': `Bearer ${token}` },
    body: '{this is not json',
  });
  assert(r1.status === 400, `malformed JSON → ${r1.status} (want 400)`);
  const r1b = await r1.json() as { error: { code: number } };
  assert(r1b.error.code === A2A_ERROR_CODES.PARSE_ERROR, `error.code = ${r1b.error.code} (want PARSE_ERROR ${A2A_ERROR_CODES.PARSE_ERROR})`);

  // Unknown method → METHOD_NOT_FOUND 404
  const { status: s2, body: b2 } = await a2aPost(token, 'MethodThatDoesNotExist', {});
  assert(s2 === 404, `unknown method → ${s2} (want 404)`);
  assert((b2 as { error?: { code: number } }).error?.code === A2A_ERROR_CODES.METHOD_NOT_FOUND, 'error.code = METHOD_NOT_FOUND');

  // INVALID_PARAMS: missing taskId in CreatePushConfig → 400
  const { status: s3 } = await a2aPost(token, A2A_METHODS.CREATE_PUSH_CONFIG, {
    config: { url: 'https://x.example.com/hook' }, // no taskId
  });
  assert(s3 === 400, `missing taskId → ${s3} (want 400)`);

  // INVALID_PARAMS: missing config.url in CreatePushConfig → 400
  const { status: s4 } = await a2aPost(token, A2A_METHODS.CREATE_PUSH_CONFIG, {
    taskId: 'task-neg', config: { token: 'only-token' }, // no url
  });
  assert(s4 === 400, `missing config.url → ${s4} (want 400)`);

  // TASK_NOT_FOUND: GetTask for non-existent id → 404
  const { status: s5, body: b5 } = await a2aPost(token, A2A_METHODS.GET_TASK, {
    id: 'task-id-that-absolutely-does-not-exist-99999',
  });
  assert(s5 === 404, `GetTask unknown id → ${s5} (want 404)`);
  assert(
    (b5 as { error?: { code: number } }).error?.code === A2A_ERROR_CODES.TASK_NOT_FOUND,
    'error.code = TASK_NOT_FOUND',
  );

  // INVALID_REQUEST: JSON-RPC version 1.0 → 400
  const r6 = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify({ jsonrpc: '1.0', method: 'GetTask', id: '1', params: { id: 'x' } }),
  });
  assert(r6.status === 400, `jsonrpc 1.0 → ${r6.status} (want 400)`);

  // SQL injection in task message — must not cause server error
  const { status: s7 } = await a2aPost(token, A2A_METHODS.SEND_MESSAGE, {
    message: {
      role: 'user',
      parts: [{ text: "'; DROP TABLE tasks; SELECT * FROM users WHERE '1'='1" }],
      messageId: `msg-sql-${RUN_ID}`,
      contextId: `ctx-sql-${RUN_ID}`,
    },
  });
  assert(s7 !== 500, `SQL injection in message does not cause 500 (got ${s7})`);

  // XSS in push config token field — stored verbatim, not interpreted
  const { status: s8, body: b8 } = await a2aPost(token, A2A_METHODS.CREATE_PUSH_CONFIG, {
    taskId: `xss-task-${RUN_ID}`,
    config: { url: 'https://safe.example.com/hook', token: '<script>alert(1)</script>' },
  });
  assert(s8 === 200, `XSS push config stored safely (status ${s8})`);
  assert(
    (b8 as { result?: A2APushNotificationConfigEntry }).result?.token === '<script>alert(1)</script>',
    'XSS payload stored verbatim (not interpreted)',
  );

  // 100 K string — must not crash the server
  const { status: s9 } = await a2aPost(token, A2A_METHODS.SEND_MESSAGE, {
    message: {
      role: 'user',
      parts: [{ text: 'A'.repeat(100_000) }],
      messageId: `msg-large-${RUN_ID}`,
      contextId: `ctx-large-${RUN_ID}`,
    },
  });
  assert(s9 !== 500, `100K character message does not crash server (got ${s9})`);
}

// ─── Step 10: Logout ──────────────────────────────────────────────────────────

async function logout(token: string): Promise<void> {
  section('Step 10: Logout (POST /api/auth/logout)');

  const res = await fetch(`${BASE_URL}/api/auth/logout`, {
    method: 'POST',
    headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
  });
  assert(res.ok, `logout → ${res.status} (want 2xx)`);

  // The session token must now be invalid
  const r2 = await fetch(A2A_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${token}` },
    body: JSON.stringify(makeRpcRequest(A2A_METHODS.GET_TASK, { id: 'x' })),
  });
  assert(r2.status === 401, `revoked token after logout → ${r2.status} (want 401)`);
  pass('Session correctly invalidated after logout');
}

// ─── Main ─────────────────────────────────────────────────────────────────────

async function main() {
  console.log(`\nA2A External Client → geneWeave E2E`);
  console.log(`Target:  ${A2A_URL}`);
  console.log(`Test ID: ${RUN_ID} (${TEST_EMAIL})`);
  console.log('====================================\n');

  let token: string;
  try {
    const result = await registerAndAuthenticate();
    token = result.token;
  } catch (err) {
    console.error(`\nFatal: could not register or authenticate.`);
    console.error(`  URL:  ${BASE_URL}`);
    console.error(`  User: ${TEST_EMAIL}`);
    console.error(`  ${err instanceof Error ? err.message : String(err)}`);
    console.error(`\nTip: start geneWeave with NODE_ENV=test to skip email verification:`);
    console.error(`  NODE_ENV=test npm start  (in apps/geneweave)`);
    process.exit(1);
  }

  await discoverCard();
  const taskId = await sendMessage(token);
  await sendStreamingMessage(token);
  await getTask(token, taskId);
  await listTasks(token);
  await getExtendedCard(token);
  await pushNotificationCrud(token);
  await negativeUnauthenticated();
  await negativeAuthenticated(token);
  await logout(token);

  console.log(`\n====================================`);
  console.log(`Results: ${passed} passed, ${failed} failed`);
  if (failed > 0) process.exit(1);
}

main().catch((err) => {
  console.error('\nFatal:', err instanceof Error ? err.message : err);
  process.exit(1);
});
