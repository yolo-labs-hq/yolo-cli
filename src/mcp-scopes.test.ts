/**
 * mcp-scopes tests — `yolo mcp scopes`.
 *
 * Coverage:
 *   - happy summary (default agent substrate-cli, Bearer user JWT, query params)
 *   - --json output shape
 *   - --agent override rides in the query
 *   - empty allowed/denied render "(none)"
 *   - missing SESSION_ID → auth failure (no network)
 *   - HTTP failure surfaces status + body
 *   - malformed response (missing arrays) → http failure
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runMcpScopes, exitCodeForFailure } from './mcp-scopes.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  HOME: '/nonexistent-yolo-cli-test-home',
  YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};

interface Captured { url: string; method: string; headers?: Record<string, string> }

function makeFetchStub(
  respond: () => { ok: boolean; status: number; body: unknown },
  captured: Captured[] = [],
): FetchLike {
  return async (url, init = {}) => {
    captured.push({ url, method: init.method ?? 'GET', headers: init.headers });
    const r = respond();
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  };
}

describe('runMcpScopes', () => {
  it('fetches the partition for substrate-cli by default and renders the summary', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetchStub(() => ({
      ok: true,
      status: 200,
      body: { agentId: 'substrate-cli', allowed: ['work.get_artifact', 'work.list_artifacts'], denied: ['studio.create_tile'] },
    }), captured);

    const result = await runMcpScopes({ env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(result.allowed, ['work.get_artifact', 'work.list_artifacts']);
    assert.deepEqual(result.denied, ['studio.create_tile']);
    assert.match(result.output, /Mintable MCP scopes for agent 'substrate-cli' \(session sess-abc\)/);
    assert.match(result.output, /Allowed \(2\):/);
    assert.match(result.output, /- work\.get_artifact/);
    assert.match(result.output, /Not mintable \(1\):/);
    assert.match(result.output, /- studio\.create_tile/);

    assert.equal(captured.length, 1);
    assert.equal(captured[0]!.method, 'GET');
    assert.equal(captured[0]!.url, 'https://api.example.com/internal/mcp/scopes?sessionId=sess-abc&agentId=substrate-cli');
    assert.equal(captured[0]!.headers?.Authorization, 'Bearer user-jwt');
  });

  it('emits {agentId, allowed, denied} with --json', async () => {
    const fetchImpl = makeFetchStub(() => ({
      ok: true,
      status: 200,
      body: { agentId: 'substrate-cli', allowed: ['work.get_artifact'], denied: [] },
    }));
    const result = await runMcpScopes({ env: STUB_ENV, fetchImpl, outputFormat: 'json' });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.deepEqual(JSON.parse(result.output), { agentId: 'substrate-cli', allowed: ['work.get_artifact'], denied: [] });
  });

  it('passes an --agent override through as the agentId query param', async () => {
    const captured: Captured[] = [];
    const fetchImpl = makeFetchStub(() => ({
      ok: true, status: 200, body: { agentId: 'claude', allowed: [], denied: [] },
    }), captured);
    const result = await runMcpScopes({ env: STUB_ENV, fetchImpl, agentId: 'claude' });
    assert.equal(result.ok, true);
    assert.match(captured[0]!.url, /agentId=claude$/);
    if (result.ok) {
      assert.match(result.output, /agent 'claude'/);
      assert.match(result.output, /Allowed \(0\):\n {2}\(none\)/);
    }
  });

  it('fails auth (no network) without SESSION_ID', async () => {
    const fetchImpl = makeFetchStub(() => { throw new Error('must not be called'); });
    const { SESSION_ID: _omit, ...envNoSession } = STUB_ENV;
    const result = await runMcpScopes({ env: envNoSession, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'auth');
      assert.match(result.message, /SESSION_ID/);
    }
  });

  it('surfaces an HTTP failure with status + body', async () => {
    const fetchImpl = makeFetchStub(() => ({ ok: false, status: 403, body: { error: 'User does not own this session' } }));
    const result = await runMcpScopes({ env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'http');
      assert.match(result.message, /HTTP 403/);
      assert.match(result.message, /does not own/);
    }
  });

  it('rejects a malformed response missing allowed/denied arrays', async () => {
    const fetchImpl = makeFetchStub(() => ({ ok: true, status: 200, body: { agentId: 'substrate-cli' } }));
    const result = await runMcpScopes({ env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'http');
      assert.match(result.message, /allowed.*denied/);
    }
  });
});

describe('exitCodeForFailure', () => {
  it('maps http → 1, usage/auth → 64', () => {
    assert.equal(exitCodeForFailure('http'), 1);
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
  });
});
