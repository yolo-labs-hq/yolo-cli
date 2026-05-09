/**
 * plan-state tests.
 *
 * Stubs:
 *   - fetchImpl: routes /internal/mcp/tokens + /internal/work/...
 *   - env: synthetic trio
 *   - now(): deterministic ISO timestamp
 *   - plansDir: tmp dir per test
 *
 * Coverage:
 *   - draft → active happy path (mint → GET → PATCH → lockfile refresh)
 *   - draft → archived
 *   - active → archived
 *   - same-state no-op (no PATCH, no lockfile mutation)
 *   - lockfile entry refresh: revision unchanged, version bumped
 *   - lockfile absent (e.g., plan created via curl) — best-effort skip
 *   - --workspace mismatch
 *   - missing env trio
 *   - planId regex rejection (no network call)
 *   - HTTP 404 from get_plan
 *   - HTTP 409 (transition rejected by substrate, e.g., archived → active)
 *   - HTTP 409 version conflict
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  runPlanStateTransition,
  exitCodeForFailure,
  formatSuccess,
} from './plan-state.js';
import type { FetchLike } from './work-client.js';
import { writeLockfile } from './lockfile.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  INTERNAL_API_KEY: 'svc-key-xyz',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';
const STUB_NOW = () => '2026-04-30T12:00:00.000Z';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, userId: '507f1f77bcf86cd799439001', agentId: 'substrate-cli', scopes: ['work.update_plan'] },
};

const SAMPLE_REVISION = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';

interface CapturedCall {
  url: string;
  method: string;
  body?: string;
}

interface RouteHandler {
  matches: (url: string, method: string) => boolean;
  respond: () => { ok: boolean; status: number; body: unknown };
}

function makeFetchStub(routes: RouteHandler[]): { fetch: FetchLike; calls: CapturedCall[] } {
  const calls: CapturedCall[] = [];
  const fetch: FetchLike = async (url, init = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body });
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

function getRoute(planId: string, state: string, version: number): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({
      ok: true,
      status: 200,
      body: { plan: { planId, state, version } },
    }),
  };
}

function getError(planId: string, status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: false, status, body }),
  };
}

function patchRoute(planId: string, version: number): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'PATCH' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: true, status: 200, body: { planId, version, state: 'active' } }),
  };
}

function patchError(planId: string, status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'PATCH' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy paths ─────────────────────────────────────────────────────────
describe('plan-state — happy paths', () => {
  it('draft → active: mints, GETs, PATCHes set-state, refreshes lockfile', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      // Seed lockfile so we can verify version bump.
      writeLockfile(path.join(dir, '.imports.json'), {
        [STUB_WS]: {
          foo: {
            lastImportedRevision: SAMPLE_REVISION,
            lastImportedVersion: 1,
            lastImportedAt: '2026-04-29T00:00:00.000Z',
          },
        },
      });

      const { fetch, calls } = makeFetchStub([
        mintRoute,
        getRoute('foo', 'draft', 1),
        patchRoute('foo', 2),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.fromState, 'draft');
      assert.equal(result.toState, 'active');
      assert.equal(result.version, 2);
      assert.equal(result.noop, false);

      // mint + GET + PATCH
      const methods = calls.map((c) => c.method);
      assert.deepEqual(methods, ['POST', 'GET', 'PATCH']);

      // PATCH body shape: baseVersion + single set-state mutation
      const patchBody = JSON.parse(calls[2]!.body!) as {
        baseVersion: number;
        mutations: Array<{ op: string; state: string }>;
      };
      assert.equal(patchBody.baseVersion, 1);
      assert.equal(patchBody.mutations.length, 1);
      assert.deepEqual(patchBody.mutations[0], { op: 'set-state', state: 'active' });

      // Lockfile: revision unchanged, version bumped, timestamp refreshed
      const lockfile = JSON.parse(readFileSync(path.join(dir, '.imports.json'), 'utf8'));
      assert.equal(lockfile[STUB_WS].foo.lastImportedRevision, SAMPLE_REVISION);
      assert.equal(lockfile[STUB_WS].foo.lastImportedVersion, 2);
      assert.equal(lockfile[STUB_WS].foo.lastImportedAt, '2026-04-30T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('draft → archived', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch, calls } = makeFetchStub([
        mintRoute,
        getRoute('foo', 'draft', 1),
        patchRoute('foo', 2),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'archived',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.fromState, 'draft');
      assert.equal(result.toState, 'archived');
      const patchBody = JSON.parse(calls[2]!.body!);
      assert.equal(patchBody.mutations[0].state, 'archived');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('active → archived', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch } = makeFetchStub([
        mintRoute,
        getRoute('foo', 'active', 5),
        patchRoute('foo', 6),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'archived',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.fromState, 'active');
      assert.equal(result.version, 6);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Same-state no-op ─────────────────────────────────────────────────────
describe('plan-state — same-state no-op', () => {
  it('returns noop=true and SKIPS the PATCH when already in target state', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch, calls } = makeFetchStub([mintRoute, getRoute('foo', 'active', 3)]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.noop, true);
      assert.equal(result.fromState, 'active');
      assert.equal(result.toState, 'active');
      assert.equal(result.version, 3);

      // Only mint + GET — no PATCH (the no-op short-circuit point).
      const methods = calls.map((c) => c.method);
      assert.deepEqual(methods, ['POST', 'GET']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('REALIGNS a stale lockfile entry on no-op (Codex R1 retry-safety fix)', async () => {
    // Setup: lockfile says version=1, but DB is at version=5 with
    // state already active (someone else activated, or an earlier
    // `yolo plan activate` succeeded at the PATCH step but failed
    // later — leaving the substrate updated and the lockfile
    // stale). Without this fix, a retry would hit the no-op path,
    // return success, and leave the lockfile pointing at v1.
    // The next real `yolo plan import` would then see DB at v5 vs
    // lockfile expecting v1 → DIVERGED.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      writeLockfile(path.join(dir, '.imports.json'), {
        [STUB_WS]: {
          foo: {
            lastImportedRevision: SAMPLE_REVISION,
            lastImportedVersion: 1,
            lastImportedAt: '2026-04-29T00:00:00.000Z',
          },
        },
      });

      const { fetch, calls } = makeFetchStub([mintRoute, getRoute('foo', 'active', 5)]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.noop, true);
      assert.equal(result.version, 5);

      // Still no PATCH — substrate untouched.
      assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET']);

      // Lockfile realigned: revision unchanged (file didn't change),
      // version bumped to GET response's version, timestamp refreshed.
      const lockfile = JSON.parse(readFileSync(path.join(dir, '.imports.json'), 'utf8'));
      assert.equal(lockfile[STUB_WS].foo.lastImportedRevision, SAMPLE_REVISION);
      assert.equal(lockfile[STUB_WS].foo.lastImportedVersion, 5);
      assert.equal(lockfile[STUB_WS].foo.lastImportedAt, '2026-04-30T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('skips lockfile entirely on no-op when no entry exists (best-effort)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch } = makeFetchStub([mintRoute, getRoute('foo', 'active', 3)]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      // No lockfile entry existed → no write happens.
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Lockfile-absent best-effort ──────────────────────────────────────────
describe('plan-state — lockfile entry absent', () => {
  it('skips lockfile refresh gracefully when no entry exists for (workspace, plan)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      // No lockfile written — runPlanStateTransition should still succeed.
      const { fetch } = makeFetchStub([
        mintRoute,
        getRoute('foo', 'draft', 1),
        patchRoute('foo', 2),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      // Lockfile created (writeLockfile ran), but with no entry for this
      // (workspace, plan) — readLockfile of an absent file returns {}.
      // So the file should NOT exist after the transition (best-effort
      // skip).
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── HTTP error paths ─────────────────────────────────────────────────────
describe('plan-state — HTTP failures', () => {
  it('returns http failure when get_plan returns 404', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch } = makeFetchStub([
        mintRoute,
        getError('foo', 404, { error: 'plan not found', code: 'NOT_FOUND' }),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'http');
      assert.match(result.message, /HTTP 404/);
      assert.equal(exitCodeForFailure(result.kind), 1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns http failure when update_plan rejects the transition (e.g., archived → active)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      // Substrate's applyMutations rejects archived → active with 409 INVALID_STATE.
      const { fetch } = makeFetchStub([
        mintRoute,
        getRoute('foo', 'archived', 7),
        patchError('foo', 409, {
          error: 'invalid authoring state transition: archived -> active',
          code: 'INVALID_STATE',
        }),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'http');
      assert.match(result.message, /HTTP 409/);
      assert.match(result.message, /archived/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns http failure on version conflict (CAS race)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch } = makeFetchStub([
        mintRoute,
        getRoute('foo', 'draft', 1),
        patchError('foo', 409, {
          error: 'version conflict (current is not 1)',
          code: 'VERSION_CONFLICT',
        }),
      ]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'http');
      assert.match(result.message, /version conflict/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Usage / env failures ─────────────────────────────────────────────────
describe('plan-state — usage / env failures', () => {
  it('rejects malformed planId before any network call', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch, calls } = makeFetchStub([]);
      const result = await runPlanStateTransition({
        planId: 'has spaces',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'usage');
      assert.equal(calls.length, 0);
      assert.equal(exitCodeForFailure(result.kind), 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch } = makeFetchStub([]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: { ...STUB_ENV, SESSION_ID: undefined },
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'auth');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --workspace mismatch', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-state-test-'));
    try {
      const { fetch } = makeFetchStub([mintRoute]);
      const result = await runPlanStateTransition({
        planId: 'foo',
        targetState: 'active',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
        workspaceFlag: 'wrong-workspace',
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'workspace_mismatch');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── formatSuccess + exitCodeForFailure ──────────────────────────────────
describe('plan-state — formatSuccess + exitCodeForFailure', () => {
  it('formatSuccess includes the from→to transition for non-noop', () => {
    const out = formatSuccess({
      ok: true,
      planId: 'foo',
      workspaceId: STUB_WS,
      fromState: 'draft',
      toState: 'active',
      version: 2,
      noop: false,
    });
    assert.match(out, /draft → active/);
    assert.match(out, /version 2/);
  });

  it('formatSuccess says "already <state>" for no-op', () => {
    const out = formatSuccess({
      ok: true,
      planId: 'foo',
      workspaceId: STUB_WS,
      fromState: 'active',
      toState: 'active',
      version: 3,
      noop: true,
    });
    assert.match(out, /already active/);
  });

  it('exitCodeForFailure maps usage/auth/workspace_mismatch to 64; http/lockfile to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
    assert.equal(exitCodeForFailure('lockfile'), 1);
  });
});
