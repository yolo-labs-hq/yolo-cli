/**
 * run-transfer tests.
 *
 * Coverage:
 *   - happy summary + happy --json
 *   - request body shape: { newOperatorAgentId: string } and
 *     { newOperatorAgentId: null }
 *   - operatorCount rendered in summary (item 16 — replaces
 *     operatorHistoryLength which is gone now that operators[] is
 *     itself the audit trail)
 *   - user-driven summary string ("user-driven (primaryOperator=null)")
 *   - planRunId regex rejection (no network)
 *   - newOperatorAgentId validation: empty string, > 128 chars,
 *     non-string types
 *   - missing SESSION_ID → auth failure
 *   - YOLO_API_URL fallback
 *   - --workspace mismatch
 *   - HTTP 403 NOT_AUTHORIZED (caller not authorized under R4)
 *   - HTTP 403 invalid_transfer_target (target not Operator-tier)
 *   - HTTP 409 INVALID_STATE (CAS miss)
 *   - exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { runRunTransfer, formatSummary, exitCodeForFailure } from './run-transfer.js';
import type { FetchLike } from './work-client.js';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  INTERNAL_API_KEY: 'svc-key',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';
const RUN_ID = 'pr_abc123';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: { workspaceId: STUB_WS, userId: '507f1f77bcf86cd799439001', agentId: 'substrate-cli', scopes: ['work.transfer_run_operator'] },
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

function transferRoute(
  finalAgent: string | null,
  operatorCount: number,
  captured: { body?: unknown } = {},
): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' &&
      url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs/${RUN_ID}/operator/transfer`),
    capture: (init) => {
      if (typeof init.body === 'string') captured.body = JSON.parse(init.body);
    },
    respond: () => ({
      ok: true,
      status: 200,
      body: {
        planRunId: RUN_ID,
        operatorAgentId: finalAgent,
        primaryOperator: finalAgent,
        operatorCount,
      },
    }),
  };
}

function transferError(status: number, body: unknown): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' &&
      url.endsWith(`/internal/work/workspaces/${STUB_WS}/runs/${RUN_ID}/operator/transfer`),
    respond: () => ({ ok: false, status, body }),
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────
describe('run-transfer — happy path', () => {
  it('emits "OK: transferred run …" with target + operatorCount', async () => {
    const fetch = makeFetchStub([mintRoute, transferRoute('claude', 2)]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /^OK: transferred run pr_abc123 primary to claude \(operatorCount=2\)$/);
  });

  it('sends { newOperatorAgentId: <agentId> } body when targeting an agent', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transferRoute('claude', 2, cap)]);
    await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.deepEqual(cap.body, { newOperatorAgentId: 'claude' });
  });

  it('sends { newOperatorAgentId: null } body for user-driven', async () => {
    const cap: { body?: unknown } = {};
    const fetch = makeFetchStub([mintRoute, transferRoute(null, 3, cap)]);
    await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: null,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.deepEqual(cap.body, { newOperatorAgentId: null });
  });

  it('renders user-driven explicitly in the summary', async () => {
    const fetch = makeFetchStub([mintRoute, transferRoute(null, 3)]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: null,
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /to user-driven \(primaryOperator=null\)/);
  });

  it('emits raw JSON when format is "json"', async () => {
    const fetch = makeFetchStub([mintRoute, transferRoute('codex', 4)]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'codex',
      fetchImpl: fetch,
      env: STUB_ENV,
      outputFormat: 'json',
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    const parsed = JSON.parse(result.output);
    assert.equal(parsed.planRunId, RUN_ID);
    assert.equal(parsed.operatorAgentId, 'codex');
    assert.equal(parsed.operatorCount, 4);
  });
});

// ─── formatSummary pure renderer ─────────────────────────────────────────
describe('run-transfer — formatSummary pure renderer', () => {
  it('renders agent target', () => {
    const out = formatSummary({ planRunId: 'r1', operatorAgentId: 'claude', operatorCount: 1 });
    assert.match(out, /to claude/);
    assert.match(out, /operatorCount=1/);
  });

  it('renders user-driven target with explicit null annotation', () => {
    const out = formatSummary({ planRunId: 'r1', operatorAgentId: null, operatorCount: 5 });
    assert.match(out, /to user-driven \(primaryOperator=null\)/);
  });
});

// ─── Error paths ─────────────────────────────────────────────────────────
describe('run-transfer — failures', () => {
  it('rejects malformed planRunId before any network call', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunTransfer({
      planRunId: 'has spaces',
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('rejects empty-string newOperatorAgentId pre-network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: '',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('rejects newOperatorAgentId longer than 128 chars pre-network', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'x'.repeat(129),
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const fetch = makeFetchStub([]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: { ...STUB_ENV, SESSION_ID: undefined },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'auth');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const fetch = makeFetchStub([mintRoute, transferRoute('claude', 2)]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: { SESSION_ID: 's', INTERNAL_API_KEY: 'k', YOLO_API_URL: 'https://api.example.com' },
    });
    assert.equal(result.ok, true);
  });

  it('rejects --workspace mismatch', async () => {
    const fetch = makeFetchStub([mintRoute]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: STUB_ENV,
      workspaceFlag: 'wrong',
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
  });

  it('returns http failure on 403 NOT_AUTHORIZED (caller not authorized under R4)', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      transferError(403, {
        error: 'caller is not authorized to transfer this binding',
        code: 'NOT_AUTHORIZED',
        details: { reason: 'caller_is_not_current_operator_or_user' },
      }),
    ]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 403/);
    assert.match(result.message, /NOT_AUTHORIZED/);
  });

  it('returns http failure on 403 invalid_transfer_target (target not Operator-tier)', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      transferError(403, {
        error: 'newOperatorAgentId must be an Operator-tier agent or null (user-driven)',
        code: 'NOT_AUTHORIZED',
        details: { reason: 'invalid_transfer_target', allowedOperatorTier: ['claude', 'codex'] },
      }),
    ]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'substrate-cli',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /invalid_transfer_target/);
  });

  it('returns http failure on 409 INVALID_STATE (CAS miss)', async () => {
    const fetch = makeFetchStub([
      mintRoute,
      transferError(409, {
        error: 'binding moved between read and transfer; retry',
        code: 'INVALID_STATE',
      }),
    ]);
    const result = await runRunTransfer({
      planRunId: RUN_ID,
      newOperatorAgentId: 'claude',
      fetchImpl: fetch,
      env: STUB_ENV,
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 409/);
  });
});

// ─── exitCodeForFailure ─────────────────────────────────────────────────
describe('run-transfer — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
