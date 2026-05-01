/**
 * work-client tests (Phase 8c.2).
 *
 * Stub `fetchImpl` so we never touch real network; assert the request
 * shape (URL, method, headers, body) and the parsing of common-api's
 * response/error envelopes. All tests are pure and self-contained.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  mintSubstrateToken,
  authenticatedRequest,
  WorkClientError,
  SUBSTRATE_CLI_AGENT_ID,
  SUBSTRATE_CLI_PLAN_SCOPES,
  SUBSTRATE_CLI_RUN_SCOPES,
  type FetchLike,
} from './work-client.js';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string;
}

function makeFetchStub(
  response: { ok?: boolean; status?: number; jsonBody?: unknown; textBody?: string },
): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    calls.push({
      url,
      method: init.method ?? 'GET',
      headers: init.headers ?? {},
      body: init.body,
    });
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => {
        if (response.jsonBody === undefined) throw new Error('no json body');
        return response.jsonBody;
      },
      text: async () => response.textBody ?? JSON.stringify(response.jsonBody ?? {}),
    };
  };
  return { fetch, calls };
}

const VALID_MINT_RESPONSE = {
  token: 'eyJhbGc.fake.jwt',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: {
    workspaceId: '507f1f77bcf86cd799439011',
    agentId: 'substrate-cli',
    scopes: ['work.get_plan'],
  },
};

// ─── mintSubstrateToken — request shape ──────────────────────────────────
describe('work-client — mintSubstrateToken request shape', () => {
  it('POSTs to /internal/mcp/tokens with X-Internal-Auth + correct body', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: VALID_MINT_RESPONSE });
    await mintSubstrateToken({
      commonApiUrl: 'https://api.example.com',
      internalApiKey: 'svc-key-xyz',
      sessionId: 'sess-abc',
      scopes: ['work.create_plan'],
      fetchImpl: fetch,
    });
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.example.com/internal/mcp/tokens');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers['Content-Type'], 'application/json');
    assert.equal(calls[0]!.headers['X-Internal-Auth'], 'svc-key-xyz');
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body.sessionId, 'sess-abc');
    assert.equal(body.agentId, SUBSTRATE_CLI_AGENT_ID);
    assert.deepEqual(body.scopes, ['work.create_plan']);
  });

  it('strips a trailing slash from commonApiUrl', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: VALID_MINT_RESPONSE });
    await mintSubstrateToken({
      commonApiUrl: 'https://api.example.com/',
      internalApiKey: 'k',
      sessionId: 's',
      scopes: SUBSTRATE_CLI_PLAN_SCOPES,
      fetchImpl: fetch,
    });
    assert.equal(calls[0]!.url, 'https://api.example.com/internal/mcp/tokens');
  });
});

// ─── mintSubstrateToken — happy path ─────────────────────────────────────
describe('work-client — mintSubstrateToken happy path', () => {
  it('returns token + workspaceId + jti from claims', async () => {
    const { fetch } = makeFetchStub({ jsonBody: VALID_MINT_RESPONSE });
    const result = await mintSubstrateToken({
      commonApiUrl: 'https://api.example.com',
      internalApiKey: 'k',
      sessionId: 's',
      scopes: ['work.get_plan'],
      fetchImpl: fetch,
    });
    assert.equal(result.token, VALID_MINT_RESPONSE.token);
    assert.equal(result.expiresAt, VALID_MINT_RESPONSE.expiresAt);
    assert.equal(result.workspaceId, VALID_MINT_RESPONSE.claims.workspaceId);
    assert.equal(result.jti, VALID_MINT_RESPONSE.jti);
  });
});

// ─── mintSubstrateToken — error envelopes ────────────────────────────────
describe('work-client — mintSubstrateToken error handling', () => {
  it('throws WorkClientError with status + code on 4xx', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 400,
      jsonBody: { error: 'sessionId is required', code: 'INVALID_ARGUMENT' },
    });
    await assert.rejects(
      mintSubstrateToken({
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        sessionId: '',
        scopes: ['work.get_plan'],
        fetchImpl: fetch,
      }),
      (err: unknown) =>
        err instanceof WorkClientError &&
        err.status === 400 &&
        err.code === 'INVALID_ARGUMENT' &&
        /sessionId/.test(err.message),
    );
  });

  it('throws WorkClientError with HTTP status when body is not JSON', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 500,
      textBody: 'internal error (text body, not JSON)',
    });
    await assert.rejects(
      mintSubstrateToken({
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        sessionId: 's',
        scopes: ['work.get_plan'],
        fetchImpl: fetch,
      }),
      (err: unknown) =>
        err instanceof WorkClientError &&
        err.status === 500 &&
        err.code === 'INTERNAL' &&
        /HTTP 500/.test(err.message),
    );
  });

  it('throws WorkClientError on missing token in response', async () => {
    const { fetch } = makeFetchStub({
      jsonBody: {
        // no `token` field — common-api guarantees it but the client
        // still validates defensively in case of a proxy/middleware bug.
        expiresAt: '2026-04-30T...',
        jti: 'x',
        claims: { workspaceId: 'w' },
      },
    });
    await assert.rejects(
      mintSubstrateToken({
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        sessionId: 's',
        scopes: ['work.get_plan'],
        fetchImpl: fetch,
      }),
      (err: unknown) =>
        err instanceof WorkClientError && /token/.test(err.message),
    );
  });

  it('throws WorkClientError on missing claims.workspaceId', async () => {
    const { fetch } = makeFetchStub({
      jsonBody: {
        token: 'jwt',
        expiresAt: '2026-04-30T...',
        jti: 'x',
        claims: {}, // no workspaceId
      },
    });
    await assert.rejects(
      mintSubstrateToken({
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        sessionId: 's',
        scopes: ['work.get_plan'],
        fetchImpl: fetch,
      }),
      (err: unknown) =>
        err instanceof WorkClientError && /workspaceId/.test(err.message),
    );
  });
});

// ─── authenticatedRequest ────────────────────────────────────────────────
describe('work-client — authenticatedRequest', () => {
  it('sends both X-Internal-Auth and Authorization Bearer + work-path prefix', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { plan: { planId: 'foo', version: 1 } } });
    await authenticatedRequest(
      {
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'svc-key',
        delegatedToken: 'jwt-xyz',
        fetchImpl: fetch,
      },
      '/workspaces/wsA/plans/foo',
      { method: 'GET' },
    );
    assert.equal(calls.length, 1);
    assert.equal(
      calls[0]!.url,
      'https://api.example.com/internal/work/workspaces/wsA/plans/foo',
    );
    assert.equal(calls[0]!.method, 'GET');
    assert.equal(calls[0]!.headers['X-Internal-Auth'], 'svc-key');
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer jwt-xyz');
  });

  it('serializes jsonBody and sets Content-Type', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { ok: true } });
    await authenticatedRequest(
      {
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        delegatedToken: 't',
        fetchImpl: fetch,
      },
      '/workspaces/wsA/plans',
      { method: 'POST', jsonBody: { planId: 'foo', name: 'Foo' } },
    );
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers['Content-Type'], 'application/json');
    const body = JSON.parse(calls[0]!.body!) as Record<string, unknown>;
    assert.equal(body.planId, 'foo');
    assert.equal(body.name, 'Foo');
  });

  it('does not set Content-Type when there is no body (GET request)', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: {} });
    await authenticatedRequest(
      {
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        delegatedToken: 't',
        fetchImpl: fetch,
      },
      '/workspaces/wsA/plans',
    );
    assert.equal(calls[0]!.body, undefined);
    assert.equal(calls[0]!.headers['Content-Type'], undefined);
  });

  it('returns the underlying response object verbatim (caller handles status)', async () => {
    const { fetch } = makeFetchStub({ ok: false, status: 409, jsonBody: { error: 'version conflict', code: 'VERSION_CONFLICT' } });
    const response = await authenticatedRequest(
      {
        commonApiUrl: 'https://api.example.com',
        internalApiKey: 'k',
        delegatedToken: 't',
        fetchImpl: fetch,
      },
      '/workspaces/wsA/plans/foo',
      { method: 'PATCH', jsonBody: { baseVersion: 1, mutations: [] } },
    );
    assert.equal(response.ok, false);
    assert.equal(response.status, 409);
    const body = (await response.json()) as { code?: string };
    assert.equal(body.code, 'VERSION_CONFLICT');
  });

  it('strips trailing slash from commonApiUrl', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: {} });
    await authenticatedRequest(
      {
        commonApiUrl: 'https://api.example.com/',
        internalApiKey: 'k',
        delegatedToken: 't',
        fetchImpl: fetch,
      },
      '/workspaces/wsA/plans',
    );
    assert.equal(calls[0]!.url, 'https://api.example.com/internal/work/workspaces/wsA/plans');
  });
});

// ─── Constants stay in sync with agents.json (substrate-cli scopes) ─────
describe('work-client — substrate scope constants', () => {
  it('exposes the expected v1 plan scopes (capped per agents.json substrate-cli)', () => {
    assert.deepEqual(SUBSTRATE_CLI_PLAN_SCOPES, [
      'work.create_plan',
      'work.update_plan',
      'work.get_plan',
      'work.list_plans',
    ]);
  });

  it('exposes the expected v1 run-lifecycle scopes', () => {
    assert.deepEqual(SUBSTRATE_CLI_RUN_SCOPES, [
      'work.start_run',
      'work.get_run',
      'work.list_runs',
      'work.pause_run',
      'work.resume_run',
      'work.cancel_run',
      'work.transfer_run_operator',
    ]);
  });
});
