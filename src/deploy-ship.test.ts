/**
 * deploy-ship orchestration tests — detect/bundle/client all stubbed via
 * the deps seam, asserted at the transcript level: the `deploy:` line
 * protocol (spec §4), missing-bucket-only uploads, the dry-run offline
 * stop, the awaiting-approval path, and the spec §5 exit-code map.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runDeployShip,
  exitCodeForFailure,
  formatShipSuccess,
  formatPending,
  formatFail,
  type DeployShipDeps,
  type DeployShipOptions,
} from './deploy-ship.js';
import type { BundleSuccess } from './deploy-bundle.js';
import type { ProjectShape } from './deploy-detect.js';
import type { DeployConfig, ReadDeployConfigResult } from './deploy-config.js';
import type { FinalizeShipResult, StartShipResponse } from './deploy-client.js';

const CONFIG: DeployConfig = { $version: 1, projectId: 'hp_8f3a', slug: 'my-app', type: 'static' };
const CONFIG_PATH = '/proj/.yolo/deploy.json';

function linked(config: DeployConfig | null): ReadDeployConfigResult {
  return { ok: true, config, path: CONFIG_PATH, warnings: [] };
}

const STATIC_SHAPE: ProjectShape = { type: 'static', assetsDir: 'dist' };

const STATIC_BUNDLE: BundleSuccess = {
  ok: true,
  type: 'static',
  manifest: {
    '/index.html': { hash: 'h1', size: 1024 },
    '/app.js': { hash: 'h2', size: 2048 },
  },
  assetPaths: {
    '/index.html': '/proj/dist/index.html',
    '/app.js': '/proj/dist/app.js',
  },
  assets: [
    { path: '/index.html', hash: 'h1', size: 1024, absPath: '/proj/dist/index.html' },
    { path: '/app.js', hash: 'h2', size: 2048, absPath: '/proj/dist/app.js' },
  ],
  module: null,
  workerModules: [],
  moduleSource: null,
  sourceMap: null,
  fileCount: 2,
  totalAssetBytes: 3072,
  bundleDigest: 'sha256:91c2aabbccdd',
  warnings: [],
};

const START_RESPONSE: StartShipResponse = {
  shipId: 'shp_77',
  missing: [['h2']],
  caps: { maxFileBytes: 26214400, maxTotalBytes: 268435456, maxFiles: 20000 },
};

const FINALIZE_LIVE: FinalizeShipResult = {
  ok: true,
  value: { releaseId: 'rel_0192', url: 'https://my-app.yolo.host', status: 'live' },
};

const ENV = { YOLO_COMMON_API_URL: 'https://api.example.com', YOLO_API_TOKEN: 'tok', HOME: '/home/test' };

interface Recorded {
  startCalls: Array<{ projectId: string; request: Record<string, unknown> }>;
  uploadCalls: Array<{ shipId: string; files: Array<{ hash: string; base64: string; contentType: string }> }>;
  finalizeCalls: Array<{ shipId: string; modules: Array<{ name: string }> }>;
}

function makeDeps(overrides: Partial<DeployShipDeps> = {}): { deps: DeployShipDeps; recorded: Recorded } {
  const recorded: Recorded = { startCalls: [], uploadCalls: [], finalizeCalls: [] };
  const deps: DeployShipDeps = {
    readDeployConfigImpl: () => linked({ ...CONFIG }),
    detectProjectShapeImpl: () => ({ ok: true, shape: { ...STATIC_SHAPE }, source: 'deploy-json' }),
    bundleProjectImpl: async () => ({ ...STATIC_BUNDLE }),
    startShipImpl: async (_ctx, projectId, request) => {
      recorded.startCalls.push({ projectId, request: request as unknown as Record<string, unknown> });
      return { ok: true, value: START_RESPONSE };
    },
    uploadAssetBucketImpl: async (_ctx, _projectId, shipId, files) => {
      recorded.uploadCalls.push({ shipId, files });
      return { ok: true, value: {} };
    },
    finalizeShipImpl: async (_ctx, _projectId, shipId, modules = []) => {
      recorded.finalizeCalls.push({ shipId, modules });
      return FINALIZE_LIVE;
    },
    readAssetFileImpl: () => new TextEncoder().encode('file-bytes'),
    resolveGitShaImpl: () => 'f'.repeat(40),
    ...overrides,
  };
  return { deps, recorded };
}

function runShip(deps: DeployShipDeps, options: Partial<DeployShipOptions> = {}) {
  const lines: string[] = [];
  const promise = runDeployShip({
    cwd: '/proj',
    env: ENV,
    readFileImpl: () => undefined,
    progress: (line) => lines.push(line),
    deps,
    ...options,
  });
  return { lines, promise };
}

// ─── Happy path ───────────────────────────────────────────────────────────

describe('deploy-ship — happy path (static)', () => {
  it('emits the spec §4 line protocol and returns the release', async () => {
    const { deps, recorded } = makeDeps();
    const { lines, promise } = runShip(deps);
    const result = await promise;

    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.dryRun, false);
      assert.equal(result.projectId, 'hp_8f3a');
      assert.equal(result.slug, 'my-app');
      assert.equal(result.env, 'staging');
      assert.equal(result.channel, 'preview');
      assert.equal(result.releaseId, 'rel_0192');
      assert.equal(result.url, 'https://my-app.yolo.host');
      assert.equal(result.shipId, 'shp_77');
    }

    assert.deepEqual(lines, [
      'deploy: link ok (project hp_8f3a, slug my-app, type static)',
      'deploy: bundle ok (dist/, 2 files, 0.0 MiB, digest sha256:91c2aabb…)',
      'deploy: ship/start ok (shipId shp_77, 1/2 assets missing, 0.0 MiB to upload)',
      'deploy: assets 1/1 buckets ok (0.0 MiB)',
      'deploy: finalize ok',
    ]);

    // startShip body: channel mapping + manifest + digest + gitSha.
    assert.equal(recorded.startCalls.length, 1);
    const request = recorded.startCalls[0]!.request;
    assert.equal(recorded.startCalls[0]!.projectId, 'hp_8f3a');
    assert.equal(request.env, 'preview');
    assert.equal(request.type, 'static');
    assert.deepEqual(request.manifest, {
      '/index.html': { hash: 'h1', size: 1024 },
      '/app.js': { hash: 'h2', size: 2048 },
    });
    assert.equal(request.bundleDigest, 'sha256:91c2aabbccdd');
    assert.equal(request.gitSha, 'f'.repeat(40));
    assert.equal(request.worker, undefined);

    // Upload: ONLY the missing hash (h2), base64-encoded with a content type.
    assert.equal(recorded.uploadCalls.length, 1);
    const files = recorded.uploadCalls[0]!.files;
    assert.equal(files.length, 1);
    assert.equal(files[0]!.hash, 'h2');
    assert.equal(files[0]!.base64, Buffer.from('file-bytes').toString('base64'));
    assert.equal(files[0]!.contentType, 'text/javascript');

    // Pure static → finalize with zero modules.
    assert.deepEqual(recorded.finalizeCalls, [{ shipId: 'shp_77', modules: [] }]);
  });

  it('surfaces a bootCheck from the finalize response into the success result + a progress warn', async () => {
    const { deps } = makeDeps({
      finalizeShipImpl: async () => ({
        ok: true,
        value: {
          releaseId: 'rel_0192',
          url: 'https://my-app.yolo.host',
          status: 'live',
          bootCheck: { ok: false, status: 522, detail: 'Worker failed to boot (522).' },
        },
      }),
    });
    const { lines, promise } = runShip(deps);
    const result = await promise;
    assert.equal(result.ok, true);
    if (result.ok) assert.deepEqual(result.bootCheck, { status: 522, detail: 'Worker failed to boot (522).' });
    assert.ok(lines.some((l) => /warn — deployed Worker failed to boot \(HTTP 522\)/.test(l)));
  });

  it('ignores a malformed bootCheck envelope (no field on the result)', async () => {
    const { deps } = makeDeps({
      finalizeShipImpl: async () => ({
        ok: true,
        value: { releaseId: 'rel_0192', url: 'https://my-app.yolo.host', status: 'live', bootCheck: { nope: true } },
      }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, true);
    if (result.ok) assert.equal(result.bootCheck, undefined);
  });

  it('runs the build command first and streams prefixed output', async () => {
    const { deps } = makeDeps({
      detectProjectShapeImpl: () => ({
        ok: true,
        shape: { ...STATIC_SHAPE, buildCommand: 'npm run build' },
        source: 'package-build',
      }),
      runBuildImpl: async (command, cwd, onOutput) => {
        assert.equal(command, 'npm run build');
        assert.equal(cwd, '/proj');
        onOutput('compiled 2 modules\n');
        return { code: 0 };
      },
    });
    const { lines, promise } = runShip(deps);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.ok(lines.includes('deploy: build> compiled 2 modules'));
    assert.ok(
      lines.some((l) => /^deploy: build `npm run build` \.\.\. ok \(\d+\.\ds\)$/.test(l)),
      `expected a build-ok line, got: ${JSON.stringify(lines)}`,
    );
  });

  it('ships worker modules: worker metadata on start, modules to finalize, prod channel', async () => {
    const module = { name: 'worker.js', contents: new TextEncoder().encode('export default {};') };
    const workerBundle: BundleSuccess = {
      ...STATIC_BUNDLE,
      type: 'worker',
      module,
      workerModules: [module],
      moduleSource: 'esbuild',
    };
    const { deps, recorded } = makeDeps({
      readDeployConfigImpl: () => linked({ ...CONFIG, type: 'worker', compatibilityFlags: ['nodejs_compat'] }),
      detectProjectShapeImpl: () => ({ ok: true, shape: { type: 'worker', entry: 'src/index.ts', assetsDir: 'dist' }, source: 'deploy-json' }),
      bundleProjectImpl: async () => workerBundle,
    });
    const { promise } = runShip(deps, { envFlag: 'prod' });
    const result = await promise;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.env, 'prod');
      assert.equal(result.channel, 'prod');
    }
    const request = recorded.startCalls[0]!.request;
    assert.equal(request.env, 'prod');
    assert.deepEqual(request.worker, { mainModule: 'worker.js', sizeBytes: 18 });
    assert.deepEqual(request.compatibilityFlags, ['nodejs_compat']);
    assert.equal(recorded.finalizeCalls[0]!.modules.length, 1);
    assert.equal(recorded.finalizeCalls[0]!.modules[0]!.name, 'worker.js');
  });

  it('skips uploads entirely when the server already has every asset', async () => {
    const { deps, recorded } = makeDeps({
      startShipImpl: async () => ({ ok: true, value: { ...START_RESPONSE, missing: [] } }),
    });
    const { lines, promise } = runShip(deps);
    const result = await promise;
    assert.equal(result.ok, true);
    assert.equal(recorded.uploadCalls.length, 0);
    assert.ok(lines.includes('deploy: assets 0/0 buckets ok (0.0 MiB)'));
  });
});

// ─── Dry run ──────────────────────────────────────────────────────────────

describe('deploy-ship — dry run', () => {
  it('stops after bundle, fully offline (no auth, no client legs)', async () => {
    const { deps, recorded } = makeDeps({
      startShipImpl: async () => {
        throw new Error('startShip must not be called in dry-run');
      },
    });
    // No env / no token: dry-run must not even resolve auth.
    const { lines, promise } = runShip(deps, { dryRun: true, env: {} });
    const result = await promise;
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.dryRun, true);
      assert.equal(result.fileCount, 2);
      assert.equal(result.totalAssetBytes, 3072);
      assert.equal(result.bundleDigest, 'sha256:91c2aabbccdd');
    }
    assert.equal(recorded.uploadCalls.length, 0);
    assert.equal(recorded.finalizeCalls.length, 0);
    assert.equal(lines[lines.length - 1], 'deploy: bundle ok (dist/, 2 files, 0.0 MiB, digest sha256:91c2aabb…)');
  });
});

// ─── Failure paths ────────────────────────────────────────────────────────

describe('deploy-ship — failures', () => {
  it('not-linked when no config / no projectId, with the init hint', async () => {
    const { deps } = makeDeps({ readDeployConfigImpl: () => linked(null) });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'not-linked');
      assert.ok('hint' in result && typeof result.hint === 'string' && result.hint.includes('yolo deploy init'));
    }
  });

  it('malformed deploy.json is a local failure (exit-1 kind), not not-linked', async () => {
    const { deps } = makeDeps({
      readDeployConfigImpl: () => ({ ok: false, kind: 'malformed', path: CONFIG_PATH, message: 'Unexpected token } in JSON' }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'malformed');
      assert.equal(exitCodeForFailure(result.kind), 1);
    }
  });

  it('detect-failed passes the detector message through', async () => {
    const { deps } = makeDeps({
      detectProjectShapeImpl: () => ({ ok: false, kind: 'detect-failed', message: "run 'yolo deploy init --type static|worker'" }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'detect-failed');
      assert.match(result.message, /yolo deploy init/);
    }
  });

  it('build-failed on a non-zero build exit', async () => {
    const { deps } = makeDeps({
      detectProjectShapeImpl: () => ({ ok: true, shape: { ...STATIC_SHAPE, buildCommand: 'npm run build' }, source: 'package-build' }),
      runBuildImpl: async () => ({ code: 2 }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'build-failed');
      assert.match(result.message, /exited with code 2/);
    }
  });

  it('bundle failure kinds pass through verbatim', async () => {
    const { deps } = makeDeps({
      bundleProjectImpl: async () => ({
        ok: false,
        kind: 'file-too-large',
        message: 'dist/video.mp4 is 30 MiB (limit 25 MiB)',
        detail: { path: 'dist/video.mp4' },
      }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'file-too-large');
      assert.ok('detail' in result && result.detail);
    }
  });

  it('auth failure (post-bundle) when no token is available', async () => {
    const { deps } = makeDeps();
    const result = await runShip(deps, { env: { YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/h' } }).promise;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'auth');
  });

  it('backend refusal from ship/start passes through (reason + hint)', async () => {
    const { deps } = makeDeps({
      startShipImpl: async () => ({ ok: false, kind: 'quota-exceeded', message: 'cap', hint: 'upgrade', status: 429 }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.kind, 'quota-exceeded');
      assert.ok('hint' in result && result.hint === 'upgrade');
    }
  });

  it('bundle-rejected when the server asks for a hash we never produced', async () => {
    const { deps, recorded } = makeDeps({
      startShipImpl: async () => ({ ok: true, value: { ...START_RESPONSE, missing: [['h-unknown']] } }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'bundle-rejected');
    assert.equal(recorded.uploadCalls.length, 0);
  });

  it('upload-expired (410) from finalize passes through as a backend failure', async () => {
    const { deps } = makeDeps({
      finalizeShipImpl: async () => ({ ok: false, kind: 'upload-expired', message: 'ship session lapsed', status: 410 }),
    });
    const result = await runShip(deps).promise;
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'upload-expired');
  });
});

// ─── Awaiting approval (T3 prod gate) ─────────────────────────────────────

describe('deploy-ship — awaiting-approval', () => {
  it('returns the pending outcome with approval fields + emits the pending progress line', async () => {
    const { deps } = makeDeps({
      finalizeShipImpl: async () => ({
        ok: false,
        kind: 'awaiting-approval',
        approvalId: 'apr_55',
        approvalUrl: 'https://studio.yolo.dev/approvals/apr_55',
        releaseId: 'rel_0193',
        message: 'prod ship needs operator confirmation',
        status: 409,
      }),
    });
    const { lines, promise } = runShip(deps, { envFlag: 'prod' });
    const result = await promise;
    assert.equal(result.ok, false);
    if (!result.ok && result.kind === 'awaiting-approval' && 'approvalId' in result) {
      assert.equal(result.approvalId, 'apr_55');
      assert.equal(result.approvalUrl, 'https://studio.yolo.dev/approvals/apr_55');
      assert.equal(result.releaseId, 'rel_0193');
      assert.equal(result.slug, 'my-app');
    } else {
      assert.fail(`expected awaiting-approval, got ${JSON.stringify(result)}`);
    }
    assert.equal(lines[lines.length - 1], 'deploy: finalize → pending operator approval (T3 prod ship)');
  });
});

// ─── Formatters ───────────────────────────────────────────────────────────

describe('deploy-ship — formatters', () => {
  it('formatShipSuccess matches the spec OK line', () => {
    const line = formatShipSuccess({
      ok: true,
      dryRun: false,
      projectId: 'hp_8f3a',
      slug: 'my-app',
      env: 'staging',
      channel: 'preview',
      type: 'static',
      fileCount: 142,
      totalAssetBytes: 3355443,
      bundleDigest: 'sha256:91c2aabb',
      releaseId: 'rel_0192',
      url: 'https://my-app.yolo.host',
    });
    assert.equal(line, 'OK: shipped my-app release rel_0192 → https://my-app.yolo.host (staging)');
  });

  it('formatPending uses the PENDING prefix (never FAIL) with URL + do-NOT-rerun hint', () => {
    const text = formatPending({
      ok: false,
      kind: 'awaiting-approval',
      projectId: 'hp_8f3a',
      slug: 'my-app',
      approvalId: 'apr_55',
      approvalUrl: 'https://studio.yolo.dev/approvals/apr_55',
      releaseId: 'rel_0193',
      message: 'needs confirmation',
    });
    assert.ok(text.startsWith('PENDING [awaiting-approval]: prod ship of my-app (release-candidate rel_0193)'));
    assert.ok(!text.includes('FAIL'));
    assert.ok(text.includes('https://studio.yolo.dev/approvals/apr_55'));
    assert.ok(text.includes('rerun `yolo deploy`'));
    assert.ok(text.includes('A rerun BEFORE the grant is harmless'));
    assert.ok(text.includes('Approvals panel'));
  });

  it('formatFail renders the single structured line with hint', () => {
    assert.equal(
      formatFail({ kind: 'quota-exceeded', message: 'cap reached', hint: 'upgrade' }),
      'FAIL [quota-exceeded]: cap reached | hint: upgrade',
    );
    assert.equal(formatFail({ kind: 'network', message: 'ECONNREFUSED' }), 'FAIL [network]: ECONNREFUSED');
  });
});

// ─── Exit-code map (spec §5 — EXACT) ──────────────────────────────────────

describe('deploy-ship — exitCodeForFailure', () => {
  it('maps every spec §5 row exactly', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('session-required'), 78);
    assert.equal(exitCodeForFailure('auth'), 78);
    for (const local of ['not-linked', 'detect-failed', 'build-failed', 'file-too-large', 'too-many-files', 'bundle-too-large']) {
      assert.equal(exitCodeForFailure(local), 1, local);
    }
    for (const backend of [
      'slug-taken',
      'project-not-found',
      'quota-exceeded',
      'entitlement-lapsed',
      'hosting-disabled',
      'bundle-rejected',
      'upload-expired',
      'release-not-found',
    ]) {
      assert.equal(exitCodeForFailure(backend), 2, backend);
    }
    assert.equal(exitCodeForFailure('awaiting-approval'), 3);
    assert.equal(exitCodeForFailure('network'), 4);
    // Unknown backend reasons are backend-rejected by default (don't blind-retry).
    assert.equal(exitCodeForFailure('some-future-reason'), 2);
  });
});
