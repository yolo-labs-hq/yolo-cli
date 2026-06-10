/**
 * plan-export tests (Phase 8c.4).
 *
 * Stubs:
 *   - fetchImpl: routes /internal/mcp/tokens + /internal/work/.../plans/<id>
 *   - env: synthetic trio
 *   - now(): deterministic ISO timestamp
 *   - plansDir: tmp dir per test
 *
 * Coverage:
 *   - happy path (mint → GET → write canonical → refresh lockfile)
 *   - default output path (.yolo/plans/<planId>.md within plansDir)
 *   - -o <file> override
 *   - --env <name> selects .imports.<env>.json
 *   - --workspace mismatch
 *   - missing env trio
 *   - HTTP error from work.get_plan
 *   - dbPlanToFile pure conversion (DB → frontmatter+body)
 *   - round-trip: export then re-validate the written file
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runPlanExport, dbPlanToFile, exitCodeForFailure } from './plan-export.js';
import { canonicalizePlanFile } from './canonicalizer.js';
import { computeRevisionHash } from './revision.js';
import { validatePlanText } from './plan-validate.js';
import type { FetchLike } from './work-client.js';

// ─── Test helpers ────────────────────────────────────────────────────────

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  HOME: '/nonexistent-yolo-cli-test-home',
  YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const STUB_WS = '507f1f77bcf86cd799439011';
const STUB_NOW = () => '2026-04-30T12:00:00.000Z';

const STUB_TOKEN_RESPONSE = {
  token: 'jwt-fake',
  expiresAt: '2026-04-30T13:00:00.000Z',
  jti: '11111111-2222-3333-4444-555555555555',
  claims: {
    workspaceId: STUB_WS,
    userId: '507f1f77bcf86cd799439001',
    agentId: 'substrate-cli',
    scopes: ['work.get_plan'],
  },
};

interface CapturedCall {
  url: string;
  method: string;
  headers: Record<string, string>;
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
    calls.push({ url, method, headers: init.headers ?? {}, body: init.body });
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

function makeStubDbPlan(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  // Mirror the shape of common-api/src/routes/work.ts:serializePlan,
  // including the nullables (description?, autoRetryCap?, etc.).
  return {
    planId: 'foo',
    name: 'Foo plan',
    description: '# Foo plan\n\nBody description.\n',
    state: 'active',
    version: 3,
    inputs: [],
    failurePolicy: 'pause-and-wait',
    autoRetryCap: null,
    autoRetryFallback: null,
    integrationPolicy: null,
    steps: [
      {
        stepId: 'build',
        name: 'Build',
        mode: 'workstream',
        gates: [],
      },
    ],
    latestRunId: null,
    createdAt: '2026-04-29T00:00:00.000Z',
    updatedAt: '2026-04-30T00:00:00.000Z',
    ...overrides,
  };
}

// ─── Happy path ──────────────────────────────────────────────────────────
describe('plan-export — happy path', () => {
  it('mints, GETs, writes canonical bytes, refreshes lockfile', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const dbPlan = makeStubDbPlan();
      const { fetch, calls } = makeFetchStub([mintRoute, getRoute('foo', dbPlan)]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.planId, 'foo');
      assert.equal(result.workspaceId, STUB_WS);
      assert.equal(result.version, 3);
      assert.equal(result.exportedAt, '2026-04-30T12:00:00.000Z');
      assert.equal(result.outputPath, path.join(dir, 'foo.md'));

      // Default output landed in plansDir as `<planId>.md`
      assert.ok(existsSync(result.outputPath));
      const text = readFileSync(result.outputPath, 'utf8');
      assert.equal(result.revision, computeRevisionHash(text));

      // mint + GET were called, no PATCH/POST
      assert.equal(calls.length, 2);
      assert.deepEqual(calls.map((c) => c.method), ['POST', 'GET']);

      // Lockfile refreshed for (workspaceId, planId)
      const lockfilePath = path.join(dir, '.imports.json');
      assert.ok(existsSync(lockfilePath));
      const lockfile = JSON.parse(readFileSync(lockfilePath, 'utf8'));
      assert.equal(lockfile[STUB_WS].foo.lastImportedVersion, 3);
      assert.equal(lockfile[STUB_WS].foo.lastImportedRevision, result.revision);
      assert.equal(lockfile[STUB_WS].foo.lastImportedAt, '2026-04-30T12:00:00.000Z');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes a file that round-trips through validatePlanText', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const dbPlan = makeStubDbPlan();
      const { fetch } = makeFetchStub([mintRoute, getRoute('foo', dbPlan)]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;

      // The exported file must pass validate (parse + schema +
      // canonical + no-coercion). This is the round-trip parity 8c.5
      // CI will rely on across all repo plan files.
      const text = readFileSync(result.outputPath, 'utf8');
      const validation = validatePlanText(text);
      if (!validation.ok) {
        assert.fail(
          `exported file failed re-validation:\n${validation.errors.map((e) => `[${e.kind}] ${e.path ?? ''} ${e.message}`).join('\n')}\n\n--- file ---\n${text}`,
        );
      }
      assert.equal(validation.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── -o flag override ────────────────────────────────────────────────────
describe('plan-export — -o output flag', () => {
  it('writes to a custom directory when -o is set with the matching basename stem', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const dbPlan = makeStubDbPlan();
      const { fetch } = makeFetchStub([mintRoute, getRoute('foo', dbPlan)]);
      // Same stem (foo), different directory.
      const explicitPath = path.join(dir, 'subdir', 'foo.md');
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        outputFlag: explicitPath,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.outputPath, explicitPath);
      assert.ok(existsSync(explicitPath));
      // Default path NOT created
      assert.equal(existsSync(path.join(dir, 'foo.md')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects -o whose basename stem disagrees with planId (Codex 8c.4 R1 Medium)', async () => {
    // The exported file must round-trip through `yolo plan import`,
    // which enforces `frontmatter.planId === file-stem`. If -o lets
    // you write to `custom-name.md` for plan `foo`, the resulting
    // file becomes un-importable. Lock the cross-command contract:
    // -o is for changing the DIRECTORY, not the filename.
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const { fetch, calls } = makeFetchStub([]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        outputFlag: path.join(dir, 'custom-name.md'),
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'usage');
      assert.match(result.message, /custom-name/);
      assert.match(result.message, /foo/);
      assert.match(result.message, /round-trips/);
      assert.equal(exitCodeForFailure(result.kind), 64);
      // No network calls — the rejection is upfront, before mint/get.
      assert.equal(calls.length, 0);
      // Nothing written.
      assert.equal(existsSync(path.join(dir, 'custom-name.md')), false);
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts -o with a different extension as long as the stem matches (`foo.markdown` for planId `foo`)', async () => {
    // The import side strips ANY extension (`path.extname`), so the
    // round-trip rule is "stems match", not ".md required".
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const dbPlan = makeStubDbPlan();
      const { fetch } = makeFetchStub([mintRoute, getRoute('foo', dbPlan)]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        outputFlag: path.join(dir, 'foo.markdown'),
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── --env <name> ────────────────────────────────────────────────────────
describe('plan-export — --env', () => {
  it('refreshes .imports.<env>.json instead of the gitignored default', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const dbPlan = makeStubDbPlan();
      const { fetch } = makeFetchStub([mintRoute, getRoute('foo', dbPlan)]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        lockfileFlag: 'staging',
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      assert.ok(existsSync(path.join(dir, '.imports.staging.json')));
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Workspace + env failures ────────────────────────────────────────────
describe('plan-export — env / flag failures', () => {
  it('rejects --workspace flag that disagrees with minted workspaceId', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const { fetch } = makeFetchStub([mintRoute]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        workspaceFlag: 'wrong-workspace',
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'workspace_mismatch');
      assert.equal(exitCodeForFailure(result.kind), 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns auth failure when SESSION_ID is missing', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const { fetch } = makeFetchStub([]);
      const result = await runPlanExport({
        planId: 'foo',
        plansDir: dir,
        fetchImpl: fetch,
        env: { ...STUB_ENV, SESSION_ID: undefined },
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'auth');
      assert.match(result.message, /SESSION_ID/);
      assert.equal(exitCodeForFailure(result.kind), 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects malformed planId before any network call', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const { fetch, calls } = makeFetchStub([]);
      const result = await runPlanExport({
        planId: 'has spaces and !@#',
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'usage');
      // No network call — failure is upfront
      assert.equal(calls.length, 0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── HTTP failures ───────────────────────────────────────────────────────
describe('plan-export — HTTP failures', () => {
  it('returns http failure when work.get_plan returns 404', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-export-test-'));
    try {
      const { fetch } = makeFetchStub([
        mintRoute,
        getError('foo', 404, { error: 'plan not found', code: 'NOT_FOUND' }),
      ]);
      const result = await runPlanExport({
        planId: 'foo',
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

      // No file or lockfile written on failure
      assert.equal(existsSync(path.join(dir, 'foo.md')), false);
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── dbPlanToFile pure conversion ────────────────────────────────────────
describe('plan-export — dbPlanToFile pure conversion', () => {
  it('strips DB-only fields (version, latestRunId, createdAt, updatedAt)', () => {
    const dbPlan = makeStubDbPlan({ version: 42, latestRunId: 'run-xyz' });
    const { frontmatter } = dbPlanToFile(dbPlan as unknown as Parameters<typeof dbPlanToFile>[0]);
    assert.equal('version' in frontmatter, false);
    assert.equal('latestRunId' in frontmatter, false);
    assert.equal('createdAt' in frontmatter, false);
    assert.equal('updatedAt' in frontmatter, false);
  });

  it('drops null-valued autoRetryCap / autoRetryFallback / integrationPolicy', () => {
    const { frontmatter } = dbPlanToFile(
      makeStubDbPlan({
        autoRetryCap: null,
        autoRetryFallback: null,
        integrationPolicy: null,
      }) as unknown as Parameters<typeof dbPlanToFile>[0],
    );
    assert.equal('autoRetryCap' in frontmatter, false);
    assert.equal('autoRetryFallback' in frontmatter, false);
    assert.equal('integrationPolicy' in frontmatter, false);
  });

  it('preserves non-null integrationPolicy + autoRetry settings', () => {
    const { frontmatter } = dbPlanToFile(
      makeStubDbPlan({
        autoRetryCap: 3,
        autoRetryFallback: 'pause-and-wait',
        integrationPolicy: { baseBranch: 'main' },
      }) as unknown as Parameters<typeof dbPlanToFile>[0],
    );
    assert.equal(frontmatter.autoRetryCap, 3);
    assert.equal(frontmatter.autoRetryFallback, 'pause-and-wait');
    assert.deepEqual(frontmatter.integrationPolicy, { baseBranch: 'main' });
  });

  it('uses description for body, treats null/undefined as empty string', () => {
    const a = dbPlanToFile(makeStubDbPlan({ description: '# Body\n' }) as unknown as Parameters<typeof dbPlanToFile>[0]);
    assert.equal(a.body, '# Body\n');
    const b = dbPlanToFile(makeStubDbPlan({ description: null }) as unknown as Parameters<typeof dbPlanToFile>[0]);
    assert.equal(b.body, '');
    const c = dbPlanToFile(makeStubDbPlan({ description: undefined }) as unknown as Parameters<typeof dbPlanToFile>[0]);
    assert.equal(c.body, '');
  });

  it('preserves empty inputs:[] (round-trip equivalence with import)', () => {
    const { frontmatter } = dbPlanToFile(makeStubDbPlan({ inputs: [] }) as unknown as Parameters<typeof dbPlanToFile>[0]);
    assert.deepEqual(frontmatter.inputs, []);
  });

  it('canonicalizePlanFile output round-trips through dbPlanToFile', () => {
    // The round-trip parity 8c.5 CI will lean on: feeding a DB
    // snapshot through dbPlanToFile + canonicalize yields a file
    // that, when re-parsed and re-canonicalized, is byte-equal.
    const dbPlan = makeStubDbPlan();
    const { frontmatter, body } = dbPlanToFile(dbPlan as unknown as Parameters<typeof dbPlanToFile>[0]);
    const out1 = canonicalizePlanFile(frontmatter, body);
    // Re-parse → re-emit
    const fmRe = canonicalizePlanFile(frontmatter, body);
    assert.equal(out1, fmRe);
  });
});

// ─── exitCodeForFailure mapping ──────────────────────────────────────────
describe('plan-export — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
    assert.equal(exitCodeForFailure('write'), 1);
    assert.equal(exitCodeForFailure('lockfile'), 1);
  });
});
