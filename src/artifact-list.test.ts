/**
 * artifact-list tests.
 *
 * Coverage:
 *   - happy summary + happy --json
 *   - empty list renders "(no artifacts)"
 *   - --prefix passes through as ?prefix=
 *   - --limit passes through as ?limit=
 *   - both --prefix and --limit combined
 *   - bad --limit rejected pre-network (out-of-range, non-int)
 *   - missing SESSION_ID → auth
 *   - YOLO_API_URL fallback
 *   - --workspace mismatch
 *   - HTTP 5xx
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runArtifactList, formatSummary, exitCodeForFailure } from './artifact-list.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  HOME: '/nonexistent-yolo-cli-test-home',
  YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, userId: '507f1f77bcf86cd799439001', agentId: 'substrate-cli', scopes: ['work.list_artifacts'] },
};

const STUB_ARTIFACTS = [
  {
    key: 'plans/final-launch/output.json',
    latestVersion: 3,
    artifactType: 'plan-step-output',
    latestTimestamp: '2026-05-01T10:00:00.000Z',
  },
  {
    key: 'plans/hotfix/build.log',
    latestVersion: 1,
    artifactType: 'log',
    latestTimestamp: '2026-04-30T08:00:00.000Z',
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

function listRoute(artifacts: unknown[], captured: { url?: string } = {}): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.includes(`/internal/work/workspaces/${STUB_WS}/artifacts`),
    capture: (url) => {
      captured.url = url;
    },
    respond: () => ({ ok: true, status: 200, body: { artifacts } }),
  };
}

function listError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.includes(`/internal/work/workspaces/${STUB_WS}/artifacts`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────────
describe('artifact-list — happy paths', () => {
  it('emits a header + per-artifact rows by default', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS)]);
    const result = await runArtifactList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Artifacts in workspace .* 2/);
    assert.match(result.output, /plans\/final-launch\/output\.json\s+v3\s+plan-step-output/);
    assert.match(result.output, /plans\/hotfix\/build\.log\s+v1\s+log/);
  });

  it('emits raw JSON when format is "json"', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS)]);
    const result = await runArtifactList({
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.length, 2);
    assert.equal(parsed[0].key, 'plans/final-launch/output.json');
  });

  it('renders "(no artifacts)" when the list is empty', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute([])]);
    const result = await runArtifactList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Artifacts in workspace .* 0/);
    assert.match(result.output, /\(no artifacts\)/);
  });

  it('passes --prefix through as ?prefix=', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS, captured)]);
    await runArtifactList({ fetchImpl: fetch, env: STUB_ENV, prefix: 'plans/' });
    assert.match(captured.url ?? '', /\?prefix=plans%2F$/);
  });

  it('passes --limit through as ?limit=', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS, captured)]);
    await runArtifactList({ fetchImpl: fetch, env: STUB_ENV, limit: 50 });
    assert.match(captured.url ?? '', /\?limit=50$/);
  });

  it('combines --prefix + --limit in a single query string', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS, captured)]);
    await runArtifactList({
      fetchImpl: fetch,
      env: STUB_ENV,
      prefix: 'plans/',
      limit: 10,
    });
    assert.match(captured.url ?? '', /\?prefix=plans%2F&limit=10$/);
  });

  it('omits the query string when no filters are set', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS, captured)]);
    await runArtifactList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal((captured.url ?? '').includes('?'), false);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('artifact-list — formatSummary pure renderer', () => {
  it('column padding adapts to the longest key', () => {
    const out = formatSummary(
      [
        { ...STUB_ARTIFACTS[0]!, key: 'a' },
        { ...STUB_ARTIFACTS[1]!, key: 'a-very-long-artifact-key' },
      ],
      STUB_WS,
    );
    const shortLine = out.split('\n').find((l) => l.includes(' a ')) ?? '';
    const longLine = out.split('\n').find((l) => l.includes('a-very-long-artifact-key')) ?? '';
    const shortVCol = shortLine.indexOf('v3');
    const longVCol = longLine.indexOf('v1');
    assert.equal(shortVCol, longVCol);
  });

  it('header includes prefix tag when set', () => {
    const out = formatSummary(STUB_ARTIFACTS, STUB_WS, 'plans/');
    assert.match(out, /\(prefix: plans\/\)/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('artifact-list — failures', () => {
  it('rejects --limit < 1 pre-network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runArtifactList({ fetchImpl: fetch, env: STUB_ENV, limit: 0 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('rejects --limit > 500 pre-network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runArtifactList({ fetchImpl: fetch, env: STUB_ENV, limit: 501 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('rejects non-integer --limit pre-network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runArtifactList({ fetchImpl: fetch, env: STUB_ENV, limit: 1.5 });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runArtifactList({
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const fetch = makeFetchStub([mintRoute, listRoute(STUB_ARTIFACTS)]);
    const result = await runArtifactList({
      fetchImpl: fetch,
      env: { SESSION_ID: 's', HOME: '/nonexistent-yolo-cli-test-home', YOLO_API_TOKEN: 'user-jwt', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runArtifactList({
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
    const result = await runArtifactList({ fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 500/);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('artifact-list — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
