/**
 * yolo tileapp init + publish --personal tests.
 *   - init scaffolds a renderable pure-UI app (tileapp.json + index.html)
 *   - publish --personal registers the manifest then uploads the bundle, in order
 *   - runtime apps build + mediated-push; surfaces HTTP / build failures
 *   - worker apps (runtime.kind 'worker') upload a bundle incl. _worker/, never build; --live
 * Uses an injected fetch + temp dirs; never touches the network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTileAppInit, runTileAppPublishPersonal, exitCodeForFailure, DYNAMIC_WORKERS_DISABLED_MESSAGE, collectBundleFiles, isBundleDocFile, installNextLines, workspaceIdOf } from './tileapp-personal.js';
import { validateManifest, isPersonalManifest } from './tileapp-validator.js';
import type { FetchLike } from './tileapp-personal.js';

const ENV = { YOLO_API_TOKEN_NONPROD: 'user-jwt', YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/nonexistent-home' };

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
    // CSS is a linked file: the scaffold keeps styling out of the page.
    assert.ok(fs.existsSync(path.join(cwd, 'my-widget', 'style.css')), 'style.css should be scaffolded');
    assert.match(indexHtml, /<link rel="stylesheet" href="style\.css"/);
    assert.doesNotMatch(indexHtml.replace(/<!--[\s\S]*?-->/g, ''), /<style[\s>]|\sstyle="/);
  });

  it('writes id but no publisher (the server stamps it), and no README into the published dir', () => {
    const cwd = tmpDir();
    assert.equal(runTileAppInit({ name: 'my-widget', cwd }).ok, true);
    const dir = path.join(cwd, 'my-widget');
    const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'tileapp.json'), 'utf-8'));
    assert.equal(manifest.id, 'my-widget');
    assert.equal('publisher' in manifest, false);
    assert.equal(isPersonalManifest(manifest), true);
    assert.deepEqual(validateManifest(manifest, { personal: true }).errors, []);
    // media/ exists (screenshots go there) but is empty: nothing to publish publicly.
    assert.deepEqual(fs.readdirSync(path.join(dir, 'media')), []);
    const all = fs.readdirSync(dir, { recursive: true }).map(String);
    assert.equal(all.some((f) => /readme|\.md$/i.test(f)), false, all.join(', '));
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

  it('pre-flight rejects an invalid runtime manifest (missing ui) BEFORE building', async () => {
    const cwd = tmpDir();
    const dir = path.join(cwd, 'rt');
    fs.mkdirSync(dir);
    // Runtime manifest missing the required `ui` block (the dogfood case).
    const manifest = {
      id: 'svc', version: '1.0.0', displayName: 'Svc', publisher: 'personal',
      description: 'd', surface: { kind: 'iframe', entry: 'index.html' },
      runtime: { port: 8080 }, permissions: { required: [] },
    };
    fs.writeFileSync(path.join(dir, 'tileapp.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    const calls: string[][] = [];
    const r = await runTileAppPublishPersonal({
      manifestPath: path.join(dir, 'tileapp.json'), env: ENV,
      execImpl: writingExec(calls), fetchImpl: stubFetch(() => ({ status: 201, body: {} })),
    });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'validation');
    assert.match((r as any).message, /ui must have/);
    // The expensive build/push must NOT have run.
    assert.equal(calls.length, 0);
  });

  it('pre-flight tolerates a runtime manifest with no `publisher` (server stamps it)', async () => {
    const cwd = tmpDir();
    const dir = path.join(cwd, 'rt');
    fs.mkdirSync(dir);
    const manifest = {
      id: 'svc', version: '1.0.0', displayName: 'Svc', // no publisher — server stamps it
      description: 'd', ui: { icon: 'x', color: '#fff', label: 'S' },
      surface: { kind: 'iframe', entry: 'index.html' },
      runtime: { port: 8080 }, permissions: { required: [] },
    };
    fs.writeFileSync(path.join(dir, 'tileapp.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    const calls: string[][] = [];
    const fetchImpl = stubFetch((url, init) => {
      const body = init?.body as any;
      if (body && typeof body.on === 'function') { body.on('error', () => {}); body.resume?.(); }
      return { status: 201, body: { appId: 'pa-x-svc', ref: 'reg/owner/svc', tag: '1.0.0', digest: DIGEST } };
    });
    const r = await runTileAppPublishPersonal({ manifestPath: path.join(dir, 'tileapp.json'), env: ENV, execImpl: writingExec(calls), fetchImpl, builder: 'podman' });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.ok(calls.some((c) => c[0] === 'podman' && c[1] === 'build'), 'build should have run despite no publisher');
  });

  it('pre-flight tolerates a runtime manifest with no `image` (server fills it)', async () => {
    // scaffoldRuntime's manifest omits image; the build proceeds (exec called).
    const { manifestPath } = scaffoldRuntime();
    const calls: string[][] = [];
    const fetchImpl = stubFetch((url, init) => {
      const body = init?.body as any;
      if (body && typeof body.on === 'function') { body.on('error', () => {}); body.resume?.(); }
      return { status: 201, body: { appId: 'pa-x-svc', ref: 'reg/owner/svc', tag: '1.0.0', digest: DIGEST } };
    });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl: writingExec(calls), fetchImpl, builder: 'podman' });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.ok(calls.some((c) => c[0] === 'podman' && c[1] === 'build'), 'build should have run');
  });

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
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl: writingExec(calls), fetchImpl, builder: 'podman' });
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
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl, fetchImpl: stubFetch(() => ({ status: 200, body: {} })), builder: 'podman' });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'io');
    assert.match((r as any).message, /build failed/);
  });

  it('auto builder routes a RUN-less Dockerfile to the skopeo assembler (not podman)', async () => {
    const { manifestPath } = scaffoldRuntime();
    // Use a real base so the assembler hits the skopeo PULL path (scratch skips it).
    fs.writeFileSync(path.join(path.dirname(manifestPath), 'Dockerfile'), 'FROM alpine:3\nCOPY . /app');
    const seen: string[] = [];
    // Fail at the skopeo base-pull so we bail early; we only care WHICH engine ran.
    const execImpl = async (file: string) => { seen.push(file); return { code: 1, stderr: 'pull failed' }; };
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, execImpl, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal(seen[0], 'skopeo', 'auto should use skopeo for a RUN-less Dockerfile');
    assert.ok(!seen.includes('podman'), 'podman must not be invoked');
    assert.match((r as any).message, /skopeo pull/);
  });

  it('--builder skopeo rejects a RUN-ful Dockerfile before any exec', async () => {
    const { manifestPath } = scaffoldRuntime();
    fs.writeFileSync(path.join(path.dirname(manifestPath), 'Dockerfile'), 'FROM alpine\nRUN apk add curl\nCOPY . /app');
    const seen: string[] = [];
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, builder: 'skopeo', execImpl: async (f) => { seen.push(f); return { code: 0, stderr: '' }; }, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'validation');
    assert.equal(seen.length, 0, 'no build engine should run for an unassemblable Dockerfile under --builder skopeo');
  });
});

describe("yolo tileapp publish --personal (runtime.kind 'worker')", () => {
  function scaffoldWorker(opts: { backend?: boolean; manifest?: Record<string, unknown> } = {}): { manifestPath: string } {
    const dir = path.join(tmpDir(), 'wk');
    fs.mkdirSync(dir);
    const manifest = {
      id: 'notes', version: '1.0.0', displayName: 'Notes', publisher: 'personal',
      description: 'd', ui: { icon: 'x', color: '#fff', label: 'N' },
      surface: { kind: 'iframe', entry: 'index.html' },
      runtime: { kind: 'worker', port: 8080 }, permissions: { required: [] },
      ...opts.manifest,
    };
    fs.writeFileSync(path.join(dir, 'tileapp.json'), JSON.stringify(manifest));
    fs.writeFileSync(path.join(dir, 'index.html'), '<!doctype html><script src="app.js" type="module"></script>');
    fs.writeFileSync(path.join(dir, 'app.js'), 'fetch("/api/hello")');
    // A Dockerfile alongside must not tempt the CLI into a container build.
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    if (opts.backend !== false) {
      fs.mkdirSync(path.join(dir, '_worker'));
      fs.writeFileSync(path.join(dir, '_worker', 'index.js'), 'export default { fetch() { return new Response("hi"); } };');
    }
    return { manifestPath: path.join(dir, 'tileapp.json') };
  }
  function recordingFetch(bundleResponse: { status: number; body: unknown }) {
    const calls: Array<{ url: string; method: string; body: any }> = [];
    const fetchImpl = stubFetch((url, init) => {
      calls.push({ url, method: String(init?.method), body: JSON.parse(String(init?.body)) });
      if (url.endsWith('/tileapps/personal')) return { status: 201, body: { appId: 'pa-abc-notes' } };
      return bundleResponse;
    });
    return { calls, fetchImpl };
  }
  const noExec = (seen: string[]) => async (file: string) => { seen.push(file); return { code: 0, stderr: '' }; };

  it('uploads a bundle that includes _worker/index.js, with no podman build and no live flag', async () => {
    const { manifestPath } = scaffoldWorker();
    const seen: string[] = [];
    const { calls, fetchImpl } = recordingFetch({ status: 200, body: { uploaded: 4, live: false, publish: { status: 'published', backend: true } } });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl, execImpl: noExec(seen) });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.equal(seen.length, 0, 'no build engine may run for a worker app');
    assert.equal(calls.length, 2);
    assert.equal(calls[0]!.body.manifest.runtime.kind, 'worker');
    assert.match(calls[1]!.url, /\/tileapps\/personal\/pa-abc-notes\/bundle$/);
    assert.equal(calls[1]!.method, 'PUT');
    const paths = calls[1]!.body.files.map((f: any) => f.path);
    assert.ok(paths.includes('_worker/index.js'), `bundle paths: ${paths.join(', ')}`);
    assert.ok(paths.includes('index.html'));
    assert.equal(calls[1]!.body.live, undefined);
    assert.match((r as any).output, /live: false/);
    assert.match((r as any).output, /publish: published \(backend: true\)/);
  });

  it('--live sends live: true and reports the Dynamic Workers backend', async () => {
    const { manifestPath } = scaffoldWorker();
    const { calls, fetchImpl } = recordingFetch({ status: 200, body: { uploaded: 4, live: true, publish: { status: 'published', backend: true } } });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl, execImpl: noExec([]), live: true });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.equal(calls[1]!.body.live, true);
    assert.match((r as any).output, /live: true/);
    assert.match((r as any).output, /Dynamic Workers/);
  });

  it('--live with Dynamic Workers off on the server says the backend went to a published version', async () => {
    const { manifestPath } = scaffoldWorker();
    const { fetchImpl } = recordingFetch({ status: 200, body: { live: false, publish: { status: 'published', backend: true } } });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl, live: true });
    assert.equal(r.ok, true);
    assert.match((r as any).output, /--live had no effect/);
  });

  it('maps HTTP 409 dynamic-workers-disabled to a clear message', async () => {
    const { manifestPath } = scaffoldWorker();
    const { fetchImpl } = recordingFetch({ status: 409, body: { ok: false, code: 'dynamic-workers-disabled', message: 'x' } });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl, live: true });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'http');
    assert.equal((r as any).message, DYNAMIC_WORKERS_DISABLED_MESSAGE);
    assert.match(DYNAMIC_WORKERS_DISABLED_MESSAGE, /publish without --live/);
  });

  it('fails when the server reports the worker backend was not published', async () => {
    const { manifestPath } = scaffoldWorker();
    const { fetchImpl } = recordingFetch({ status: 200, body: { live: false, publish: { status: 'failed', backend: false, error: 'the backend was not published: bad module' } } });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl });
    assert.equal(r.ok, false);
    assert.match((r as any).message, /bad module/);
  });

  it('refuses a worker bundle with no _worker/index.js before any server call', async () => {
    const { manifestPath } = scaffoldWorker({ backend: false });
    const { calls, fetchImpl } = recordingFetch({ status: 200, body: {} });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'validation');
    assert.match((r as any).message, /_worker\/index\.js/);
    assert.equal(calls.length, 0);
  });

  it('refuses an image or runtime.exec on a worker manifest (the server would ignore them)', async () => {
    const { manifestPath } = scaffoldWorker({ manifest: { runtime: { kind: 'worker', port: 8080, exec: 'node x.js' } } });
    const { calls, fetchImpl } = recordingFetch({ status: 200, body: {} });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl });
    assert.equal(r.ok, false);
    assert.match((r as any).message, /remove `runtime\.exec`/);
    assert.equal(calls.length, 0);
  });

  it('--live on a container runtime app is a usage error, and no build runs', async () => {
    const dir = path.join(tmpDir(), 'rt');
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'tileapp.json'), JSON.stringify({
      id: 'svc', version: '1.0.0', displayName: 'Svc', publisher: 'personal', description: 'd',
      ui: { icon: 'x', color: '#fff', label: 'S' }, surface: { kind: 'iframe', entry: 'index.html' },
      runtime: { port: 8080 }, permissions: { required: [] },
    }));
    fs.writeFileSync(path.join(dir, 'Dockerfile'), 'FROM scratch\n');
    const seen: string[] = [];
    const r = await runTileAppPublishPersonal({ manifestPath: path.join(dir, 'tileapp.json'), env: ENV, live: true, execImpl: noExec(seen), fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    assert.equal((r as any).kind, 'usage');
    assert.equal(seen.length, 0);
  });
});

describe('publish --personal bundle file filter', () => {
  function project(files: Record<string, string>, manifest: Record<string, unknown> = {}): { dir: string; manifestPath: string } {
    const dir = tmpDir();
    for (const [rel, body] of Object.entries(files)) {
      fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
      fs.writeFileSync(path.join(dir, rel), body);
    }
    const manifestPath = path.join(dir, 'tileapp.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      id: 'docs', version: '1.0.0', displayName: 'Docs', description: 'd',
      ui: { icon: 'x', color: '#fff', label: 'D' }, surface: { kind: 'iframe', entry: 'index.html' },
      permissions: { required: [] }, ...manifest,
    }));
    return { dir, manifestPath };
  }
  const paths = (r: ReturnType<typeof collectBundleFiles>) => (r.ok ? r.files.map((f) => f.path).sort() : []);

  it('classifies README* and *.md / *.markdown as docs, case-insensitively, at any depth', () => {
    for (const p of ['README', 'README.md', 'readme.txt', 'media/README.md', 'docs/Guide.MD', 'notes.markdown']) assert.equal(isBundleDocFile(p), true, p);
    for (const p of ['index.html', 'readme-widget.js', 'media/01.webp', 'md.js', 'app.mdx']) assert.equal(isBundleDocFile(p), false, p);
  });

  it('skips unreferenced docs and dotfiles, and reports the skipped docs', () => {
    const { dir, manifestPath } = project({
      'index.html': '<script src="app.js"></script>', 'app.js': '1', 'media/README.md': '# notes',
      'README.md': '# app', 'CHANGES.md': 'x', '.env': 'SECRET=1', 'sub/.hidden': 'x',
    });
    const r = collectBundleFiles(dir, manifestPath, { entry: 'index.html' });
    assert.equal(r.ok, true);
    assert.deepEqual(paths(r), ['app.js', 'index.html']);
    if (r.ok) assert.deepEqual(r.skipped, ['CHANGES.md', 'README.md', 'media/README.md']);
  });

  it('keeps a doc that is referenced by an uploaded file, named with --include, or is surface.entry', () => {
    const { dir, manifestPath } = project({
      'index.html': '<a href="docs/help.md">help</a>', 'docs/help.md': '# help',
      'media/README.md': '# notes', 'about.md': '# about',
    });
    const r = collectBundleFiles(dir, manifestPath, { entry: 'index.html', include: ['./media/README.md'] });
    assert.deepEqual(paths(r), ['docs/help.md', 'index.html', 'media/README.md']);
    if (r.ok) assert.deepEqual(r.skipped, ['about.md']);
    const asEntry = collectBundleFiles(dir, manifestPath, { entry: 'about.md' });
    assert.ok(paths(asEntry).includes('about.md'));
  });

  it('--include of a file that is not in the bundle dir fails', () => {
    const { dir, manifestPath } = project({ 'index.html': 'x' });
    const r = collectBundleFiles(dir, manifestPath, { include: ['nope.md'] });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /--include nope\.md/);
  });

  it('publish uploads none of the skipped docs and says which were skipped', async () => {
    const { manifestPath } = project({ 'index.html': '<p>hi</p>', 'media/README.md': '# notes' });
    let uploaded: string[] = [];
    const fetchImpl = stubFetch((url, init) => {
      if (url.endsWith('/tileapps/personal')) return { status: 201, body: { appId: 'pa-abc-docs' } };
      uploaded = JSON.parse(String(init?.body)).files.map((f: any) => f.path);
      return { status: 200, body: {} };
    });
    const r = await runTileAppPublishPersonal({ manifestPath, env: ENV, fetchImpl });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.deepEqual(uploaded, ['index.html']);
    assert.match((r as any).output, /skipped \(docs are not uploaded; --include <path> to upload one\): media\/README\.md/);
  });
});

describe('publish --personal: the workspace install after a new version', () => {
  const WS = 'a'.repeat(24);
  // A pod provisioned for the API it talks to (else $WORKSPACE_ID names nothing there).
  const envFile = path.join(tmpDir(), 'env');
  fs.writeFileSync(envFile, "export YOLO_COMMON_API_URL='https://api.example.com'\n");
  const POD_ENV = { ...ENV, SESSION_ID: 'b'.repeat(24), WORKSPACE_ID: WS, YOLO_ENV_FILE: envFile };

  it('workspaceIdOf: only in a pod, only a 24-hex id, only on the API the pod belongs to', () => {
    const none = () => undefined;
    assert.equal(workspaceIdOf(POD_ENV), WS);
    assert.equal(workspaceIdOf({ ...POD_ENV, SESSION_ID: '' }), undefined);
    assert.equal(workspaceIdOf({ ...POD_ENV, WORKSPACE_ID: 'nope' }), undefined);
    assert.equal(workspaceIdOf({ ...POD_ENV, YOLO_ENV_FILE: undefined }, none), undefined);
    assert.equal(workspaceIdOf({ SESSION_ID: 's', WORKSPACE_ID: WS }, none), WS); // production default
  });

  it('sends the pod workspace with the batch publish and reports a server-side upgrade, with no next command', async () => {
    const cwd = tmpDir();
    runTileAppInit({ name: 'clock', cwd });
    let sent: any;
    const fetchImpl = stubFetch((_url, init) => {
      sent = JSON.parse(String(init?.body));
      return { status: 200, body: { appId: 'pa-x-clock', bundle: {}, install: { status: 'upgraded', version: '1.0.1', refreshedTileIds: ['t1'] } } };
    });
    const r = await runTileAppPublishPersonal({ manifestPath: path.join(cwd, 'clock', 'tileapp.json'), env: POD_ENV, fetchImpl });
    assert.equal(r.ok, true, r.ok ? '' : (r as any).message);
    assert.equal(sent.workspaceId, WS);
    assert.match((r as any).output, /install moved to 1\.0\.1 \(1 open tile reloading\) — nothing else to run/);
    assert.doesNotMatch((r as any).output, /next:/);
  });

  it('no workspace id outside a pod', async () => {
    const cwd = tmpDir();
    runTileAppInit({ name: 'clock', cwd });
    const bodies: any[] = [];
    const fetchImpl = stubFetch((url, init) => {
      bodies.push(JSON.parse(String(init?.body)));
      return url.endsWith('/tileapps/personal') ? { status: 201, body: { appId: 'pa-x-clock' } } : { status: 200, body: {} };
    });
    await runTileAppPublishPersonal({ manifestPath: path.join(cwd, 'clock', 'tileapp.json'), env: { ...ENV, WORKSPACE_ID: WS }, fetchImpl });
    assert.equal(bodies.some((b) => 'workspaceId' in b), false);
  });

  it('installNextLines names exactly one command for each outcome', () => {
    const one = (status: any, extra = {}) => installNextLines('pa-x-clock', WS, { status, ...extra });
    assert.deepEqual(one('current'), ['  install: this workspace already runs this version — nothing else to run.']);
    assert.deepEqual(one('not-installed'), [`  next: yolo tileapp install pa-x-clock --workspace ${WS} && yolo tileapp add-tile pa-x-clock --workspace ${WS}`]);
    const re = one('reconsent-required', { newRequiredPermissions: ['net:api.example.com'] });
    assert.equal(re.length, 1);
    assert.match(re[0]!, new RegExp(`^  next: yolo tileapp install pa-x-clock --workspace ${WS} .*net:api\\.example\\.com`));
    const failed = one('failed', { error: 'HTTP 503' });
    assert.equal(failed.filter((l) => l.includes('next:')).length, 1);
    assert.match(installNextLines('pa-x-clock', undefined, undefined)[0]!, /--workspace <workspaceId>/);
  });
});
