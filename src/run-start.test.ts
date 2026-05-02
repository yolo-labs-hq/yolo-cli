/**
 * run-start tests.
 *
 * Stubs:
 *   - fetchImpl: routes /internal/mcp/tokens + POST /internal/work/...
 *   - env: synthetic trio
 *
 * Coverage:
 *   - happy summary + happy --json
 *   - request body shape (planId only / planId + inputs)
 *   - planId regex rejection (no network)
 *   - missing SESSION_ID → auth failure
 *   - YOLO_API_URL fallback when YOLO_COMMON_API_URL is missing
 *   - --workspace mismatch
 *   - HTTP 4xx (PLAN_NOT_ACTIVE → 409)
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRunStart, formatSummary, exitCodeForFailure } from './run-start.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  INTERNAL_API_KEY: 'svc-key',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, userId: '507f1f77bcf86cd799439001', agentId: 'substrate-cli', scopes: ['work.start_run'] },
};

const STUB_BOOTSTRAP = {
  planRunId: 'pr_abc123',
  runNumber: 7,
  runDesktopId: 'desk_xyz',
  executionState: 'pending',
  operatorAgentId: 'substrate-cli',
};

interface RouteHandler {
  matches: (url: string, method: string) => boolean;
  respond: () => { ok: boolean; status: number; body: unknown };
  capture?: (init: { method?: string; headers?: Record<string, string>; body?: string }) => void;
}

function makeFetchStub(routes: RouteHandler[]): FetchLike {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    for (const route of routes) {
      if (route.matches(url, method)) {
        if (route.capture) route.capture(init);
        const r = route.respond();
        return {
          ok: r.ok,
          status: r.status,
          json: async () => r.body,
          text: async () => JSON.stringify(r.body),
        };
      }
    }
    throw new Error(`unmatched fetch in test: ${method} ${url}`);
  };
}

const mintRoute: RouteHandler = {
  matches: (url, method) => method === 'POST' && url.endsWith('/internal/mcp/tokens'),
  respond: () => ({ ok: true, status: 201, body: STUB_TOKEN_RESPONSE }),
};

function startRoute(captured: { body?: unknown }): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs`),
    capture: (init) => {
      if (typeof init.body === 'string') captured.body = JSON.parse(init.body);
    },
    respond: () => ({ ok: true, status: 200, body: STUB_BOOTSTRAP }),
  };
}

function startError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────
describe('run-start — happy path', () => {
  it('emits a one-line OK summary by default', async () => {
    const captured: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, startRoute(captured)]);
    const result = await runRunStart({ planId: 'final-launch', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /^OK: started run pr_abc123 for plan final-launch \(run #7, executionState=pending, operator=substrate-cli\)$/);
  });

  it('sends planId-only body when --inputs is absent', async () => {
    const captured: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, startRoute(captured)]);
    await runRunStart({ planId: 'final-launch', fetchImpl: fetch, env: STUB_ENV });
    assert.deepEqual(captured.body, { planId: 'final-launch' });
  });

  it('sends planId + inputs body when --inputs is provided', async () => {
    const captured: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, startRoute(captured)]);
    await runRunStart({
      planId: 'final-launch',
      inputs: { env: 'prod', region: 'us-east-1' },
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.deepEqual(captured.body, {
      planId: 'final-launch',
      inputs: { env: 'prod', region: 'us-east-1' },
    });
  });

  it('emits raw JSON when format is "json"', async () => {
    const captured: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, startRoute(captured)]);
    const result = await runRunStart({
      planId: 'final-launch',
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.planRunId, 'pr_abc123');
    assert.equal(parsed.runNumber, 7);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('run-start — formatSummary pure renderer', () => {
  it('renders operator=(unbound) when operatorAgentId is null', () => {
    const out = formatSummary(
      { ...STUB_BOOTSTRAP, operatorAgentId: null },
      'final-launch',
    );
    assert.match(out, /operator=\(unbound\)/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('run-start — failures', () => {
  it('rejects malformed planId before any network call', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunStart({ planId: 'has spaces', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunStart({
      planId: 'final-launch',
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
    assert.match(result.message, /SESSION_ID/);
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const captured: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, startRoute(captured)]);
    const result = await runRunStart({
      planId: 'final-launch',
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runRunStart({
      planId: 'final-launch',
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns http failure on 409 PLAN_NOT_ACTIVE', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      startError(409, { error: 'plan is not active', code: 'PLAN_NOT_ACTIVE' }),
    ]);
    const result = await runRunStart({ planId: 'draft-plan', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 409/);
    assert.equal(exitCodeForFailure(result.kind), 1);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('run-start — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
