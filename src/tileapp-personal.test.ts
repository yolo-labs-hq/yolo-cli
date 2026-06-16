/**
 * yolo tileapp init + publish --personal tests.
 *   - init scaffolds a renderable pure-UI app (tileapp.json + index.html)
 *   - publish --personal registers the manifest then uploads the bundle, in order
 *   - rejects a runtime manifest + a bad id; surfaces HTTP failures
 * Uses an injected fetch + temp dirs; never touches the network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTileAppInit, runTileAppPublishPersonal, exitCodeForFailure } from './tileapp-personal.js';
import type { FetchLike } from './tileapp-personal.js';

const ENV = { YOLO_API_TOKEN: 'user-jwt', YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/nonexistent-home' };

function tmpDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-personal-'));
}
function stubFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown }): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as FetchLike;
}

describe('yolo tileapp init', () => {
  it('scaffolds tileapp.json + index.html under ./<name>/', () => {
    const cwd = tmpDir();
    const r = runTileAppInit({ name: 'my-widget', cwd });
    assert.equal(r.ok, true);
    const manifest = JSON.parse(fs.readFileSync(path.join(cwd, 'my-widget', 'tileapp.json'), 'utf-8'));
    assert.equal(manifest.id, 'my-widget');
    assert.equal(manifest.surface.entry, 'index.html');
    assert.ok(fs.existsSync(path.join(cwd, 'my-widget', 'index.html')));
  });

  it('rejects a bad name and an existing dir', () => {
    const cwd = tmpDir();
    assert.equal((runTileAppInit({ name: 'Bad Name', cwd }) as any).kind, 'usage');
    runTileAppInit({ name: 'dup', cwd });
    assert.equal((runTileAppInit({ name: 'dup', cwd }) as any).kind, 'io');
  });
});

describe('yolo tileapp publish --personal', () => {
  function scaffold(): { cwd: string; manifestPath: string } {
    const cwd = tmpDir();
    runTileAppInit({ name: 'clock', cwd });
    return { cwd, manifestPath: path.join(cwd, 'clock', 'tileapp.json') };
  }

  it('registers the manifest then uploads the bundle, in order', async () => {
    const { manifestPath } = scaffold();
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = stubFetch((url, init) => {
      calls.push({ url, method: String(init?.method), body: JSON.parse(String(init?.body)) });
      if (url.endsWith('/tileapps/personal')) return { status: 201, body: { appId: 'pa-abc-clock', created: true } };
      return { status: 200, body: { uploaded: 1 } };
    });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.equal(calls.length, 2);
    assert.match(calls[0]!.url, /\/v1\/tileapps\/personal$/);
    assert.equal(calls[0]!.method, 'POST');
    assert.equal(calls[0]!.body.id, 'clock');
    assert.match(calls[1]!.url, /\/v1\/tileapps\/personal\/pa-abc-clock\/bundle$/);
    assert.equal(calls[1]!.method, 'PUT');
    // index.html is text → utf8 encoding, uploaded as a bundle file.
    const f = calls[1]!.body.files.find((x: any) => x.path === 'index.html');
    assert.ok(f);
    assert.equal(f.encoding, 'utf8');
  });

  it('rejects a runtime manifest (personal is pure-UI only today)', async () => {
    const { manifestPath } = scaffold();
    const m = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
    m.runtime = { port: 8080 };
    m.image = { ref: 'r/x', tag: '1' };
    fs.writeFileSync(manifestPath, JSON.stringify(m));
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'validation');
  });

  it('surfaces an HTTP error from the register call', async () => {
    const { manifestPath } = scaffold();
    const fetchImpl = stubFetch(() => ({ status: 403, body: 'forbidden' }));
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'http');
    assert.equal(exitCodeForFailure((r as any).kind), 1);
  });

  it('fails auth when no user token is present', async () => {
    const { manifestPath } = scaffold();
    const r = await runTileAppPublishPersonal({ manifestPath, env: { YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/nonexistent-home' } });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'auth');
  });
});
