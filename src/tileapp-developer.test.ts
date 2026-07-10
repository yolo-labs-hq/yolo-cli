/**
 * `yolo tileapp validate|dev` — the local developer harness (M1 slice 6).
 *   - validateManifest mirrors the server taxonomy (collect-all errors);
 *   - resolveBundleDir finds surface.entry across the candidate layouts;
 *   - runTileAppValidate gates on schema + bundle, skips bundle for runtime apps;
 *   - the dev server mounts the mock broker + manifest routes and serves the bundle.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import * as http from 'node:http';
import { validateManifest, parsePermissionShape, isRuntimeManifest } from './tileapp-validator.js';
import {
  resolveBundleDir, mockBrokerResponse, runTileAppValidate, createDevHandler,
  DEV_BROKER_PATH, DEV_MANIFEST_PATH,
} from './tileapp-developer.js';

const MANIFEST = (over: Record<string, unknown> = {}): Record<string, unknown> => ({
  id: 'demo', version: '1.0.0', displayName: 'Demo', publisher: 'acme', description: 'x',
  ui: { icon: 'a', color: '#fff', label: 'A' },
  surface: { kind: 'iframe', entry: 'index.html' },
  permissions: { required: [] },
  ...over,
});

function tmpProject(manifest: Record<string, unknown>, opts: { withEntry?: boolean } = {}): { dir: string; manifestPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tileapp-dev-'));
  const manifestPath = path.join(dir, 'manifest.json');
  fs.writeFileSync(manifestPath, JSON.stringify(manifest));
  if (opts.withEntry !== false) {
    const bundle = path.join(dir, 'bundles', String(manifest.id));
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(bundle, 'index.html'), '<h1>hi</h1>');
  }
  return { dir, manifestPath };
}

describe('tileapp-validator', () => {
  it('a clean pure-UI manifest validates', () => {
    assert.deepEqual(validateManifest(MANIFEST()), { ok: true, errors: [] });
  });

  it('collects every error at once', () => {
    const v = validateManifest({ id: 'BAD ID', version: 'nope', surface: { kind: 'canvas' } });
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('kebab-case')));
    assert.ok(v.errors.some((e) => e.includes('semver')));
    assert.ok(v.errors.some((e) => e.includes("surface.kind must be 'iframe'")));
    assert.ok(v.errors.length >= 4);
  });

  it('rejects a wildcard net permission + an unrecognized permission', () => {
    const v = validateManifest(MANIFEST({ permissions: { required: ['net:*', 'bogus:thing'] } }));
    assert.equal(v.ok, false);
    assert.ok(v.errors.some((e) => e.includes('no wildcards')));
    assert.ok(v.errors.some((e) => e.includes("unrecognized permission: 'bogus:thing'")));
  });

  it('accepts well-formed mcp/secret shapes (membership is server-side)', () => {
    const v = validateManifest(MANIFEST({ permissions: { required: ['mcp:studio.get_workspace_context', 'secret:OPENAI_API_KEY', 'fs.read:workspace', 'net:api.example.com'] } }));
    assert.deepEqual(v, { ok: true, errors: [] });
  });

  it('parsePermissionShape decomposes namespaces and rejects junk', () => {
    assert.equal(parsePermissionShape('fs.read:workspace')?.namespace, 'fs');
    assert.equal(parsePermissionShape('llm.invoke:claude')?.action, 'invoke');
    // Bare provider-agnostic llm.invoke parses (arg optional).
    assert.equal(parsePermissionShape('llm.invoke')?.namespace, 'llm');
    assert.equal(parsePermissionShape('llm.invoke')?.arg, undefined);
    assert.equal(parsePermissionShape('fs.delete:x'), null);
    assert.equal(parsePermissionShape(''), null);
  });

  it('isRuntimeManifest is keyed on `runtime` only — image-only is pure-UI', () => {
    assert.equal(isRuntimeManifest(MANIFEST()), false);
    // image WITHOUT runtime → pure-UI in production (launcher serves the static
    // surface), so NOT runtime here.
    assert.equal(isRuntimeManifest(MANIFEST({ image: { ref: 'r/x', tag: '1' } })), false);
    assert.equal(isRuntimeManifest(MANIFEST({ runtime: { port: 7000 }, image: { ref: 'r/x', tag: '1' } })), true);
  });
});

describe('resolveBundleDir', () => {
  it('finds the registry-layout bundle (bundles/<id>/index.html)', () => {
    const { manifestPath } = tmpProject(MANIFEST());
    const r = resolveBundleDir(manifestPath, MANIFEST());
    assert.equal(r.ok, true);
  });

  it('errors with the candidate list when the entry is missing', () => {
    const { manifestPath } = tmpProject(MANIFEST(), { withEntry: false });
    const r = resolveBundleDir(manifestPath, MANIFEST());
    assert.equal(r.ok, false);
    if (!r.ok) assert.ok(r.message.includes('index.html'));
  });

  it('rejects a DIRECTORY entry (production serves a file, not a dir)', () => {
    const m = MANIFEST({ surface: { kind: 'iframe', entry: 'dist' } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tileapp-dev-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    fs.mkdirSync(path.join(dir, 'bundles', 'demo', 'dist'), { recursive: true }); // entry is a DIR
    const r = resolveBundleDir(path.join(dir, 'manifest.json'), m);
    assert.equal(r.ok, false);
  });

  it('an explicit --bundle-dir is the ONLY candidate — no silent fallback', () => {
    const { manifestPath, dir } = tmpProject(MANIFEST()); // has bundles/demo/index.html
    const emptyDir = path.join(dir, 'empty');
    fs.mkdirSync(emptyDir);
    // override points at an empty dir → must FAIL, not fall back to bundles/demo.
    const r = resolveBundleDir(manifestPath, MANIFEST(), emptyDir);
    assert.equal(r.ok, false);
    if (!r.ok) assert.deepEqual(r.candidates, [emptyDir]); // only the override was tried
  });

  it('rejects an entry that ESCAPES the bundle dir with `..` (production 403s)', () => {
    const m = MANIFEST({ surface: { kind: 'iframe', entry: '../escape.html' } });
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tileapp-dev-'));
    fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(m));
    const bundle = path.join(dir, 'bundles', 'demo');
    fs.mkdirSync(bundle, { recursive: true });
    fs.writeFileSync(path.join(dir, 'bundles', 'escape.html'), 'x'); // sits one level UP from the bundle root
    const r = resolveBundleDir(path.join(dir, 'manifest.json'), m);
    assert.equal(r.ok, false); // the `..` entry escapes bundles/demo → refused
  });
});

describe('runTileAppValidate', () => {
  it('OK for a clean pure-UI project with its bundle', () => {
    const { manifestPath } = tmpProject(MANIFEST());
    const r = runTileAppValidate({ manifestPath });
    assert.equal(r.ok, true);
  });

  it('validation failure (kind=validation) when the bundle entry is missing', () => {
    const { manifestPath } = tmpProject(MANIFEST(), { withEntry: false });
    const r = runTileAppValidate({ manifestPath });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, 'validation');
  });

  const DIGEST = 'sha256:' + 'a'.repeat(64);

  it('skips the bundle check for a digest-pinned runtime app (has `runtime`)', () => {
    const { manifestPath } = tmpProject(MANIFEST({ runtime: { port: 7000 }, image: { ref: 'r/x', tag: '1.0.0', digest: DIGEST } }), { withEntry: false });
    const r = runTileAppValidate({ manifestPath });
    assert.equal(r.ok, true); // no local bundle required for a container app
  });

  it('a runtime app WITHOUT a pinned image.digest fails (mirrors publish DIGEST_REQUIRED)', () => {
    const { manifestPath } = tmpProject(MANIFEST({ runtime: { port: 7000 }, image: { ref: 'r/x', tag: '1.0.0' } }), { withEntry: false });
    const r = runTileAppValidate({ manifestPath });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.kind, 'validation'); assert.ok(r.message.includes('content digest')); }
  });

  it('STILL bundle-checks an image-only manifest (no runtime = pure-UI in prod)', () => {
    const { manifestPath } = tmpProject(MANIFEST({ image: { ref: 'r/x', tag: '1.0.0', digest: DIGEST } }), { withEntry: false });
    const r = runTileAppValidate({ manifestPath });
    assert.equal(r.ok, false); // image-only is served as a static surface → needs the bundle
    if (!r.ok) assert.equal(r.kind, 'validation');
  });

  it('io failure for a missing manifest file', () => {
    const r = runTileAppValidate({ manifestPath: '/nope/manifest.json' });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, 'io');
  });

  it('a top-level non-object manifest (null) is a validation failure, not a crash', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tileapp-dev-'));
    const manifestPath = path.join(dir, 'manifest.json');
    fs.writeFileSync(manifestPath, 'null');
    const r = runTileAppValidate({ manifestPath });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.kind, 'validation'); assert.ok(r.message.includes('not an object')); }
  });
});

describe('mockBrokerResponse', () => {
  it('allows by default with the production BrokerResult shape (ok+payload, 200)', () => {
    const r = mockBrokerResponse({ permission: 'net:x' }, { allow: true });
    assert.equal(r.httpStatus, 200);
    assert.deepEqual(r.result, { ok: true, payload: { echo: { permission: 'net:x' } } });
  });
  it('denies with ok:false + reason + 403 when allow=false', () => {
    const r = mockBrokerResponse(null, { allow: false });
    assert.equal(r.httpStatus, 403);
    assert.equal(r.result.ok, false);
    if (!r.result.ok) assert.equal(r.result.reason, 'permission-not-granted');
  });
});

describe('createDevHandler (server)', () => {
  it('serves the bundle, the mock broker, and the manifest', async () => {
    const { dir } = tmpProject(MANIFEST());
    const bundleDir = path.join(dir, 'bundles', 'demo');
    const server = http.createServer(createDevHandler({ dir: bundleDir, manifest: MANIFEST(), allow: true }));
    await new Promise<void>((res) => server.listen(0, '127.0.0.1', res));
    const addr = server.address() as { port: number };
    const base = `http://127.0.0.1:${addr.port}`;
    try {
      const html = await fetch(`${base}/index.html`).then((r) => r.text());
      assert.ok(html.includes('<h1>hi</h1>'));

      const manifest = await fetch(`${base}${DEV_MANIFEST_PATH}`).then((r) => r.json()) as { id: string };
      assert.equal(manifest.id, 'demo');

      const brokerRes = await fetch(`${base}${DEV_BROKER_PATH}`, { method: 'POST', body: JSON.stringify({ permission: 'net:api.x' }) });
      assert.equal(brokerRes.status, 200);
      const broker = await brokerRes.json() as { ok: boolean; payload: { echo: unknown } };
      assert.equal(broker.ok, true);
      assert.deepEqual(broker.payload.echo, { permission: 'net:api.x' });

      const getBroker = await fetch(`${base}${DEV_BROKER_PATH}`);
      assert.equal(getBroker.status, 405); // POST only
    } finally {
      await new Promise<void>((res) => server.close(() => res()));
    }
  });
});
