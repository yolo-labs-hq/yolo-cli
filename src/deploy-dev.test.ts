/**
 * Tests for `yolo deploy dev` (deploy-dev.ts) — the pure config→miniflare
 * mapping and the orchestrator's serve/failure paths (server start + SIGINT wait
 * are seamed, so no workerd is launched here; the real end-to-end run is
 * exercised manually).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { mkdtempSync, writeFileSync, mkdirSync, existsSync, readFileSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  buildMiniflareInit,
  stageProdAssets,
  runDeployDev,
  DEV_COMPATIBILITY_DATE,
  type DevIo,
  type MiniflareInit,
} from './deploy-dev.js';
import type { ProjectShape } from './deploy-detect.js';
import type { BundleAsset, BundleResult } from './deploy-bundle.js';

function makeIo(): DevIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
}

const CONFIG_PATH = '/proj/.yolo/deploy.json';
const linked = (config: unknown) => ({ ok: true as const, config, path: CONFIG_PATH, warnings: [] });

function fakeBundle(opts: { moduleText?: string | null; assets?: BundleAsset[]; type?: 'worker' | 'static'; warnings?: string[] } = {}): BundleResult {
  const moduleText = opts.moduleText;
  const module = moduleText == null ? null : { name: 'index.js', contents: new TextEncoder().encode(moduleText) };
  return {
    ok: true,
    type: opts.type ?? 'worker',
    manifest: {},
    assetPaths: {},
    assets: opts.assets ?? [],
    module,
    workerModules: module ? [module] : [],
    moduleSource: module ? 'esbuild' : null,
    fileCount: 0,
    totalAssetBytes: 0,
    bundleDigest: 'sha256:deadbeef',
    warnings: opts.warnings ?? [],
  };
}

describe('deploy-dev — buildMiniflareInit (config → miniflare mapping)', () => {
  it('maps deploy.json bindings onto local kv/d1/r2 + pins the server compat date', () => {
    const init = buildMiniflareInit({
      config: {
        $version: 1,
        projectId: 'hp_1',
        compatibilityFlags: ['nodejs_compat'],
        bindings: [
          { kind: 'kv', binding: 'CACHE' },
          { kind: 'd1', binding: 'DB' },
          { kind: 'r2', binding: 'FILES' },
        ],
      } as never,
      script: 'export default {};',
      port: 8787,
      host: '127.0.0.1',
      vars: { FOO: 'bar' },
    });
    assert.deepEqual(init.kvNamespaces, ['CACHE']);
    assert.deepEqual(init.d1Databases, ['DB']);
    assert.deepEqual(init.r2Buckets, ['FILES']);
    assert.deepEqual(init.compatibilityFlags, ['nodejs_compat']);
    assert.equal(init.compatibilityDate, DEV_COMPATIBILITY_DATE);
    assert.deepEqual(init.bindings, { FOO: 'bar' });
    assert.equal(init.assets, undefined); // no staged assets
    assert.equal(init.script, 'export default {};');
    assert.equal(init.port, 8787);
  });

  it('binds ASSETS to the staged dir when one is provided', () => {
    const init = buildMiniflareInit({ config: null, script: 's', port: 1, host: 'h', vars: {}, stagedAssetsDir: '/tmp/staged' });
    assert.deepEqual(init.assets, { directory: '/tmp/staged', binding: 'ASSETS' });
  });

  it('empty binding lists + no flags when deploy.json is absent', () => {
    const init = buildMiniflareInit({ config: null, script: 's', port: 1, host: 'h', vars: {} });
    assert.deepEqual(init.kvNamespaces, []);
    assert.deepEqual(init.d1Databases, []);
    assert.deepEqual(init.r2Buckets, []);
    assert.deepEqual(init.compatibilityFlags, []);
    assert.equal(init.assets, undefined);
  });
});

describe('deploy-dev — stageProdAssets (prod-filtered staging)', () => {
  it('returns null for an empty asset set, but a dir when alwaysDir is set', () => {
    assert.equal(stageProdAssets([]), null);
    const empty = stageProdAssets([], true);
    assert.ok(empty && existsSync(empty)); // static shim needs ASSETS bound even when empty
  });

  it('copies the already-filtered assets into a temp dir by manifest path', () => {
    const src = mkdtempSync(path.join(os.tmpdir(), 'yolo-dev-src-'));
    writeFileSync(path.join(src, 'index.html'), '<h1>hi</h1>');
    mkdirSync(path.join(src, 'assets'));
    writeFileSync(path.join(src, 'assets', 'app.js'), 'console.log(1)');
    const assets: BundleAsset[] = [
      { path: '/index.html', hash: 'h1', size: 1, absPath: path.join(src, 'index.html') },
      { path: '/assets/app.js', hash: 'h2', size: 1, absPath: path.join(src, 'assets', 'app.js') },
    ];
    const staged = stageProdAssets(assets);
    assert.ok(staged);
    assert.ok(existsSync(path.join(staged!, 'index.html')));
    assert.equal(readFileSync(path.join(staged!, 'assets', 'app.js'), 'utf8'), 'console.log(1)');
    // A dotfile in the source dir that was NOT in the filtered set never lands here.
    assert.equal(existsSync(path.join(staged!, '.env')), false);
  });
});

describe('deploy-dev — runDeployDev orchestration', () => {
  const workerShape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
  const staticShape: ProjectShape = { type: 'static', assetsDir: 'dist' };

  function seams(io: DevIo, over: Record<string, unknown> = {}) {
    let started: MiniflareInit | undefined;
    return {
      captured: () => started,
      opts: {
        cwd: '/proj',
        io,
        vars: {},
        readDeployConfigImpl: (() => linked({ $version: 1, projectId: 'hp_1' })) as never,
        detectProjectShapeImpl: (() => ({ ok: true, shape: workerShape, source: 'deploy-json' })) as never,
        bundleProjectImpl: (async () => fakeBundle({ moduleText: 'export default { fetch(){ return new Response("ok"); } };' })) as never,
        // Never touch the real fs/build in unit tests.
        stageAssetsImpl: (_a: BundleAsset[], alwaysDir: boolean) => (alwaysDir ? '/tmp/empty-static' : null),
        runBuildImpl: async () => ({ code: 0 }),
        startImpl: async (init: MiniflareInit) => {
          started = init;
          return { url: 'http://127.0.0.1:9999/', dispose: async () => {} };
        },
        waitForStopImpl: async () => {}, // resolve immediately so the run completes
        ...over,
      },
    };
  }

  it('bundles the worker, serves it, and exits 0 on a clean stop', async () => {
    const io = makeIo();
    const s = seams(io);
    const code = await runDeployDev(s.opts as never);
    assert.equal(code, 0);
    const out = io.stdout.join('');
    assert.match(out, /serving worker on http:\/\/127\.0\.0\.1:9999\//);
    assert.match(out, /dev server stopped/);
    assert.equal(s.captured()!.script.includes('return new Response("ok")'), true);
  });

  it('surfaces bundler warnings on stderr', async () => {
    const io = makeIo();
    const s = seams(io, { bundleProjectImpl: async () => fakeBundle({ moduleText: 'export default {};', warnings: ['imports node: builtins …'] }) });
    await runDeployDev(s.opts as never);
    assert.match(io.stderr.join(''), /warn: imports node: builtins/);
  });

  it('runs a configured build command before bundling; fails if it errors', async () => {
    const io = makeIo();
    let ran = '';
    const ok = seams(io, {
      detectProjectShapeImpl: () => ({ ok: true, shape: { ...workerShape, buildCommand: 'npm run build' }, source: 'deploy-json' }),
      runBuildImpl: async (cmd: string) => { ran = cmd; return { code: 0 }; },
    });
    assert.equal(await runDeployDev(ok.opts as never), 0);
    assert.equal(ran, 'npm run build');
    assert.match(io.stdout.join(''), /building: npm run build/);

    const io2 = makeIo();
    const bad = seams(io2, {
      detectProjectShapeImpl: () => ({ ok: true, shape: { ...workerShape, buildCommand: 'npm run build' }, source: 'deploy-json' }),
      runBuildImpl: async () => ({ code: 1 }),
    });
    assert.equal(await runDeployDev(bad.opts as never), 1);
    assert.match(io2.stderr.join(''), /build command .* exited with code 1/);
  });

  it('fails (exit 1) when the bundle fails', async () => {
    const io = makeIo();
    const s = seams(io, { bundleProjectImpl: async () => ({ ok: false, kind: 'build-failed', message: 'boom' }) });
    const code = await runDeployDev(s.opts as never);
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /FAIL: boom/);
  });

  it('serves a static project through the assets shim', async () => {
    const io = makeIo();
    const s = seams(io, {
      detectProjectShapeImpl: () => ({ ok: true, shape: staticShape, source: 'deploy-json' }),
      bundleProjectImpl: async () => fakeBundle({ type: 'static', moduleText: null }),
    });
    const code = await runDeployDev(s.opts as never);
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /serving static on/);
    assert.match(s.captured()!.script, /env\.ASSETS\.fetch/);
    // Even an empty static site binds ASSETS so the shim doesn't throw.
    assert.deepEqual(s.captured()!.assets, { directory: '/tmp/empty-static', binding: 'ASSETS' });
  });

  it('stages assets and binds ASSETS to the staged dir (never the raw dir)', async () => {
    const io = makeIo();
    const s = seams(io, {
      bundleProjectImpl: async () =>
        fakeBundle({ moduleText: 'export default {};', assets: [{ path: '/index.html', hash: 'h', size: 1, absPath: '/proj/dist/index.html' }] }),
      stageAssetsImpl: (assets: BundleAsset[]) => (assets.length ? '/tmp/staged-xyz' : null),
    });
    await runDeployDev(s.opts as never);
    assert.deepEqual(s.captured()!.assets, { directory: '/tmp/staged-xyz', binding: 'ASSETS' });
  });

  it('fails (exit 1) on an unreadable deploy config', async () => {
    const io = makeIo();
    const s = seams(io, { readDeployConfigImpl: () => ({ ok: false, kind: 'malformed', message: 'bad json', path: CONFIG_PATH }) });
    const code = await runDeployDev(s.opts as never);
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /FAIL: bad json/);
  });

  it('notes when no local vars are set', async () => {
    const io = makeIo();
    await runDeployDev(seams(io).opts as never);
    assert.match(io.stdout.join(''), /no local vars set/);
  });
});
