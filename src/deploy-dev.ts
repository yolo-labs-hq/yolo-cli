/**
 * `yolo deploy dev` — run the project locally on the SAME runtime it deploys to
 * (Cloudflare workerd, via miniflare) so the workerd-contract gotchas
 * (`process.env`, `node:` builtins, `WeakRef`/`FinalizationRegistry`, an
 * unpinned dev-React build) surface locally instead of only after a ship. A
 * plain `node dist/server.js` runs on Node and gives false confidence — see the
 * Runtime Contract doc.
 *
 * The worker is bundled with the SAME `bundleProject` recipe `yolo deploy` uses
 * (so the NODE_ENV pin + node: handling match prod), and served under the SAME
 * pinned compatibility date the hosting service uses. Static projects are served
 * through the identical assets-only shim the server attaches in prod.
 *
 * miniflare is a heavy (workerd-carrying) dependency, so it's dynamically
 * imported ONLY here — no other `yolo` verb pays for it.
 */

import { copyFileSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { bundleProject, type BundleAsset, type BundleResult } from './deploy-bundle.js';
import { readDeployConfig, type DeployConfig } from './deploy-config.js';
import { detectProjectShape, type ProjectShape } from './deploy-detect.js';
import { defaultRunBuild, type RunBuildImpl } from './deploy-ship.js';

/**
 * The compatibility date the hosting runtime pins
 * (`common-api/.../release-service.ts` COMPATIBILITY_DATE). Dev MUST match it so
 * a feature that works locally works in prod and vice-versa.
 */
export const DEV_COMPATIBILITY_DATE = '2024-12-01';

/** The assets-only shim the SERVER attaches for a pure-static project (kept in lockstep). */
const STATIC_DEV_SHIM = `export default { async fetch(request, env) { return env.ASSETS.fetch(request); } };`;

export interface DevIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface DevServerOptions {
  cwd?: string;
  port?: number;
  host?: string;
  /** `--var KEY=VALUE` locals — dev has no access to real server-side env/secrets. */
  vars?: Record<string, string>;
  io: DevIo;
  // ─ test seams ─
  readDeployConfigImpl?: typeof readDeployConfig;
  detectProjectShapeImpl?: typeof detectProjectShape;
  bundleProjectImpl?: typeof bundleProject;
  runBuildImpl?: RunBuildImpl;
  /** Stage the prod-filtered asset set to a temp dir; returns its path (or null). */
  stageAssetsImpl?: (assets: BundleAsset[], alwaysDir: boolean) => string | null;
  /** Start the server; returns the served URL + a disposer. Defaults to miniflare. */
  startImpl?: (opts: MiniflareInit) => Promise<{ url: string; dispose: () => Promise<void> }>;
  /** Block until the user stops the server (SIGINT). Defaults to a SIGINT wait. */
  waitForStopImpl?: () => Promise<void>;
}

/** The subset of miniflare options we assemble (kept narrow so it's test-pure). */
export interface MiniflareInit {
  port: number;
  host: string;
  script: string;
  modules: true;
  compatibilityDate: string;
  compatibilityFlags: string[];
  bindings: Record<string, string>;
  kvNamespaces: string[];
  d1Databases: string[];
  r2Buckets: string[];
  assets?: { directory: string; binding: string };
}

/**
 * Map deploy.json + the bundled module text + an already-STAGED assets dir onto
 * miniflare options. Pure — the whole config→runtime translation is unit-tested
 * here without starting workerd. Local KV/D1/R2 are declared (in-memory) so a
 * worker that reads `env.<NAME>` doesn't crash; they hold no real data.
 *
 * `stagedAssetsDir` MUST be a dir holding only the prod-shipped asset set (see
 * stageProdAssets) — never the raw project dir, which would expose dotfiles
 * (`.env`), `node_modules`, and escaped symlinks that prod excludes.
 */
export function buildMiniflareInit(params: {
  config: DeployConfig | null;
  script: string;
  port: number;
  host: string;
  vars: Record<string, string>;
  stagedAssetsDir?: string | null;
}): MiniflareInit {
  const { config, script, port, host, vars, stagedAssetsDir } = params;
  const bindings = config?.bindings ?? [];
  const byKind = (kind: string) =>
    bindings.filter((b) => b.kind === kind).map((b) => b.binding).filter((n): n is string => typeof n === 'string');

  return {
    port,
    host,
    script,
    modules: true,
    compatibilityDate: DEV_COMPATIBILITY_DATE,
    compatibilityFlags: config?.compatibilityFlags ?? [],
    bindings: { ...vars },
    kvNamespaces: byKind('kv'),
    d1Databases: byKind('d1'),
    r2Buckets: byKind('r2'),
    ...(stagedAssetsDir ? { assets: { directory: stagedAssetsDir, binding: 'ASSETS' } } : {}),
  };
}

/**
 * Copy the bundle's ALREADY-FILTERED asset set (bundleProject applies the prod
 * exclusion rules: dotfiles, node_modules, escaping symlinks) into a fresh temp
 * dir laid out by manifest path, so miniflare serves exactly what prod would —
 * not the raw project dir.
 *
 * Returns null for an empty asset set UNLESS `alwaysDir` — a static project's
 * shim unconditionally calls `env.ASSETS.fetch`, so an empty static site still
 * needs an ASSETS binding (an empty dir → faithful 404s) rather than a runtime
 * "ASSETS is undefined" throw on every request.
 */
export function stageProdAssets(assets: BundleAsset[], alwaysDir = false): string | null {
  if (assets.length === 0 && !alwaysDir) return null;
  const dir = mkdtempSync(path.join(os.tmpdir(), 'yolo-dev-assets-'));
  for (const a of assets) {
    const dest = path.join(dir, a.path); // a.path is a URL-style '/index.html'
    mkdirSync(path.dirname(dest), { recursive: true });
    copyFileSync(a.absPath, dest);
  }
  return dir;
}

/** Default server start — lazy-imports miniflare so no other verb loads workerd. */
async function startWithMiniflare(init: MiniflareInit): Promise<{ url: string; dispose: () => Promise<void> }> {
  let Miniflare: typeof import('miniflare').Miniflare;
  try {
    ({ Miniflare } = await import('miniflare'));
  } catch {
    throw new Error(
      "`yolo deploy dev` needs the 'miniflare' package (it carries the workerd runtime). Install it with `npm i miniflare`.",
    );
  }
  const mf = new Miniflare(init as unknown as ConstructorParameters<typeof Miniflare>[0]);
  const url = (await mf.ready).toString();
  return { url, dispose: () => mf.dispose() };
}

/** Block until SIGINT/SIGTERM. */
function waitForSigint(): Promise<void> {
  return new Promise<void>((resolve) => {
    const stop = () => resolve();
    process.once('SIGINT', stop);
    process.once('SIGTERM', stop);
  });
}

/**
 * Orchestrate a local dev run: resolve shape → bundle (worker) or shim (static)
 * → assemble options → serve until stopped. Exit 0 on a clean stop, 1 on a
 * bundle/config failure.
 */
export async function runDeployDev(opts: DevServerOptions): Promise<number> {
  const cwd = opts.cwd ?? process.cwd();
  const io = opts.io;
  const readConfig = opts.readDeployConfigImpl ?? readDeployConfig;
  const detect = opts.detectProjectShapeImpl ?? detectProjectShape;
  const bundle = opts.bundleProjectImpl ?? bundleProject;
  const runBuild = opts.runBuildImpl ?? defaultRunBuild;
  const stageAssets = opts.stageAssetsImpl ?? stageProdAssets;
  const start = opts.startImpl ?? startWithMiniflare;
  const waitForStop = opts.waitForStopImpl ?? waitForSigint;
  const port = opts.port ?? 8787;
  const host = opts.host ?? '127.0.0.1';

  const readResult = readConfig(cwd);
  if (!readResult.ok) {
    io.err(`FAIL: ${readResult.message}\n  hint: run 'yolo deploy validate' for full config diagnostics\n`);
    return 1;
  }
  const config = readResult.config;
  const det = detect({ cwd, config: config ?? null });
  if (!det.ok) {
    io.err(`FAIL: ${det.message}\n`);
    return 1;
  }
  const shape = det.shape;

  // Build first — a static/prebuilt project serves its build OUTPUT, so a clean
  // checkout would otherwise miss (or serve stale) files. Mirrors the ship path.
  if (shape.buildCommand) {
    io.out(`building: ${shape.buildCommand}\n`);
    const built = await runBuild(shape.buildCommand, cwd, (chunk) => {
      for (const line of chunk.split(/\r?\n/)) if (line.trim()) io.err(`build> ${line}\n`);
    });
    if (built.code !== 0) {
      io.err(`FAIL: build command \`${shape.buildCommand}\` exited with code ${built.code}\n`);
      return 1;
    }
  }

  // Bundle (both static + worker): this walks the assets dir with the SAME prod
  // exclusion rules (dotfiles, node_modules, escaping symlinks) and, for a
  // worker, produces the module. We serve the STAGED filtered set — never the
  // raw dir — so dev can't expose files prod wouldn't.
  const bundled: BundleResult = await bundle(shape, cwd, undefined, { compatibilityFlags: config?.compatibilityFlags });
  if (!bundled.ok) {
    io.err(`FAIL: ${bundled.message}${bundled.hint ? `\n  hint: ${bundled.hint}` : ''}\n`);
    return 1;
  }
  for (const w of bundled.warnings) io.err(`warn: ${w}\n`);

  let script: string;
  if (shape.type === 'worker') {
    if (!bundled.module) {
      io.err('FAIL: worker produced no module to run\n');
      return 1;
    }
    script = Buffer.from(bundled.module.contents).toString('utf8');
  } else {
    script = STATIC_DEV_SHIM;
  }

  // Static projects always need an ASSETS binding (the shim calls it), even when
  // the output dir is empty — stage an empty dir in that case.
  const stagedAssetsDir = stageAssets(bundled.assets, shape.type === 'static');
  const cleanup = () => {
    if (stagedAssetsDir) {
      try {
        rmSync(stagedAssetsDir, { recursive: true, force: true });
      } catch {
        /* best-effort temp cleanup */
      }
    }
  };

  const init = buildMiniflareInit({ config, script, port, host, vars: opts.vars ?? {}, stagedAssetsDir });

  let server: { url: string; dispose: () => Promise<void> };
  try {
    server = await start(init);
  } catch (err) {
    io.err(`FAIL: ${err instanceof Error ? err.message : String(err)}\n`);
    cleanup();
    return 1;
  }

  io.out(`yolo deploy dev — serving ${shape.type} on ${server.url} (workerd, compat ${DEV_COMPATIBILITY_DATE})\n`);
  if (Object.keys(init.bindings).length === 0) {
    io.out('  note: no local vars set — real env vars/secrets are server-side; pass `--var KEY=VALUE` for local values\n');
  }
  io.out('  press Ctrl-C to stop\n');

  try {
    await waitForStop();
  } finally {
    await server.dispose();
    cleanup();
  }
  io.out('\ndev server stopped\n');
  return 0;
}
