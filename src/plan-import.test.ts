/**
 * plan-import tests (Phase 8c.3).
 *
 * End-to-end coverage of the orchestration in `runPlanImport`. Stubs:
 *   - fetchImpl: records calls + returns canned mint/work responses.
 *   - env: synthetic trio (SESSION_ID / INTERNAL_API_KEY / YOLO_COMMON_API_URL).
 *   - now(): deterministic ISO timestamp so lockfile snapshots are stable.
 *   - plansDir: tmp dir per test (lockfile + plan file land here).
 *
 * Each test exercises one decision-tree branch:
 *   - CREATE happy path
 *   - CREATE collision (409) without --force → conflict_no_force
 *   - CREATE collision (409) with --force → falls into UPDATE
 *   - Re-import, file revision unchanged → no-change (no DB calls)
 *   - Re-import, file changed, DB version matches lockfile → updated
 *   - Re-import, file changed, DB diverged, no --force → diverged
 *   - Re-import, file changed, DB diverged + --force → updated
 *   - validation failure / planId-stem mismatch / workspace mismatch / missing env trio
 *   - lockfile errors (unreadable tmp file)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { runPlanImport, exitCodeForFailure, type ImportFailure } from './plan-import.js';
import { canonicalizePlanFile } from './canonicalizer.js';
import { computeRevisionHash } from './revision.js';
import type { FetchLike } from './work-client.js';
import { writeLockfile } from './lockfile.js';

// ─── Test helpers ────────────────────────────────────────────────────────

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
  claims: {
    workspaceId: STUB_WS,
    agentId: 'substrate-cli',
    scopes: ['work.create_plan'],
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
  /** Returns either a JSON response OR an error envelope. */
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

function createRoute(planId: string, version = 1): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans`),
    respond: () => ({ ok: true, status: 200, body: { planId, version, authoringState: 'active' } }),
  };
}

function createConflictRoute(): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'POST' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans`),
    respond: () => ({ ok: false, status: 409, body: { error: 'plan id already exists', code: 'CONFLICT' } }),
  };
}

function getRoute(planId: string, dbPlan: Record<string, unknown>): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'GET' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: true, status: 200, body: { plan: dbPlan } }),
  };
}

function updateRoute(planId: string, version: number): RouteHandler {
  return {
    matches: (url, method) =>
      method === 'PATCH' && url.endsWith(`/internal/work/workspaces/${STUB_WS}/plans/${planId}`),
    respond: () => ({ ok: true, status: 200, body: { planId, version, authoringState: 'active' } }),
  };
}

// Minimal canonical plan file (planId === stem on disk).
function buildPlanFile(): { frontmatter: Record<string, unknown>; body: string; canonical: string } {
  const frontmatter: Record<string, unknown> = {
    planId: 'foo',
    name: 'Foo plan',
    authoringState: 'active',
    failurePolicy: 'pause-and-wait',
    steps: [
      {
        stepId: 'build',
        name: 'Build',
        mode: 'workstream',
        gates: [],
      },
    ],
  };
  const body = '# Foo plan\n\nBody description.\n';
  const canonical = canonicalizePlanFile(frontmatter, body);
  return { frontmatter, body, canonical };
}

function setupTmp(): { dir: string; filePath: string; canonical: string; planId: string } {
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-import-test-'));
  const planId = 'foo';
  const filePath = path.join(dir, `${planId}.md`);
  const { canonical } = buildPlanFile();
  writeFileSync(filePath, canonical);
  return { dir, filePath, canonical, planId };
}

function dbSnapshotMatchingFile(version: number): Record<string, unknown> {
  // Body normalization matches plan-import's makeFilePlan.
  return {
    planId: 'foo',
    name: 'Foo plan',
    description: '# Foo plan\n\nBody description.\n',
    authoringState: 'active',
    failurePolicy: 'pause-and-wait',
    inputs: [],
    integrationPolicy: undefined,
    steps: [
      {
        stepId: 'build',
        name: 'Build',
        mode: 'workstream',
        gates: [],
      },
    ],
    version,
  };
}

// ─── CREATE happy path ───────────────────────────────────────────────────
describe('plan-import — CREATE happy path', () => {
  it('mints token, calls work.create_plan, writes lockfile entry', async () => {
    const { dir, filePath, canonical } = setupTmp();
    try {
      const { fetch, calls } = makeFetchStub([mintRoute, createRoute('foo', 1)]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.action, 'created');
      assert.equal(result.planId, 'foo');
      assert.equal(result.workspaceId, STUB_WS);
      assert.equal(result.version, 1);
      assert.equal(result.revision, computeRevisionHash(canonical));
      assert.equal(result.importedAt, '2026-04-30T12:00:00.000Z');

      // Mint + create were both called
      assert.equal(calls.length, 2);
      assert.equal(calls[0]!.url, 'https://api.example.com/internal/mcp/tokens');
      assert.ok(calls[1]!.url.endsWith(`/workspaces/${STUB_WS}/plans`));
      assert.equal(calls[1]!.method, 'POST');

      // Lockfile written with the right entry
      const lockfilePath = path.join(dir, '.imports.json');
      assert.ok(existsSync(lockfilePath));
      const written = JSON.parse(readFileSync(lockfilePath, 'utf8'));
      assert.equal(written[STUB_WS].foo.lastImportedVersion, 1);
      assert.equal(written[STUB_WS].foo.lastImportedRevision, computeRevisionHash(canonical));
      assert.equal(written[STUB_WS].foo.lastImportedAt, '2026-04-30T12:00:00.000Z');

      // Codex 8c.3 R1 lock: the description sent to work.create_plan
      // is the separator-normalized body, NOT the raw regex capture.
      // Canonical files emit `---\n\n<body>`, so the captured body
      // starts with `\n`; if we sent that raw, the imported DB
      // description would begin with a phantom blank line and 8c.4
      // export round-trips would churn.
      const createBody = JSON.parse(calls[1]!.body!) as {
        description: string;
        authoringState: string;
      };
      assert.equal(createBody.description, '# Foo plan\n\nBody description.\n');
      assert.equal(createBody.description.startsWith('\n'), false);
      // Substrate now accepts authoringState on create_plan (the fix
      // that surfaced from Phase 8d.2 verification — file says
      // active, DB used to silently downgrade to draft). Lock that
      // the import path forwards the file's value.
      assert.equal(createBody.authoringState, 'active');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('strips leading and trailing whitespace from the body before sending (R1 fix invariant)', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-import-test-'));
    try {
      // Write a file whose body has multiple leading blank lines AND
      // trailing whitespace. The validate step will reject it as
      // non-canonical (so this isn't a valid input via the CLI), but
      // we exercise makeFilePlan's normalization directly by routing
      // through the canonicalizer first to produce a canonical file
      // that nevertheless captures with a leading `\n` (which is the
      // every-canonical-file case).
      const { canonical } = buildPlanFile();
      const filePath = path.join(dir, 'foo.md');
      writeFileSync(filePath, canonical);

      // Sanity check: the canonical file's regex-captured body really
      // does start with `\n` — that's the bug surface we're locking.
      const parsedBody = canonical.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/)![1]!;
      assert.equal(parsedBody.startsWith('\n'), true, 'canonical files must capture with leading \\n');

      const { fetch, calls } = makeFetchStub([mintRoute, createRoute('foo', 1)]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      const sentDescription = (JSON.parse(calls[1]!.body!) as { description: string }).description;
      assert.equal(sentDescription.startsWith('\n'), false);
      assert.match(sentDescription, /\n$/);
      assert.equal(sentDescription.match(/\n+$/)![0]!.length, 1, 'exactly one trailing newline');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CREATE 409 (no --force) → conflict_no_force ─────────────────────────
describe('plan-import — CREATE 409 without --force', () => {
  it('refuses with a clear message + retains lockfile-empty state', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch } = makeFetchStub([mintRoute, createConflictRoute()]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'conflict_no_force');
      assert.match(result.message, /already exists/);
      assert.match(result.message, /--force/);
      assert.equal(exitCodeForFailure(result.kind), 1);

      // Lockfile NOT written
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── CREATE 409 + --force → falls into UPDATE ────────────────────────────
describe('plan-import — CREATE 409 with --force', () => {
  it('fetches DB plan and runs the update path', async () => {
    const { dir, filePath, canonical } = setupTmp();
    try {
      const { fetch, calls } = makeFetchStub([
        mintRoute,
        createConflictRoute(),
        getRoute('foo', { ...dbSnapshotMatchingFile(3), name: 'Old name' }),
        updateRoute('foo', 4),
      ]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
        force: true,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.action, 'updated');
      assert.equal(result.version, 4);
      assert.equal(result.revision, computeRevisionHash(canonical));

      const methods = calls.map((c) => c.method);
      assert.deepEqual(methods, ['POST', 'POST', 'GET', 'PATCH']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── No-change (lockfile revision matches file) ──────────────────────────
describe('plan-import — no-change', () => {
  it('refreshes lockfile timestamp and skips the DB call', async () => {
    const { dir, filePath, canonical } = setupTmp();
    try {
      // Pre-seed the lockfile with the file's current revision.
      const lockfilePath = path.join(dir, '.imports.json');
      writeLockfile(lockfilePath, {
        [STUB_WS]: {
          foo: {
            lastImportedRevision: computeRevisionHash(canonical),
            lastImportedVersion: 5,
            lastImportedAt: '2026-04-29T12:00:00.000Z',
          },
        },
      });

      const { fetch, calls } = makeFetchStub([mintRoute]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.action, 'no-change');
      assert.equal(result.version, 5);

      // Only mint was called — no work.* GET / POST / PATCH.
      assert.equal(calls.length, 1);
      assert.match(calls[0]!.url, /\/internal\/mcp\/tokens$/);

      // Timestamp refreshed, version preserved
      const updated = JSON.parse(readFileSync(lockfilePath, 'utf8'));
      assert.equal(updated[STUB_WS].foo.lastImportedAt, '2026-04-30T12:00:00.000Z');
      assert.equal(updated[STUB_WS].foo.lastImportedVersion, 5);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Re-import, file changed, DB version matches lockfile → updated ──────
describe('plan-import — re-import (no drift)', () => {
  it('runs work.get_plan + work.update_plan, updates lockfile to new version', async () => {
    const { dir, filePath, canonical } = setupTmp();
    try {
      // Pre-seed lockfile with a stale revision (any non-current value).
      const lockfilePath = path.join(dir, '.imports.json');
      writeLockfile(lockfilePath, {
        [STUB_WS]: {
          foo: {
            lastImportedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            lastImportedVersion: 3,
            lastImportedAt: '2026-04-29T12:00:00.000Z',
          },
        },
      });

      const { fetch, calls } = makeFetchStub([
        mintRoute,
        getRoute('foo', { ...dbSnapshotMatchingFile(3), name: 'Old name' }),
        updateRoute('foo', 4),
      ]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.action, 'updated');
      assert.equal(result.version, 4);

      // Mint, GET, PATCH (no POST create attempted since lockfile entry existed)
      const methods = calls.map((c) => c.method);
      assert.deepEqual(methods, ['POST', 'GET', 'PATCH']);

      // Lockfile updated to v4 + new revision
      const updated = JSON.parse(readFileSync(lockfilePath, 'utf8'));
      assert.equal(updated[STUB_WS].foo.lastImportedVersion, 4);
      assert.equal(updated[STUB_WS].foo.lastImportedRevision, computeRevisionHash(canonical));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Re-import, DB diverged, no --force → diverged ───────────────────────
describe('plan-import — diverged without --force', () => {
  it('refuses with a clear message + does not call PATCH', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const lockfilePath = path.join(dir, '.imports.json');
      writeLockfile(lockfilePath, {
        [STUB_WS]: {
          foo: {
            lastImportedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            lastImportedVersion: 3,
            lastImportedAt: '2026-04-29T12:00:00.000Z',
          },
        },
      });

      const { fetch, calls } = makeFetchStub([
        mintRoute,
        // DB at v7 but lockfile expected v3 → diverged
        getRoute('foo', { ...dbSnapshotMatchingFile(7), name: 'DB-side rename' }),
      ]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });

      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'diverged');
      assert.match(result.message, /version 7/);
      assert.match(result.message, /version 3/);
      assert.match(result.message, /--force/);

      // Mint + GET were called, PATCH was NOT
      const methods = calls.map((c) => c.method);
      assert.deepEqual(methods, ['POST', 'GET']);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── Re-import, DB diverged + --force → updated ──────────────────────────
describe('plan-import — diverged with --force', () => {
  it('proceeds with update', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const lockfilePath = path.join(dir, '.imports.json');
      writeLockfile(lockfilePath, {
        [STUB_WS]: {
          foo: {
            lastImportedRevision: 'sha256:0000000000000000000000000000000000000000000000000000000000000000',
            lastImportedVersion: 3,
            lastImportedAt: '2026-04-29T12:00:00.000Z',
          },
        },
      });

      const { fetch } = makeFetchStub([
        mintRoute,
        getRoute('foo', { ...dbSnapshotMatchingFile(7), name: 'DB-side rename' }),
        updateRoute('foo', 8),
      ]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
        force: true,
      });

      assert.equal(result.ok, true);
      if (!result.ok) return;
      assert.equal(result.action, 'updated');
      assert.equal(result.version, 8);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── env + flag failure modes ────────────────────────────────────────────
describe('plan-import — env / flag failures', () => {
  it('returns auth failure when SESSION_ID is missing', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch } = makeFetchStub([]);
      const result = await runPlanImport({
        filePath,
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

  it('returns auth failure when INTERNAL_API_KEY is missing', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch } = makeFetchStub([]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: { ...STUB_ENV, INTERNAL_API_KEY: undefined },
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      assert.equal((result as ImportFailure).kind, 'auth');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is missing', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch, calls } = makeFetchStub([mintRoute, createRoute('foo', 1)]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: {
          SESSION_ID: 'sess',
          INTERNAL_API_KEY: 'k',
          YOLO_API_URL: 'https://api.example.com',
        },
        now: STUB_NOW,
      });
      assert.equal(result.ok, true);
      assert.match(calls[0]!.url, /^https:\/\/api\.example\.com/);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('rejects --workspace flag that disagrees with the minted workspaceId', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch } = makeFetchStub([mintRoute]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
        workspaceFlag: 'wrong-workspace',
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'workspace_mismatch');
      assert.match(result.message, /wrong-workspace/);
      assert.match(result.message, new RegExp(STUB_WS));
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('accepts --workspace flag that matches the minted workspaceId', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch } = makeFetchStub([mintRoute, createRoute('foo', 1)]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
        workspaceFlag: STUB_WS,
      });
      assert.equal(result.ok, true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes to .imports.<env>.json when --env is set', async () => {
    const { dir, filePath } = setupTmp();
    try {
      const { fetch } = makeFetchStub([mintRoute, createRoute('foo', 1)]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
        envFlag: 'staging',
      });
      assert.equal(result.ok, true);
      assert.ok(existsSync(path.join(dir, '.imports.staging.json')));
      assert.equal(existsSync(path.join(dir, '.imports.json')), false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── validation / planId-stem / lockfile failures ────────────────────────
describe('plan-import — file/validation failures', () => {
  it('returns validation failure on a non-canonical file', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-import-test-'));
    try {
      // Non-canonical: extra blank lines, swapped fields
      writeFileSync(
        path.join(dir, 'foo.md'),
        '---\nname: X\nplanId: foo\nauthoringState: active\nfailurePolicy: pause-and-wait\nsteps: []\n---\n\n# x\n',
      );
      const { fetch } = makeFetchStub([]);
      const result = await runPlanImport({
        filePath: path.join(dir, 'foo.md'),
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'validation');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns planid_stem_mismatch when frontmatter planId differs from file stem', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-import-test-'));
    try {
      const { canonical } = buildPlanFile(); // planId: foo
      // But save it with a different stem
      const wrongStemPath = path.join(dir, 'bar.md');
      writeFileSync(wrongStemPath, canonical);
      const { fetch } = makeFetchStub([]);
      const result = await runPlanImport({
        filePath: wrongStemPath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'planid_stem_mismatch');
      assert.match(result.message, /'foo'/);
      assert.match(result.message, /'bar'/);
      assert.equal(exitCodeForFailure(result.kind), 64);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns usage failure when file path does not exist', async () => {
    const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-import-test-'));
    try {
      const { fetch } = makeFetchStub([]);
      const result = await runPlanImport({
        filePath: path.join(dir, 'does-not-exist.md'),
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'usage');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns lockfile failure when the lockfile is malformed', async () => {
    const { dir, filePath } = setupTmp();
    try {
      writeFileSync(path.join(dir, '.imports.json'), '{ malformed json');
      const { fetch } = makeFetchStub([mintRoute]);
      const result = await runPlanImport({
        filePath,
        plansDir: dir,
        fetchImpl: fetch,
        env: STUB_ENV,
        now: STUB_NOW,
      });
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'lockfile');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── exitCodeForFailure mapping ──────────────────────────────────────────
describe('plan-import — exitCodeForFailure', () => {
  it('maps usage-class failures to 64 and runtime-class failures to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('planid_stem_mismatch'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('validation'), 1);
    assert.equal(exitCodeForFailure('lockfile'), 1);
    assert.equal(exitCodeForFailure('diverged'), 1);
    assert.equal(exitCodeForFailure('conflict_no_force'), 1);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});
