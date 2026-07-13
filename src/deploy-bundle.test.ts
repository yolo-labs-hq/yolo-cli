/**
 * Bundling tests (managed-hosting CLI spec §2, `deploy-bundle`).
 *
 * Everything here is offline by construction — the module has no
 * network surface. Ceiling tests fire via the injectable caps (the
 * same override the ship orchestration uses for the server's
 * authoritative tier caps); the spec defaults are pinned separately so
 * the constants can't silently drift.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DEPLOY_CEILINGS,
  bundleProject,
  computeBundleDigest,
} from './deploy-bundle.js';
import type { ProjectShape } from './deploy-detect.js';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-deploy-bundle-test-'));
}

function writeTree(root: string, files: Record<string, string | Buffer>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
}

function sha256(text: string | Buffer): string {
  return createHash('sha256').update(text).digest('hex');
}

// Cloudflare Workers-Assets manifest hash: sha256(base64(contents)+ext) → 32 hex.
function cfHash(text: string | Buffer, ext: string): string {
  const buf = Buffer.isBuffer(text) ? text : Buffer.from(text);
  return createHash('sha256').update(buf.toString('base64') + ext).digest('hex').slice(0, 32);
}

const STATIC_SHAPE: ProjectShape = { type: 'static', assetsDir: 'dist' };

// ─── Spec default ceilings ────────────────────────────────────────────────

describe('deploy-bundle — spec default ceilings', () => {
  it('pins the spec values (25 MiB/file, 20k files, 256 MiB total, 10 MiB module)', () => {
    assert.equal(DEPLOY_CEILINGS.maxFileBytes, 25 * 1024 * 1024);
    assert.equal(DEPLOY_CEILINGS.maxFiles, 20_000);
    assert.equal(DEPLOY_CEILINGS.maxTotalBytes, 256 * 1024 * 1024);
    assert.equal(DEPLOY_CEILINGS.maxModuleBytes, 10 * 1024 * 1024);
    assert.equal(DEPLOY_CEILINGS.warnModuleGzipBytes, 1 * 1024 * 1024);
  });
});

// ─── Static manifests ─────────────────────────────────────────────────────

describe('deploy-bundle — static asset manifest', () => {
  it('builds a URL-style-path manifest with sha256 hashes and sizes', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'dist/index.html': '<html>hello</html>',
      'dist/js/app.js': 'console.log(1)',
    });
    const res = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.type, 'static');
      assert.equal(res.module, null);
      assert.equal(res.moduleSource, null);
      assert.equal(res.fileCount, 2);
      assert.deepEqual(res.manifest, {
        '/index.html': { hash: cfHash('<html>hello</html>', 'html'), size: 18 },
        '/js/app.js': { hash: cfHash('console.log(1)', 'js'), size: 14 },
      });
      // CF requires 32-hex asset hashes (rejects 64-hex sha256).
      assert.match(res.manifest['/index.html']!.hash, /^[0-9a-f]{32}$/);
      assert.equal(res.totalAssetBytes, 32);
      assert.equal(res.assetPaths['/index.html'], path.join(tmp, 'dist', 'index.html'));
      assert.match(res.bundleDigest, /^sha256:[0-9a-f]{64}$/);
    }
  });

  it('exposes array views (assets, workerModules) consistent with the manifest', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'dist/index.html': '<html/>', 'dist/a/x.txt': 'xxx' });
    const res = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.workerModules, []);
      assert.equal(res.assets.length, 2);
      // Sorted-path order, mirroring the manifest entries exactly.
      assert.deepEqual(res.assets.map((a) => a.path), ['/a/x.txt', '/index.html']);
      for (const asset of res.assets) {
        assert.deepEqual(res.manifest[asset.path], { hash: asset.hash, size: asset.size });
        assert.equal(res.assetPaths[asset.path], asset.absPath);
      }
    }
  });

  it('produces a deterministic bundleDigest across runs and dir layouts', async () => {
    const files = { 'dist/b.txt': 'bbb', 'dist/a/x.txt': 'xxx', 'dist/index.html': '<html/>' };
    const tmp1 = makeTmpDir();
    const tmp2 = makeTmpDir();
    writeTree(tmp1, files);
    writeTree(tmp2, files);
    const res1 = await bundleProject(STATIC_SHAPE, tmp1);
    const res2 = await bundleProject(STATIC_SHAPE, tmp2);
    assert.equal(res1.ok, true);
    assert.equal(res2.ok, true);
    if (res1.ok && res2.ok) {
      assert.equal(res1.bundleDigest, res2.bundleDigest);
      assert.deepEqual(res1.manifest, res2.manifest);
    }
  });

  it('digest changes when any file content changes', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'dist/index.html': 'v1' });
    const res1 = await bundleProject(STATIC_SHAPE, tmp);
    writeTree(tmp, { 'dist/index.html': 'v2' });
    const res2 = await bundleProject(STATIC_SHAPE, tmp);
    assert.ok(res1.ok && res2.ok);
    if (res1.ok && res2.ok) assert.notEqual(res1.bundleDigest, res2.bundleDigest);
  });

  it('skips dotfiles, dot-dirs, and node_modules at every level', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'dist/index.html': '<html/>',
      'dist/.hidden': 'nope',
      'dist/.well-known/x': 'nope',
      'dist/node_modules/pkg/index.js': 'nope',
      'dist/sub/node_modules/pkg/index.js': 'nope',
      'dist/sub/keep.txt': 'yes',
    });
    const res = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(Object.keys(res.manifest).sort(), ['/index.html', '/sub/keep.txt']);
    }
  });

  it('excludes a symlink that escapes the asset root, includes one that stays inside (codex P1 r12)', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'dist/index.html': '<html/>',
      'dist/real.txt': 'inside',
      'secret.txt': 'TOP SECRET credential outside the bundle root',
    });
    // Escaping symlink → must NOT be published.
    symlinkSync(path.join(tmp, 'secret.txt'), path.join(tmp, 'dist', 'leak.txt'));
    // In-root symlink → allowed (resolves under dist/).
    symlinkSync(path.join(tmp, 'dist', 'real.txt'), path.join(tmp, 'dist', 'alias.txt'));

    const res = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      const keys = Object.keys(res.manifest).sort();
      assert.ok(!keys.includes('/leak.txt'), `escaping symlink leaked: ${keys.join(', ')}`);
      assert.deepEqual(keys, ['/alias.txt', '/index.html', '/real.txt']);
    }
  });

  it('fails build-failed when the assets dir does not exist (build not run)', async () => {
    const tmp = makeTmpDir();
    const res = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'build-failed');
      assert.match(res.message, /assets directory not found/);
    }
  });
});

// ─── Ceilings (each fires locally, pre-network, with the right kind) ─────

describe('deploy-bundle — ceilings', () => {
  it('per-file ceiling → file-too-large with the R2 hint', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'dist/big.bin': Buffer.alloc(64, 7), 'dist/index.html': '<html/>' });
    const res = await bundleProject(STATIC_SHAPE, tmp, { maxFileBytes: 32 });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'file-too-large');
      assert.match(res.message, /big\.bin/);
      assert.match(res.hint ?? '', /R2 bucket/);
    }
  });

  it('file-count ceiling → too-many-files', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'dist/a.txt': 'a',
      'dist/b.txt': 'b',
      'dist/c.txt': 'c',
    });
    const res = await bundleProject(STATIC_SHAPE, tmp, { maxFiles: 2 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, 'too-many-files');
  });

  it('total-bytes ceiling → bundle-too-large', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'dist/a.bin': Buffer.alloc(30), 'dist/b.bin': Buffer.alloc(30) });
    const res = await bundleProject(STATIC_SHAPE, tmp, { maxTotalBytes: 50 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, 'bundle-too-large');
  });

  it('a file at the 25 MiB default boundary passes; one byte over fails', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'dist/exact.bin': Buffer.alloc(DEPLOY_CEILINGS.maxFileBytes) });
    const ok = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(ok.ok, true);
    writeTree(tmp, { 'dist/exact.bin': Buffer.alloc(DEPLOY_CEILINGS.maxFileBytes + 1) });
    const over = await bundleProject(STATIC_SHAPE, tmp);
    assert.equal(over.ok, false);
    if (!over.ok) assert.equal(over.kind, 'file-too-large');
  });

  it('worker-module ceiling → bundle-too-large', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'worker.mjs': 'export default { fetch() {} };// ' + 'x'.repeat(100) });
    const shape: ProjectShape = { type: 'worker', entry: 'worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp, { maxModuleBytes: 64 });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'bundle-too-large');
      assert.match(res.message, /worker module/);
    }
  });

  it('gzipped module over the warn threshold warns but still succeeds', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'worker.mjs': 'export default { fetch() { return "' + 'y'.repeat(2000) + '"; } };' });
    const shape: ProjectShape = { type: 'worker', entry: 'worker.mjs' };
    const res = await bundleProject(shape, tmp, { warnModuleGzipBytes: 16 });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.warnings.length, 1);
      assert.match(res.warnings[0]!, /gzipped/);
    }
  });
});

// ─── Worker modules ───────────────────────────────────────────────────────

describe('deploy-bundle — worker modules', () => {
  it('bundles a TS entry with imports into one minified ESM module via esbuild', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'src/util.ts': 'export const GREETING: string = "hello-from-util";\n',
      'src/index.ts': [
        'import { GREETING } from "./util.js";',
        'export default { async fetch(): Promise<Response> { return new Response(GREETING); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.moduleSource, 'esbuild');
      assert.ok(res.module);
      assert.equal(res.module!.name, 'index.js');
      const text = Buffer.from(res.module!.contents).toString('utf8');
      assert.ok(text.includes('hello-from-util'), 'import was inlined');
      assert.ok(text.includes('export'), 'ESM output');
      assert.ok(!text.includes('./util'), 'no unresolved relative import');
    }
  });

  it('bundles a Worker that imports @yolo-labs/flexdb WITHOUT it installed (vendored)', async () => {
    const tmp = makeTmpDir();
    // No node_modules / no install — the deploy bundler must vendor FlexDB.
    writeTree(tmp, {
      'src/index.ts': [
        "import { FlexDB } from '@yolo-labs/flexdb';",
        'export default {',
        '  async fetch(req: Request, env: any): Promise<Response> {',
        '    const db = new FlexDB(env.DB);',
        "    await db.collection('todos').insertOne({ title: 'x' });",
        '    return new Response("ok");',
        '  },',
        '};',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.moduleSource, 'esbuild');
      const text = Buffer.from(res.module!.contents).toString('utf8');
      // FlexDB's code is inlined (minified), and nothing left unresolved.
      assert.ok(text.includes('_flexdb_documents'), 'FlexDB engine inlined into the bundle');
      assert.ok(!text.includes('@yolo-labs/flexdb'), 'no unresolved package specifier');
    }
  });

  it('pins process.env.NODE_ENV to "production" via esbuild define', async () => {
    const tmp = makeTmpDir();
    // A branch that only survives when NODE_ENV is replaced at build time.
    writeTree(tmp, {
      'src/index.ts': [
        'const mode = process.env.NODE_ENV === "production" ? "prod-marker" : "dev-marker";',
        'export default { fetch(): Response { return new Response(mode); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      const text = Buffer.from(res.module!.contents).toString('utf8');
      assert.ok(text.includes('prod-marker'), 'production branch retained');
      assert.ok(!text.includes('dev-marker'), 'dev branch dead-code-eliminated');
    }
  });

  it('leaves node: builtins external and warns when nodejs_compat is absent', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'src/index.ts': [
        'import { AsyncLocalStorage } from "node:async_hooks";',
        'export default { fetch(): Response { return new Response(String(!!AsyncLocalStorage)); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true, 'node: import no longer hard-fails the bundle');
    if (res.ok) {
      const text = Buffer.from(res.module!.contents).toString('utf8');
      assert.ok(text.includes('node:async_hooks'), 'node: import kept external, not inlined');
      assert.ok(
        res.warnings.some((w) => w.includes('nodejs_compat') && w.includes('node:async_hooks')),
        'warns about the missing nodejs_compat flag',
      );
    }
  });

  it('still fails the build on an unknown/misspelled node: specifier', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      // node:async_hook (missing the trailing "s") is not a real builtin —
      // externalizing it blindly would defer the failure to runtime.
      'src/index.ts': [
        'import { AsyncLocalStorage } from "node:async_hook";',
        'export default { fetch(): Response { return new Response(String(!!AsyncLocalStorage)); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, false, 'unknown node: builtin is rejected, not silently externalized');
    if (!res.ok) assert.equal(res.kind, 'build-failed');
  });

  it('externalizes a workerd-provided subpath builtin (node:stream/promises)', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'src/index.ts': [
        'import { pipeline } from "node:stream/promises";',
        'export default { fetch(): Response { return new Response(typeof pipeline); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(res.ok, true, 'subpath of an allowlisted base is externalized');
    if (res.ok) {
      const text = Buffer.from(res.module!.contents).toString('utf8');
      assert.ok(text.includes('node:stream/promises'), 'kept external');
    }
  });

  it('rejects a bogus subpath (node:path/typo) — not a real builtin', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      // node:path/typo is not a real builtin, so it is not externalized and
      // esbuild's resolver fails it — a typo stays a build error, not runtime.
      'src/index.ts': [
        'import x from "node:path/typo";',
        'export default { fetch(): Response { return new Response(typeof x); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(res.ok, false, 'a non-builtin subpath is not externalized');
    if (!res.ok) assert.equal(res.kind, 'build-failed');
  });

  it('externalizes every real builtin (node:fs, node:tls) — bundler is not the workerd oracle', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'src/index.ts': [
        'import { readFileSync } from "node:fs";',
        'import { connect } from "node:tls";',
        'export default { fetch(): Response { return new Response(typeof readFileSync + typeof connect); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(res.ok, true, 'real builtins are externalized, never false-rejected at build');
    if (res.ok) {
      const text = Buffer.from(res.module!.contents).toString('utf8');
      assert.ok(text.includes('node:fs') && text.includes('node:tls'), 'both kept external');
    }
  });

  it('externalizes a require() of a node: builtin and WARNS (guarded probes stay valid)', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      // A guarded optional-dependency probe must still bundle — esbuild emits
      // __require(...) inside the catch, so the fallback runs at runtime.
      'src/index.ts': [
        'let fs; try { fs = require("node:fs"); } catch { fs = null; }',
        'export default { fetch(): Response { return new Response(typeof fs); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(res.ok, true, 'require() no longer hard-fails the build');
    if (res.ok) {
      assert.ok(
        res.warnings.some((w) => w.includes('require()') && w.includes('node:fs')),
        'warns that require() of a builtin throws unless guarded',
      );
    }
  });

  it('warns about a DYNAMIC import("node:…") in a prebuilt worker', async () => {
    const tmp = makeTmpDir();
    const prebuilt = 'export default{async fetch(){const{AsyncLocalStorage}=await import("node:async_hooks");return new Response(String(!!AsyncLocalStorage))}};\n';
    writeTree(tmp, { '.vinext/worker.mjs': prebuilt });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(
        res.warnings.some((w) => w.includes('nodejs_compat') && w.includes('node:async_hooks')),
        'dynamic import() is detected on the prebuilt path',
      );
    }
  });

  it('warns on require()/__require() of a node: builtin in a prebuilt bundle even WITH nodejs_compat', async () => {
    const tmp = makeTmpDir();
    // require of a builtin throws in an ESM Worker regardless of nodejs_compat,
    // so the warning must fire even when the missing-compat warning is suppressed.
    const prebuilt = 'var __require=(x)=>x;var fs=__require("node:fs");export default{fetch(){return new Response(typeof fs)}};\n';
    writeTree(tmp, { '.vinext/worker.mjs': prebuilt });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(!res.warnings.some((w) => w.includes('nodejs_compat')), 'missing-compat warning suppressed by the flag');
      assert.ok(
        res.warnings.some((w) => w.includes('require()') && w.includes('node:fs')),
        'require-of-builtin warning fires independently',
      );
    }
  });

  it('detects a renamed require helper (__require("node:…")) in a prebuilt bundle', async () => {
    const tmp = makeTmpDir();
    // esbuild emits `__require(...)` for CJS builtins — the scanner must not key
    // on the literal `require` token.
    const prebuilt = 'var __require=(x)=>x;var fs=__require("node:fs");export default{fetch(){return new Response(typeof fs)}};\n';
    writeTree(tmp, { '.vinext/worker.mjs': prebuilt });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(
        res.warnings.some((w) => w.includes('nodejs_compat') && w.includes('node:fs')),
        'helper-call form is detected',
      );
    }
  });

  it('warns about retained node: imports in a PREBUILT worker (esbuild skipped)', async () => {
    const tmp = makeTmpDir();
    const prebuilt = 'import{AsyncLocalStorage}from"node:async_hooks";export default{fetch(){return new Response(String(!!AsyncLocalStorage))}};\n';
    writeTree(tmp, { '.vinext/worker.mjs': prebuilt });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const noFlag = await bundleProject(shape, tmp);
    assert.equal(noFlag.ok, true);
    if (noFlag.ok) {
      assert.equal(noFlag.moduleSource, 'prebuilt');
      assert.ok(
        noFlag.warnings.some((w) => w.includes('nodejs_compat') && w.includes('node:async_hooks')),
        'prebuilt path warns too',
      );
    }
    const withFlag = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(withFlag.ok, true);
    if (withFlag.ok) assert.ok(!withFlag.warnings.some((w) => w.includes('nodejs_compat')));
  });

  it('warns when a PREBUILT worker retains an unpinned process.env.NODE_ENV', async () => {
    const tmp = makeTmpDir();
    // A pinned build would have replaced this literal; its survival = unpinned.
    const prebuilt = 'const dev=process.env.NODE_ENV!=="production";export default{fetch(){return new Response(String(dev))}};\n';
    writeTree(tmp, { '.vinext/worker.mjs': prebuilt });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.moduleSource, 'prebuilt');
      assert.ok(
        res.warnings.some((w) => w.includes('process.env.NODE_ENV') && w.includes('dev build')),
        'unpinned NODE_ENV in a prebuilt bundle is flagged',
      );
    }
  });

  it('warns even under nodejs_als — only nodejs_compat is server-accepted', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      // nodejs_als is a real workerd flag, but the hosting service rejects it at
      // ship (ALLOWED_COMPATIBILITY_FLAGS = nodejs_compat only), so the warning
      // must still steer users to nodejs_compat rather than pass here and fail there.
      'src/index.ts': [
        'import { AsyncLocalStorage } from "node:async_hooks";',
        'export default { fetch(): Response { return new Response(String(!!AsyncLocalStorage)); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_als'] });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(
        res.warnings.some((w) => w.includes('nodejs_compat') && w.includes('node:async_hooks')),
        'nodejs_als does not suppress the nodejs_compat warning',
      );
    }
  });

  it('suppresses the node: warning when nodejs_compat is set', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'src/index.ts': [
        'import { AsyncLocalStorage } from "node:async_hooks";',
        'export default { fetch(): Response { return new Response(String(!!AsyncLocalStorage)); } };',
      ].join('\n'),
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, undefined, { compatibilityFlags: ['nodejs_compat'] });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(!res.warnings.some((w) => w.includes('nodejs_compat')), 'no warning when the flag is present');
    }
  });

  it('emits a linked sourcemap sidecar only when sourcemaps:true (out of the digest)', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'src/util.ts': 'export const G: string = "hi";\n',
      'src/index.ts': 'import { G } from "./util.js";\nexport default { fetch(): Response { return new Response(G); } };',
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };

    const off = await bundleProject(shape, tmp); // default: no sourcemaps
    assert.equal(off.ok, true);
    const on = await bundleProject(shape, tmp, undefined, { sourcemaps: true });
    assert.equal(on.ok, true);
    if (off.ok && on.ok) {
      // OFF → no sidecar, module has no sourceMappingURL comment.
      assert.equal(off.sourceMap, null);
      assert.ok(!Buffer.from(off.module!.contents).toString('utf8').includes('sourceMappingURL'));
      // ON → sidecar present, valid JSON map, module links to it by the matching name.
      assert.ok(on.sourceMap, 'sidecar emitted');
      assert.equal(on.sourceMap!.name, 'index.js.map');
      const map = JSON.parse(on.sourceMap!.content);
      assert.equal(map.version, 3);
      assert.ok(Array.isArray(map.sources) && map.sources.some((s: string) => s.includes('index.ts')));
      // CF associates the map to the module by `file` (esbuild omits it) — without
      // this, deploy.logs exception stacks stay minified (verified against CF).
      assert.equal(map.file, 'index.js');
      const modText = Buffer.from(on.module!.contents).toString('utf8');
      assert.ok(modText.includes('//# sourceMappingURL=index.js.map'), 'module links to the map by name');
      // The sidecar is NOT a worker module and NOT in the digest input.
      assert.equal(on.workerModules.length, 1);
      assert.ok(!on.workerModules.some((m) => m.name.endsWith('.map')));
    }
  });

  it('drops an oversize sourcemap (+ warns) instead of failing or 413-ing late', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'src/index.ts': 'export default { fetch(): Response { return new Response("hi"); } };' });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp, { maxSourceMapBytes: 10 }, { sourcemaps: true });
    assert.equal(res.ok, true, 'deploy still ships — the module is valid');
    if (res.ok) {
      assert.equal(res.sourceMap, null, 'oversize map dropped, not uploaded');
      assert.ok(res.warnings.some((w) => w.includes('sourcemap is') && w.includes('skipping')));
    }
  });

  it('a broken entry fails build-failed (esbuild error surfaced, not thrown)', async () => {
    const tmp = makeTmpDir();
    // The import must be USED — esbuild elides unused TS imports before
    // resolving them, which would let a dangling specifier slip through.
    writeTree(tmp, {
      'src/index.ts': 'import { missing } from "./does-not-exist.js";\nexport default { fetch() { return missing; } };',
    });
    const shape: ProjectShape = { type: 'worker', entry: 'src/index.ts' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, 'build-failed');
  });

  it('ships a pre-built .mjs entry byte-for-byte AS-IS (esbuild skipped — vinext path)', async () => {
    const tmp = makeTmpDir();
    // Comments + whitespace would NOT survive minify:true — byte equality
    // proves esbuild never touched it.
    const prebuilt = '// vinext build output — esbuild must not touch this\nexport default {\n  fetch() { return new Response("ok"); }\n};\n';
    writeTree(tmp, { '.vinext/worker.mjs': prebuilt });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.moduleSource, 'prebuilt');
      assert.equal(res.module!.name, 'worker.mjs');
      assert.equal(Buffer.from(res.module!.contents).toString('utf8'), prebuilt);
      assert.deepEqual(res.workerModules, [res.module]);
    }
  });

  it('ceilings still apply to pre-built modules', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'worker.js': '// ' + 'z'.repeat(200) });
    const shape: ProjectShape = { type: 'worker', entry: 'worker.js', prebuilt: true };
    const res = await bundleProject(shape, tmp, { maxModuleBytes: 100 });
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.kind, 'bundle-too-large');
  });

  it('a missing pre-built entry fails build-failed with the framework-build hint', async () => {
    const tmp = makeTmpDir();
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', prebuilt: true };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'build-failed');
      assert.match(res.message, /worker entry not found/);
    }
  });

  it('worker with assetsDir walks the assets too and digests module+manifest together', async () => {
    const tmp = makeTmpDir();
    const prebuilt = 'export default { fetch() {} };\n';
    writeTree(tmp, {
      '.vinext/worker.mjs': prebuilt,
      '.vinext/assets/index.html': '<html/>',
    });
    const shape: ProjectShape = { type: 'worker', entry: '.vinext/worker.mjs', assetsDir: '.vinext/assets', prebuilt: true };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.fileCount, 1);
      assert.deepEqual(Object.keys(res.manifest), ['/index.html']);
      assert.equal(
        res.bundleDigest,
        computeBundleDigest([{ name: 'worker.mjs', contents: Buffer.from(prebuilt) }], res.manifest),
      );
      // Module bytes participate: same manifest, no module ⇒ different digest.
      assert.notEqual(res.bundleDigest, computeBundleDigest([], res.manifest));
    }
  });

  // ⚠️ Cross-implementation lockstep: the SAME vector (same expected hex) is
  // asserted in common-api release-service tests and yolo-studio-mcp
  // static-bundle tests. The server recipe is canonical — if this test fails,
  // fix THIS implementation, then keep all three green together.
  it('golden vector matches the canonical server digest recipe', () => {
    const manifest = {
      '/index.html': { hash: 'a'.repeat(64), size: 5 },
      '/app.css': { hash: 'b'.repeat(64), size: 10 },
    };
    assert.equal(
      computeBundleDigest(
        [{ name: 'index.js', contents: Buffer.from('export default {};', 'utf8') }],
        manifest,
      ),
      'sha256:3d7cb9f8616025431ef83d245f579851a7b704da9d5130da1b479bbccd846e28',
    );
    assert.equal(
      computeBundleDigest([], manifest),
      'sha256:78950c2010b4b065c2334e2067ada09381661e57b8aec2bf9a5f635d1d230aa7',
    );
  });

  it('worker WITHOUT assetsDir ships a module and an empty manifest', async () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'worker.mjs': 'export default { fetch() {} };\n' });
    const shape: ProjectShape = { type: 'worker', entry: 'worker.mjs' };
    const res = await bundleProject(shape, tmp);
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.manifest, {});
      assert.equal(res.fileCount, 0);
      assert.ok(res.module);
    }
  });
});
