/**
 * routing-cli tests: argument parsing for every verb, the exact route each
 * one reaches with the USER token, `--json` printing the body as-is, and the
 * short human readings of status and decisions.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatDecisions, formatStatus, parseRoutingArgs, runRouting, type ParsedRoutingArgs } from './routing-cli.js';
import type { FetchLike } from './work-client.js';

const WS = '507f1f77bcf86cd799439011';
const CARD = '507f1f77bcf86cd799439022';
const BOARD = '507f1f77bcf86cd799439033';
const BASE = `https://api.example.com/v1/workspaces/${WS}/yolo-background/routing`;
const ENV = {
  SESSION_ID: 'sess-abc', HOME: '/nonexistent-yolo-cli-test-home', YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com', WORKSPACE_ID: WS,
};

interface Seen { url: string; method?: string; auth?: string; body?: unknown }

function stub(responses: Array<{ status?: number; body: unknown }>): { fetchImpl: FetchLike; seen: Seen[] } {
  const seen: Seen[] = [];
  let i = 0;
  const fetchImpl: FetchLike = async (url, init) => {
    seen.push({ url, method: init?.method, auth: init?.headers?.Authorization, body: init?.body ? JSON.parse(init.body) : undefined });
    const r = responses[Math.min(i++, responses.length - 1)]!;
    const text = typeof r.body === 'string' ? r.body : JSON.stringify(r.body);
    const status = r.status ?? 200;
    return { ok: status < 400, status, json: async () => JSON.parse(text), text: async () => text };
  };
  return { fetchImpl, seen };
}

const parsed = (args: string[]) => {
  const p = parseRoutingArgs(args);
  assert.ok(p.ok, `expected ${args.join(' ')} to parse: ${!p.ok ? p.message : ''}`);
  return p as Extract<ParsedRoutingArgs, { ok: true }>;
};
const refusal = (args: string[]) => {
  const p = parseRoutingArgs(args);
  assert.equal(p.ok, false, `expected ${args.join(' ')} to be refused`);
  return (p as { message: string }).message;
};

describe('parseRoutingArgs', () => {
  it('parses each verb', () => {
    assert.deepEqual(parsed(['status']).command, { verb: 'status' });
    assert.deepEqual(parsed(['on']).command, { verb: 'on' });
    assert.deepEqual(parsed(['off', '--json']), { ok: true, command: { verb: 'off' }, json: true, workspaceFlag: undefined });
    assert.deepEqual(parsed(['decisions']).command, { verb: 'decisions' });
    assert.deepEqual(parsed(['decisions', '--card', CARD, '--limit=5']).command, { verb: 'decisions', cardId: CARD, limit: 5 });
    assert.deepEqual(parsed(['preview', CARD]).command, { verb: 'preview', cardId: CARD });
    assert.deepEqual(parsed(['policy', 'get', '--card', CARD]).command, { verb: 'policy-get', cardId: CARD });
    assert.deepEqual(parsed(['policy', 'set', '--runner', '--policy', '{}']).command,
      { verb: 'policy-set', target: { scope: 'runner' }, policyJson: '{}' });
    assert.deepEqual(parsed(['policy', 'set', '--board', BOARD, '--file', 'p.json', '--expected-revision', '2']).command,
      { verb: 'policy-set', target: { scope: 'board', scopeId: BOARD }, policyFile: 'p.json', expectedRevision: 2 });
    assert.deepEqual(parsed(['policy', 'delete', '--card', CARD]).command, { verb: 'policy-delete', target: { scope: 'card', scopeId: CARD } });
    assert.equal(parsed(['status', '--workspace', WS]).workspaceFlag, WS);
  });

  it('refuses malformed input', () => {
    assert.match(refusal(['nope']), /unknown routing subcommand/);
    assert.match(refusal(['status', 'extra']), /unexpected positional/);
    assert.match(refusal(['status', '--card', CARD]), /--card does not apply/);
    assert.match(refusal(['decisions', '--limit', '0']), /1 to 200/);
    assert.match(refusal(['decisions', '--card', 'abc']), /card id/);
    assert.match(refusal(['preview']), /cardId> is required/);
    assert.match(refusal(['policy']), /get, set or delete/);
    assert.match(refusal(['policy', 'set', '--policy', '{}']), /--runner or --board/);
    assert.match(refusal(['policy', 'set', '--runner', '--board', BOARD, '--policy', '{}']), /--runner or --board/);
    assert.match(refusal(['policy', 'set', '--runner']), /exactly one of --file/);
    assert.match(refusal(['policy', 'set', '--card', CARD, '--policy', '{}']), /set on the card/);
    assert.match(refusal(['policy', 'delete', '--runner', '--expected-revision', '0']), /1 or more/);
    assert.match(refusal(['status', '--frobnicate']), /unknown option/);
    assert.match(refusal(['decisions', '--card']), /requires a value/);
  });
});

describe('runRouting', () => {
  it('status reads /config with the user token; --json prints the body unchanged', async () => {
    const body = '{"enabled":false,"jev":{"state":"unavailable","reason":"routing-off"}}';
    const { fetchImpl, seen } = stub([{ body }]);
    const result = await runRouting(parsed(['status', '--json']), { fetchImpl, env: ENV });
    assert.deepEqual(result, { ok: true, output: body, raw: true, workspaceId: WS });
    assert.deepEqual(seen, [{ url: `${BASE}/config`, method: 'GET', auth: 'Bearer user-jwt', body: undefined }]);
  });

  it('status says why Jev is unavailable', async () => {
    const { fetchImpl } = stub([{ body: { enabled: true, jev: { state: 'unavailable', reason: 'missing-credentials', usage: [] },
      policies: [{ scope: 'runner', scopeId: null, revision: 3 }], cardPolicies: { count: 2 } } }]);
    const result = await runRouting(parsed(['status']), { fetchImpl, env: ENV });
    assert.ok(result.ok);
    assert.match(result.output, /Routing: on/);
    assert.match(result.output, /Jev: +unavailable \(missing-credentials\)/);
    assert.match(result.output, /runner +revision 3/);
    assert.match(result.output, /Card policies \(model pins\): 2/);
  });

  it('on and off PUT /enabled', async () => {
    const { fetchImpl, seen } = stub([{ body: { ok: true, enabled: true } }]);
    const on = await runRouting(parsed(['on']), { fetchImpl, env: ENV });
    assert.ok(on.ok && /Routing is on/.test(on.output));
    await runRouting(parsed(['off', '--json']), { fetchImpl, env: ENV });
    assert.deepEqual(seen.map(s => [s.url, s.method, s.body]), [
      [`${BASE}/enabled`, 'PUT', { enabled: true }],
      [`${BASE}/enabled`, 'PUT', { enabled: false }],
    ]);
  });

  it('decisions and preview reach their routes', async () => {
    const { fetchImpl, seen } = stub([{ body: { decisions: [], shadow: {} } }]);
    await runRouting(parsed(['decisions', '--card', CARD, '--limit', '3']), { fetchImpl, env: ENV });
    await runRouting(parsed(['decisions']), { fetchImpl, env: ENV });
    await runRouting(parsed(['preview', CARD, '--json']), { fetchImpl, env: ENV });
    assert.deepEqual(seen.map(s => [s.url, s.method, s.body]), [
      [`${BASE}/decisions?cardIds=${CARD}&limit=3`, 'GET', undefined],
      [`${BASE}/decisions`, 'GET', undefined],
      [`${BASE}/preview`, 'POST', { cardId: CARD }],
    ]);
  });

  it('policy get --json returns only the policies', async () => {
    const { fetchImpl } = stub([{ body: { enabled: true, catalog: [1, 2, 3], policies: [{ scope: 'runner', revision: 1 }], cardPolicies: { count: 0 } } }]);
    const result = await runRouting(parsed(['policy', 'get', '--json']), { fetchImpl, env: ENV });
    assert.ok(result.ok);
    assert.deepEqual(JSON.parse(result.output), { policies: [{ scope: 'runner', revision: 1 }], cardPolicies: { count: 0 } });
  });

  it('policy set fences on the stored revision when none is given', async () => {
    const { fetchImpl, seen } = stub([
      { body: { policies: [{ scope: 'board', scopeId: BOARD, revision: 4 }] } },
      { body: { ok: true, revision: 5 } },
    ]);
    const result = await runRouting(parsed(['policy', 'set', '--board', BOARD, '--file', 'p.json']),
      { fetchImpl, env: ENV, readFileImpl: () => '{"strategy":"balanced"}' });
    assert.ok(result.ok && /revision 5/.test(result.output));
    assert.deepEqual(seen[1], { url: `${BASE}/policy`, method: 'PUT', auth: 'Bearer user-jwt',
      body: { scope: 'board', scopeId: BOARD, policy: { strategy: 'balanced' }, expectedRevision: 4 } });
  });

  it('policy set refuses a policy that is not a JSON object, before any request', async () => {
    const { fetchImpl, seen } = stub([{ body: {} }]);
    const result = await runRouting(parsed(['policy', 'set', '--runner', '--policy', '[1]', '--expected-revision', '1']), { fetchImpl, env: ENV });
    assert.equal(result.ok, false);
    assert.equal(!result.ok && result.kind, 'usage');
    assert.equal(seen.length, 0);
  });

  it('policy delete uses the per-scope route; a stale revision is an http failure', async () => {
    const { fetchImpl, seen } = stub([{ status: 409, body: { error: 'The policy changed since it was loaded. Reload and retry.', code: 'stale-revision' } }]);
    const result = await runRouting(parsed(['policy', 'delete', '--board', BOARD, '--expected-revision', '2']), { fetchImpl, env: ENV });
    assert.equal(seen[0]!.url, `${BASE}/policy/board/${BOARD}?expectedRevision=2`);
    assert.equal(seen[0]!.method, 'DELETE');
    assert.equal(result.ok, false);
    assert.ok(!result.ok && result.kind === 'http' && /HTTP 409/.test(result.message));
  });

  it('a --workspace that does not match the session refuses', async () => {
    const { fetchImpl, seen } = stub([{ body: {} }]);
    const result = await runRouting(parsed(['status', '--workspace', BOARD]), { fetchImpl, env: ENV });
    assert.equal(!result.ok && result.kind, 'workspace_mismatch');
    assert.equal(seen.length, 0);
  });
});

describe('formatting', () => {
  it('formatDecisions lists selected models and waiting codes', () => {
    assert.equal(formatDecisions({ decisions: [] }), 'No routing decisions recorded.');
    const out = formatDecisions({ decisions: [
      { cardId: CARD, kind: 'attempt', createdAt: 't1', decision: { status: 'selected', selected: { configurationId: 'claude:opus' } } },
      { cardId: CARD, kind: 'waiting', createdAt: 't0', decision: { status: 'waiting', selected: null, waiting: { code: 'jev-unavailable' } } },
    ] });
    assert.equal(out, `t1  ${CARD}  attempt  selected  claude:opus\nt0  ${CARD}  waiting  waiting  jev-unavailable`);
  });

  it('formatStatus totals Jev usage', () => {
    const out = formatStatus({ enabled: true, jev: { state: 'active', reason: null, usage: [
      { day: 'd1', calls: 2, failures: 0, costUsd: 0.01 }, { day: 'd2', calls: 1, failures: 0, costUsd: 0.005 }] } });
    assert.match(out, /Jev: +active/);
    assert.match(out, /3 calls in the last 2 days, \$0\.0150/);
    assert.match(out, /Policies: none/);
  });
});
