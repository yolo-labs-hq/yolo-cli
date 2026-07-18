/**
 * tileapp-workspace tests — `yolo tileapp install` + `yolo tileapp add-tile`.
 *
 * Coverage:
 *   install:
 *     - happy path posts { workspaceId } and prints granted permissions
 *     - --accept-optional values ride as acceptedOptional
 *     - HTTP failure surfaces status + body
 *     - missing auth env → auth failure (no network)
 *   add-tile:
 *     - ALWAYS preflights app existence + workspace grant (even with explicit
 *       --version/--name) before creating the tile
 *     - omitted version/name defaults from GET /tileapps/:appId
 *     - generated tile id is app-<slug>-<suffix> and rides in the POST body
 *     - manifest 404 → "not found" failure, no tile POST
 *     - no grant in the workspace → "not installed" failure w/ install hint
 *     - manifest missing app.version → http failure with a --version hint
 *     - HTTP failure on the tiles POST surfaces status
 *   exitCodeForFailure mapping
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runTileAppInstall,
  runTileAppAddTile,
  generateTileId,
  exitCodeForFailure,
  type FetchLike,
} from './tileapp-workspace.js';

const STUB_ENV = {
  HOME: '/nonexistent-yolo-cli-test-home',
  YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};
const WS = '507f1f77bcf86cd799439011';

interface Call { url: string; method: string; body?: unknown }

function makeFetchStub(
  respond: (url: string, method: string) => { ok: boolean; status: number; body: unknown },
  calls: Call[] = [],
): FetchLike {
  return (async (url: string, init: { method?: string; body?: string } = {}) => {
    const method = init.method ?? 'GET';
    calls.push({ url, method, body: init.body ? JSON.parse(init.body) : undefined });
    const r = respond(url, method);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => r.body,
      text: async () => JSON.stringify(r.body),
    };
  }) as unknown as FetchLike;
}

describe('runTileAppInstall', () => {
  it('posts the grant and prints granted permissions', async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetchStub(() => ({
      ok: true,
      status: 200,
      body: { installed: true, grant: { appId: 'notes', version: '1.2.0', releaseId: null, grantedPermissions: ['llm:complete', 'storage:kv'] } },
    }), calls);

    const result = await runTileAppInstall({ appId: 'notes', workspaceId: WS, env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Installed notes@1\.2\.0 into workspace 507f/);
    assert.match(result.output, /- llm:complete/);
    assert.match(result.output, /- storage:kv/);

    assert.equal(calls.length, 1);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/tileapps/notes/install');
    assert.deepEqual(calls[0]!.body, { workspaceId: WS });
  });

  it('forwards --accept-optional values as acceptedOptional', async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetchStub(() => ({
      ok: true,
      status: 200,
      body: { installed: true, grant: { appId: 'notes', version: '1.0.0', grantedPermissions: [] } },
    }), calls);

    const result = await runTileAppInstall({
      appId: 'notes', workspaceId: WS, acceptOptional: ['net:example.com', 'llm:complete'], env: STUB_ENV, fetchImpl,
    });
    assert.equal(result.ok, true);
    assert.deepEqual(calls[0]!.body, { workspaceId: WS, acceptedOptional: ['net:example.com', 'llm:complete'] });
    if (result.ok) assert.match(result.output, /\(none\)/);
  });

  it('surfaces an HTTP failure with status + body', async () => {
    const fetchImpl = makeFetchStub(() => ({ ok: false, status: 403, body: { error: 'workspace access denied' } }));
    const result = await runTileAppInstall({ appId: 'notes', workspaceId: WS, env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.match(result.message, /HTTP 403/);
    assert.match(result.message, /workspace access denied/);
  });

  it('fails auth (no network) when no token is available', async () => {
    const fetchImpl = makeFetchStub(() => { throw new Error('must not be called'); });
    const result = await runTileAppInstall({
      appId: 'notes', workspaceId: WS, env: { HOME: STUB_ENV.HOME, YOLO_COMMON_API_URL: STUB_ENV.YOLO_COMMON_API_URL }, fetchImpl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'auth');
  });
});

/** Route the three add-tile legs: manifest GET, installed GET, tiles POST. */
function addTileRoutes(overrides: {
  manifest?: { ok: boolean; status: number; body: unknown };
  installed?: { ok: boolean; status: number; body: unknown };
  tiles?: { ok: boolean; status: number; body: unknown };
} = {}) {
  return (url: string, method: string): { ok: boolean; status: number; body: unknown } => {
    if (method === 'GET' && url.includes('/tileapps/installed')) {
      return overrides.installed ?? { ok: true, status: 200, body: { installed: [{ appId: 'notes', version: '1.0.0' }] } };
    }
    if (method === 'GET' && url.includes('/tileapps/')) {
      return overrides.manifest ?? { ok: true, status: 200, body: { app: { id: 'notes', version: '3.1.4', displayName: 'Notes App' } } };
    }
    return overrides.tiles ?? { ok: true, status: 201, body: { workspace: {} } };
  };
}

describe('runTileAppAddTile', () => {
  it('ALWAYS preflights app existence + grant, even with explicit --version and --name', async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetchStub(addTileRoutes(), calls);

    const result = await runTileAppAddTile({
      appId: 'notes', workspaceId: WS, name: 'My Notes', version: '2.0.0',
      env: STUB_ENV, fetchImpl, idSuffixImpl: () => 'abc123',
    });
    assert.equal(result.ok, true);
    // manifest GET → installed GET → tiles POST, in that order.
    assert.equal(calls.length, 3);
    assert.equal(calls[0]!.url, 'https://api.example.com/v1/tileapps/notes');
    assert.equal(calls[1]!.url, `https://api.example.com/v1/tileapps/installed?workspaceId=${WS}`);
    assert.equal(calls[2]!.url, `https://api.example.com/v1/workspaces/${WS}/tiles`);
    assert.equal(calls[2]!.method, 'POST');
    assert.deepEqual(calls[2]!.body, {
      id: 'app-notes-abc123',
      type: 'app',
      name: 'My Notes',
      app: { appId: 'notes', version: '2.0.0' },
    });
    if (result.ok) assert.match(result.output, /Added app tile app-notes-abc123 \(notes@2\.0\.0/);
  });

  it('defaults version + displayName from GET /tileapps/:appId when omitted', async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetchStub(addTileRoutes(), calls);

    const result = await runTileAppAddTile({
      appId: 'notes', workspaceId: WS, env: STUB_ENV, fetchImpl, idSuffixImpl: () => 'zzz999',
    });
    assert.equal(result.ok, true);
    assert.equal(calls.length, 3);
    assert.deepEqual(calls[2]!.body, {
      id: 'app-notes-zzz999',
      type: 'app',
      name: 'Notes App',
      app: { appId: 'notes', version: '3.1.4' },
    });
  });

  it('fails "not found" (no tile POST) when the app does not exist', async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetchStub(addTileRoutes({
      manifest: { ok: false, status: 404, body: { error: 'tile app not found' } },
    }), calls);
    const result = await runTileAppAddTile({
      appId: 'ghost', workspaceId: WS, name: 'G', version: '1.0.0', env: STUB_ENV, fetchImpl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'http');
      assert.match(result.message, /app 'ghost' not found/);
    }
    // Failed at the first preflight — nothing else was called.
    assert.equal(calls.length, 1);
  });

  it('fails "not installed" with an install hint (no tile POST) when the workspace has no grant', async () => {
    const calls: Call[] = [];
    const fetchImpl = makeFetchStub(addTileRoutes({
      installed: { ok: true, status: 200, body: { installed: [{ appId: 'other-app' }] } },
    }), calls);
    const result = await runTileAppAddTile({
      appId: 'notes', workspaceId: WS, name: 'N', version: '1.0.0', env: STUB_ENV, fetchImpl,
    });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'http');
      assert.match(result.message, /not installed in this workspace/);
      assert.match(result.message, new RegExp(`yolo tileapp install notes --workspace ${WS}`));
    }
    // manifest + installed only — the tile was never created.
    assert.equal(calls.length, 2);
  });

  it('fails with a --version hint when the manifest has no version', async () => {
    const fetchImpl = makeFetchStub(addTileRoutes({
      manifest: { ok: true, status: 200, body: { app: { id: 'notes' } } },
    }));
    const result = await runTileAppAddTile({ appId: 'notes', workspaceId: WS, env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'http');
      assert.match(result.message, /--version/);
    }
  });

  it('surfaces a tiles-POST failure', async () => {
    const fetchImpl = makeFetchStub(addTileRoutes({
      tiles: { ok: false, status: 400, body: { error: 'Tile id, type, and name are required' } },
    }));
    const result = await runTileAppAddTile({ appId: 'notes', workspaceId: WS, env: STUB_ENV, fetchImpl });
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'http');
      assert.match(result.message, /HTTP 400/);
    }
  });
});

describe('generateTileId', () => {
  it('slugs the appId and appends the suffix', () => {
    assert.equal(generateTileId('personal.owner.my-app', () => 'x1y2z3'), 'app-personal-owner-my-app-x1y2z3');
  });

  it('uses a random 6-char suffix by default', () => {
    assert.match(generateTileId('notes'), /^app-notes-[a-z0-9]{1,8}$/);
  });
});

describe('exitCodeForFailure', () => {
  it('maps http → 1, usage/auth → 64', () => {
    assert.equal(exitCodeForFailure('http'), 1);
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
  });
});
