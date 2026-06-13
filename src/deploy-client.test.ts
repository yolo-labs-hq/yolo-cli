/**
 * deploy-client tests — every leg vs a stubbed DeployFetchLike (the
 * work-client.test.ts convention): URL/method/header/body shapes, 4xx
 * refusal-reason passthrough, the finalize 409/410 special cases, and
 * per-leg token re-resolution from the rotation file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  resolveDeployContext,
  startShip,
  uploadAssetBucket,
  finalizeShip,
  createProject,
  getProjectStatus,
  rollbackProject,
  getLogs,
  tailLogs,
  queryD1,
  type DeployContext,
  type DeployFetchLike,
  type RetryConfig,
} from './deploy-client.js';

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
  body?: string | FormData;
}

interface StubResponse {
  ok?: boolean;
  status?: number;
  jsonBody?: unknown;
  textBody?: string;
  streamLines?: string[];
}

function makeFetchStub(responses: StubResponse | StubResponse[]): { fetch: DeployFetchLike; calls: CapturedCall[] } {
  const queue = Array.isArray(responses) ? [...responses] : [responses];
  const calls: CapturedCall[] = [];
  const fetch: DeployFetchLike = async (url, init = {}) => {
    calls.push({ url, method: init.method ?? 'GET', headers: init.headers ?? {}, body: init.body });
    const response = queue.length > 1 ? queue.shift()! : queue[0]!;
    const stream = response.streamLines
      ? (async function* () {
          for (const chunk of response.streamLines!) yield new TextEncoder().encode(chunk);
        })()
      : undefined;
    return {
      ok: response.ok ?? true,
      status: response.status ?? 200,
      json: async () => {
        if (response.jsonBody === undefined) throw new Error('no json body');
        return response.jsonBody;
      },
      text: async () => response.textBody ?? JSON.stringify(response.jsonBody ?? {}),
      body: stream ?? null,
    };
  };
  return { fetch, calls };
}

function makeContext(fetch: DeployFetchLike, overrides: Partial<DeployContext> = {}): DeployContext {
  return {
    commonApiUrl: 'https://api.example.com',
    env: { HOME: '/home/test', YOLO_API_TOKEN: 'tok-env' },
    readFileImpl: () => undefined,
    fetchImpl: fetch,
    ...overrides,
  };
}

const START_OK = {
  jsonBody: {
    shipId: 'shp_77',
    missing: [['h2', 'h3']],
    caps: { maxFileBytes: 26214400, maxTotalBytes: 268435456, maxFiles: 20000 },
  },
};

// ─── resolveDeployContext ─────────────────────────────────────────────────

describe('deploy-client — resolveDeployContext', () => {
  it('fails with kind auth when no common-api URL is configured', () => {
    const result = resolveDeployContext({}, () => undefined);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'auth');
      assert.match(result.message, /YOLO_COMMON_API_URL/);
    }
  });

  it('fails with kind auth when no token resolves from file or env', () => {
    const result = resolveDeployContext({ YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/h' }, () => undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.match(result.message, /no user token available/);
  });

  it('resolves with the rotation file preferred over the env token', () => {
    const result = resolveDeployContext(
      { YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/h', YOLO_API_TOKEN: 'env-tok' },
      () => 'file-tok',
    );
    assert.equal(result.ok, true);
  });
});

// ─── startShip ────────────────────────────────────────────────────────────

describe('deploy-client — startShip', () => {
  it('POSTs the manifest body to /v1/deploy/projects/:id/ship/start with Bearer auth', async () => {
    const { fetch, calls } = makeFetchStub(START_OK);
    const ctx = makeContext(fetch);
    const result = await startShip(ctx, 'hp_8f3a', {
      env: 'preview',
      type: 'static',
      manifest: { '/index.html': { hash: 'h1', size: 120 } },
      compatibilityFlags: ['nodejs_compat'],
      gitSha: 'a'.repeat(40),
      bundleDigest: 'sha256:91c2deadbeef',
    });
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.shipId, 'shp_77');
      assert.deepEqual(result.value.missing, [['h2', 'h3']]);
      assert.equal(result.value.caps.maxFiles, 20000);
    }
    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_8f3a/ship/start');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer tok-env');
    assert.equal(calls[0]!.headers['X-Internal-Auth'], undefined);
    assert.equal(calls[0]!.headers['Content-Type'], 'application/json');
    const body = JSON.parse(calls[0]!.body as string) as Record<string, unknown>;
    assert.equal(body.env, 'preview');
    assert.equal(body.type, 'static');
    assert.deepEqual(body.manifest, { '/index.html': { hash: 'h1', size: 120 } });
    assert.deepEqual(body.compatibilityFlags, ['nodejs_compat']);
    assert.equal(body.bundleDigest, 'sha256:91c2deadbeef');
    assert.equal(body.gitSha, 'a'.repeat(40));
  });

  it('passes a 4xx refusal reason through verbatim with detail + hint', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 429,
      jsonBody: {
        ok: false,
        reason: 'quota-exceeded',
        message: 'release cap reached for today',
        detail: { releasesPerDay: 20 },
        hint: 'wait until tomorrow or upgrade',
      },
    });
    const result = await startShip(makeContext(fetch), 'hp_1', {
      env: 'preview',
      type: 'static',
      manifest: {},
      bundleDigest: 'd',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'quota-exceeded');
      assert.equal(result.message, 'release cap reached for today');
      assert.equal(result.status, 429);
      assert.deepEqual(result.detail, { releasesPerDay: 20 });
      assert.equal(result.hint, 'wait until tomorrow or upgrade');
    }
  });

  it('maps the legacy {error, code} envelope onto kind/message', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      jsonBody: { error: 'project not found', code: 'project-not-found' },
    });
    const result = await startShip(makeContext(fetch), 'hp_gone', {
      env: 'preview',
      type: 'static',
      manifest: {},
      bundleDigest: 'd',
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'project-not-found');
      assert.equal(result.message, 'project not found');
    }
  });

  it('maps 401 to kind auth and 5xx to kind network', async () => {
    const unauth = makeFetchStub({ ok: false, status: 401, jsonBody: { error: 'token expired' } });
    const result401 = await startShip(makeContext(unauth.fetch), 'p', { env: 'preview', type: 'static', manifest: {}, bundleDigest: 'd' });
    assert.equal(result401.ok, false);
    if (!result401.ok) assert.equal(result401.kind, 'auth');

    const upstream = makeFetchStub({ ok: false, status: 502, jsonBody: { error: 'upstream cf failure' } });
    const result502 = await startShip(makeContext(upstream.fetch), 'p', { env: 'preview', type: 'static', manifest: {}, bundleDigest: 'd' });
    assert.equal(result502.ok, false);
    if (!result502.ok) assert.equal(result502.kind, 'network');
  });

  it('maps a thrown fetch onto kind network', async () => {
    const fetch: DeployFetchLike = async () => {
      throw new Error('ECONNREFUSED');
    };
    const result = await startShip(makeContext(fetch), 'p', { env: 'preview', type: 'static', manifest: {}, bundleDigest: 'd' });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'network');
      assert.match(result.message, /ECONNREFUSED/);
    }
  });

  it('fails with auth when no token is resolvable at leg time', async () => {
    const { fetch, calls } = makeFetchStub(START_OK);
    const ctx = makeContext(fetch, { env: { HOME: '/h' } });
    const result = await startShip(ctx, 'p', { env: 'preview', type: 'static', manifest: {}, bundleDigest: 'd' });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'auth');
    assert.equal(calls.length, 0);
  });
});

// ─── token re-resolution per leg ──────────────────────────────────────────

describe('deploy-client — per-leg token re-resolution (rotation file)', () => {
  it('re-reads the token file before EVERY leg, never caching across legs', async () => {
    const { fetch, calls } = makeFetchStub([START_OK, { jsonBody: {} }, { jsonBody: { releaseId: 'rel_1' } }]);
    const tokens = ['tok-1', 'tok-2', 'tok-3'];
    let reads = 0;
    const ctx = makeContext(fetch, {
      env: { HOME: '/home/test' },
      readFileImpl: () => tokens[reads++],
    });

    await startShip(ctx, 'p', { env: 'preview', type: 'static', manifest: {}, bundleDigest: 'd' });
    await uploadAssetBucket(ctx, 'p', 'shp_1', []);
    await finalizeShip(ctx, 'p', 'shp_1', []);

    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer tok-1');
    assert.equal(calls[1]!.headers['Authorization'], 'Bearer tok-2');
    assert.equal(calls[2]!.headers['Authorization'], 'Bearer tok-3');
  });
});

// ─── uploadAssetBucket ────────────────────────────────────────────────────

describe('deploy-client — uploadAssetBucket', () => {
  it('POSTs {files} JSON to /ship/:shipId/assets', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { ok: true } });
    const result = await uploadAssetBucket(makeContext(fetch), 'hp_1', 'shp_77', [
      { hash: 'h2', base64: 'aGVsbG8=', contentType: 'text/html' },
    ]);
    assert.equal(result.ok, true);
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_1/ship/shp_77/assets');
    assert.equal(calls[0]!.method, 'POST');
    const body = JSON.parse(calls[0]!.body as string) as { files: unknown[] };
    assert.deepEqual(body.files, [{ hash: 'h2', base64: 'aGVsbG8=', contentType: 'text/html' }]);
  });
});

// ─── finalizeShip ─────────────────────────────────────────────────────────

describe('deploy-client — finalizeShip', () => {
  it('sends worker modules as multipart FormData (no manual Content-Type)', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { releaseId: 'rel_0192', url: 'https://my-app.yolo.host', status: 'live' } });
    const contents = new TextEncoder().encode('export default {};');
    const result = await finalizeShip(makeContext(fetch), 'hp_1', 'shp_77', [{ name: 'worker.js', contents }]);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.value.releaseId, 'rel_0192');
      assert.equal(result.value.url, 'https://my-app.yolo.host');
    }
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_1/ship/shp_77/finalize');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers['Content-Type'], undefined, 'fetch must set the multipart boundary itself');
    assert.ok(calls[0]!.body instanceof FormData, 'body must be FormData');
    const form = calls[0]!.body as FormData;
    const entry = form.get('worker.js');
    assert.ok(entry && typeof entry === 'object', 'module entry present');
    const uploaded = Buffer.from(await (entry as Blob).arrayBuffer()).toString();
    assert.equal(uploaded, 'export default {};');
  });

  it('sends empty JSON for a pure-static finalize (server attaches the shim)', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { releaseId: 'rel_1', url: 'https://s.yolo.host', status: 'live' } });
    const result = await finalizeShip(makeContext(fetch), 'hp_1', 'shp_77', []);
    assert.equal(result.ok, true);
    assert.equal(calls[0]!.headers['Content-Type'], 'application/json');
    assert.equal(calls[0]!.body, '{}');
  });

  it('returns the distinct awaiting-approval outcome on the T3 409', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 409,
      jsonBody: {
        ok: false,
        code: 'awaiting-approval',
        approvalId: 'apr_55',
        approvalUrl: 'https://studio.yolo.dev/approvals/apr_55',
        releaseId: 'rel_0193',
        message: 'prod ship needs operator confirmation',
      },
    });
    const result = await finalizeShip(makeContext(fetch), 'hp_1', 'shp_77', []);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'awaiting-approval');
      if (result.kind === 'awaiting-approval' && 'approvalId' in result) {
        assert.equal(result.approvalId, 'apr_55');
        assert.equal(result.approvalUrl, 'https://studio.yolo.dev/approvals/apr_55');
        assert.equal(result.releaseId, 'rel_0193');
      }
    }
  });

  it("normalizes the backend's approval-required spelling (reason + detail) too", async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 409,
      jsonBody: {
        ok: false,
        reason: 'approval-required',
        message: 'needs approval',
        detail: { approvalId: 'apr_9', statement: 'Ship release r7', expiresAt: '2026-06-13T00:00:00Z' },
      },
    });
    const result = await finalizeShip(makeContext(fetch), 'hp_1', 'shp_77', []);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'awaiting-approval');
      if ('approvalId' in result) {
        assert.equal(result.approvalId, 'apr_9');
        assert.equal(result.statement, 'Ship release r7');
      }
    }
  });

  it('passes 410 upload-expired through (ship session lapsed → rerun)', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 410,
      jsonBody: { ok: false, code: 'upload-expired', message: 'ship session lapsed' },
    });
    const result = await finalizeShip(makeContext(fetch), 'hp_1', 'shp_77', []);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'upload-expired');
      assert.equal(result.status, 410);
    }
  });
});

// ─── thin wrappers ────────────────────────────────────────────────────────

describe('deploy-client — thin wrappers', () => {
  it('createProject POSTs to /v1/deploy/projects', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { project: { id: 'hp_9', slug: 'site' } } });
    const result = await createProject(makeContext(fetch), { name: 'site', slug: 'site' });
    assert.equal(result.ok, true);
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects');
    assert.equal(calls[0]!.method, 'POST');
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { name: 'site', slug: 'site' });
  });

  it('getProjectStatus GETs /v1/deploy/projects/:id', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { project: { slug: 's' } } });
    await getProjectStatus(makeContext(fetch), 'hp_9');
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_9');
    assert.equal(calls[0]!.method, 'GET');
  });

  it('rollbackProject POSTs the releaseId to /rollback', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { releaseId: 'rel_3' } });
    await rollbackProject(makeContext(fetch), 'hp_9', { releaseId: 'rel_3' });
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_9/rollback');
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { releaseId: 'rel_3' });
  });

  it('getLogs GETs /logs with sinceMinutes/limit query params', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { logs: [] } });
    await getLogs(makeContext(fetch), 'hp_9', { sinceMinutes: 120, limit: 50 });
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_9/logs?sinceMinutes=120&limit=50');
  });

  it('tailLogs streams NDJSON lines from the response body', async () => {
    const { fetch, calls } = makeFetchStub({
      streamLines: ['{"level":"info","message":"a"}\n{"level":"err', 'or","message":"b"}\n', '{"message":"tail-no-newline"}'],
    });
    const lines: string[] = [];
    const result = await tailLogs(makeContext(fetch), 'hp_9', { sinceMinutes: 30 }, (line) => lines.push(line));
    assert.equal(result.ok, true);
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_9/logs?tail=true&sinceMinutes=30');
    assert.deepEqual(lines, [
      '{"level":"info","message":"a"}',
      '{"level":"error","message":"b"}',
      '{"message":"tail-no-newline"}',
    ]);
  });

  it('tailLogs maps a 4xx onto the structured failure (no stream)', async () => {
    const { fetch } = makeFetchStub({ ok: false, status: 403, jsonBody: { ok: false, reason: 'hosting-disabled', message: 'off' } });
    const result = await tailLogs(makeContext(fetch), 'hp_9', {}, () => undefined);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'hosting-disabled');
  });
});

// ─── queryD1 (Phase 2) ─────────────────────────────────────────────────────

describe('deploy-client — queryD1', () => {
  it("POSTs to the sole-D1 'default' segment with allowWrite:false by default", async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { results: [{ id: 1 }] } });
    const result = await queryD1(makeContext(fetch), 'hp_9', 'SELECT * FROM t');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.results, [{ id: 1 }]);
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/deploy/projects/hp_9/resources/default/query');
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.headers['Authorization'], 'Bearer tok-env');
    assert.deepEqual(JSON.parse(calls[0]!.body as string), { sql: 'SELECT * FROM t', allowWrite: false });
  });

  it('threads params and allowWrite through', async () => {
    const { fetch, calls } = makeFetchStub({ jsonBody: { results: [] } });
    await queryD1(makeContext(fetch), 'hp_9', 'UPDATE t SET x=? WHERE id=?', { params: ['v', 3], allowWrite: true });
    assert.deepEqual(JSON.parse(calls[0]!.body as string), {
      sql: 'UPDATE t SET x=? WHERE id=?',
      params: ['v', 3],
      allowWrite: true,
    });
  });

  it('normalizes a missing results array to []', async () => {
    const { fetch } = makeFetchStub({ jsonBody: { meta: { rows_read: 0 } } });
    const result = await queryD1(makeContext(fetch), 'hp_9', 'SELECT 1 WHERE 0');
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.value.results, []);
  });

  it('passes the sql-not-allowed refusal reason through verbatim', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 403,
      jsonBody: { ok: false, reason: 'sql-not-allowed', message: 'writes require allowWrite:true' },
    });
    const result = await queryD1(makeContext(fetch), 'hp_9', 'DELETE FROM t');
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'sql-not-allowed');
      assert.equal(result.status, 403);
    }
  });

  it('passes resource-not-found (no D1 provisioned yet) through', async () => {
    const { fetch } = makeFetchStub({
      ok: false,
      status: 404,
      jsonBody: { ok: false, reason: 'resource-not-found', message: 'no D1 on this project' },
    });
    const result = await queryD1(makeContext(fetch), 'hp_9', 'SELECT 1');
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'resource-not-found');
  });
});

// ─── transient retry (bounded backoff on kind 'network') ───────────────────

describe('deploy-client — transient retry', () => {
  const START_REQ = { env: 'prod' as const, type: 'static' as const, manifest: {}, bundleDigest: 'sha256:dead' };

  function retryCtx(
    fetch: DeployFetchLike,
    onRetry?: RetryConfig['onRetry'],
    overrides: Partial<RetryConfig> = {},
  ): DeployContext {
    return makeContext(fetch, {
      retry: { sleepImpl: async () => {}, onRetry, ...overrides },
    });
  }

  it('retries ship/start past a CF 522 and succeeds (incident repro)', async () => {
    const retries: string[] = [];
    const { fetch, calls } = makeFetchStub([
      { ok: false, status: 522, textBody: 'HTTP 522' },
      START_OK,
    ]);
    const result = await startShip(retryCtx(fetch, (i) => retries.push(`${i.leg} ${i.attempt}/${i.maxAttempts}`)), 'hp_1', START_REQ);
    assert.equal(result.ok, true);
    assert.equal(calls.length, 2); // one failure + one success
    assert.deepEqual(retries, ['ship/start 1/3']);
  });

  it('gives up after maxAttempts on persistent 5xx and returns kind network', async () => {
    const { fetch, calls } = makeFetchStub({ ok: false, status: 503, textBody: 'down' });
    const result = await startShip(retryCtx(fetch), 'hp_1', START_REQ);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'network');
    assert.equal(calls.length, 3); // default maxAttempts
  });

  it('does NOT retry a deterministic 4xx refusal', async () => {
    const { fetch, calls } = makeFetchStub({
      ok: false,
      status: 409,
      jsonBody: { ok: false, reason: 'quota-exceeded', message: 'over cap' },
    });
    const result = await startShip(retryCtx(fetch), 'hp_1', START_REQ);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'quota-exceeded');
    assert.equal(calls.length, 1); // no retry
  });

  it('does not retry at all when no retry config is set (single attempt)', async () => {
    const { fetch, calls } = makeFetchStub({ ok: false, status: 522, textBody: 'HTTP 522' });
    const result = await startShip(makeContext(fetch), 'hp_1', START_REQ);
    assert.equal(result.ok, false);
    assert.equal(calls.length, 1);
  });

  it('does NOT retry the finalize leg (single-shot — avoid masking a lost-response success)', async () => {
    const { fetch, calls } = makeFetchStub({ ok: false, status: 502, textBody: 'bad gateway' });
    const result = await finalizeShip(retryCtx(fetch), 'hp_1', 'shp_1', []);
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'network');
    assert.equal(calls.length, 1); // surfaced as transient, not retried
  });
});
