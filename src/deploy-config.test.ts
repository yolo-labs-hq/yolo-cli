/**
 * `.yolo/deploy.json` read/validate/write tests (managed-hosting CLI
 * spec §3). Pin the canonical write discipline (2-space JSON, fixed
 * key order, trailing newline, idempotent re-write — the configuration
 * rules) and the structured validation errors the deploy verb prints.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  DeployConfigError,
  deployConfigPath,
  readDeployConfig,
  validateDeployConfig,
  writeDeployConfig,
  type DeployConfig,
} from './deploy-config.js';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-deploy-config-test-'));
}

function fileStub(map: Record<string, string>) {
  return (p: string) => map[p];
}

const FULL_CONFIG: DeployConfig = {
  $version: 1,
  projectId: 'hp_8f3a',
  slug: 'my-app',
  type: 'worker',
  build: { command: 'npm run build', outputDir: 'dist' },
  worker: { entry: '.vinext/worker.mjs', prebuilt: true, assetsDir: '.vinext/assets' },
  compatibilityFlags: ['nodejs_compat'],
  bindings: [{ kind: 'd1', binding: 'DB' }],
};

// ─── readDeployConfig ─────────────────────────────────────────────────────

describe('deploy-config — readDeployConfig', () => {
  it('returns config:null when no deploy.json exists (first-ship case, not an error)', () => {
    const res = readDeployConfig('/proj', fileStub({}));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.config, null);
      assert.equal(res.path, path.join('/proj', '.yolo', 'deploy.json'));
    }
  });

  it('reads and validates a full config via the injectable readFileImpl', () => {
    const res = readDeployConfig('/proj', fileStub({
      [path.join('/proj', '.yolo', 'deploy.json')]: JSON.stringify(FULL_CONFIG),
    }));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.ok(res.config);
      assert.equal(res.config.projectId, 'hp_8f3a');
      assert.equal(res.config.type, 'worker');
      assert.deepEqual(res.config.compatibilityFlags, ['nodejs_compat']);
    }
  });

  it('returns kind:malformed for invalid JSON', () => {
    const res = readDeployConfig('/proj', fileStub({
      [path.join('/proj', '.yolo', 'deploy.json')]: '{ not json',
    }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'malformed');
      assert.match(res.message, /malformed JSON/);
    }
  });

  it('returns kind:invalid with structured field errors for schema violations', () => {
    const res = readDeployConfig('/proj', fileStub({
      [path.join('/proj', '.yolo', 'deploy.json')]: JSON.stringify({
        $version: 2,
        type: 'lambda',
        build: { command: 42 },
      }),
    }));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'invalid');
      assert.ok(res.errors);
      const paths = res.errors!.map((e) => e.path).sort();
      assert.deepEqual(paths, ['$version', 'build.command', 'type']);
    }
  });

  it('reads from the real filesystem by default', () => {
    const tmp = makeTmpDir();
    mkdirSync(path.join(tmp, '.yolo'));
    writeFileSync(path.join(tmp, '.yolo', 'deploy.json'), JSON.stringify({ $version: 1, type: 'static' }), 'utf8');
    const res = readDeployConfig(tmp);
    assert.equal(res.ok, true);
    if (res.ok) assert.equal(res.config?.type, 'static');
  });
});

// ─── validateDeployConfig ─────────────────────────────────────────────────

describe('deploy-config — validateDeployConfig', () => {
  it('accepts a minimal config ($version only — init may write a partial link)', () => {
    const res = validateDeployConfig({ $version: 1 });
    assert.equal(res.ok, true);
  });

  it('rejects a non-object top level', () => {
    const res = validateDeployConfig([1, 2]);
    assert.equal(res.ok, false);
    if (!res.ok) assert.equal(res.errors[0]!.path, '$');
  });

  it('requires $version === 1', () => {
    for (const bad of [undefined, 0, 2, '1']) {
      const res = validateDeployConfig({ $version: bad });
      assert.equal(res.ok, false, `expected $version=${String(bad)} to fail`);
      if (!res.ok) assert.equal(res.errors[0]!.path, '$version');
    }
  });

  it('collects ALL violations, not just the first', () => {
    const res = validateDeployConfig({
      $version: 1,
      projectId: '',
      compatibilityFlags: ['ok', 7],
      bindings: [{ kind: 'd1' }, 'nope'],
    });
    assert.equal(res.ok, false);
    if (!res.ok) {
      const paths = res.errors.map((e) => e.path).sort();
      assert.deepEqual(paths, ['bindings[0].binding', 'bindings[1]', 'compatibilityFlags[1]', 'projectId']);
    }
  });

  it('accepts worker.prebuilt as a boolean and rejects a non-boolean (codex P2 r9)', () => {
    assert.equal(validateDeployConfig({ $version: 1, worker: { entry: 'x.js', prebuilt: true } }).ok, true);
    const bad = validateDeployConfig({ $version: 1, worker: { entry: 'x.js', prebuilt: 'yes' } });
    assert.equal(bad.ok, false);
    if (!bad.ok) assert.equal(bad.errors[0]!.path, 'worker.prebuilt');
  });

  it('rejects non-object build / worker sections', () => {
    const res = validateDeployConfig({ $version: 1, build: 'npm run build', worker: ['src/index.ts'] });
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.deepEqual(res.errors.map((e) => e.path).sort(), ['build', 'worker']);
    }
  });

  it('tolerates binding entries with extra provisioning hints', () => {
    const res = validateDeployConfig({
      $version: 1,
      bindings: [{ kind: 'd1', binding: 'DB', databaseName: 'app-db' }],
    });
    assert.equal(res.ok, true);
  });

  it('returns no warnings for a clean, fully-known config', () => {
    const res = validateDeployConfig({
      $version: 1,
      projectId: 'hp_1',
      type: 'worker',
      worker: { entry: 'x.js', prebuilt: true },
      compatibilityFlags: ['nodejs_compat'],
      bindings: [{ kind: 'd1', binding: 'DB', databaseName: 'app-db' }],
    });
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.warnings, []);
  });

  it('warns (non-fatally) on unknown top-level / build / worker keys — forward compat keeps ok:true', () => {
    const res = validateDeployConfig({
      $version: 1,
      typo: true,
      build: { command: 'npm run build', oops: 1 },
      worker: { entry: 'x.js', nope: 'x' },
    });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.deepEqual(res.warnings.map((w) => w.path).sort(), ['build.oops', 'typo', 'worker.nope']);
      for (const w of res.warnings) assert.match(w.message, /unknown field .* ignored/);
    }
  });

  it('gives a targeted hint for the platform-fixed `compatibilityDate` field (field-report case)', () => {
    const res = validateDeployConfig({ $version: 1, compatibilityDate: '2024-09-01' });
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.warnings.length, 1);
      assert.equal(res.warnings[0]!.path, 'compatibilityDate');
      assert.match(res.warnings[0]!.message, /fixed by the platform.*compatibilityFlags/);
    }
  });
});

// ─── writeDeployConfig ────────────────────────────────────────────────────

describe('deploy-config — writeDeployConfig', () => {
  it('writes canonical 2-space JSON with fixed key order and a trailing newline', () => {
    const tmp = makeTmpDir();
    // Deliberately scrambled input key order — write must canonicalize.
    const scrambled = {
      bindings: [{ binding: 'DB', extra: 'x', kind: 'd1' }],
      type: 'worker',
      $version: 1,
      worker: { assetsDir: '.vinext/assets', entry: '.vinext/worker.mjs' },
      slug: 'my-app',
      compatibilityFlags: ['nodejs_compat'],
      projectId: 'hp_8f3a',
      build: { outputDir: 'dist', command: 'npm run build' },
    } as unknown as DeployConfig;
    const filePath = writeDeployConfig(tmp, scrambled);
    assert.equal(filePath, deployConfigPath(tmp));
    const text = readFileSync(filePath, 'utf8');
    assert.equal(text, [
      '{',
      '  "$version": 1,',
      '  "projectId": "hp_8f3a",',
      '  "slug": "my-app",',
      '  "type": "worker",',
      '  "build": {',
      '    "command": "npm run build",',
      '    "outputDir": "dist"',
      '  },',
      '  "worker": {',
      '    "entry": ".vinext/worker.mjs",',
      '    "assetsDir": ".vinext/assets"',
      '  },',
      '  "compatibilityFlags": [',
      '    "nodejs_compat"',
      '  ],',
      '  "bindings": [',
      '    {',
      '      "kind": "d1",',
      '      "binding": "DB",',
      '      "extra": "x"',
      '    }',
      '  ]',
      '}',
      '',
    ].join('\n'));
  });

  it('round-trips: write → read returns a deep-equal config', () => {
    const tmp = makeTmpDir();
    writeDeployConfig(tmp, FULL_CONFIG);
    const res = readDeployConfig(tmp);
    assert.equal(res.ok, true);
    if (res.ok) assert.deepEqual(res.config, FULL_CONFIG);
  });

  it('is idempotent — re-writing the read-back config produces byte-identical output', () => {
    const tmp = makeTmpDir();
    writeDeployConfig(tmp, FULL_CONFIG);
    const first = readFileSync(deployConfigPath(tmp), 'utf8');
    const readBack = readDeployConfig(tmp);
    assert.equal(readBack.ok, true);
    if (readBack.ok && readBack.config) writeDeployConfig(tmp, readBack.config);
    assert.equal(readFileSync(deployConfigPath(tmp), 'utf8'), first);
  });

  it('omits absent optional fields entirely (no "undefined" keys)', () => {
    const tmp = makeTmpDir();
    writeDeployConfig(tmp, { $version: 1, type: 'static', build: { outputDir: 'dist' } });
    const text = readFileSync(deployConfigPath(tmp), 'utf8');
    assert.ok(!text.includes('worker'));
    assert.ok(!text.includes('command'));
    assert.ok(!text.includes('bindings'));
  });

  it('creates .yolo/ when missing', () => {
    const tmp = makeTmpDir();
    const nested = path.join(tmp, 'sub', 'project');
    mkdirSync(nested, { recursive: true });
    writeDeployConfig(nested, { $version: 1 });
    assert.ok(readFileSync(deployConfigPath(nested), 'utf8').length > 0);
  });

  it('refuses to write an invalid config (throws DeployConfigError with structured errors)', () => {
    const tmp = makeTmpDir();
    assert.throws(
      () => writeDeployConfig(tmp, { $version: 1, type: 'lambda' } as unknown as DeployConfig),
      (err: unknown) => {
        assert.ok(err instanceof DeployConfigError);
        assert.equal(err.code, 'invalid');
        assert.equal(err.errors?.[0]?.path, 'type');
        return true;
      },
    );
  });
});
