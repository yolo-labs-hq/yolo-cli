/**
 * `yolo tileapp media push` — the ADDITIVE screenshot upload.
 *
 * Two behaviours here were shipped broken and caught in review, so both are
 * pinned:
 *   - the personal-app list returns `{ appId, localId }`, never `{ id }`.
 *     Reading the wrong field made EVERY invocation report "no published app"
 *     before it uploaded anything — the command never worked at all.
 *   - uploading bytes alone leaves the screenshot invisible, because the store
 *     renders from the STORED manifest. The command must re-register the
 *     manifest (manifest-only, never the bundle) or it accomplishes nothing.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { runTileAppMediaPush } from './tileapp-personal.js';

const ENV = { YOLO_COMMON_API_URL: 'https://api.test', YOLO_API_TOKEN: 't0ken' };

/** A 1×1 png — the server validates pixels, these tests validate wiring. */
const PNG = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
);

function project(opts: { withMedia?: boolean; manifest?: unknown } = {}): { dir: string; manifestPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mediapush-'));
  // `??` would treat an intentional `null` as absent, so key off presence.
  const manifest = 'manifest' in opts ? opts.manifest : { id: 'demo', version: '1.0.0', displayName: 'Demo' };
  const manifestPath = path.join(dir, 'tileapp.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  if (opts.withMedia !== false) {
    fs.mkdirSync(path.join(dir, 'media'));
    fs.writeFileSync(path.join(dir, 'media', '01-main.png'), PNG);
    // Scaffolded by `init` and NOT a screenshot — must be skipped.
    fs.writeFileSync(path.join(dir, 'media', 'README.md'), '# notes');
  }
  return { dir, manifestPath };
}

interface Call { url: string; method: string; body: unknown }

function stubFetch(calls: Call[], listApps: unknown[]) {
  return async (url: string, init?: { method?: string; body?: string }) => {
    const method = init?.method ?? 'GET';
    calls.push({ url, method, body: init?.body ? JSON.parse(init.body) : undefined });
    if (url.endsWith('/tileapps/personal') && method === 'GET') {
      return { ok: true, status: 200, json: async () => ({ apps: listApps }), text: async () => '' };
    }
    if (url.includes('/media') && method === 'POST') {
      return {
        ok: true, status: 200, text: async () => '',
        json: async () => ({ ok: true, files: [{ ref: 'media/01-main.png', width: 1280, height: 800 }] }),
      };
    }
    if (url.endsWith('/tileapps/personal') && method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ appId: 'pa-o-demo' }), text: async () => '' };
    }
    return { ok: false, status: 404, json: async () => ({}), text: async () => 'unexpected' };
  };
}

describe('yolo tileapp media push', () => {
  it('resolves the appId from localId (not the absent `id` field)', async () => {
    const { manifestPath } = project();
    const calls: Call[] = [];
    const res = await runTileAppMediaPush({
      manifestPath,
      fetchImpl: stubFetch(calls, [{ appId: 'pa-owner-demo', localId: 'demo', manifest: { version: '1.0.0' } }]) as never,
      env: ENV,
    });
    assert.equal(res.ok, true, res.ok ? '' : res.message);
    const upload = calls.find((c) => c.url.includes('/media'));
    assert.ok(upload, 'should have posted to the media route');
    assert.match(upload.url, /pa-owner-demo/);
  });

  it('uploads only image files, skipping the scaffolded README', async () => {
    const { manifestPath } = project();
    const calls: Call[] = [];
    await runTileAppMediaPush({
      manifestPath,
      fetchImpl: stubFetch(calls, [{ appId: 'pa-owner-demo', localId: 'demo', manifest: {} }]) as never,
      env: ENV,
    });
    const upload = calls.find((c) => c.url.includes('/media'))!;
    const names = (upload.body as { files: Array<{ name: string }> }).files.map((f) => f.name);
    assert.deepEqual(names, ['01-main.png']);
  });

  it('re-registers the manifest so the screenshot is actually visible', async () => {
    const { manifestPath } = project();
    const calls: Call[] = [];
    await runTileAppMediaPush({
      manifestPath,
      fetchImpl: stubFetch(calls, [{ appId: 'pa-owner-demo', localId: 'demo', manifest: { version: '2.0.0' } }]) as never,
      env: ENV,
    });
    const register = calls.find((c) => c.url.endsWith('/tileapps/personal') && c.method === 'POST');
    assert.ok(register, 'must re-register the manifest — uploading bytes alone renders nothing');
    const body = register.body as { id: string; manifest: Record<string, unknown> };
    assert.equal(body.id, 'demo');
    assert.deepEqual(body.manifest.screenshots, ['media/01-main.png']);
    // Merged onto the STORED manifest, so unrelated fields survive.
    assert.equal(body.manifest.version, '2.0.0');
    // Manifest-only: it must never touch the bundle route.
    assert.ok(!calls.some((c) => c.url.includes('/bundle')), 'must not replace the bundle');
  });

  it('merges with existing refs instead of clobbering them', async () => {
    const { manifestPath } = project();
    const calls: Call[] = [];
    await runTileAppMediaPush({
      manifestPath,
      fetchImpl: stubFetch(calls, [
        { appId: 'pa-owner-demo', localId: 'demo', manifest: { screenshots: ['https://cdn/old.webp'] } },
      ]) as never,
      env: ENV,
    });
    const register = calls.find((c) => c.url.endsWith('/tileapps/personal') && c.method === 'POST')!;
    assert.deepEqual((register.body as { manifest: { screenshots: string[] } }).manifest.screenshots, [
      'https://cdn/old.webp',
      'media/01-main.png',
    ]);
  });

  it('fails clearly when no published app matches', async () => {
    const { manifestPath } = project();
    const res = await runTileAppMediaPush({
      manifestPath,
      fetchImpl: stubFetch([], [{ appId: 'pa-owner-other', localId: 'other', manifest: {} }]) as never,
      env: ENV,
    });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /no published personal app/);
  });

  it('reports a missing media directory rather than throwing', async () => {
    const { manifestPath } = project({ withMedia: false });
    const res = await runTileAppMediaPush({ manifestPath, fetchImpl: stubFetch([], []) as never, env: ENV });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /no media directory/);
  });

  it('rejects a JSON null manifest instead of throwing a TypeError', async () => {
    const { manifestPath } = project({ manifest: null, withMedia: false });
    const res = await runTileAppMediaPush({ manifestPath, fetchImpl: stubFetch([], []) as never, env: ENV });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /must be a JSON object/);
  });
});
