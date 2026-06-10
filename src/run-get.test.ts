/**
 * run-get tests.
 *
 * Coverage:
 *   - happy summary + happy --json
 *   - operator-tag rendering: bound responsive / bound unresponsive /
 *     bound (responsive flag absent) / unbound
 *   - empty steps array → no per-step rows but header lines preserved
 *   - column padding adapts to longest stepId / state / stepRunId
 *   - planRunId regex rejection (no network)
 *   - missing SESSION_ID → auth failure
 *   - YOLO_API_URL fallback
 *   - --workspace mismatch
 *   - HTTP 404 (run not found)
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRunGet, formatSummary, exitCodeForFailure } from './run-get.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  HOME: '/nonexistent-yolo-cli-test-home',
  YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';
const RUN_ID = 'pr_abc123';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, userId: '507f1f77bcf86cd799439001', agentId: 'substrate-cli', scopes: ['work.get_run'] },
};

const STUB_RUN = {
  planRunId: RUN_ID,
  planId: 'final-launch',
  planVersion: 3,
  runNumber: 7,
  executionState: 'running',
  inputs: { env: 'prod' },
  operatorAgentId: 'substrate-cli',
  operatorResponsive: true,
  runDesktopId: 'desk_xyz',
  overviewTileId: 'tile_overview',
  steps: [
    { stepId: '01-foundations', latestStepRunId: 'sr_001', state: 'completed', tileId: 'tile_001' },
    { stepId: '02-credential-viability', latestStepRunId: 'sr_002', state: 'running', tileId: 'tile_002' },
    { stepId: '03-agent-resolver', latestStepRunId: null, state: 'pending', tileId: null },
  ],
  startedAt: '2026-05-01T10:00:00.000Z',
  endedAt: null,
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

function getRoute(run: Record<string, unknown>): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs/${RUN_ID}`),
    respond: () => ({ ok: true, status: 200, body: { run } }),
  };
}

function getError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs/${RUN_ID}`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────
describe('run-get — happy path', () => {
  it('emits a summary by default (header + per-step table)', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute(STUB_RUN)]);
    const result = await runRunGet({ planRunId: RUN_ID, fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Plan Run pr_abc123/);
    assert.match(result.output, new RegExp(STUB_WS));
    assert.match(result.output, /run #7/);
    assert.match(result.output, /plan final-launch v3/);
    assert.match(result.output, /executionState=running/);
    assert.match(result.output, /operator: substrate-cli \(responsive\)/);
    assert.match(result.output, /startedAt: 2026-05-01T10:00:00.000Z/);
    assert.match(result.output, /steps: 3/);
    assert.match(result.output, /- 01-foundations\s+completed\s+sr_001\s+tile_001/);
    assert.match(result.output, /- 03-agent-resolver\s+pending\s+—\s+—/);
  });

  it('emits raw JSON when format is "json"', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute(STUB_RUN)]);
    const result = await runRunGet({
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.planRunId, RUN_ID);
    assert.equal(parsed.runNumber, 7);
    assert.equal(parsed.steps.length, 3);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('run-get — formatSummary pure renderer', () => {
  it('renders operator (unresponsive) when operatorResponsive is false', () => {
    const out = formatSummary({ ...STUB_RUN, operatorResponsive: false }, STUB_WS);
    assert.match(out, /operator: substrate-cli \(unresponsive\)/);
  });

  it('renders bare operator name when operatorResponsive is undefined', () => {
    const { operatorResponsive: _drop, ...rest } = STUB_RUN;
    const out = formatSummary(rest, STUB_WS);
    assert.match(out, /operator: substrate-cli$/m);
  });

  it('renders operator: (unbound) when operatorAgentId is null', () => {
    const out = formatSummary({ ...STUB_RUN, operatorAgentId: null }, STUB_WS);
    assert.match(out, /operator: \(unbound\)/);
  });

  it('omits the per-step rows when steps[] is empty (header preserved)', () => {
    const out = formatSummary({ ...STUB_RUN, steps: [] }, STUB_WS);
    assert.match(out, /steps: 0$/m);
    assert.equal(out.includes('    - '), false);
  });

  it('column padding adapts to the longest stepId in the steps array', () => {
    const out = formatSummary(
      {
        ...STUB_RUN,
        steps: [
          { stepId: 'a', latestStepRunId: 'sr_a', state: 'completed', tileId: 't_a' },
          { stepId: 'a-very-long-step-id', latestStepRunId: 'sr_b', state: 'pending', tileId: 't_b' },
        ],
      },
      STUB_WS,
    );
    // The short stepId line should pad to match the longer one.
    const shortLine = out.match(/- a\s+completed/)![0];
    const longLine = out.match(/- a-very-long-step-id\s+pending/)![0];
    // Both lines should have completed/pending start at the same column.
    const shortCol = shortLine.indexOf('completed');
    const longCol = longLine.indexOf('pending');
    assert.equal(shortCol, longCol);
  });

  it('omits endedAt when it is null', () => {
    const out = formatSummary(STUB_RUN, STUB_WS);
    assert.equal(out.includes('endedAt:'), false);
  });

  it('renders endedAt when set', () => {
    const out = formatSummary(
      { ...STUB_RUN, executionState: 'cancelled', endedAt: '2026-05-01T12:00:00.000Z' },
      STUB_WS,
    );
    assert.match(out, /endedAt:\s+2026-05-01T12:00:00.000Z/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('run-get — failures', () => {
  it('rejects malformed planRunId before any network call', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunGet({ planRunId: 'has spaces', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunGet({
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute(STUB_RUN)]);
    const result = await runRunGet({
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: { SESSION_ID: 's', HOME: '/nonexistent-yolo-cli-test-home', YOLO_API_TOKEN: 'user-jwt', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runRunGet({
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
  });

  it('returns http failure on 404', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      getError(404, { error: 'plan run not found', code: 'NOT_FOUND' }),
    ]);
    const result = await runRunGet({ planRunId: RUN_ID, fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 404/);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('run-get — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
