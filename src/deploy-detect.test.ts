/**
 * Project-shape detection tests (managed-hosting CLI spec §2).
 *
 * One tmp-dir fixture per detection branch (deploy.json / wrangler /
 * package-build / plain-static / worker-entry / ambiguous), plus
 * in-memory readFileImpl cases for precedence and the parsing edges
 * (jsonc comments, toml sections, lockfile-based package managers).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import { DETECT_INIT_HINT, detectProjectShape } from './deploy-detect.js';
import type { DeployConfig } from './deploy-config.js';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-deploy-detect-test-'));
}

/** Write a fixture tree: relative path → content (dirs auto-created). */
function writeTree(root: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const abs = path.join(root, ...rel.split('/'));
    mkdirSync(path.dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
}

function fileStub(cwd: string, map: Record<string, string>) {
  const resolved: Record<string, string> = {};
  for (const [rel, content] of Object.entries(map)) {
    resolved[path.join(cwd, ...rel.split('/'))] = content;
  }
  return (p: string) => resolved[p];
}

const WORKER_SRC = 'export default { async fetch(request) { return new Response("ok"); } };\n';

// ─── 1. deploy.json is authoritative ──────────────────────────────────────

describe('deploy-detect — deploy.json type wins', () => {
  it('static type with build.outputDir + command', () => {
    const config: DeployConfig = {
      $version: 1,
      type: 'static',
      build: { command: 'npm run build', outputDir: 'site' },
    };
    const res = detectProjectShape({ cwd: '/proj', config, readFileImpl: fileStub('/proj', {}) });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'deploy-json');
      assert.deepEqual(res.shape, { type: 'static', assetsDir: 'site', buildCommand: 'npm run build' });
    }
  });

  it('worker type with prebuilt entry + assetsDir (the vinext shape)', () => {
    const config: DeployConfig = {
      $version: 1,
      type: 'worker',
      worker: { entry: '.vinext/worker.mjs', assetsDir: '.vinext/assets' },
      compatibilityFlags: ['nodejs_compat'],
    };
    const res = detectProjectShape({ cwd: '/proj', config, readFileImpl: fileStub('/proj', {}) });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'deploy-json');
      assert.deepEqual(res.shape, { type: 'worker', entry: '.vinext/worker.mjs', assetsDir: '.vinext/assets' });
    }
  });

  it('beats a wrangler config sitting in the same project', () => {
    const stub = fileStub('/proj', {
      'wrangler.toml': 'main = "worker.js"\n',
      'dist/index.html': '<html/>',
    });
    const config: DeployConfig = { $version: 1, type: 'static' };
    const res = detectProjectShape({ cwd: '/proj', config, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'deploy-json');
      assert.equal(res.shape.type, 'static');
    }
  });

  it('worker type without entry falls back to src/index.ts existence (no signature required)', () => {
    const stub = fileStub('/proj', { 'src/index.ts': '// not a fetch handler yet\n' });
    const config: DeployConfig = { $version: 1, type: 'worker' };
    const res = detectProjectShape({ cwd: '/proj', config, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.shape, { type: 'worker', entry: 'src/index.ts' });
  });

  it('static type with no resolvable output dir is detect-failed (actionable message)', () => {
    const config: DeployConfig = { $version: 1, type: 'static' };
    const res = detectProjectShape({ cwd: '/proj', config, readFileImpl: fileStub('/proj', {}) });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'detect-failed');
      assert.match(res.message, /build\.outputDir/);
    }
  });

  it('reads .yolo/deploy.json itself when config is not passed', () => {
    const stub = fileStub('/proj', {
      '.yolo/deploy.json': JSON.stringify({ $version: 1, type: 'static', build: { outputDir: 'www' } }),
    });
    const res = detectProjectShape({ cwd: '/proj', readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.shape, { type: 'static', assetsDir: 'www' });
  });

  it('an invalid deploy.json fails detection rather than being silently overridden', () => {
    const stub = fileStub('/proj', {
      '.yolo/deploy.json': JSON.stringify({ $version: 1, type: 'lambda' }),
      'dist/index.html': '<html/>',
    });
    const res = detectProjectShape({ cwd: '/proj', readFileImpl: stub });
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /invalid deploy config/);
  });
});

// ─── 2. wrangler configs ──────────────────────────────────────────────────

describe('deploy-detect — wrangler configs', () => {
  it('wrangler.jsonc with comments and trailing commas → worker', () => {
    const stub = fileStub('/proj', {
      'wrangler.jsonc': [
        '{',
        '  // the worker entry',
        '  "main": "src/worker.ts",',
        '  /* assets too */',
        '  "assets": { "directory": "public", },',
        '}',
      ].join('\n'),
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'wrangler');
      assert.deepEqual(res.shape, { type: 'worker', entry: 'src/worker.ts', assetsDir: 'public' });
    }
  });

  it('wrangler.toml main + [assets] directory → worker', () => {
    const stub = fileStub('/proj', {
      'wrangler.toml': [
        '# comment',
        'name = "my-worker"',
        'main = "src/worker.ts"',
        '',
        '[assets]',
        'directory = "./public"',
      ].join('\n'),
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.shape, { type: 'worker', entry: 'src/worker.ts', assetsDir: './public' });
    }
  });

  it('a key named main inside another toml section is NOT the worker entry', () => {
    const stub = fileStub('/proj', {
      'wrangler.toml': '[build]\nmain = "not-the-entry.js"\n',
      'dist/index.html': '<html/>',
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.shape.type, 'static'); // fell through to plain-static
  });

  it('assets-only wrangler config (no main) → static with that directory', () => {
    const stub = fileStub('/proj', {
      'wrangler.jsonc': '{ "assets": { "directory": "site" } }',
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'wrangler');
      assert.deepEqual(res.shape, { type: 'static', assetsDir: 'site' });
    }
  });

  it('carries the package.json build command alongside the wrangler entry', () => {
    const stub = fileStub('/proj', {
      'wrangler.toml': 'main = ".vinext/worker.mjs"\n',
      'package.json': JSON.stringify({ scripts: { build: 'vinext build' } }),
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.shape, { type: 'worker', entry: '.vinext/worker.mjs', buildCommand: 'npm run build' });
    }
  });
});

// ─── 3. package.json build script ─────────────────────────────────────────

describe('deploy-detect — package.json build script', () => {
  it('build script + dist/index.html → static with npm run build', () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'package.json': JSON.stringify({ scripts: { build: 'vite build' } }),
      'dist/index.html': '<html/>',
    });
    const res = detectProjectShape({ cwd: tmp });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'package-build');
      assert.deepEqual(res.shape, { type: 'static', assetsDir: 'dist', buildCommand: 'npm run build' });
    }
  });

  it('resolves the FIRST candidate output dir containing index.html (build before out)', () => {
    const stub = fileStub('/proj', {
      'package.json': JSON.stringify({ scripts: { build: 'x' } }),
      'build/index.html': '<html/>',
      'out/index.html': '<html/>',
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal((res.shape as { assetsDir: string }).assetsDir, 'build');
  });

  it('config build.outputDir overrides the candidate scan even without a config type', () => {
    const stub = fileStub('/proj', {
      'package.json': JSON.stringify({ scripts: { build: 'x' } }),
      'dist/index.html': '<html/>',
    });
    const config: DeployConfig = { $version: 1, build: { outputDir: '_site' } };
    const res = detectProjectShape({ cwd: '/proj', config, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.equal((res.shape as { assetsDir: string }).assetsDir, '_site');
  });

  it('picks the package manager from the lockfile (pnpm / yarn / bun)', () => {
    const cases: Array<[string, string]> = [
      ['pnpm-lock.yaml', 'pnpm run build'],
      ['yarn.lock', 'yarn run build'],
      ['bun.lock', 'bun run build'],
    ];
    for (const [lockfile, expected] of cases) {
      const stub = fileStub('/proj', {
        'package.json': JSON.stringify({ scripts: { build: 'x' } }),
        [lockfile]: '',
        'dist/index.html': '<html/>',
      });
      const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
      assert.equal(res.ok, true, lockfile);
      if (res.ok) assert.equal(res.shape.buildCommand, expected, lockfile);
    }
  });

  it('build script with NO resolvable output dir falls through to the worker-entry step', () => {
    const tmp = makeTmpDir();
    writeTree(tmp, {
      'package.json': JSON.stringify({ scripts: { build: 'tsc' } }),
      'src/index.ts': WORKER_SRC,
    });
    const res = detectProjectShape({ cwd: tmp });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'worker-entry');
      assert.deepEqual(res.shape, { type: 'worker', entry: 'src/index.ts' });
    }
  });
});

// ─── 4. plain static ──────────────────────────────────────────────────────

describe('deploy-detect — plain static', () => {
  it('dist/index.html with no package.json → static', () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'dist/index.html': '<html/>' });
    const res = detectProjectShape({ cwd: tmp });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'plain-static');
      assert.deepEqual(res.shape, { type: 'static', assetsDir: 'dist' });
    }
  });

  it('public/index.html → static', () => {
    const stub = fileStub('/proj', { 'public/index.html': '<html/>' });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.shape, { type: 'static', assetsDir: 'public' });
  });

  it('cwd itself when it has a root index.html and no package.json', () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'index.html': '<html/>' });
    const res = detectProjectShape({ cwd: tmp });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.shape, { type: 'static', assetsDir: '.' });
  });

  it('root index.html WITH a package.json does not make the cwd static', () => {
    const stub = fileStub('/proj', {
      'index.html': '<html/>',
      'package.json': JSON.stringify({}),
    });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, false);
  });
});

// ─── 5. worker entry signature ────────────────────────────────────────────

describe('deploy-detect — worker entry signature', () => {
  it('src/index.ts with export default + fetch( → worker', () => {
    const tmp = makeTmpDir();
    writeTree(tmp, { 'src/index.ts': WORKER_SRC });
    const res = detectProjectShape({ cwd: tmp });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.source, 'worker-entry');
      assert.deepEqual(res.shape, { type: 'worker', entry: 'src/index.ts' });
    }
  });

  it('src/index.js works too', () => {
    const stub = fileStub('/proj', { 'src/index.js': WORKER_SRC });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.shape, { type: 'worker', entry: 'src/index.js' });
  });

  it('a src/index.ts WITHOUT the fetch-handler signature is not a worker', () => {
    const stub = fileStub('/proj', { 'src/index.ts': 'export const x = 1;\n' });
    const res = detectProjectShape({ cwd: '/proj', config: null, readFileImpl: stub });
    assert.equal(res.ok, false);
  });
});

// ─── 6. detect-failed ─────────────────────────────────────────────────────

describe('deploy-detect — detect-failed', () => {
  it('an empty/ambiguous project fails with the init hint', () => {
    const tmp = makeTmpDir();
    const res = detectProjectShape({ cwd: tmp });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'detect-failed');
      assert.ok(res.message.includes(DETECT_INIT_HINT), res.message);
    }
  });
});
