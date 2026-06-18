/**
 * yolo tileapp init + publish --personal tests.
 *   - init scaffolds a renderable pure-UI app (tileapp.json + index.html)
 *   - publish --personal registers the manifest then uploads the bundle, in order
 *   - runtime apps build + mediated-push; surfaces HTTP / build failures
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
    const indexHtml = fs.readFileSync(path.join(cwd, 'my-widget', 'index.html'), 'utf-8');
    assert.ok(indexHtml.includes('index.html') || indexHtml.length > 0);
    // Scaffolds a separate app.js (CSP forbids inline <script>) + references it.
    assert.ok(fs.existsSync(path.join(cwd, 'my-widget', 'app.js')), 'app.js should be scaffolded');
    assert.match(indexHtml, /<script src="app\.js"/);
    // And surfaces the CSP constraint (no inline script / no eval) at scaffold time.
    assert.match(indexHtml, /script-src 'self'/);
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

describe('yolo tileapp publish --personal (runtime / mediated push)', () => {
  function scaffoldRuntime(): { cwd: string; manifestPath: string } {
    const cwd = tmpDir();
    const dir = path.join(cwd, 'rt');
    fs.mkdirSync(dir);
    const manifest = {
      id: 'svc', version: '1.0.0', displayName: 'Svc', publisher: 'personal',
      description: 'd', ui: { icon: 'x', color: '#fff', label: 'S' },
      surface: { kind: 'iframe', entry: 'index.html' },
      runtime: { port: 8080 }, permissions: { required: [] },
    };
    fs.writeFileSync(path.join(dir, 'tileapp.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    return { cwd, manifestPath: path.join(dir, 'tileapp.json') };
  }
  // Mock exec that creates the OCI archive on `podman save` (so the upload's
  // fs.createReadStream finds a real file).
  const writingExec = (calls?: string[][]) => async (file: string, args: string[]) => {
    if (calls) calls.push([file, ...args]);
    if (args[0] === 'save') { const out = args[args.indexOf('-o') + 1]; fs.writeFileSync(out, 'OCI-ARCHIVE-BYTES'); }
    return { code: 0, stderr: '' };
  };
  const DIGEST = 'sha256:' + 'a'.repeat(64);

  it('builds, saves an OCI archive, and streams it to the mediated publish-image endpoint', async () => {
    const { manifestPath } = scaffoldRuntime();
    const calls: string[][] = [];
    let posted: any;
    const fetchImpl = stubFetch((url, init) => {
      const hdr = (init?.headers as Record<string, string>)['x-tileapp-manifest'];
      posted = { url, ct: (init?.headers as Record<string, string>)['content-type'], meta: JSON.parse(Buffer.from(hdr, 'base64').toString('utf-8')) };
      // Real fetch consumes the stream body before resolving (so the caller's
      // unlink is safe); the stub doesn't, so drain + swallow to avoid a racey
      // ENOENT when the temp archive is unlinked mid-open.
      const body = init?.body as any;
      if (body && typeof body.on === 'function') { body.on('error', () => {}); body.resume?.(); }
      return { status: 201, body: { appId: 'pa-x-svc', ref: 'reg/owner/svc', tag: '1.0.0', digest: DIGEST } };
    });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl: writingExec(calls), fetchImpl });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.ok(calls.some((c) => c[0] === 'podman' && c[1] === 'build'), 'podman build called');
    assert.ok(calls.some((c) => c[0] === 'podman' && c[1] === 'save'), 'podman save called');
    assert.match(posted.url, /\/v1\/tileapps\/personal\/publish-image$/);
    assert.equal(posted.ct, 'application/octet-stream');
    assert.equal(posted.meta.id, 'svc');               // manifest travels in the header
    assert.equal(posted.meta.manifest.image, undefined); // image is server-computed
    assert.equal(posted.meta.manifest.runtime.port, 8080);
  });

  it('rejects a non-object manifest (JSON null) with a validation error, not a crash', async () => {
    const cwd = tmpDir();
    const p = path.join(cwd, 'tileapp.json');
    fs.writeFileSync(p, 'null');
    const r = await runTileAppPublishPersonal({ manifestPath: p, env: ENV, execImpl: writingExec(), fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'validation');
  });

  it('fails when the Dockerfile is missing', async () => {
    const { manifestPath } = scaffoldRuntime();
    fs.unlinkSync(path.join(path.dirname(manifestPath), 'Dockerfile'));
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl: writingExec(), fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'io');
  });

  it('surfaces a build failure', async () => {
    const { manifestPath } = scaffoldRuntime();
    const execImpl = async (_file: string, args: string[]) => (args[0] === 'build' ? { code: 1, stderr: 'boom' } : { code: 0, stderr: '' });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'io');
    assert.match((r as any).message, /build failed/);
  });
});
