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
  return { ok: true as const, config, path: CONFIG_PATH };
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

  it('passes a static project with a build command even if the output dir is missing (note, exit 0)', async () => {
    const io = makeIo();
    const code = await runDeployCmd(
      ['validate'],
      baseDeps(io, {
        readDeployConfigImpl: () => ({
          ok: true as const,
          config: { $version: 1 as const, slug: 's', type: 'static' as const, build: { command: 'npm run build', outputDir: 'dist' } },
          path: CONFIG_PATH,
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

  it('awaiting-approval prints PENDING (not FAIL) with URL + do-NOT-rerun hint, exit 3', async () => {
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
    assert.ok(err.includes('do NOT rerun `yolo deploy`'));
  });

  it('awaiting-approval under --json emits the JSON result on stdout, exit 3', async () => {
    const io = makeIo();
    const code = await runDeployCmd(['--env', 'prod', '--json'], baseDeps(io, { runShipImpl: async () => SHIP_PENDING }));
    assert.equal(code, 3);
    const parsed = JSON.parse(io.stdout.join('')) as Record<string, unknown>;
    assert.equal(parsed.kind, 'awaiting-approval');
    assert.equal(parsed.approvalId, 'apr_55');
    assert.match(String(parsed.hint), /do NOT rerun/);
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
  it('creates the project, writes .yolo/deploy.json, prints the committed-by-design note', async () => {
    const io = makeIo();
    const written: Array<{ cwd: string; config: Record<string, unknown> }> = [];
    const code = await runDeployCmd(
      ['init', '--slug', 'my-app', '--type', 'static'],
      baseDeps(io, {
        readDeployConfigImpl: () => linked(null),
        createProjectImpl: async (_ctx, request) => {
          assert.equal(request.name, 'my-app');
          assert.equal(request.slug, 'my-app');
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

  it('--tail degrades honestly to the buffered fetch with a notice (codex P2 r3 — no streaming route yet)', async () => {
    const io = makeIo();
    let buffered = 0;
    const code = await runDeployCmd(
      ['logs', '--tail', '--json'],
      baseDeps(io, {
        getLogsImpl: async () => {
          buffered += 1;
          return { ok: true, value: { entries: [], note: 'stub' } };
        },
        tailLogsImpl: async () => {
          throw new Error('tail leg must NOT be called until the streaming route exists');
        },
      }),
    );
    assert.equal(code, 0);
    assert.equal(buffered, 1);
    assert.match(io.stderr.join(''), /--tail is not available yet/);
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
