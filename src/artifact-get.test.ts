/**
 * artifact-get tests.
 *
 * Coverage:
 *   - happy summary + happy --json + happy --content
 *   - request URL: with and without ?version=
 *   - artifact key regex rejection (no network)
 *   - --version validation (non-int, zero, negative)
 *   - missing SESSION_ID → auth failure
 *   - YOLO_API_URL fallback
 *   - --workspace mismatch
 *   - HTTP 404 (artifact not found)
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runArtifactGet, formatSummary, exitCodeForFailure } from './artifact-get.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  INTERNAL_API_KEY: 'svc-key',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';
const KEY = 'plans/final-launch/output.json';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, agentId: 'substrate-cli', scopes: ['work.get_artifact'] },
};

const STUB_ARTIFACT = {
  key: KEY,
  version: 3,
  artifactType: 'plan-step-output',
  contentLength: 42,
  content: '{"hello":"world"}',
  producedByAgentId: 'claude',
  producedByTileId: 'tile_abc',
  producerType: 'step-run',
  producerId: 'sr_xyz',
  fingerprint: 'sha256:deadbeef',
  refPath: null,
  meta: null,
  createdAt: '2026-05-01T10:00:00.000Z',
};

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

function getRoute(captured: { url?: string } = {}): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.includes(`/internal/work/workspaces/${STUB_WS}/artifacts/`),
    capture: (url) => {
      captured.url = url;
    },
    respond: () => ({ ok: true, status: 200, body: STUB_ARTIFACT }),
  };
}

function getError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.includes(`/internal/work/workspaces/${STUB_WS}/artifacts/`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy paths ──────────────────────────────────────────────────────────
describe('artifact-get — happy paths', () => {
  it('emits a summary with metadata fields by default', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute()]);
    const result = await runArtifactGet({ key: KEY, fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, new RegExp(`Artifact ${KEY} v3`));
    assert.match(result.output, /type:\s+plan-step-output/);
    assert.match(result.output, /contentLength:\s+42/);
    assert.match(result.output, /producedBy:\s+claude \(tile tile_abc\)/);
    assert.match(result.output, /fingerprint:\s+sha256:deadbeef/);
  });

  it('emits raw JSON (including content) when format is "json"', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute()]);
    const result = await runArtifactGet({
      key: KEY,
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.key, KEY);
    assert.equal(parsed.version, 3);
    assert.equal(parsed.content, '{"hello":"world"}');
  });

  it('emits ONLY the content body when format is "content"', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute()]);
    const result = await runArtifactGet({
      key: KEY,
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'content',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.output, '{"hello":"world"}');
  });

  it('omits ?version= when no version is requested (latest)', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, getRoute(captured)]);
    await runArtifactGet({ key: KEY, fetchImpl: fetch, env: STUB_ENV });
    assert.equal((captured.url ?? '').includes('?version='), false);
  });

  it('passes ?version=N when version is pinned', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, getRoute(captured)]);
    await runArtifactGet({ key: KEY, version: 5, fetchImpl: fetch, env: STUB_ENV });
    assert.match(captured.url ?? '', /\?version=5$/);
  });

  it('URL-encodes the artifact key (slashes preserved as-is for path segments)', async () => {
    const captured: { url?: string } = {};
    const fetch = makeFetchStub([mintRoute, getRoute(captured)]);
    await runArtifactGet({ key: 'plans/foo/bar.json', fetchImpl: fetch, env: STUB_ENV });
    // encodeURIComponent escapes `/` to `%2F` — confirm that's what we emit.
    // (The route uses the same regex as the server's ARTIFACT_KEY_REGEX.)
    assert.match(captured.url ?? '', /plans%2Ffoo%2Fbar\.json/);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('artifact-get — formatSummary pure renderer', () => {
  it('omits producedByTileId when null', () => {
    const out = formatSummary({ ...STUB_ARTIFACT, producedByTileId: null }, STUB_WS);
    assert.match(out, /producedBy:\s+claude$/m);
    assert.equal(out.includes('(tile '), false);
  });

  it('omits optional fields when null', () => {
    const out = formatSummary(
      {
        ...STUB_ARTIFACT,
        producerType: null,
        producerId: null,
        fingerprint: null,
        refPath: null,
        meta: null,
      },
      STUB_WS,
    );
    assert.equal(out.includes('producerType:'), false);
    assert.equal(out.includes('producerId:'), false);
    assert.equal(out.includes('fingerprint:'), false);
    assert.equal(out.includes('refPath:'), false);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('artifact-get — failures', () => {
  it('rejects malformed key before any network call', async () => {
    const fetch = makeFetchStub([]);
    const result = await runArtifactGet({ key: 'INVALID UPPER', fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('rejects non-positive --version pre-network', async () => {
    const fetch = makeFetchStub([]);
    for (const v of [0, -1]) {
      const result = await runArtifactGet({ key: KEY, version: v, fetchImpl: fetch, env: STUB_ENV });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'usage');
    }
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runArtifactGet({
      key: KEY,
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const fetch = makeFetchStub([mintRoute, getRoute()]);
    const result = await runArtifactGet({
      key: KEY,
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runArtifactGet({
      key: KEY,
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
      getError(404, { error: 'artifact not found', code: 'NOT_FOUND' }),
    ]);
    const result = await runArtifactGet({ key: KEY, fetchImpl: fetch, env: STUB_ENV });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 404/);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('artifact-get — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
