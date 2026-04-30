/**
 * plan-get tests.
 *
 * Stubs:
 *   - fetchImpl: routes /internal/mcp/tokens + /internal/work/...
 *   - env: synthetic trio
 *
 * Coverage:
 *   - happy path summary output (mint → GET → render)
 *   - --json mode
 *   - dependency-gate stepIds rendered in summary
 *   - workspace mismatch
 *   - missing env trio
 *   - planId regex rejection (no network call)
 *   - HTTP 404 from work.get_plan
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runPlanGet, formatSummary, exitCodeForFailure } from './plan-get.js';
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
  claims: { workspaceId: STUB_WS, agentId: 'substrate-cli', scopes: ['work.get_plan'] },
};

interface RouteHandler {
  matches: (url: string, method: string) => boolean;
  respond: () => { ok: boolean; status: number; body: unknown };
}

function makeFetchStub(routes: RouteHandler[]): FetchLike {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
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
}

const mintRoute: RouteHandler = {
  matches: (url, method) => method === 'POST' && url.endsWith('/internal/mcp/tokens'),
  respond: () => ({ ok: true, status: 201, body: STUB_TOKEN_RESPONSE }),
};

function getRoute(planId: string, dbPlan: Record<string, unknown>): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: true, status: 200, body: { plan: dbPlan } }),
  };
}

function getError(planId: string, status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: false, status, body }),
  };
}

const STUB_PLAN = {
  planId: 'foo',
  name: 'Foo plan',
  description: '# body\n',
  authoringState: 'active' as const,
  version: 3,
  inputs: [{ name: 'env', required: true }],
  failurePolicy: 'pause-and-wait',
  autoRetryCap: 0,
  steps: [
    { stepId: 'build', mode: 'workstream', gates: [] },
    {
      stepId: 'test',
      mode: 'test',
      gates: [
        { gateId: 'gate-test-deps-build', type: 'dependency', config: { stepId: 'build' } },
      ],
    },
  ],
};

// ─── Happy path ──────────────────────────────────────────────────────────
describe('plan-get — happy path', () => {
  it('prints a summary by default (header + per-step rows)', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute('foo', STUB_PLAN)]);
    const result = await runPlanGet({ planId: 'foo', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Plan 'foo'/);
    assert.match(result.output, new RegExp(STUB_WS));
    assert.match(result.output, /version 3/);
    assert.match(result.output, /authoringState: active|, active\)/);
    assert.match(result.output, /failurePolicy: pause-and-wait/);
    assert.match(result.output, /steps: 2/);
    assert.match(result.output, /- build \(workstream\)/);
    assert.match(result.output, /- test \(test\)\s+← deps: build/);
  });

  it('prints raw JSON when --json is set', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute('foo', STUB_PLAN)]);
    const result = await runPlanGet({
      planId: 'foo',
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.planId, 'foo');
    assert.equal(parsed.version, 3);
    assert.equal(parsed.steps.length, 2);
  });
});

// ─── formatSummary pure function ─────────────────────────────────────────
describe('plan-get — formatSummary pure renderer', () => {
  it('renders multi-predecessor dependency gates as comma-separated stepIds', () => {
    const plan = {
      ...STUB_PLAN,
      steps: [
        { stepId: '01', mode: 'workstream' as const, gates: [] },
        { stepId: '02', mode: 'workstream' as const, gates: [] },
        {
          stepId: '03',
          mode: 'workstream' as const,
          gates: [
            { gateId: 'g-03-01', type: 'dependency', config: { stepId: '01' } },
            { gateId: 'g-03-02', type: 'dependency', config: { stepId: '02' } },
          ],
        },
      ],
    };
    const out = formatSummary(plan, STUB_WS);
    assert.match(out, /- 03 \(workstream\)\s+← deps: 01, 02/);
  });

  it('omits the deps tag when there are no dependency gates', () => {
    const plan = {
      ...STUB_PLAN,
      steps: [{ stepId: 'lonely', mode: 'workstream' as const, gates: [] }],
    };
    const out = formatSummary(plan, STUB_WS);
    assert.match(out, /- lonely \(workstream\)$/m);
    assert.equal(out.includes('← deps:'), false);
  });

  it('skips non-dependency gates from the deps line', () => {
    const plan = {
      ...STUB_PLAN,
      steps: [
        {
          stepId: 'gated',
          mode: 'test' as const,
          gates: [
            { gateId: 'dep', type: 'dependency', config: { stepId: 'build' } },
            { gateId: 'tr', type: 'test-result', config: { minPassRate: '0.95' } },
          ],
        },
      ],
    };
    const out = formatSummary(plan, STUB_WS);
    assert.match(out, /- gated \(test\)\s+← deps: build$/m);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('plan-get — failures', () => {
  it('rejects malformed planId before any network call', async () => {
    const fetch = makeFetchStub([]);
    const result = await runPlanGet({
      planId: 'has spaces',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.match(result.message, /planId/);
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runPlanGet({
      planId: 'foo',
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
    assert.match(result.message, /SESSION_ID/);
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute('foo', STUB_PLAN)]);
    const result = await runPlanGet({
      planId: 'foo',
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runPlanGet({
      planId: 'foo',
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns http failure on 404', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      getError('foo', 404, { error: 'plan not found', code: 'NOT_FOUND' }),
    ]);
    const result = await runPlanGet({ planId: 'foo', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 404/);
    assert.equal(exitCodeForFailure(result.kind), 1);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('plan-get — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
