/**
 * run-lifecycle tests (pause / resume / cancel).
 *
 * Coverage:
 *   - happy summary for each verb (route path + past-tense word)
 *   - --reason body inclusion (pause, cancel) + exclusion (resume)
 *   - resume rejects --reason pre-network
 *   - reason length ceiling (1024)
 *   - planRunId regex rejection
 *   - missing SESSION_ID
 *   - YOLO_API_URL fallback
 *   - --workspace mismatch
 *   - HTTP 403 NOT_AUTHORIZED (substrate-cli not the bound Operator)
 *   - HTTP 409 INVALID_STATE (already paused / not paused / terminal)
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runRunLifecycle,
  formatSummary,
  exitCodeForFailure,
  type RunLifecycleVerb,
} from './run-lifecycle.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  INTERNAL_API_KEY: 'svc-key',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';
const RUN_ID = 'pr_abc123';

const STUB_USER = '507f1f77bcf86cd799439001';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, userId: STUB_USER, agentId: 'substrate-cli', scopes: ['work.pause_run'] },
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

function transitionRoute(
  verb: RunLifecycleVerb,
  finalState: string,
  captured: { body?: unknown; url?: string },
): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs/${RUN_ID}/${verb}`),
    capture: (init) => {
      captured.url = `${verb}`;
      if (typeof init.body === 'string') captured.body = JSON.parse(init.body);
    },
    respond: () => ({
      ok: true,
      status: 200,
      body: { planRunId: RUN_ID, executionState: finalState },
    }),
  };
}

function transitionError(verb: RunLifecycleVerb, status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs/${RUN_ID}/${verb}`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy paths ─────────────────────────────────────────────────────────
describe('run-lifecycle — happy paths', () => {
  it('pause emits "OK: paused …"', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('pause', 'paused', cap)]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /^OK: paused run pr_abc123 \(executionState=paused\)$/);
  });

  it('resume emits "OK: resumed …"', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('resume', 'running', cap)]);
    const result = await runRunLifecycle({
      verb: 'resume',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /^OK: resumed run pr_abc123 \(executionState=running\)$/);
  });

  it('cancel emits "OK: cancelled …"', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('cancel', 'cancelled', cap)]);
    const result = await runRunLifecycle({
      verb: 'cancel',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /^OK: cancelled run pr_abc123 \(executionState=cancelled\)$/);
  });

  it('--json mode emits the raw response body', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('pause', 'paused', cap)]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.planRunId, RUN_ID);
    assert.equal(parsed.executionState, 'paused');
  });
});

// ─── --reason handling ───────────────────────────────────────────────────
describe('run-lifecycle — --reason', () => {
  it('includes reason in pause body', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('pause', 'paused', cap)]);
    await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      reason: 'investigating flaky test',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.deepEqual(cap.body, { reason: 'investigating flaky test' });
  });

  it('includes reason in cancel body', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('cancel', 'cancelled', cap)]);
    await runRunLifecycle({
      verb: 'cancel',
      planRunId: RUN_ID,
      reason: 'no longer needed',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.deepEqual(cap.body, { reason: 'no longer needed' });
  });

  it('rejects --reason with resume pre-network (no fetch made)', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunLifecycle({
      verb: 'resume',
      planRunId: RUN_ID,
      reason: 'should not be allowed',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.match(result.message, /resume/);
  });

  it('rejects reason longer than 1024 chars pre-network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      reason: 'x'.repeat(1025),
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('omits reason field when not supplied', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('pause', 'paused', cap)]);
    await runRunLifecycle({ verb: 'pause', planRunId: RUN_ID, fetchImpl: fetch, env: STUB_ENV });
    assert.deepEqual(cap.body, {});
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('run-lifecycle — formatSummary pure renderer', () => {
  it('uses past-tense word matching the verb', () => {
    assert.match(formatSummary('pause', { planRunId: 'r1', executionState: 'paused' }), /paused/);
    assert.match(formatSummary('resume', { planRunId: 'r1', executionState: 'running' }), /resumed/);
    assert.match(formatSummary('cancel', { planRunId: 'r1', executionState: 'cancelled' }), /cancelled/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('run-lifecycle — failures', () => {
  it('rejects malformed planRunId before network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: 'has spaces',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('rejects unknown verb', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunLifecycle({
      verb: 'badVerb' as unknown as RunLifecycleVerb,
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('pause', 'paused', cap)]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
  });

  it('returns http failure on 403 NOT_AUTHORIZED (not the bound Operator)', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      transitionError('pause', 403, { error: 'caller is not the bound Operator', code: 'NOT_AUTHORIZED' }),
    ]);
    const result = await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 403/);
    assert.match(result.message, /NOT_AUTHORIZED/);
    assert.equal(exitCodeForFailure(result.kind), 1);
  });

  it('returns http failure on 409 INVALID_STATE', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      transitionError('resume', 409, { error: 'invalid transition: running -> running', code: 'INVALID_STATE' }),
    ]);
    const result = await runRunLifecycle({
      verb: 'resume',
      planRunId: RUN_ID,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 409/);
  });
});

// ─── --user-driven (skips MCP, hits user-facing route) ──────────────────
describe('run-lifecycle — --user-driven', () => {
  function userRouteMatch(verb: RunLifecycleVerb, captured: { url?: string; headers?: Record<string, string>; body?: unknown }): RouteHandler {
    return {
      matches: (url, method) =>
        method === 'POST' && url.endsWith(`/v1/workspaces/${STUB_WS}/runs/${RUN_ID}/${verb}`),
      capture: (init) => {
        captured.url = `${verb}`;
        captured.headers = init.headers;
        if (typeof init.body === 'string') captured.body = JSON.parse(init.body);
      },
      respond: () => ({
        ok: true,
        status: 200,
        body: { planRunId: RUN_ID, executionState: verb === 'pause' ? 'paused' : verb === 'resume' ? 'running' : 'cancelled' },
      }),
    };
  }

  it('hits /v1/workspaces/.../runs/.../cancel instead of /internal/work/...', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, userRouteMatch('cancel', captured)]);
    const result = await runRunLifecycle({
      verb: 'cancel',
      planRunId: RUN_ID,
      userDriven: true,
      reason: 'cleaning up zombie run',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'cancel');
    // Forwards reason in body.
    assert.deepEqual(captured.body, { reason: 'cleaning up zombie run' });
  });

  it('sends X-Internal-Auth + X-User-Id (NOT Authorization Bearer)', async () => {
    const captured: { url?: string; headers?: Record<string, string>; body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, userRouteMatch('pause', captured)]);
    await runRunLifecycle({
      verb: 'pause',
      planRunId: RUN_ID,
      userDriven: true,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(captured.headers?.['X-Internal-Auth'], 'svc-key');
    assert.equal(captured.headers?.['X-User-Id'], STUB_USER);
    // Critically: NO Authorization Bearer header — that would route
    // the request through userAuth/MCP-validation, defeating the
    // whole point of the user-driven path.
    assert.equal(captured.headers?.['Authorization'], undefined);
    assert.equal(captured.headers?.['authorization'], undefined);
  });

  it('default (userDriven: false) still hits /internal/work/... with Bearer', async () => {
    const captured: { body?: unknown; url?: string } = {};
    const fetch = makeFetchStub([mintRoute, transitionRoute('cancel', 'cancelled', captured)]);
    const result = await runRunLifecycle({
      verb: 'cancel',
      planRunId: RUN_ID,
      // userDriven omitted → MCP path
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    assert.equal(captured.url, 'cancel');
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('run-lifecycle — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
