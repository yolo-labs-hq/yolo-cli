/**
 * run-list tests.
 *
 * Coverage:
 *   - happy summary + happy --json
 *   - empty list renders "(no runs)"
 *   - --state filter passes through as ?executionState=
 *   - --state value validated client-side first (no network)
 *   - column padding adapts to longest planRunId / planId / state /
 *     operatorAgentId
 *   - operator=(unbound) when operatorAgentId is null
 *   - missing SESSION_ID → auth failure
 *   - YOLO_API_URL fallback
 *   - --workspace mismatch
 *   - HTTP 5xx
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRunList, formatSummary, exitCodeForFailure } from './run-list.js';
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
  claims: { workspaceId: STUB_WS, userId: '507f1f77bcf86cd799439001', agentId: 'substrate-cli', scopes: ['work.list_runs'] },
};

const STUB_RUNS = [
  {
    planRunId: 'pr_abc',
    planId: 'final-launch',
    planVersion: 3,
    runNumber: 7,
    executionState: 'running' as const,
    operatorAgentId: 'substrate-cli',
    operatorResponsive: true,
    startedAt: '2026-05-01T10:00:00.000Z',
    endedAt: null,
  },
  {
    planRunId: 'pr_def',
    planId: 'hotfix',
    planVersion: 1,
    runNumber: 1,
    executionState: 'succeeded' as const,
    operatorAgentId: 'claude',
    operatorResponsive: true,
    startedAt: '2026-04-30T08:00:00.000Z',
    endedAt: '2026-04-30T08:30:00.000Z',
  },
];

interface RouteHandler {
  matches: (url: string, method: string) => boolean;
  respond: () => { ok: boolean; status: number; body: unknown };
  capture?: (url: string) => void;
}

function makeFetchStub(routes: RouteHandler[]): FetchLike {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    for (const route of routes) {
      if (route.matches(url, method)) {
        if (route.capture) route.capture(url);
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

function listRoute(runs: unknown[], captured: { url?: string } = {}): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.includes(`/internal/work/workspaces/${STUB_WS}/runs`),
    capture: (url) => {
      captured.url = url;
    },
    respond: () => ({ ok: true, status: 200, body: { runs } }),
  };
}

function listError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.includes(`/internal/work/workspaces/${STUB_WS}/runs`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────
describe('run-list — happy path', () => {
  it('emits a header + per-run rows by default', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_RUNS)]);
    const result = await runRunList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Plan Runs in workspace .* 2/);
    assert.match(result.output, /pr_abc\s+final-launch\s+#7\s+running\s+substrate-cli/);
    assert.match(result.output, /pr_def\s+hotfix\s+#1\s+succeeded\s+claude/);
  });

  it('emits raw JSON when format is "json"', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_RUNS)]);
    const result = await runRunList({
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].planRunId, 'pr_abc');
  });

  it('renders "(no runs)" hint when the list is empty', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute([])]);
    const result = await runRunList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Plan Runs in workspace .* 0/);
    assert.match(result.output, /\(no runs\)/);
  });

  it('passes --state through as ?executionState=', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_RUNS, captured)]);
    await runRunList({
      fetchImpl: fetch,
      env: STUB_ENV,
      stateFilter: 'running',
    });
    assert.match(captured.url ?? '', /\?executionState=running$/);
  });

  it('omits ?executionState= when no filter', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_RUNS, captured)]);
    await runRunList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal((captured.url ?? '').includes('?executionState='), false);
  });

  it('renders the filter tag in the header when --state is set', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_RUNS)]);
    const result = await runRunList({
      fetchImpl: fetch,
      env: STUB_ENV,
      stateFilter: 'paused',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /\(filter: paused\)/);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('run-list — formatSummary pure renderer', () => {
  it('renders operator=(unbound) when operatorAgentId is null', () => {
    const out = formatSummary(
      [{ ...STUB_RUNS[0]!, operatorAgentId: null }],
      STUB_WS,
    );
    assert.match(out, /\(unbound\)/);
  });

  it('column padding adapts to the longest planRunId', () => {
    const out = formatSummary(
      [
        { ...STUB_RUNS[0]!, planRunId: 'a' },
        { ...STUB_RUNS[1]!, planRunId: 'a-very-very-long-run-id' },
      ],
      STUB_WS,
    );
    const shortLine = out.split('\n').find((l) => l.includes(' a '))!;
    const longLine = out.split('\n').find((l) => l.includes('a-very-very-long-run-id'))!;
    // planId column should start at the same offset on both rows.
    const shortPlanIdCol = shortLine.indexOf('final-launch');
    const longPlanIdCol = longLine.indexOf('hotfix');
    assert.equal(shortPlanIdCol, longPlanIdCol);
  });

  it('header includes filter tag when stateFilter is provided', () => {
    const out = formatSummary(STUB_RUNS, STUB_WS, 'running');
    assert.match(out, /\(filter: running\)/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('run-list — failures', () => {
  it('rejects bad --state value before any network call', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunList({
      fetchImpl: fetch,
      env: STUB_ENV,
      stateFilter: 'banana' as never,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunList({
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_RUNS)]);
    const result = await runRunList({
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runRunList({
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
  });

  it('returns http failure on 500', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      listError(500, { error: 'Internal server error', code: 'INTERNAL' }),
    ]);
    const result = await runRunList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 500/);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('run-list — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
