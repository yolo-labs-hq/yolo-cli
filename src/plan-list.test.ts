/**
 * plan-list tests.
 *
 * Stubs:
 *   - fetchImpl: routes /internal/mcp/tokens + /internal/work/...
 *   - env: synthetic trio
 *
 * Coverage:
 *   - happy path summary (mint → GET → render table)
 *   - --json mode
 *   - --state filter passes through to query string
 *   - empty list renders cleanly
 *   - column padding adapts to longest planId / name
 *   - planIds with all 3 states render in the same row layout
 *   - --workspace mismatch
 *   - missing env trio
 *   - YOLO_API_URL fallback
 *   - bad --state value (no network call)
 *   - HTTP 4xx
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runPlanList, formatSummary, exitCodeForFailure } from './plan-list.js';
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
  claims: { workspaceId: STUB_WS, agentId: 'substrate-cli', scopes: ['work.list_plans'] },
};

interface CapturedCall {
  url: string;
  method: string;
}

interface RouteHandler {
  matches: (url: string, method: string) => boolean;
  respond: () => { ok: boolean; status: number; body: unknown };
}

function makeFetchStub(routes: RouteHandler[]): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method });
    for (const route of routes) {
      if (route.matches(url, method)) {
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
  return { fetch, calls };
}

const mintRoute: RouteHandler = {
  matches: (url, method) => method === 'POST' && url.endsWith('/internal/mcp/tokens'),
  respond: () => ({ ok: true, status: 201, body: STUB_TOKEN_RESPONSE }),
};

function listRoute(plans: unknown[]): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' &&
      url.includes(`/internal/work/workspaces/${STUB_WS}/plans`),
    respond: () => ({ ok: true, status: 200, body: { plans } }),
  };
}

function listError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' &&
      url.includes(`/internal/work/workspaces/${STUB_WS}/plans`),
    respond: () => ({ ok: false, status, body }),
  };
}

const SAMPLE_PLAN = {
  planId: 'foo',
  name: 'Foo plan',
  authoringState: 'draft' as const,
  version: 1,
  latestRunId: null,
  updatedAt: '2026-04-30T12:00:00.000Z',
};

// ─── Happy paths ─────────────────────────────────────────────────────────
describe('plan-list — happy path', () => {
  it('renders a summary table with header + per-plan rows', async () => {
    const { fetch, calls } = makeFetchStub([
      mintRoute,
      listRoute([
        SAMPLE_PLAN,
        { ...SAMPLE_PLAN, planId: 'bar', authoringState: 'active', version: 3, latestRunId: 'run-xyz' },
      ]),
    ]);
    const result = await runPlanList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, new RegExp(`Plans in workspace ${STUB_WS}: 2`));
    assert.match(result.output, /planId\s+name\s+state\s+version\s+latestRun\s+updatedAt/);
    assert.match(result.output, /foo\s+Foo plan\s+draft\s+v1\s+—/);
    assert.match(result.output, /bar\s+Foo plan\s+active\s+v3\s+run-xyz/);

    // Mint + GET, no query string when no filter
    assert.equal(calls.length, 2);
    assert.equal(calls[1]!.url.endsWith(`/workspaces/${STUB_WS}/plans`), true);
  });

  it('returns raw JSON when --json is set', async () => {
    const { fetch } = makeFetchStub([mintRoute, listRoute([SAMPLE_PLAN])]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.ok(Array.isArray(parsed));
    assert.equal(parsed[0].planId, 'foo');
  });

  it('passes --state filter as authoringState query param', async () => {
    const { fetch, calls } = makeFetchStub([
      mintRoute,
      listRoute([{ ...SAMPLE_PLAN, authoringState: 'active' }]),
    ]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: STUB_ENV,
      stateFilter: 'active',
    });
    assert.equal(result.ok, true);
    assert.match(calls[1]!.url, /\?authoringState=active$/);
    if (!result.ok) return;
    assert.match(result.output, /\(filter: active\)/);
  });
});

// ─── Empty workspace ─────────────────────────────────────────────────────
describe('plan-list — empty workspace', () => {
  it('renders "(no plans)" when the list is empty', async () => {
    const { fetch } = makeFetchStub([mintRoute, listRoute([])]);
    const result = await runPlanList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Plans in workspace .*: 0/);
    assert.match(result.output, /\(no plans\)/);
  });

  it('still emits the JSON empty-array when --json + zero plans', async () => {
    const { fetch } = makeFetchStub([mintRoute, listRoute([])]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.deepEqual(parsed, []);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('plan-list — formatSummary', () => {
  it('pads planId column to the longest entry width', () => {
    const out = formatSummary(
      [
        { ...SAMPLE_PLAN, planId: 'short' },
        { ...SAMPLE_PLAN, planId: 'a-much-longer-planId' },
      ],
      STUB_WS,
    );
    // Each row should align — the long planId sets the column width.
    const lines = out.split('\n');
    const headerLine = lines.find((l) => l.includes('planId'))!;
    const planIdColEnd = headerLine.indexOf('name');
    assert.ok(planIdColEnd >= 'a-much-longer-planId'.length, 'planId column too narrow for longest entry');
  });

  it('shows "—" for null latestRunId', () => {
    const out = formatSummary([SAMPLE_PLAN], STUB_WS);
    assert.match(out, /—/);
  });

  it('shows the runId when present', () => {
    const out = formatSummary([{ ...SAMPLE_PLAN, latestRunId: 'run-abc' }], STUB_WS);
    assert.match(out, /run-abc/);
  });

  it('renders all 3 authoring states cleanly', () => {
    const out = formatSummary(
      [
        { ...SAMPLE_PLAN, planId: 'd', authoringState: 'draft' },
        { ...SAMPLE_PLAN, planId: 'a', authoringState: 'active' },
        { ...SAMPLE_PLAN, planId: 'r', authoringState: 'archived' },
      ],
      STUB_WS,
    );
    assert.match(out, /draft/);
    assert.match(out, /active/);
    assert.match(out, /archived/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('plan-list — failures', () => {
  it('rejects an invalid --state value before any network call', async () => {
    const { fetch, calls } = makeFetchStub([]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: STUB_ENV,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      stateFilter: 'pending' as any,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.match(result.message, /pending/);
    assert.equal(calls.length, 0);
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const { fetch } = makeFetchStub([]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const { fetch } = makeFetchStub([mintRoute, listRoute([SAMPLE_PLAN])]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const { fetch } = makeFetchStub([mintRoute]);
    const result = await runPlanList({
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
  });

  it('returns http failure on non-200', async () => {
    const { fetch } = makeFetchStub([
      mintRoute,
      listError(500, { error: 'internal', code: 'INTERNAL' }),
    ]);
    const result = await runPlanList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 500/);
    assert.equal(exitCodeForFailure(result.kind), 1);
  });
});

// ─── exitCodeForFailure ──────────────────────────────────────────────────
describe('plan-list — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
