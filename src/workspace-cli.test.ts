/**
 * `yolo workspace set-repository` — a thin client over
 * POST /v1/workspaces/:id/repository. Pinned: argument parsing (doc flags and
 * the card's aliases), that a preview sends no snapshot and --confirm sends it,
 * the user token on the /v1 route, and exit codes for refusals.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatSetRepository, parseSetRepositoryArgs, runSetRepository } from './workspace-cli.js';

const SNAP = 'c'.repeat(64);
const ENV = { SESSION_ID: 's-1', HOME: '/nonexistent-home', YOLO_API_TOKEN: 'user-jwt', YOLO_API_URL: 'http://api.test', WORKSPACE_ID: 'ws-1' };

function fakeFetch(status: number, body: unknown) {
  const calls: Array<{ url: string; init: { method?: string; headers: Record<string, string>; body?: string } }> = [];
  const impl = async (url: string, init: any) => {
    calls.push({ url, init });
    return { ok: status < 400, status, json: async () => body, text: async () => JSON.stringify(body) };
  };
  return { calls, impl: impl as never };
}

describe('parseSetRepositoryArgs', () => {
  it('takes the doc flags and the card aliases', () => {
    assert.deepEqual(parseSetRepositoryArgs(['https://github.com/o/r', '--branch', 'main', '--keep-old-as', 'old', '--auth=ssh']),
      { ok: true, url: 'https://github.com/o/r', json: false, defaultBranch: 'main', keepOldRemoteAs: 'old', authMethod: 'ssh' });
    const drop = parseSetRepositoryArgs(['u', '--drop-old-remote', '--confirm', SNAP]);
    assert.equal(drop.ok && drop.keepOldRemoteAs, null);
    assert.equal(drop.ok && drop.confirm, SNAP);
  });

  it('refuses what the route would refuse anyway, before any request', () => {
    assert.equal(parseSetRepositoryArgs([]).ok, false);
    assert.equal(parseSetRepositoryArgs(['u', '--confirm', 'abc']).ok, false);
    assert.equal(parseSetRepositoryArgs(['u', '--auth', 'git']).ok, false);
    assert.equal(parseSetRepositoryArgs(['u', '--keep-old-as', 'x', '--drop-old-remote']).ok, false);
    assert.equal(parseSetRepositoryArgs(['u', '--yes']).ok, false);
  });
});

describe('runSetRepository', () => {
  it('previews on the user-token /v1 route with no snapshot, and prints how to confirm', async () => {
    const fetch = fakeFetch(200, { applied: false, snapshot: SNAP, from: { url: 'https://git.yolo.studio/i/o.git' },
      to: { url: 'https://github.com/o/r.git', defaultBranch: 'main', authMethod: 'https' }, blockers: [], warnings: [],
      restart: { required: true, reason: 'host-change' } });
    const result = await runSetRepository({ url: 'https://github.com/o/r', json: false }, { env: ENV, fetchImpl: fetch.impl });
    assert.equal(result.code, 0);
    assert.equal(fetch.calls[0]!.url, 'http://api.test/v1/workspaces/ws-1/repository');
    assert.equal(fetch.calls[0]!.init.headers.Authorization, 'Bearer user-jwt');
    assert.deepEqual(JSON.parse(fetch.calls[0]!.init.body!), { url: 'https://github.com/o/r' });
    assert.match(result.stdout!, /Would switch: https:\/\/git\.yolo\.studio\/i\/o\.git → https:\/\/github\.com\/o\/r\.git/);
    assert.match(result.stdout!, new RegExp(`--confirm ${SNAP}`));
    assert.match(result.stdout!, /restart required/);
  });

  it('applies with --confirm and exits 1 on a refusal, listing the blockers', async () => {
    const fetch = fakeFetch(409, { ok: false, applied: false, code: 'blocked', error: 'The switch is blocked.',
      preview: { blockers: [{ code: 'workspace-dirty', message: 'uncommitted changes' }] } });
    const result = await runSetRepository({ url: 'u', confirm: SNAP, keepOldRemoteAs: null, json: false }, { env: ENV, fetchImpl: fetch.impl });
    assert.equal(result.code, 1);
    assert.deepEqual(JSON.parse(fetch.calls[0]!.init.body!), { url: 'u', keepOldRemoteAs: null, expectedSnapshot: SNAP });
    assert.match(result.stderr!, /Refused \(blocked\)/);
    assert.match(result.stderr!, /workspace-dirty/);
  });

  it('needs a workspace and a token', async () => {
    assert.equal((await runSetRepository({ url: 'u', json: false }, { env: { ...ENV, WORKSPACE_ID: '' } })).code, 64);
    assert.equal((await runSetRepository({ url: 'u', json: false }, { env: { ...ENV, YOLO_API_TOKEN: '' } })).code, 64);
  });

  it('a blocked preview says so instead of offering --confirm', () => {
    const out = formatSetRepository({ applied: false, snapshot: SNAP, blockers: [{ code: 'lane-running', message: 'Lane a is running' }] }, 'u');
    assert.match(out, /Blocked/);
    assert.doesNotMatch(out, /--confirm/);
  });
});
