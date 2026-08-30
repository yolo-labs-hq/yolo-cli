/**
 * deploy-cli tests — arg parsing, subcommand dispatch, and the output/exit
 * contract (spec §1 + §5): FAIL lines, the PENDING/exit-3 path (two
 * independent do-not-retry signals), --json stream split, and the wired
 * subcommand legs (init/status/logs/rollback; db = Phase 2, refused).
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  runDeployCmd,
  parseSinceMinutes,
  parseDbQueryArgs,
  parseDevArgs,
  parseRenameArgs,
  parseAliasArgs,
  parseRedirectArgs,
  parseSetParentArgs,
  parseDeleteArgs,
  parseCloneArgs,
  formatRowsTable,
  type DeployCliDeps,
  type DeployIo,
} from './deploy-cli.js';
import type { DeployShipResult } from './deploy-ship.js';

const ENV = { YOLO_COMMON_API_URL: 'https://api.example.com', YOLO_API_TOKEN: 'tok', HOME: '/home/test' };

function makeIo(): DeployIo & { stdout: string[]; stderr: string[] } {
  const stdout: string[] = [];
  const stderr: string[] = [];
  return { stdout, stderr, out: (t) => stdout.push(t), err: (t) => stderr.push(t) };
}

const SHIP_SUCCESS: DeployShipResult = {
  ok: true,
  dryRun: false,
  projectId: 'hp_8f3a',
  slug: 'my-app',
  env: 'staging',
  channel: 'preview',
  type: 'static',
  fileCount: 2,
  totalAssetBytes: 3072,
  bundleDigest: 'sha256:91c2aabb',
  shipId: 'shp_77',
  releaseId: 'rel_0192',
  url: 'https://my-app.yolo.host',
};

const SHIP_PENDING: DeployShipResult = {
  ok: false,
  kind: 'awaiting-approval',
  projectId: 'hp_8f3a',
  slug: 'my-app',
  approvalId: 'apr_55',
  approvalUrl: 'https://studio.yolo.dev/approvals/apr_55',
  releaseId: 'rel_0193',
  message: 'prod ship needs operator confirmation',
};

const CONFIG_PATH = '/proj/.yolo/deploy.json';

function linked(config: { $version: 1; projectId?: string; slug?: string } | null) {
  return { ok: true as const, config, path: CONFIG_PATH, warnings: [] };
}

function baseDeps(io: DeployIo, overrides: Partial<DeployCliDeps> = {}): DeployCliDeps {
  return {
    cwd: '/proj',
    env: ENV,
    io,
    readFileImpl: () => undefined,
    readDeployConfigImpl: () => linked({ $version: 1, projectId: 'hp_8f3a', slug: 'my-app' }),
    ...overrides,
  };
}

// ─── Usage / dispatch ─────────────────────────────────────────────────────

describe('deploy-cli — usage & dispatch', () => {
  it('rejects a bad --env value with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['--env', 'production'], baseDeps(io));
    assert.equal(code, 64);
    assert.match(io.stderr.join(''), /--env must be 'staging' or 'prod'/);
  });

  it('rejects an unknown flag with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['--frobnicate'], baseDeps(io));
    assert.equal(code, 64);
  });

  it('rejects an unknown subcommand with exit 64 + usage', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['promote'], baseDeps(io));
    assert.equal(code, 64);
    assert.match(io.stderr.join(''), /unknown subcommand 'promote'/);
  });

  it('rejects an unknown db subcommand with exit 64 + MCP-only note', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['db', 'provision'], baseDeps(io));
    assert.equal(code, 64);
    assert.match(io.stderr.join(''), /unknown subcommand 'provision'/);
    assert.match(io.stderr.join(''), /MCP-only/);
  });

  it('rejects a bare `db` (no verb) with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['db'], baseDeps(io));
    assert.equal(code, 64);
  });

  it('prints deploy usage on --help with exit 0', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['--help'], baseDeps(io));
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /yolo deploy init/);
  });
});

// ─── validate ─────────────────────────────────────────────────────────────

describe('deploy-cli — validate', () => {
  const workerCfg = {
    ok: true as const,
    config: { $version: 1 as const, projectId: 'hp_1', slug: 'app', type: 'worker' as const, worker: { entry: 'src/index.ts' } },
    path: CONFIG_PATH,
    warnings: [],
  };

  it('passes a valid worker config whose entry exists (exit 0)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg, statPathImpl: () => 'file' }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /OK: deploy config is valid/);
    assert.match(io.stdout.join(''), /entry: src\/index\.ts/);
  });

  it('fails when the worker entry does not exist (exit 1)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg, statPathImpl: () => 'missing' }),
    );
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /FAIL: deploy config is not valid/);
    assert.match(io.stderr.join(''), /worker\.entry: entry 'src\/index\.ts' does not exist/);
  });

  it('fails when the worker entry is a directory, not a file (exit 1)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg, statPathImpl: () => 'dir' }),
    );
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /worker\.entry: 'src\/index\.ts' is not a file \(it's a dir\)/);
  });

  it('reports schema errors with their path (exit 1)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        readDeployConfigImpl: () => ({
          ok: false as const,
          kind: 'invalid' as const,
          path: CONFIG_PATH,
          message: 'invalid deploy config',
          errors: [{ path: '$version', message: 'must be the number 1, got 2' }],
        }),
      }),
    );
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /\$version: must be the number 1, got 2/);
  });

  it('echoes a non-fatal warning for an unknown/ignored deploy.json field but still passes (exit 0)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: { $version: 1 as const, projectId: 'hp_1', slug: 's', type: 'static' as const, build: { command: 'npm run build', outputDir: 'dist' } },
          path: CONFIG_PATH,
          warnings: [{ path: 'compatibilityDate', message: "unknown field 'compatibilityDate' — ignored. The Worker compatibility date is fixed by the platform and is not configurable via deploy.json; use 'compatibilityFlags' for runtime flags (e.g. [\"nodejs_compat\"])." }],
        }),
        statPathImpl: () => 'dir',
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /warn: compatibilityDate: .*fixed by the platform/);
  });

  it('passes a static project with a build command even if the output dir is missing (note, exit 0)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: { $version: 1 as const, slug: 's', type: 'static' as const, build: { command: 'npm run build', outputDir: 'dist' } },
          path: CONFIG_PATH,
          warnings: [],
        }),
        statPathImpl: () => 'missing', // dist not built yet
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /note:.*produced by the build/);
  });

  it('passes a static project whose build command is INFERRED from package.json (note, exit 0)', async () => {
    const io = makeIo();
    const pkgJson = JSON.stringify({ scripts: { build: 'vite build' } });
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        // No explicit build.command — detection infers `npm run build` from the
        // package.json build script, so the missing dist/ is a note, not error.
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: { $version: 1 as const, slug: 's', type: 'static' as const, build: { outputDir: 'dist' } },
          path: CONFIG_PATH,
          warnings: [],
        }),
        readFileImpl: (p: string) => (p.endsWith('package.json') ? pkgJson : undefined),
        statPathImpl: () => 'missing',
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /note:.*produced by the build/);
  });

  it('a missing SOURCE worker entry is still an ERROR even with a build command (esbuild bundles it, build does not create it)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        // Source worker (not prebuilt) + a package.json build script → the
        // detected shape carries buildCommand, but the entry is bundled in
        // place, so a typo'd missing entry must NOT be excused as "built".
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: { $version: 1 as const, slug: 'api', type: 'worker' as const, worker: { entry: 'src/indx.ts' } },
          path: CONFIG_PATH,
          warnings: [],
        }),
        readFileImpl: (p: string) => (p.endsWith('package.json') ? JSON.stringify({ scripts: { build: 'tsc' } }) : undefined),
        statPathImpl: () => 'missing',
      }),
    );
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /worker\.entry: entry 'src\/indx\.ts' does not exist/);
  });

  it('a missing PREBUILT worker entry with a build command is a NOTE (the build produces it)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: {
            $version: 1 as const,
            slug: 'api',
            type: 'worker' as const,
            worker: { entry: 'dist/worker.mjs', prebuilt: true },
            build: { command: 'tsc' },
          },
          path: CONFIG_PATH,
          warnings: [],
        }),
        readFileImpl: () => undefined,
        statPathImpl: () => 'missing',
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /note:.*produced by the build/);
  });

  it('notes a present wrangler.toml (de-silences the minimal-toml-support gotcha)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        readDeployConfigImpl: () => workerCfg,
        statPathImpl: () => 'file',
        // wrangler.toml present on disk alongside a valid deploy.json.
        readFileImpl: (p: string) => (p.endsWith('wrangler.toml') ? 'main = "src/index.ts"\n' : undefined),
      }),
    );
    assert.equal(code, 0); // a note, not an error
    assert.match(io.stdout.join(''), /note:.*wrangler\.toml found/);
  });

  it('does NOT note wrangler.toml when none is present', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg, statPathImpl: () => 'file', readFileImpl: () => undefined }),
    );
    assert.equal(code, 0);
    assert.doesNotMatch(io.stdout.join(''), /wrangler\.toml/);
  });

  it('rejects unknown flags/positionals with exit 64', async () => {
    const io = makeIo();
    assert.equal(await runDeployCmd(['validate', '--jsoon'], baseDeps(io)), 64);
    assert.match(io.stderr.join(''), /unexpected argument/);
    const io2 = makeIo();
    assert.equal(await runDeployCmd(['validate', './dist'], baseDeps(io2)), 64);
  });

  it('--json emits a machine-readable result and exits 1 on failure', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate', '--json'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg, statPathImpl: () => 'missing' }),
    );
    assert.equal(code, 1);
    const parsed = JSON.parse(io.stdout.join('').trim());
    assert.equal(parsed.ok, false);
    assert.ok(parsed.issues.some((i: { path?: string }) => i.path === 'worker.entry'));
  });
});

// ─── dev arg parsing + dispatch ──────────────────────────────────────────────

describe('deploy-cli — dev arg parsing', () => {
  it('parses --port, --host, and repeatable --var KEY=VALUE', () => {
    const p = parseDevArgs(['--port', '3000', '--host', '0.0.0.0', '--var', 'A=1', '--var', 'B=two=2']);
    assert.ok(p.ok);
    if (p.ok) {
      assert.equal(p.port, 3000);
      assert.equal(p.host, '0.0.0.0');
      assert.deepEqual(p.vars, { A: '1', B: 'two=2' }); // only the FIRST '=' splits
    }
  });

  it('accepts --port=/--var= forms and defaults host/port to undefined', () => {
    const p = parseDevArgs(['--port=0', '--var=X=y']);
    assert.ok(p.ok);
    if (p.ok) {
      assert.equal(p.port, 0);
      assert.deepEqual(p.vars, { X: 'y' });
      assert.equal(p.host, undefined);
    }
  });

  it('rejects a non-numeric / out-of-range port', () => {
    assert.equal(parseDevArgs(['--port', 'abc']).ok, false);
    assert.equal(parseDevArgs(['--port', '70000']).ok, false);
  });

  it('rejects a --var without =', () => {
    assert.equal(parseDevArgs(['--var', 'NOPE']).ok, false);
  });

  it('rejects an unexpected positional', () => {
    assert.equal(parseDevArgs(['serve']).ok, false);
  });
});

describe('deploy-cli — dev dispatch', () => {
  it('rejects bad dev flags with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['dev', '--port', 'nope'], baseDeps(io));
    assert.equal(code, 64);
    assert.match(io.stderr.join(''), /--port must be an integer/);
  });

  it('runs the dev server via seamed deps and exits 0', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['dev', '--var', 'FOO=bar'],
      baseDeps(io, {
        devDeps: {
          readDeployConfigImpl: () => ({ ok: true, config: { $version: 1, projectId: 'hp_1', type: 'worker', worker: { entry: 'src/index.ts' } }, path: '/proj/.yolo/deploy.json', warnings: [] }),
          detectProjectShapeImpl: () => ({ ok: true, shape: { type: 'worker', entry: 'src/index.ts' }, source: 'deploy-json' }),
          bundleProjectImpl: async () => ({
            ok: true, type: 'worker', manifest: {}, assetPaths: {}, assets: [],
            module: { name: 'index.js', contents: new TextEncoder().encode('export default {};') },
            workerModules: [{ name: 'index.js', contents: new TextEncoder().encode('export default {};') }],
            moduleSource: 'esbuild', sourceMap: null, fileCount: 0, totalAssetBytes: 0, bundleDigest: 'sha256:x', warnings: [],
          }),
          startImpl: async () => ({ url: 'http://127.0.0.1:8787/', dispose: async () => {} }),
          waitForStopImpl: async () => {},
        },
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /serving worker on http:\/\/127\.0\.0\.1:8787\//);
  });
});

// ─── doctor ─────────────────────────────────────────────────────────────────

describe('deploy-cli — doctor', () => {
  const workerCfg = (extra: Record<string, unknown> = {}, worker: Record<string, unknown> = { entry: 'src/index.ts' }) => ({
    ok: true as const,
    config: { $version: 1 as const, projectId: 'hp_1', slug: 'app', type: 'worker' as const, worker, ...extra },
    path: CONFIG_PATH,
    warnings: [],
  });
  const withEntry = (io: DeployIo, src: string, extra: Record<string, unknown> = {}, worker?: Record<string, unknown>) =>
    baseDeps(io, { readDeployConfigImpl: () => workerCfg(extra, worker), statPathImpl: () => 'file', readFileImpl: () => src });

  it('passes a clean worker entry (exit 0, no warnings)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor'], withEntry(io, 'export default { fetch(req, env) { return new Response(env.NAME); } };'));
    assert.equal(code, 0);
    const out = io.stdout.join('');
    assert.match(out, /no runtime-contract issues found/);
    assert.match(out, /NODE_ENV pinned to production by the bundler/);
  });

  it('flags a process.env read (advisory ⚠, exit 0)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor'], withEntry(io, 'export default { fetch(req) { return new Response(process.env.API_KEY); } };'));
    assert.equal(code, 0); // advisory — does not fail
    const out = io.stdout.join('');
    assert.match(out, /reads process\.env\.API_KEY/);
    assert.match(out, /workerd has no runtime process\.env/);
  });

  it('does not flag process.env.NODE_ENV (bundler pins it)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor'], withEntry(io, 'const p = process.env.NODE_ENV === "production"; export default { fetch() { return new Response(String(p)); } };'));
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /no process\.env reads \(other than NODE_ENV\)/);
  });

  it('warns on a node: import when nodejs_compat is absent', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor'], withEntry(io, 'import { randomUUID } from "node:crypto"; export default { fetch() { return new Response(randomUUID()); } };'));
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /imports node: builtins \(node:crypto\), deploy\.json missing nodejs_compat/);
  });

  it('passes a node: import when nodejs_compat is set', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor'], withEntry(io, 'import { randomUUID } from "node:crypto"; export default { fetch() { return new Response(randomUUID()); } };', { compatibilityFlags: ['nodejs_compat'] }));
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /node: builtins \(node:crypto\) covered by nodejs_compat/);
  });

  it('warns on a require() of a node: builtin', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor'], withEntry(io, 'const fs = require("node:fs"); export default { fetch() { return new Response(typeof fs); } };', { compatibilityFlags: ['nodejs_compat'] }));
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /uses require\(\) of a node: builtin/);
  });

  it('warns on an unpinned NODE_ENV in a prebuilt bundle', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['doctor'],
      withEntry(io, 'export default { fetch() { return new Response(process.env.NODE_ENV); } };', {}, { entry: '.vinext/worker.mjs', prebuilt: true }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /prebuilt bundle references an unpinned process\.env\.NODE_ENV/);
  });

  it('fails (exit 1) when a source entry is missing', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['doctor'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg(), statPathImpl: () => 'missing' }),
    );
    assert.equal(code, 1);
    assert.match(io.stdout.join('') + io.stderr.join(''), /does not exist/);
  });

  it('fails (exit 1) for a missing SOURCE entry even with a build command (typo, not build output)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['doctor'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg({ build: { command: 'npm run build' } }), statPathImpl: () => 'missing' }),
    );
    assert.equal(code, 1);
    assert.match(io.stdout.join(''), /does not exist/);
  });

  it('is OK (exit 0) for a missing PREBUILT entry — build output, not yet produced', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['doctor'],
      baseDeps(io, { readDeployConfigImpl: () => workerCfg({}, { entry: '.vinext/worker.mjs', prebuilt: true }), statPathImpl: () => 'missing' }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /not built yet/);
  });

  it('reports static projects as N/A for the worker runtime contract', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['doctor'],
      baseDeps(io, {
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: { $version: 1 as const, projectId: 'hp_1', slug: 's', type: 'static' as const, build: { outputDir: 'dist' } },
          path: CONFIG_PATH,
          warnings: [],
        }),
        statPathImpl: () => 'dir',
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /static site — the workerd runtime contract applies to Workers only/);
  });

  it('emits --json with checks and hardError=false', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor', '--json'], withEntry(io, 'export default { fetch(req, env) { return new Response(env.X); } };'));
    assert.equal(code, 0);
    const parsed = JSON.parse(io.stdout.join('').trim());
    assert.equal(parsed.ok, true);
    assert.equal(parsed.hardError, false);
    assert.ok(Array.isArray(parsed.checks));
  });

  it('rejects an unexpected argument with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['doctor', '--frobnicate'], withEntry(io, 'export default {};'));
    assert.equal(code, 64);
  });
});

// ─── Bare ship ────────────────────────────────────────────────────────────

describe('deploy-cli — bare ship', () => {
  it('defaults to staging, prints the OK line, exits 0', async () => {
    const io = makeIo();
    let seenOptions: Record<string, unknown> = {};
    const code = await runDeployCmd(
      [],
      baseDeps(io, {
        runShipImpl: async (options) => {
          seenOptions = options as unknown as Record<string, unknown>;
          options.progress?.('deploy: finalize ok');
          return SHIP_SUCCESS;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(seenOptions.envFlag, 'staging');
    assert.equal(seenOptions.dryRun, false);
    const out = io.stdout.join('');
    assert.ok(out.includes('deploy: finalize ok\n'), 'progress goes to stdout without --json');
    assert.ok(out.includes('OK: shipped my-app release rel_0192 → https://my-app.yolo.host (staging)\n'));
  });

  it('prints a boot-failure warning (stderr) when the ship succeeded but the Worker did not boot (exit 0)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      [],
      baseDeps(io, {
        runShipImpl: async () => ({
          ...SHIP_SUCCESS,
          bootCheck: { status: 522, detail: 'The deployed Worker failed to boot — Cloudflare returned 522, the script did not instantiate.' },
        }),
      }),
    );
    assert.equal(code, 0); // still a success — the release is staged
    assert.ok(io.stdout.join('').includes('OK: shipped'), 'success line still printed');
    assert.match(io.stderr.join(''), /warn:.*failed to boot.*522/);
  });

  it('--json carries bootCheck and emits no human warn line', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['--json'],
      baseDeps(io, {
        runShipImpl: async () => ({
          ...SHIP_SUCCESS,
          bootCheck: { status: 522, detail: 'boot failed' },
        }),
      }),
    );
    assert.equal(code, 0);
    const payload = JSON.parse(io.stdout.join(''));
    assert.deepEqual(payload.bootCheck, { status: 522, detail: 'boot failed' });
    assert.equal(io.stderr.join('').includes('warn:'), false);
  });

  it('--env prod and --dry-run thread through to the orchestrator', async () => {
    const io = makeIo();
    let seenOptions: Record<string, unknown> = {};
    await runDeployCmd(
      ['--env', 'prod', '--dry-run'],
      baseDeps(io, {
        runShipImpl: async (options) => {
          seenOptions = options as unknown as Record<string, unknown>;
          return { ...SHIP_SUCCESS, dryRun: true, env: 'prod', channel: 'prod' };
        },
      }),
    );
    assert.equal(seenOptions.envFlag, 'prod');
    assert.equal(seenOptions.dryRun, true);
  });

  it('--json routes progress to stderr and emits one final JSON object on stdout', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['--json'],
      baseDeps(io, {
        runShipImpl: async (options) => {
          options.progress?.('deploy: bundle ok (dist/, 2 files, 0.0 MiB, digest sha256:91c2aabb…)');
          return SHIP_SUCCESS;
        },
      }),
    );
    assert.equal(code, 0);
    assert.match(io.stderr.join(''), /deploy: bundle ok/);
    assert.ok(!io.stdout.join('').includes('deploy: bundle ok'));
    const parsed = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
    assert.equal(parsed.releaseId, 'rel_0192');
    assert.equal(parsed.url, 'https://my-app.yolo.host');
    assert.equal(parsed.env, 'staging');
    assert.equal(parsed.ok, undefined, 'ok discriminant is stripped (exit code conveys it)');
  });

  it('awaiting-approval prints PENDING (not FAIL) with URL + rerun-once-after-grant hint, exit 3', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['--env', 'prod'],
      baseDeps(io, { runShipImpl: async () => SHIP_PENDING }),
    );
    assert.equal(code, 3);
    const err = io.stderr.join('');
    assert.ok(err.startsWith('PENDING [awaiting-approval]:'), `expected PENDING prefix, got: ${err}`);
    assert.ok(!err.includes('FAIL'));
    assert.ok(err.includes('https://studio.yolo.dev/approvals/apr_55'));
    assert.ok(err.includes('rerun `yolo deploy --env prod`'));
    assert.ok(err.includes('A rerun BEFORE the grant is harmless'));
  });

  it('awaiting-approval under --json emits the JSON result on stdout, exit 3', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['--env', 'prod', '--json'], baseDeps(io, { runShipImpl: async () => SHIP_PENDING }));
    assert.equal(code, 3);
    const parsed = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
    assert.equal(parsed.kind, 'awaiting-approval');
    assert.equal(parsed.approvalId, 'apr_55');
    assert.match(String(parsed.hint), /rerun 'yolo deploy --env prod'/);
    assert.match(String(parsed.hint), /early rerun is harmless/);
  });

  it('maps failure kinds onto the spec §5 exit codes (1 local, 2 backend, 4 network, 78 auth)', async () => {
    const cases: Array<[string, number]> = [
      ['not-linked', 1],
      ['build-failed', 1],
      ['quota-exceeded', 2],
      ['upload-expired', 2],
      ['network', 4],
      ['auth', 78],
    ];
    for (const [kind, expected] of cases) {
      const io = makeIo();
      const code = await runDeployCmd(
        [],
        baseDeps(io, { runShipImpl: async () => ({ ok: false, kind, message: `${kind} happened` }) }),
      );
      assert.equal(code, expected, kind);
      assert.match(io.stderr.join(''), new RegExp(`FAIL \\[${kind}\\]: ${kind} happened`));
    }
  });
});

// ─── init ─────────────────────────────────────────────────────────────────

describe('deploy-cli — init', () => {
  // Nesting S4 — `--parent` links the new project under an existing one.
  it('--parent passes the id through to create and does NOT persist it locally', async () => {
    const io = makeIo();
    const written: Array<{ cwd: string; config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api', '--type', 'worker', '--parent', '6a736e980ebe7300095936e6'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        // Resolution tries SLUG first (a slug may legally be 24 hex chars);
        // no match, so the id-shaped value passes through.
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        createProjectImpl: async (_ctx, request) => {
          assert.equal(request.parentProjectId, '6a736e980ebe7300095936e6');
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: (cwd, config) => {
          written.push({ cwd, config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    // The parent link lives on the project document, not in deploy.json —
    // duplicating it locally would just create a second thing to drift.
    assert.equal('parentProjectId' in written[0]!.config, false);
  });

  // ── Inferred parent — the upward walk (nesting §10 S4) ──────────────────
  // `yolo deploy init` inside `apps/api` used to mint a fully independent
  // project named after the directory. That is how `El Paso Ballroom API` came
  // to sit as an unrelated top-level card beside the site it serves.

  const PARENT_ID = '6a736e980ebe7300095936e6';
  const ancestorFs = (files: Record<string, string>) => (p: string) => files[p];
  const ancestorAt = (dir: string, id = PARENT_ID) => ({
    [`${dir}/.yolo/deploy.json`]: JSON.stringify({ projectId: id, slug: 'my-site' }),
  });
  const rootParent = [{ id: PARENT_ID, slug: 'my-site', parentProjectId: null, status: 'active' }];

  it('infers the parent from an ancestor link and passes it to create', async () => {
    const io = makeIo();
    let sent: string | undefined;
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: rootParent }),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0);
    assert.equal(sent, PARENT_ID);
  });

  it('🚨 SAYS it inferred, names the source file, and gives the undo', async () => {
    // A parent nobody asked for, applied silently, is the worst outcome here —
    // the caller would only find out from the console.
    const io = makeIo();
    await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: rootParent }),
        createProjectImpl: async () => ({ ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } }),
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    const out = io.stdout.join('');
    assert.match(out, /nested under my-site/);
    assert.match(out, /inferred from .*\/repo\/\.yolo\/deploy\.json/);
    assert.match(out, /--no-parent/);
    assert.match(out, /set-parent --none/);
  });

  it('--json carries parentProjectId and parentInferredFrom', async () => {
    // Nesting is invisible in deploy.json by design, so JSON callers would
    // otherwise have no way to see it happened.
    const io = makeIo();
    await runDeployCmd(
      ['init', '--slug', 'my-api', '--json'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: rootParent }),
        createProjectImpl: async () => ({ ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } }),
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    const payload = JSON.parse(io.stdout.join(''));
    assert.equal(payload.parentProjectId, PARENT_ID);
    assert.match(String(payload.parentInferredFrom), /\/repo\/\.yolo\/deploy\.json$/);
    assert.equal(io.stderr.join(''), '', 'JSON mode keeps stderr empty');
  });

  it('--no-parent suppresses the walk and creates a root', async () => {
    const io = makeIo();
    let sent: unknown = 'unset';
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api', '--no-parent'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: rootParent }),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0);
    assert.equal(sent, undefined);
    assert.doesNotMatch(io.stdout.join(''), /inferred from/);
  });

  it('rejects --parent together with --no-parent', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['init', '--parent', 'x', '--no-parent'], baseDeps(io));
    assert.notEqual(code, 0);
    assert.match(io.stderr.join('') + io.stdout.join(''), /mutually exclusive/);
  });

  it('🚨 an ancestor that is NOT a root is dropped — init still succeeds', async () => {
    // The server accepts roots only. An inference is a suggestion, so a
    // disqualified one must degrade to a top-level project, never fail the init.
    const io = makeIo();
    let sent: unknown = 'unset';
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({
          ok: true,
          value: [{ id: PARENT_ID, slug: 'my-site', parentProjectId: 'aaaaaaaaaaaaaaaaaaaaaaaa', status: 'active' }],
        }),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0);
    assert.equal(sent, undefined);
  });

  it('🚨 an ancestor the caller does not own is dropped — init still succeeds', async () => {
    const io = makeIo();
    let sent: unknown = 'unset';
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0);
    assert.equal(sent, undefined);
  });

  it('🚨 a projects-list FAILURE must not fail init — it only cost us a default', async () => {
    const io = makeIo();
    let sent: unknown = 'unset';
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: false, kind: 'network', message: 'upstream down' } as never),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0, 'a lookup failure while guessing a default must not fail the command');
    assert.equal(sent, undefined);
  });

  it('a suspended ancestor is dropped', async () => {
    const io = makeIo();
    let sent: unknown = 'unset';
    await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({
          ok: true,
          value: [{ id: PARENT_ID, slug: 'my-site', parentProjectId: null, status: 'suspended' }],
        }),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(sent, undefined);
  });

  it('🚨 an explicit --parent wins and is never overridden by the walk', async () => {
    const io = makeIo();
    let sent: string | undefined;
    await runDeployCmd(
      ['init', '--slug', 'my-api', '--parent', 'bbbbbbbbbbbbbbbbbbbbbbbb'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: rootParent }),
        createProjectImpl: async (_ctx, request) => {
          sent = request.parentProjectId;
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(sent, 'bbbbbbbbbbbbbbbbbbbbbbbb');
    assert.doesNotMatch(io.stdout.join(''), /inferred from/);
  });

  it('🚨 says when reconciliation dropped an inferred parent, and how to fix it', async () => {
    // Reconciliation is right — refusing would strand a project the caller
    // already owns. But they were about to get a nested project and are getting
    // a link to an existing one elsewhere in the tree, so it must not be silent.
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({
          ok: true,
          value: [
            { id: PARENT_ID, slug: 'my-site', parentProjectId: null, status: 'active' },
            { id: 'hp_existing', slug: 'my-api', parentProjectId: null, status: 'active' },
          ],
        }),
        createProjectImpl: async () => ({ ok: false, kind: 'slug-taken', message: 'taken', detail: { slug: 'my-api' } } as never),
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0, 'must not strand a project the caller already owns');
    const out = io.stdout.join('');
    assert.match(out, /already existed and is NOT under my-site/);
    assert.match(out, /set-parent my-site/);
  });

  it('reconciliation reports the dropped parent as a FIELD in --json, never as applied', async () => {
    const io = makeIo();
    await runDeployCmd(
      ['init', '--slug', 'my-api', '--json'],
      baseDeps(io, {
        cwd: '/repo/apps/api',
        readFileImpl: ancestorFs(ancestorAt('/repo')),
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({
          ok: true,
          value: [
            { id: PARENT_ID, slug: 'my-site', parentProjectId: null, status: 'active' },
            { id: 'hp_existing', slug: 'my-api', parentProjectId: null, status: 'active' },
          ],
        }),
        createProjectImpl: async () => ({ ok: false, kind: 'slug-taken', message: 'taken', detail: { slug: 'my-api' } } as never),
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    const payload = JSON.parse(io.stdout.join(''));
    assert.equal(payload.status, 'linked-existing');
    assert.equal(payload.parentNotApplied, PARENT_ID);
    assert.equal(payload.parentProjectId, undefined, 'must never claim the nesting happened');
  });

  it('🚨 falls back to process.env — deps.env is a TEST SEAM, not the environment', async () => {
    // The real CLI calls `runDeployCmd(args)` with no deps (`cli.ts:739`), so
    // `deps.env?.X` is always undefined in production. Two things sat behind
    // that shape: this walk's $HOME floor, and WORKSPACE_ID on create.
    const io = makeIo();
    const prevHome = process.env.HOME;
    process.env.HOME = '/home/dev';
    try {
      let sent: unknown = 'unset';
      await runDeployCmd(
        ['init', '--slug', 'my-api'],
        {
          // NO env key at all — exactly how production arrives here.
          cwd: '/home/dev/scratch/api',
          io,
          readFileImpl: ancestorFs({
            '/home/dev/.yolo/deploy.json': JSON.stringify({ projectId: PARENT_ID, slug: 'my-site' }),
          }),
          readDeployConfigImpl: () => linked(null),
          listProjectsImpl: async () => ({ ok: true, value: rootParent }),
          createProjectImpl: async (_ctx: unknown, request: Record<string, unknown>) => {
            sent = request.parentProjectId;
            return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
          },
          writeDeployConfigImpl: () => CONFIG_PATH,
        } as never,
      );
      assert.equal(
        sent, undefined,
        'the $HOME floor must hold in production — one stray ~/.yolo/deploy.json '
        + 'would otherwise adopt every project on the machine',
      );
    } finally {
      if (prevHome === undefined) delete process.env.HOME; else process.env.HOME = prevHome;
    }
  });

  it('🚨 stamps WORKSPACE_ID from process.env — dead since it shipped', async () => {
    // A hosting project made by `yolo deploy init` inside a session pod carries
    // `workspaceId` so deploy lifecycle events route back to the workspace. It
    // was read as `deps.env?.WORKSPACE_ID`, which production never populates.
    const io = makeIo();
    const prev = process.env.WORKSPACE_ID;
    process.env.WORKSPACE_ID = 'ws_from_pod';
    try {
      let sent: unknown;
      await runDeployCmd(
        ['init', '--slug', 'my-api', '--no-parent'],
        {
          cwd: '/repo/apps/api',
          io,
          readFileImpl: () => undefined,
          readDeployConfigImpl: () => linked(null),
          createProjectImpl: async (_ctx: unknown, request: Record<string, unknown>) => {
            sent = request.workspaceId;
            return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
          },
          writeDeployConfigImpl: () => CONFIG_PATH,
        } as never,
      );
      assert.equal(sent, 'ws_from_pod');
    } finally {
      if (prev === undefined) delete process.env.WORKSPACE_ID; else process.env.WORKSPACE_ID = prev;
    }
  });

  it('--parent accepts a SLUG and resolves it to an id', async () => {
    // A CLI-only user has no way to discover an opaque 24-hex id (there is no
    // `deploy list` subcommand), but slugs are the handle they already use.
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--slug', 'my-api', '--parent', 'my-site'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({
          ok: true,
          value: [{ id: '6a736e980ebe7300095936e6', slug: 'my-site' }],
        }),
        createProjectImpl: async (_ctx, request) => {
          // Resolved to the id, not passed through as the slug.
          assert.equal(request.parentProjectId, '6a736e980ebe7300095936e6');
          return { ok: true, value: { project: { id: 'hp_child', slug: 'my-api' } } };
        },
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0);
  });

  it('--parent fails clearly when no owned project matches', async () => {
    const io = makeIo();
    let created = false;
    const code = await runDeployCmd(
      ['init', '--parent', 'no-such-project'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        createProjectImpl: async () => {
          created = true;
          return { ok: true, value: { project: { id: 'x', slug: 'y' } } };
        },
      }),
    );
    assert.notEqual(code, 0);
    assert.equal(created, false);
    assert.match(io.stderr.join(''), /no project of yours matches parent/);
  });

  it('--parent failures keep stderr EMPTY under --json (stream-split contract)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--parent', '6a736e980ebe7300095936e6', '--json'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked({ $version: 1, projectId: 'hp_existing', slug: 'existing' }),
      }),
    );
    assert.notEqual(code, 0);
    // Automation treats stderr as diagnostics; the machine result goes to stdout.
    assert.equal(io.stderr.join(''), '');
    assert.match(io.stdout.join(''), /"status": ?"failed"/);
  });

  it('🚨 --parent on an ALREADY-LINKED directory fails instead of silently ignoring it', async () => {
    // Parent links are create-only, so reporting `already-linked` here would be
    // a false success: the caller believes a family exists and it does not.
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--parent', '6a736e980ebe7300095936e6'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked({ $version: 1, projectId: 'hp_existing', slug: 'existing' }),
      }),
    );
    assert.notEqual(code, 0);
    assert.match(io.stderr.join(''), /--parent only applies when creating one/);
  });

  it('creates the project, writes .yolo/deploy.json, prints the committed-by-design note', async () => {
    const io = makeIo();
    const written: Array<{ cwd: string; config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['init', '--slug', 'my-app', '--type', 'static'],
      baseDeps(io, {
        env: { ...ENV, WORKSPACE_ID: 'ws-current' },
        readDeployConfigImpl: () => linked(null),
        createProjectImpl: async (_ctx, request) => {
          assert.equal(request.name, 'my-app');
          assert.equal(request.slug, 'my-app');
          assert.equal(request.workspaceId, 'ws-current');
          return { ok: true, value: { project: { id: 'hp_8f3a', slug: 'my-app' } } };
        },
        writeDeployConfigImpl: (cwd, config) => {
          written.push({ cwd, config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.cwd, '/proj');
    assert.deepEqual(written[0]!.config, { $version: 1, projectId: 'hp_8f3a', slug: 'my-app', type: 'static' });
    const out = io.stdout.join('');
    assert.match(out, /OK: linked project hp_8f3a \(slug my-app\) — wrote \.yolo\/deploy\.json/);
    assert.match(out, /committed by design; it contains no secrets/);
  });

  it('--json emits a machine-readable created object (progress-free stdout)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--slug', 'my-app', '--json'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        createProjectImpl: async () => ({ ok: true, value: { project: { id: 'hp_8f3a', slug: 'my-app' } } }),
        writeDeployConfigImpl: () => CONFIG_PATH,
      }),
    );
    assert.equal(code, 0);
    const payload = JSON.parse(io.stdout.join(''));
    assert.equal(payload.status, 'created');
    assert.equal(payload.projectId, 'hp_8f3a');
    assert.equal(payload.slug, 'my-app');
    assert.equal(payload.configPath, '.yolo/deploy.json');
    assert.match(payload.note, /committed by design/);
  });

  it('--json routes a CREATE failure to stdout too, not stderr (codex P2 r16)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--slug', 'taken', '--json'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        createProjectImpl: async () => ({ ok: false, kind: 'quota-exceeded', message: 'project cap reached' }),
      }),
    );
    assert.notEqual(code, 0);
    const payload = JSON.parse(io.stdout.join(''));
    assert.equal(payload.kind, 'quota-exceeded');
    assert.equal(io.stderr.join(''), ''); // machine mode: nothing on stderr
  });

  it('--json reports already-linked idempotently without rewriting', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--json'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked({ $version: 1, projectId: 'hp_old', slug: 'kept' }),
        writeDeployConfigImpl: () => {
          throw new Error('must not rewrite an existing link');
        },
      }),
    );
    assert.equal(code, 0);
    const payload = JSON.parse(io.stdout.join(''));
    assert.deepEqual(payload, { status: 'already-linked', projectId: 'hp_old', slug: 'kept' });
  });

  it('--json honors the flag on an ARG error too (machine-readable failure on stdout, exit 64)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['init', '--json', '--type', 'bogus'], baseDeps(io, {}));
    assert.equal(code, 64);
    // The contract: one final machine-readable object on STDOUT (codex P2 r16).
    const payload = JSON.parse(io.stdout.join(''));
    assert.equal(payload.kind, 'usage');
    assert.match(String(payload.message), /--type must be/);
    assert.equal(io.stderr.join(''), ''); // nothing on stderr in --json mode
  });

  it('adapts an existing wrangler.json into the written .yolo/deploy.json on a fresh init', async () => {
    const io = makeIo();
    const written: Array<{ config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['init', '--slug', 'api'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null), // no existing deploy.json
        // wrangler.json present on disk; auth still resolves from ENV (undefined
        // for non-wrangler paths, mirroring the default stub).
        readFileImpl: (p: string) =>
          p.endsWith('wrangler.json')
            ? JSON.stringify({ main: 'src/index.ts', compatibility_flags: ['nodejs_compat'] })
            : undefined,
        createProjectImpl: async () => ({ ok: true, value: { project: { id: 'hp_api', slug: 'api' } } }),
        writeDeployConfigImpl: (_cwd, config) => {
          written.push({ config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(written.length, 1);
    assert.deepEqual(written[0]!.config, {
      $version: 1,
      projectId: 'hp_api',
      slug: 'api',
      type: 'worker',
      worker: { entry: 'src/index.ts' },
      compatibilityFlags: ['nodejs_compat'],
    });
    assert.match(io.stdout.join(''), /note: adapted wrangler\.json → \.yolo\/deploy\.json \(.*worker\.entry=src\/index\.ts.*\)/);
  });

  it('is idempotent: an existing link is left unchanged, no project created', async () => {
    const io = makeIo();
    let createCalls = 0;
    const code = await runDeployCmd(
      ['init'],
      baseDeps(io, {
        createProjectImpl: async () => {
          createCalls++;
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(createCalls, 0);
    assert.match(io.stdout.join(''), /already linked to project hp_8f3a/);
  });

  it('passes a slug-taken refusal through with exit 2 when the slug is NOT one we own', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['init', '--slug', 'taken'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        createProjectImpl: async () => ({ ok: false, kind: 'slug-taken', message: "slug 'taken' is in use", status: 409 }),
        // We own other projects, but none with slug 'taken' → genuinely taken.
        listProjectsImpl: async () => ({ ok: true, value: [{ id: 'hp_other', slug: 'something-else' }] }),
      }),
    );
    assert.equal(code, 2);
    assert.match(io.stderr.join(''), /FAIL \[slug-taken\]/);
  });

  it('reconciles a slug-taken when the slug is ALREADY OURS — links to it (exit 0)', async () => {
    const io = makeIo();
    const written: Array<{ cwd: string; config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['init', '--slug', 'sushi-rescue'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        createProjectImpl: async () => ({ ok: false, kind: 'slug-taken', message: "slug 'sushi-rescue' is in use", status: 409 }),
        listProjectsImpl: async () => ({
          ok: true,
          value: [{ id: 'hp_sushi', slug: 'sushi-rescue' }],
        }),
        writeDeployConfigImpl: (cwd, config) => {
          written.push({ cwd, config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(written.length, 1);
    assert.deepEqual(written[0]!.config, { $version: 1, projectId: 'hp_sushi', slug: 'sushi-rescue' });
    assert.match(io.stdout.join(''), /was already yours — linked existing project hp_sushi/);
  });

  it('reconciles a slug-taken with NO --slug, using the server-derived slug from detail', async () => {
    const io = makeIo();
    const written: Array<{ config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['init'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        // bare init derives a slug server-side; the refusal carries it in detail.
        createProjectImpl: async () => ({
          ok: false,
          kind: 'slug-taken',
          message: 'in use',
          status: 409,
          detail: { slug: 'derived-slug' },
        }),
        listProjectsImpl: async () => ({ ok: true, value: [{ id: 'hp_d', slug: 'derived-slug' }] }),
        writeDeployConfigImpl: (_cwd, config) => {
          written.push({ config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(written[0]!.config, { $version: 1, projectId: 'hp_d', slug: 'derived-slug' });
  });

  it('rejects a bad --type with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['init', '--type', 'spa'], baseDeps(io));
    assert.equal(code, 64);
  });

  it('fails with exit 78 when no token is available', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['init'],
      baseDeps(io, { env: { YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/h' }, readDeployConfigImpl: () => linked(null) }),
    );
    assert.equal(code, 78);
    assert.match(io.stderr.join(''), /FAIL \[auth\]/);
  });
});

// ─── link ──────────────────────────────────────────────────────────────────

describe('deploy-cli — link', () => {
  it('requires --project-id or --slug (exit 64)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['link'], baseDeps(io, { readDeployConfigImpl: () => linked(null) }));
    assert.equal(code, 64);
    assert.match(io.stderr.join(''), /--project-id <id> or --slug <slug>/);
  });

  it('rejects --project-id and --slug together (exit 64)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['link', '--project-id', 'hp_a', '--slug', 'slug-for-b'],
      baseDeps(io, { readDeployConfigImpl: () => linked(null) }),
    );
    assert.equal(code, 64);
    assert.match(io.stderr.join(''), /not both/);
  });

  it('links by --project-id (ownership verified via status) and writes the file', async () => {
    const io = makeIo();
    const written: Array<{ config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['link', '--project-id', 'hp_sushi'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        getProjectStatusImpl: async (_ctx, projectId) => {
          assert.equal(projectId, 'hp_sushi');
          return { ok: true, value: { project: { id: 'hp_sushi', slug: 'sushi-rescue' } } };
        },
        writeDeployConfigImpl: (_cwd, config) => {
          written.push({ config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(written[0]!.config, { $version: 1, projectId: 'hp_sushi', slug: 'sushi-rescue' });
    assert.match(io.stdout.join(''), /linked project hp_sushi \(slug sushi-rescue\)/);
  });

  it('links by --slug via the owned-project lookup', async () => {
    const io = makeIo();
    const written: Array<{ config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['link', '--slug', 'sushi-rescue'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: [{ id: 'hp_sushi', slug: 'sushi-rescue' }] }),
        writeDeployConfigImpl: (_cwd, config) => {
          written.push({ config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(written[0]!.config, { $version: 1, projectId: 'hp_sushi', slug: 'sushi-rescue' });
  });

  it('errors when no owned project has the given slug', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['link', '--slug', 'ghost'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: true, value: [] }),
      }),
    );
    assert.notEqual(code, 0);
    assert.match(io.stderr.join(''), /no hosting project you own has slug 'ghost'/);
  });

  it('propagates a list FAILURE (network) rather than reporting not-found', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['link', '--slug', 'sushi-rescue'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        listProjectsImpl: async () => ({ ok: false, kind: 'network', message: 'server error (HTTP 503)' }),
      }),
    );
    assert.equal(code, 4); // transient transport — retryable, not "not found"
    assert.match(io.stderr.join(''), /FAIL \[network\]/);
    assert.doesNotMatch(io.stderr.join(''), /no hosting project you own/);
  });

  it('refuses to repoint an existing link at a different project', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['link', '--project-id', 'hp_new'],
      baseDeps(io, {
        // default baseDeps readDeployConfigImpl is linked to hp_8f3a
        getProjectStatusImpl: async () => ({ ok: true, value: { project: { id: 'hp_new', slug: 'new' } } }),
      }),
    );
    assert.notEqual(code, 0);
    assert.match(io.stderr.join(''), /already linked to project hp_8f3a/);
  });

  it('is a no-op when already linked to the same project (no new --type)', async () => {
    const io = makeIo();
    let wrote = false;
    const code = await runDeployCmd(
      ['link', '--project-id', 'hp_8f3a'],
      baseDeps(io, {
        getProjectStatusImpl: async () => ({ ok: true, value: { project: { id: 'hp_8f3a', slug: 'my-app' } } }),
        writeDeployConfigImpl: () => {
          wrote = true;
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(wrote, false);
    assert.match(io.stdout.join(''), /already linked to project hp_8f3a/);
  });

  it('honors a new --type when already linked to the same project', async () => {
    const io = makeIo();
    const written: Array<{ config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['link', '--project-id', 'hp_8f3a', '--type', 'worker'],
      baseDeps(io, {
        // default baseDeps is linked to hp_8f3a, slug my-app, no type
        getProjectStatusImpl: async () => ({ ok: true, value: { project: { id: 'hp_8f3a', slug: 'my-app' } } }),
        writeDeployConfigImpl: (_cwd, config) => {
          written.push({ config: config as unknown as Record<string, unknown> });
          return CONFIG_PATH;
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(written.length, 1);
    assert.equal(written[0]!.config.type, 'worker');
    assert.equal(written[0]!.config.projectId, 'hp_8f3a');
    assert.match(io.stdout.join(''), /set type worker/);
  });
});

// ─── status / logs / rollback ─────────────────────────────────────────────

describe('deploy-cli — status', () => {
  it('fails with not-linked (exit 1) when there is no deploy.json', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['status'], baseDeps(io, { readDeployConfigImpl: () => linked(null) }));
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /FAIL \[not-linked\].*yolo deploy init/);
  });

  it('summarizes project + releases, surfacing awaiting-approval', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['status'],
      baseDeps(io, {
        getProjectStatusImpl: async (_ctx, projectId) => {
          assert.equal(projectId, 'hp_8f3a');
          return {
            ok: true,
            value: {
              project: { slug: 'my-app', status: 'active', hostname: 'my-app.yolo.host' },
              currentRelease: { releaseId: 'rel_0192', status: 'live' },
              recentReleases: [
                { releaseId: 'rel_0193', status: 'awaiting-approval' },
                { releaseId: 'rel_0192', status: 'live' },
              ],
            },
          };
        },
      }),
    );
    assert.equal(code, 0);
    const out = io.stdout.join('');
    assert.match(out, /project my-app \(active\)/);
    assert.match(out, /url: https:\/\/my-app\.yolo\.host/);
    assert.match(out, /release rel_0192: live \(current\)/);
    assert.match(out, /release rel_0193: awaiting-approval/);
  });

  it('--json prints the raw response', async () => {
    const io = makeIo();
    await runDeployCmd(
      ['status', '--json'],
      baseDeps(io, { getProjectStatusImpl: async () => ({ ok: true, value: { project: { slug: 's' } } }) }),
    );
    assert.deepEqual(JSON.parse(io.stdout.join('')), { project: { slug: 's' } });
  });
});

describe('deploy-cli — logs', () => {
  it('parses --since durations into minutes', () => {
    assert.equal(parseSinceMinutes('30m'), 30);
    assert.equal(parseSinceMinutes('2h'), 120);
    assert.equal(parseSinceMinutes('1d'), 1440);
    assert.equal(parseSinceMinutes('45'), 45);
    assert.equal(parseSinceMinutes('soon'), undefined);
    assert.equal(parseSinceMinutes('0m'), undefined);
  });

  it('threads --since through to the buffered leg and prints entries', async () => {
    const io = makeIo();
    let seen: Record<string, unknown> = {};
    const code = await runDeployCmd(
      ['logs', '--since', '2h'],
      baseDeps(io, {
        getLogsImpl: async (_ctx, _projectId, options) => {
          seen = options as Record<string, unknown>;
          return { ok: true, value: { logs: [{ timestamp: '2026-06-13T00:00:00Z', level: 'info', message: 'hello' }] } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(seen.sinceMinutes, 120);
    assert.match(io.stdout.join(''), /\[2026-06-13T00:00:00Z\] info hello/);
  });

  it('prints the symbolicated exception stack indented under the message', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['logs'],
      baseDeps(io, {
        getLogsImpl: async () => ({
          ok: true,
          value: {
            logs: [
              {
                timestamp: '2026-07-13T00:00:00Z',
                level: 'error',
                message: 'kaboom-detonation',
                errorName: 'Error',
                stack: 'at detonate (boom.ts:3:9)\nat Object.fetch (entry.ts:4:5)',
              },
            ],
          },
        }),
      }),
    );
    assert.equal(code, 0);
    const out = io.stdout.join('');
    assert.match(out, /\[2026-07-13T00:00:00Z\] error kaboom-detonation/);
    assert.match(out, /Error/);
    assert.match(out, /at detonate \(boom\.ts:3:9\)/); // original source, not the bundle
    assert.match(out, /at Object\.fetch \(entry\.ts:4:5\)/);
  });

  it('--tail long-polls the live buffer, prints new lines, and threads the cursor', async () => {
    const io = makeIo();
    const calls: Array<{ cursor?: string }> = [];
    let buffered = 0;
    const code = await runDeployCmd(
      ['logs', '--tail'],
      baseDeps(io, {
        getLogsImpl: async () => {
          buffered += 1;
          return { ok: true, value: { entries: [] } };
        },
        tailMaxIterations: 2,
        pollTailImpl: async (_ctx, _projectId, opts) => {
          calls.push({ cursor: (opts as { cursor?: string }).cursor });
          return calls.length === 1
            ? { ok: true, value: { events: [{ timestamp: '2026-06-17T00:00:00Z', level: 'error', message: 'boom' }], cursor: 'c1' } }
            : { ok: true, value: { events: [], cursor: 'c1', note: 'no-new-events' } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(buffered, 0); // --tail must NOT fall through to the buffered fetch
    assert.deepEqual(calls, [{ cursor: undefined }, { cursor: 'c1' }]); // cursor threaded
    assert.match(io.stdout.join(''), /error boom/);
  });

  it('--tail --json emits NDJSON to stdout (machine-readable contract preserved)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['logs', '--tail', '--json'],
      baseDeps(io, {
        tailMaxIterations: 1,
        pollTailImpl: async () => ({
          ok: true,
          value: { events: [{ timestamp: '2026-06-17T00:00:00Z', level: 'error', message: 'boom' }], cursor: 'c1' },
        }),
      }),
    );
    assert.equal(code, 0);
    // stdout is a parseable JSON object per line — NOT the human "error boom" format
    const lines = io.stdout.join('').trim().split('\n').filter(Boolean);
    assert.deepEqual(JSON.parse(lines[0]!), { timestamp: '2026-06-17T00:00:00Z', level: 'error', message: 'boom' });
    assert.equal(io.stdout.join('').includes('error boom'), false);
  });

  it('--tail falls back to the buffered logs fetch when live tail is disabled (no silent empty)', async () => {
    const io = makeIo();
    let buffered = 0;
    const code = await runDeployCmd(
      ['logs', '--tail'],
      baseDeps(io, {
        tailMaxIterations: 5,
        pollTailImpl: async () => ({ ok: true, value: { events: [], cursor: null, note: 'tail-disabled' } }),
        getLogsImpl: async () => {
          buffered += 1;
          return { ok: true, value: { entries: [{ timestamp: '2026-06-17T00:00:00Z', level: 'info', message: 'recent' }] } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(buffered, 1); // degraded to the buffered fetch
    assert.match(io.stderr.join(''), /live tail is not enabled/);
    assert.match(io.stdout.join(''), /info recent/); // recent buffered entry shown
  });

  it('--tail stops cleanly on a terminal target note (no-live-release) without a buffered fallback', async () => {
    const io = makeIo();
    let buffered = 0;
    const code = await runDeployCmd(
      ['logs', '--tail'],
      baseDeps(io, {
        tailMaxIterations: 5,
        pollTailImpl: async () => ({ ok: true, value: { events: [], cursor: null, note: 'no-live-release' } }),
        getLogsImpl: async () => { buffered += 1; return { ok: true, value: { entries: [] } }; },
      }),
    );
    assert.equal(code, 0);
    assert.equal(buffered, 0); // genuinely-terminal target note → stop, no fallback
    assert.match(io.stderr.join(''), /tail stopped — no-live-release/);
  });

  it('rejects an invalid --since with exit 64', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['logs', '--since', 'whenever'], baseDeps(io));
    assert.equal(code, 64);
  });
});

describe('deploy-cli — rollback', () => {
  it('passes the positional releaseId through and prints the OK line', async () => {
    const io = makeIo();
    let seen: Record<string, unknown> = {};
    const code = await runDeployCmd(
      ['rollback', 'rel_0191'],
      baseDeps(io, {
        rollbackProjectImpl: async (_ctx, projectId, request) => {
          seen = { projectId, ...request };
          return { ok: true, value: { releaseId: 'rel_0191', url: 'https://my-app.yolo.host' } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', releaseId: 'rel_0191' });
    assert.match(io.stdout.join(''), /OK: rolled back my-app to release rel_0191 → https:\/\/my-app\.yolo\.host/);
  });

  it('defaults to the previous live release when no releaseId is given', async () => {
    const io = makeIo();
    let body: Record<string, unknown> | undefined;
    await runDeployCmd(
      ['rollback'],
      baseDeps(io, {
        rollbackProjectImpl: async (_ctx, _projectId, request) => {
          body = request as Record<string, unknown>;
          return { ok: true, value: { releaseId: 'rel_0190' } };
        },
      }),
    );
    assert.deepEqual(body, {});
  });

  it('passes release-not-found through with exit 2', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['rollback', 'rel_gone'],
      baseDeps(io, {
        rollbackProjectImpl: async () => ({ ok: false, kind: 'release-not-found', message: 'no such release', status: 404 }),
      }),
    );
    assert.equal(code, 2);
    assert.match(io.stderr.join(''), /FAIL \[release-not-found\]/);
  });
});

// ─── rename / alias / redirect / delete ─────────────────────────────────────

describe('deploy-cli — rename', () => {
  it('PUTs the new slug with keepOldAsRedirect=true by default + prints the URL', async () => {
    const io = makeIo();
    let seen: Record<string, unknown> = {};
    const code = await runDeployCmd(
      ['rename', 'cooler-app'],
      baseDeps(io, {
        renameProjectImpl: async (_ctx, projectId, request) => {
          seen = { projectId, ...request };
          return { ok: true, value: { project: { slug: 'cooler-app', hostname: 'cooler-app.yolo.host' } } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', slug: 'cooler-app', keepOldAsRedirect: true });
    const out = io.stdout.join('');
    assert.match(out, /OK: renamed to slug cooler-app → https:\/\/cooler-app\.yolo\.host/);
    assert.match(out, /old slug 'my-app' now 308/);
  });

  it('--no-redirect sets keepOldAsRedirect=false', async () => {
    const io = makeIo();
    let request: Record<string, unknown> = {};
    await runDeployCmd(
      ['rename', 'cooler-app', '--no-redirect'],
      baseDeps(io, {
        renameProjectImpl: async (_ctx, _projectId, req) => {
          request = req as Record<string, unknown>;
          return { ok: true, value: { project: { slug: 'cooler-app', hostname: 'cooler-app.yolo.host' } } };
        },
      }),
    );
    assert.equal(request.keepOldAsRedirect, false);
  });

  it('requires a new slug (exit 64)', async () => {
    const io = makeIo();
    assert.equal(await runDeployCmd(['rename'], baseDeps(io)), 64);
    assert.equal(parseRenameArgs([]).ok, false);
    const r = parseRenameArgs(['x', '--no-redirect', '--json']);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.slug, r.keepOldAsRedirect, r.jsonOutput], ['x', false, true]);
  });
});

describe('deploy-cli — alias', () => {
  it('adds an alias via POST', async () => {
    const io = makeIo();
    let seen: { projectId?: string; slug?: string } = {};
    const code = await runDeployCmd(
      ['alias', 'beta'],
      baseDeps(io, {
        addAliasImpl: async (_ctx, projectId, slug) => {
          seen = { projectId, slug };
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', slug: 'beta' });
    assert.match(io.stdout.join(''), /OK: added alias 'beta'/);
  });

  it('removes an alias via `alias rm <slug>` (DELETE)', async () => {
    const io = makeIo();
    let seen: { projectId?: string; slug?: string } = {};
    const code = await runDeployCmd(
      ['alias', 'rm', 'beta'],
      baseDeps(io, {
        removeAliasImpl: async (_ctx, projectId, slug) => {
          seen = { projectId, slug };
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', slug: 'beta' });
    assert.match(io.stdout.join(''), /OK: removed alias 'beta'/);
  });

  it('requires a slug (exit 64) for both add and rm', async () => {
    const io = makeIo();
    assert.equal(await runDeployCmd(['alias'], baseDeps(io)), 64);
    assert.equal(parseAliasArgs([]).ok, false);
    assert.equal(parseAliasArgs(['rm']).ok, false);
    const r = parseAliasArgs(['rm', 'beta']);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.remove, r.slug], [true, 'beta']);
  });
});

describe('deploy-cli — redirect', () => {
  it('PUTs the slug → target url', async () => {
    const io = makeIo();
    let seen: { projectId?: string; slug?: string; url?: string } = {};
    const code = await runDeployCmd(
      ['redirect', 'old', 'https://example.com/new'],
      baseDeps(io, {
        setRedirectImpl: async (_ctx, projectId, slug, target) => {
          seen = { projectId, slug, url: target };
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', slug: 'old', url: 'https://example.com/new' });
    assert.match(io.stdout.join(''), /OK: 'old' now 308 → https:\/\/example\.com\/new/);
  });

  it('requires both slug and url (exit 64)', async () => {
    const io = makeIo();
    assert.equal(await runDeployCmd(['redirect', 'only-one'], baseDeps(io)), 64);
    assert.equal(parseRedirectArgs(['a']).ok, false);
    assert.equal(parseRedirectArgs(['a', 'b', 'c']).ok, false);
  });
});

describe('deploy-cli — set-parent', () => {
  it('🚨 --json keeps stderr EMPTY on EARLY failures too (parse / not-linked / auth)', async () => {
    // The stream-split contract has to hold on every failure path, not just the
    // ones after a successful parse — automation parses stdout and treats
    // stderr as diagnostics.

    // 1. parse failure (no parent, no --none)
    const a = makeIo();
    assert.equal(await runDeployCmd(['set-parent', '--json'], baseDeps(a, {})), 64);
    assert.equal(a.stderr.join(''), '');
    assert.match(a.stdout.join(''), /"status": ?"failed"/);

    // 2. not linked
    const b = makeIo();
    const codeB = await runDeployCmd(
      ['set-parent', 'some-parent', '--json'],
      baseDeps(b, { readDeployConfigImpl: () => linked(null) }),
    );
    assert.notEqual(codeB, 0);
    assert.equal(b.stderr.join(''), '');
    assert.match(b.stdout.join(''), /not-linked/);
  });


  it('resolves a SLUG to an id and PUTs it for the LINKED project', async () => {
    // Slug-first resolution (a slug may legally be 24 hex chars), same as
    // `init --parent`. The target is always the linked project, like rename.
    const io = makeIo();
    let seen: { projectId?: string; parentProjectId?: string | null } = {};
    const code = await runDeployCmd(
      ['set-parent', 'my-site'],
      baseDeps(io, {
        listProjectsImpl: async () => ({
          ok: true,
          value: [{ id: '6a736e980ebe7300095936e6', slug: 'my-site' }],
        }),
        setProjectParentImpl: async (_ctx, projectId, parentProjectId) => {
          seen = { projectId, parentProjectId };
          return { ok: true, value: { project: { id: 'hp_8f3a', slug: 'my-app' } } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', parentProjectId: '6a736e980ebe7300095936e6' });
    assert.match(io.stdout.join(''), /OK: my-app is now nested under my-site/);
  });

  it('passes an id-shaped value through when no owned slug matches', async () => {
    const io = makeIo();
    let seen: string | null | undefined;
    const code = await runDeployCmd(
      ['set-parent', '6a736e980ebe7300095936e6'],
      baseDeps(io, {
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        setProjectParentImpl: async (_ctx, _projectId, parentProjectId) => {
          seen = parentProjectId;
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(seen, '6a736e980ebe7300095936e6');
  });

  it('--none sends parentProjectId: null (detach to root) without a slug lookup', async () => {
    const io = makeIo();
    let seen: string | null | undefined = 'unset';
    let listed = false;
    const code = await runDeployCmd(
      ['set-parent', '--none'],
      baseDeps(io, {
        listProjectsImpl: async () => {
          listed = true;
          return { ok: true, value: [] };
        },
        setProjectParentImpl: async (_ctx, _projectId, parentProjectId) => {
          seen = parentProjectId;
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(seen, null);
    assert.equal(listed, false);
    assert.match(io.stdout.join(''), /OK: detached my-app — it is now a root project/);
  });

  it('fails clearly when no owned project matches the parent (never calls the route)', async () => {
    const io = makeIo();
    let called = false;
    const code = await runDeployCmd(
      ['set-parent', 'no-such-project'],
      baseDeps(io, {
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        setProjectParentImpl: async () => {
          called = true;
          return { ok: true, value: {} };
        },
      }),
    );
    assert.notEqual(code, 0);
    assert.equal(called, false);
    assert.match(io.stderr.join(''), /no project of yours matches parent/);
  });

  it('surfaces a server refusal verbatim as a FAIL line + exit 2', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['set-parent', '6a736e980ebe7300095936e6'],
      baseDeps(io, {
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        setProjectParentImpl: async () => ({
          ok: false,
          kind: 'project-nesting-too-deep',
          message: 'nesting is limited to 2 levels',
        }),
      }),
    );
    assert.equal(code, 2);
    assert.match(io.stderr.join(''), /FAIL \[project-nesting-too-deep\]: nesting is limited to 2 levels/);
  });

  it('refusals keep stderr EMPTY under --json (stream-split contract)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['set-parent', '6a736e980ebe7300095936e6', '--json'],
      baseDeps(io, {
        listProjectsImpl: async () => ({ ok: true, value: [] }),
        setProjectParentImpl: async () => ({
          ok: false,
          kind: 'project-has-children',
          message: 'detach its children first',
        }),
      }),
    );
    assert.notEqual(code, 0);
    // Automation treats stderr as diagnostics; the machine result goes to stdout.
    assert.equal(io.stderr.join(''), '');
    assert.match(io.stdout.join(''), /"kind": ?"project-has-children"/);
  });

  it('requires a parent or --none, and rejects both together (exit 64)', async () => {
    const io = makeIo();
    assert.equal(await runDeployCmd(['set-parent'], baseDeps(io)), 64);
    assert.equal(parseSetParentArgs([]).ok, false);
    assert.equal(parseSetParentArgs(['my-site', '--none']).ok, false);
    assert.equal(parseSetParentArgs(['a', 'b']).ok, false);
    assert.equal(parseSetParentArgs(['--frobnicate']).ok, false);
    const r = parseSetParentArgs(['my-site', '--json']);
    assert.equal(r.ok, true);
    if (r.ok) assert.deepEqual([r.parent, r.detach, r.jsonOutput], ['my-site', false, true]);
  });
});

describe('deploy-cli — delete', () => {
  it('deletes a throwaway project without --confirm', async () => {
    const io = makeIo();
    let request: Record<string, unknown> = { sentinel: true };
    const code = await runDeployCmd(
      ['delete'],
      baseDeps(io, {
        deleteProjectImpl: async (_ctx, _projectId, req) => {
          request = req as Record<string, unknown>;
          return { ok: true, value: {} };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(request, {});
    assert.match(io.stdout.join(''), /OK: deleted project my-app/);
  });

  it('passes --confirm <slug> through as confirmSlug', async () => {
    const io = makeIo();
    let request: Record<string, unknown> = {};
    await runDeployCmd(
      ['delete', '--confirm', 'my-app'],
      baseDeps(io, {
        deleteProjectImpl: async (_ctx, _projectId, req) => {
          request = req as Record<string, unknown>;
          return { ok: true, value: {} };
        },
      }),
    );
    assert.deepEqual(request, { confirmSlug: 'my-app' });
  });

  it('surfaces a not-confirmed refusal (exit 2) with the backend hint', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['delete'],
      baseDeps(io, {
        deleteProjectImpl: async () => ({
          ok: false,
          kind: 'not-confirmed',
          message: 'this is a live site',
          hint: 'pass --confirm my-app to delete it',
          status: 409,
        }),
      }),
    );
    assert.equal(code, 2);
    const err = io.stderr.join('');
    assert.match(err, /FAIL \[not-confirmed\]/);
    assert.match(err, /hint: pass --confirm my-app/);
  });

  it('parses --confirm=<slug> and rejects bare positionals', () => {
    const r = parseDeleteArgs(['--confirm=foo']);
    assert.equal(r.ok, true);
    if (r.ok) assert.equal(r.confirmSlug, 'foo');
    assert.equal(parseDeleteArgs(['stray']).ok, false);
  });
});

describe('deploy-cli — clone', () => {
  it('clones the linked project with no flags (empty body)', async () => {
    const io = makeIo();
    let request: Record<string, unknown> = { sentinel: true };
    let calledProjectId: string | undefined;
    const code = await runDeployCmd(
      ['clone'],
      baseDeps(io, {
        cloneProjectImpl: async (_ctx, projectId, req) => {
          calledProjectId = projectId;
          request = req as Record<string, unknown>;
          return {
            ok: true,
            value: { project: { id: 'hp_clone1', slug: 'my-app-copy', hostname: 'my-app-copy.yolo.host' }, sourceSlug: 'my-app', resourcesCloned: 2, secretsCloned: 1 },
          };
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(calledProjectId, 'hp_8f3a');
    assert.deepEqual(request, {});
    const out = io.stdout.join('');
    assert.match(out, /OK: cloned my-app → my-app-copy/);
    assert.match(out, /my-app-copy\.yolo\.host/);
    // The clone is empty + this dir stays linked to the source, so the message
    // must give the explicit relink step, not advise a (mis-targeted) re-ship.
    assert.doesNotMatch(out, /re-ship to populate it/);
    assert.match(out, /yolo deploy link --project-id hp_clone1/);
  });

  it('passes --name and --slug through verbatim', async () => {
    const io = makeIo();
    let request: Record<string, unknown> = {};
    await runDeployCmd(
      ['clone', '--name', 'My Copy', '--slug', 'my-copy'],
      baseDeps(io, {
        cloneProjectImpl: async (_ctx, _projectId, req) => {
          request = req as Record<string, unknown>;
          return { ok: true, value: { project: { slug: 'my-copy' }, sourceSlug: 'my-app', resourcesCloned: 0, secretsCloned: 0 } };
        },
      }),
    );
    assert.deepEqual(request, { name: 'My Copy', slug: 'my-copy' });
  });

  it('surfaces a slug-taken refusal (exit 2) with the backend hint', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['clone', '--slug', 'taken'],
      baseDeps(io, {
        cloneProjectImpl: async () => ({
          ok: false,
          kind: 'slug-taken',
          message: 'that slug is in use',
          hint: 'pick another --slug',
          status: 409,
        }),
      }),
    );
    assert.equal(code, 2);
    const err = io.stderr.join('');
    assert.match(err, /FAIL \[slug-taken\]/);
    assert.match(err, /hint: pick another --slug/);
  });

  it('emits the raw JSON envelope under --json', async () => {
    const io = makeIo();
    await runDeployCmd(
      ['clone', '--json'],
      baseDeps(io, {
        cloneProjectImpl: async () => ({
          ok: true,
          value: { project: { slug: 'my-app-copy' }, sourceSlug: 'my-app', resourcesCloned: 3, secretsCloned: 2 },
        }),
      }),
    );
    const parsed = JSON.parse(io.stdout.join(''));
    assert.equal(parsed.sourceSlug, 'my-app');
    assert.equal(parsed.resourcesCloned, 3);
    assert.equal(parsed.secretsCloned, 2);
  });

  it('parses --name=/--slug= forms and rejects bare positionals + dangling flags', () => {
    const r = parseCloneArgs(['--name=Foo', '--slug=foo']);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.name, 'Foo');
      assert.equal(r.slug, 'foo');
    }
    assert.equal(parseCloneArgs(['stray']).ok, false);
    assert.equal(parseCloneArgs(['--name']).ok, false);
    assert.equal(parseCloneArgs(['--slug']).ok, false);
  });
});

// ─── db query (Phase 2) ─────────────────────────────────────────────────────

describe('deploy-cli — db query arg parsing', () => {
  it('requires a SQL statement (exit 64 on empty)', () => {
    assert.equal(parseDbQueryArgs([]).ok, false);
    assert.equal(parseDbQueryArgs(['   ']).ok, false);
  });

  it('takes the quoted SQL as a single positional and the --json flag', () => {
    const r = parseDbQueryArgs(['SELECT * FROM users', '--json']);
    assert.equal(r.ok, true);
    if (r.ok) {
      assert.equal(r.sql, 'SELECT * FROM users');
      assert.equal(r.jsonOutput, true);
    }
  });

  it('rejects a second positional (unquoted SQL) with a quoting hint', () => {
    const r = parseDbQueryArgs(['SELECT', '*']);
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /quote the whole SQL/);
  });

  it('rejects an unknown flag', () => {
    assert.equal(parseDbQueryArgs(['SELECT 1', '--bogus']).ok, false);
  });
});

describe('deploy-cli — db query execution', () => {
  it('resolves the linked project, queries the sole D1, prints a table, exits 0', async () => {
    const io = makeIo();
    let seen: { projectId?: string; sql?: string } = {};
    const code = await runDeployCmd(
      ['db', 'query', 'SELECT id, name FROM users'],
      baseDeps(io, {
        queryD1Impl: async (_ctx, projectId, sql) => {
          seen = { projectId, sql };
          return { ok: true, value: { results: [{ id: 1, name: 'ada' }, { id: 2, name: 'bob' }] } };
        },
      }),
    );
    assert.equal(code, 0);
    assert.deepEqual(seen, { projectId: 'hp_8f3a', sql: 'SELECT id, name FROM users' });
    const out = io.stdout.join('');
    assert.match(out, /id \| name/);
    assert.match(out, /1  \| ada/);
    assert.match(out, /\(2 rows\)/);
  });

  it('prints (0 rows) for an empty result set', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['db', 'query', 'SELECT 1 WHERE 0'],
      baseDeps(io, { queryD1Impl: async () => ({ ok: true, value: { results: [] } }) }),
    );
    assert.equal(code, 0);
    assert.match(io.stdout.join(''), /\(0 rows\)/);
  });

  it('--json prints the raw response (no table)', async () => {
    const io = makeIo();
    await runDeployCmd(
      ['db', 'query', 'SELECT 1 AS n', '--json'],
      baseDeps(io, { queryD1Impl: async () => ({ ok: true, value: { results: [{ n: 1 }], meta: { rows_read: 1 } } }) }),
    );
    assert.deepEqual(JSON.parse(io.stdout.join('')), { results: [{ n: 1 }], meta: { rows_read: 1 } });
  });

  it('passes a sql-not-allowed refusal through with exit 2', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['db', 'query', 'DELETE FROM users'],
      baseDeps(io, {
        queryD1Impl: async () => ({ ok: false, kind: 'sql-not-allowed', message: 'writes need allowWrite', status: 403 }),
      }),
    );
    assert.equal(code, 2);
    assert.match(io.stderr.join(''), /FAIL \[sql-not-allowed\]/);
  });

  it('fails not-linked (exit 1) when there is no deploy.json', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['db', 'query', 'SELECT 1'],
      baseDeps(io, { readDeployConfigImpl: () => linked(null) }),
    );
    assert.equal(code, 1);
    assert.match(io.stderr.join(''), /FAIL \[not-linked\]/);
  });
});

describe('deploy-cli — formatRowsTable', () => {
  it('renders a header, separator, aligned rows, and a footer', () => {
    const table = formatRowsTable([{ id: 1, name: 'ada' }, { id: 22, name: 'b' }]);
    const lines = table.split('\n');
    assert.match(lines[0]!, /id \| name/);
    assert.match(lines[1]!, /^--/);
    assert.equal(lines[lines.length - 1], '(2 rows)');
  });

  it('renders NULL for null/undefined and JSON for objects', () => {
    const table = formatRowsTable([{ a: null, b: { x: 1 } }]);
    assert.match(table, /NULL/);
    assert.match(table, /\{"x":1\}/);
  });

  it('unions columns across rows with differing shapes', () => {
    const table = formatRowsTable([{ a: 1 }, { b: 2 }]);
    // Header has both columns (padded to data width — 'NULL' widens each to 4).
    assert.match(table.split('\n')[0]!, /a +\| b/);
  });

  it('returns (0 rows) for an empty array', () => {
    assert.equal(formatRowsTable([]), '(0 rows)');
  });
});
