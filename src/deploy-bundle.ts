/**
 * Local bundling for `yolo deploy` (spec
 * `docs/MANAGED_HOSTING_CLI_SPEC.md` §2, `deploy-bundle`).
 *
 * Fully OFFLINE: every ceiling is enforced here, before any network —
 * `--dry-run` stops after this module. Outputs:
 *
 *   - **Worker module** — esbuild ESM bundle of the entry
 *     (`{bundle, format:'esm', platform:'browser',
 *     conditions:['workerd','worker'], target:'es2022', write:false,
 *     minify:true, define:{'process.env.NODE_ENV':'"production"'}}` +
 *     `nodeBuiltinExternalPlugin`). `NODE_ENV` is pinned to `production` so
 *     libraries that branch on it (React et al.) never ship their dev build on
 *     workerd (which has no runtime `process.env`). The plugin leaves every real
 *     `node:` builtin external (nodejs_compat serves the supported ones); a
 *     misspelled non-builtin is the only `node:` case that fails the build. It
 *     WARNS (not fails) when nodejs_compat is absent and when a builtin is loaded
 *     via `require()` (throws in an ESM Worker unless guarded). If the entry
 *     already points at a
 *     BUILT `.js`/`.mjs` module (vinext/OpenNext output, skill-directed),
 *     esbuild is SKIPPED and the module ships byte-for-byte as-is — the size
 *     ceilings still apply and the shipped text is scanned to WARN on retained
 *     `node:` imports and an unpinned `process.env.NODE_ENV`. esbuild is
 *     lazy-imported so `yolo plan` startup never pays for it (the `serve.ts`
 *     lazy-load precedent).
 *   - **Asset manifest** — walk `assetsDir` (skip dotfiles +
 *     node_modules), URL-style path → `{hash: sha256hex, size}`.
 *     Pure-static ships NO module; common-api attaches the canonical
 *     assets-only shim server-side.
 *   - **`bundleDigest`** — sha256 over module bytes + the sorted
 *     manifest; becomes `hosting_releases.bundleDigest` and binds T3
 *     approvals to exactly these bytes.
 *
 * Ceilings (defaults per spec; the server returns authoritative tier
 * caps at ship/start and re-checks — overrides below are for that and
 * for tests):
 *   - per-file 25 MiB (CF hard limit)        → `file-too-large`
 *   - 20,000 files                            → `too-many-files`
 *   - total assets 256 MiB                    → `bundle-too-large`
 *   - worker module >10 MiB                   → `bundle-too-large`
 *     (plus a warning when the gzipped module exceeds 1 MiB)
 */

import { createHash } from 'node:crypto';
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { isBuiltin } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

import type { Metafile, Plugin } from 'esbuild';

import type { ProjectShape } from './deploy-detect.js';

// ─── Vendored @yolo-labs/flexdb ─────────────────────────────────────────────
//
// FlexDB is not published to npm yet (it will be). Until then, the deploy
// bundler resolves `import { FlexDB } from '@yolo-labs/flexdb'` to a copy
// vendored into the CLI's dist (built by scripts/build-vendored-flexdb.mjs), so
// a customer Worker can use FlexDB without installing it. A real installed copy
// is preferred once the package is published — see vendoredFlexdbPlugin.

let cachedFlexdbSource: string | null | undefined;

/** The vendored FlexDB bundle shipped in the CLI's dist, or null if absent (unbuilt dev tree). */
function readVendoredFlexdb(): string | null {
  if (cachedFlexdbSource !== undefined) return cachedFlexdbSource;
  try {
    const p = fileURLToPath(new URL('./vendored/flexdb.mjs', import.meta.url));
    cachedFlexdbSource = existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    cachedFlexdbSource = null;
  }
  return cachedFlexdbSource;
}

/**
 * esbuild plugin that supplies `@yolo-labs/flexdb` from the CLI's vendored copy
 * when the project hasn't installed it. A real installed copy (post-publish) is
 * preferred. Returns null when no vendored bundle is present, leaving esbuild's
 * default resolution untouched.
 */
function vendoredFlexdbPlugin(): Plugin | null {
  const source = readVendoredFlexdb();
  if (source === null) return null;
  const NS = 'yolo-vendored-flexdb';
  const SPECIFIER = '@yolo-labs/flexdb';
  return {
    name: 'yolo-vendored-flexdb',
    setup(build) {
      build.onResolve({ filter: /^@yolo-labs\/flexdb$/ }, async (args) => {
        // Re-entry guard: our build.resolve() below re-fires this same filter.
        if ((args.pluginData as { vendored?: boolean } | undefined)?.vendored) return null;
        // Prefer a real installed copy if the project has one (post-publish).
        const real = await build.resolve(args.path, {
          importer: args.importer,
          resolveDir: args.resolveDir,
          kind: args.kind,
          pluginData: { vendored: true },
        });
        if (real.errors.length === 0 && real.path) return real;
        // Otherwise route to the vendored virtual module.
        return { path: SPECIFIER, namespace: NS };
      });
      build.onLoad({ filter: /.*/, namespace: NS }, () => ({
        contents: source,
        loader: 'js',
        resolveDir: '/',
      }));
    },
  };
}

// ─── node: builtin externalization ──────────────────────────────────────────
//
// A `node:` builtin can't be bundled — esbuild's browser resolver would hard-
// fail it. We leave every REAL builtin external (workerd's nodejs_compat serves
// the ones it supports at the pinned compatibility date); the ONLY `node:` case
// that stays a build error is a non-builtin specifier (a `node:async_hook` typo
// → esbuild "Could not resolve"). Everything else externalizes and, where risky,
// WARNS post-bundle:
//   - a require()-kind load → esbuild emits __require(...), which throws in an
//     ESM Worker UNLESS guarded by try/catch → warn (collectExternalNodeRequires),
//     don't fail — a hard error would break guarded optional-dependency probes
//   - node: builtins with no nodejs_compat → warn (warnMissingNodejsCompat)
//
// Deliberately NOT a workerd compatibility oracle: which builtins a given
// compatibility-date + flag set actually serves (tls, node:fs behind
// enable_nodejs_fs_module, modules dropped by no_* flags, …) is a moving matrix
// that belongs to the runtime, not the bundler. Modeling it here only produces
// false build rejections of valid Workers. The post-ship boot probe / runtime is
// the authority on whether a module is really served.

/**
 * esbuild plugin that leaves every real `node:` builtin external (any import
 * kind, including require-call), so a non-builtin typo is the only `node:` case
 * that stays a build error. A require()-kind load is externalized rather than
 * rejected: esbuild emits `__require(...)`, which a GUARDED probe
 * (`try { require("node:fs") } catch { …fallback… }`) can still catch — a hard
 * rejection would break that common optional-dependency pattern. An UNGUARDED
 * require of a builtin throws in an ESM Worker; that's surfaced as a post-bundle
 * warning (see collectExternalNodeRequires), not a build failure.
 */
function nodeBuiltinExternalPlugin(): Plugin {
  return {
    name: 'yolo-node-builtin-external',
    setup(build) {
      build.onResolve({ filter: /^node:/ }, (args) => {
        if (isBuiltin(args.path)) return { path: args.path, external: true };
        return null; // not a builtin at all → esbuild reports "Could not resolve"
      });
    },
  };
}

/**
 * The distinct `node:<builtin>` specifiers referenced by already-bundled text
 * (prebuilt worker path, which never touches esbuild). A `node:` literal in
 * call position — `require(…)`, esbuild's `__require(…)`, dynamic `import(…)` —
 * or after `from`/bare `import` counts. Matching any call `(` (rather than a
 * specific helper name) is deliberate: bundlers rename the require helper.
 * Deduped, sorted.
 */
export function collectNodeBuiltinsFromText(text: string): string[] {
  const found = new Set<string>();
  const re = /(?:\bfrom\s*|\bimport\s*|\(\s*)['"](node:[a-zA-Z0-9_/.-]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[1]!);
  return [...found].sort();
}

/**
 * The distinct `node:` builtins loaded via a CommonJS `require(…)` / esbuild's
 * `__require(…)` (any `<ident>require(` helper) in already-bundled text. These
 * throw in an ESM Worker regardless of `nodejs_compat` — the esbuild path
 * rejects them; the prebuilt path (esbuild skipped) can only WARN. Deduped, sorted.
 */
export function collectNodeRequireCalls(text: string): string[] {
  const found = new Set<string>();
  // A require-CALL of a node: literal: `require("node:x")`, `__require("node:x")`.
  // The leading \w* covers renamed helpers; it won't match the shim's own
  // definition (that has no node: string argument).
  const re = /\w*require\s*\(\s*['"](node:[a-zA-Z0-9_/.-]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) found.add(m[1]!);
  return [...found].sort();
}

/**
 * Push the "missing nodejs_compat" warning when a Worker references a `node:`
 * builtin but that flag isn't set. Shared by the esbuild and prebuilt paths so
 * `BundleOptions`' promise holds for both.
 *
 * Keyed strictly on `nodejs_compat` — the ONLY compatibility flag the hosting
 * service accepts at ship (`ship-session.ts` ALLOWED_COMPATIBILITY_FLAGS). We
 * deliberately do NOT recognize narrower flags (`nodejs_als`) or per-module
 * enable flags here: suppressing the warning for a flag the server rejects
 * would pass local bundling only to fail at ship with `bundle-invalid`.
 */
function warnMissingNodejsCompat(nodeBuiltins: string[], compatibilityFlags: string[], warnings: string[]): void {
  if (nodeBuiltins.length === 0 || compatibilityFlags.includes('nodejs_compat')) return;
  warnings.push(
    `worker imports node: builtins (${nodeBuiltins.join(', ')}) but compatibilityFlags does not ` +
      `include "nodejs_compat" — they resolve to nothing at runtime on workerd. Add "nodejs_compat" ` +
      `to .yolo/deploy.json compatibilityFlags.`,
  );
}

// ─── Public types ─────────────────────────────────────────────────────────

export const DEPLOY_CEILINGS = {
  /** CF hard per-file limit. */
  maxFileBytes: 25 * 1024 * 1024,
  maxFiles: 20_000,
  /** Local default; the server's tier cap is authoritative at ship/start. */
  maxTotalBytes: 256 * 1024 * 1024,
  /** Worker module hard cap. */
  maxModuleBytes: 10 * 1024 * 1024,
  /** Gzipped-module size that triggers a warning (not a failure). */
  warnModuleGzipBytes: 1 * 1024 * 1024,
  /**
   * Sourcemap sidecar cap — mirrors the server's FINALIZE_SOURCEMAPS_MAX_BYTES
   * (common-api `routes/deploy.ts`). Over this we DROP the map (+ warn) rather
   * than fail the deploy or 413 late at finalize — symbolication is optional.
   */
  maxSourceMapBytes: 40 * 1024 * 1024,
} as const;

export interface BundleCeilings {
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxModuleBytes?: number;
  warnModuleGzipBytes?: number;
  maxSourceMapBytes?: number;
}

export interface AssetManifestEntry {
  /** sha256 hex of the file bytes. */
  hash: string;
  size: number;
}

/** Array view of one bundled asset (same data as a manifest entry). */
export interface BundleAsset {
  /** URL-style manifest path (`/index.html`). */
  path: string;
  /** sha256 hex of the file bytes. */
  hash: string;
  size: number;
  /** Absolute filesystem path, for the missing-assets upload leg. */
  absPath: string;
}

export interface BundleSuccess {
  ok: true;
  type: 'static' | 'worker';
  /** URL-style path (`/index.html`) → `{hash, size}` — the ship/start payload. */
  manifest: Record<string, AssetManifestEntry>;
  /** Manifest path → absolute fs path, for the missing-assets upload leg. */
  assetPaths: Record<string, string>;
  /** Array view of the manifest (same walk, sorted-path order). */
  assets: BundleAsset[];
  /** `null` for pure-static (server attaches the canonical shim). */
  module: { name: string; contents: Uint8Array } | null;
  /** Array view of `module` — empty for pure-static (finalize-leg shape). */
  workerModules: Array<{ name: string; contents: Uint8Array }>;
  /** Whether the module was shipped as-is (pre-built entry) vs esbuild-bundled. */
  moduleSource: 'esbuild' | 'prebuilt' | null;
  /**
   * External sourcemap SIDECAR for the worker module, when `sourcemaps` was
   * requested and esbuild produced one. Deliberately NOT part of `module` /
   * `workerModules` / the digest — it's uploaded as a separate CF part
   * (`application/source-map`) and the module carries a `//# sourceMappingURL`
   * comment linking to it, so CF symbolicates exceptions server-side.
   * `name` matches that comment (`index.js.map`). `null` when not emitted.
   */
  sourceMap: { name: string; content: string } | null;
  fileCount: number;
  totalAssetBytes: number;
  /** `sha256:<hex>` over module bytes + sorted manifest. */
  bundleDigest: string;
  warnings: string[];
}

export interface BundleFailure {
  ok: false;
  kind: 'build-failed' | 'file-too-large' | 'too-many-files' | 'bundle-too-large';
  message: string;
  hint?: string;
  /** Optional structured context (package failure-shape convention). */
  detail?: Record<string, unknown>;
}

export type BundleResult = BundleSuccess | BundleFailure;

// ─── Public entry ─────────────────────────────────────────────────────────

export interface BundleOptions {
  /**
   * `.yolo/deploy.json` `compatibilityFlags` — used only to decide whether a
   * worker's `node:` imports should warn. When `nodejs_compat` is present the
   * runtime provides those builtins, so the warning is suppressed.
   */
  compatibilityFlags?: string[];
  /**
   * Emit a linked sourcemap for an esbuild-bundled worker (adds a
   * `//# sourceMappingURL` comment to the module + returns the `.map` sidecar),
   * so the ship path can upload it and CF symbolicates exceptions. Opt-in: OFF
   * leaves the module bytes (and the digest) exactly as before. No effect on
   * static or prebuilt bundles.
   */
  sourcemaps?: boolean;
}

export async function bundleProject(
  shape: ProjectShape,
  cwd: string,
  ceilings: BundleCeilings = {},
  options: BundleOptions = {},
): Promise<BundleResult> {
  const caps = { ...DEPLOY_CEILINGS, ...definedOnly(ceilings) };
  const warnings: string[] = [];
  const compatibilityFlags = options.compatibilityFlags ?? [];

  // ── Worker module (esbuild, or as-is for pre-built entries) ────────────
  let module: BundleSuccess['module'] = null;
  let moduleSource: BundleSuccess['moduleSource'] = null;
  let sourceMap: BundleSuccess['sourceMap'] = null;
  if (shape.type === 'worker') {
    const built = await buildWorkerModule(
      shape.entry,
      cwd,
      shape.prebuilt === true,
      caps,
      warnings,
      compatibilityFlags,
      options.sourcemaps === true,
    );
    if (!built.ok) return built;
    module = built.module;
    moduleSource = built.source;
    sourceMap = built.sourceMap ?? null;
  }

  // ── Asset walk + manifest + ceilings ────────────────────────────────────
  const manifest: Record<string, AssetManifestEntry> = {};
  const assetPaths: Record<string, string> = {};
  const assets: BundleAsset[] = [];
  let fileCount = 0;
  let totalAssetBytes = 0;

  // Both arms carry assetsDir (required on static, optional on worker).
  const assetsDir = shape.assetsDir;
  if (assetsDir !== undefined) {
    const rootAbs = path.resolve(cwd, assetsDir);
    // Root-dir ships (assetsDir == the project root) serve whatever the walk
    // finds — which for repo-rooted static sites includes tests, README, and
    // the substrate's LANE.md. Those are excluded at the TOP level only:
    // a deliberately-shipped docs/README.md deeper in the tree still ships.
    const isRootShip = rootAbs === path.resolve(cwd);
    const rootShipSkipped: string[] = [];
    let rootStat;
    try {
      rootStat = statSync(rootAbs);
    } catch {
      rootStat = undefined;
    }
    if (rootStat === undefined || !rootStat.isDirectory()) {
      return {
        ok: false,
        kind: 'build-failed',
        message: `assets directory not found: ${assetsDir} (resolved ${rootAbs})`,
        hint: 'run the build first, or fix build.outputDir / worker.assetsDir in .yolo/deploy.json',
      };
    }

    for (const relPosix of walkAssetFiles(rootAbs)) {
      if (isRootShip && !relPosix.includes('/') && isRootShipExcludedName(relPosix)) {
        rootShipSkipped.push(relPosix);
        continue;
      }
      const absPath = path.join(rootAbs, ...relPosix.split('/'));
      const size = statSync(absPath).size;

      if (size > caps.maxFileBytes) {
        return {
          ok: false,
          kind: 'file-too-large',
          message: `${relPosix} is ${formatBytes(size)} — per-file limit is ${formatBytes(caps.maxFileBytes)}`,
          hint: 'host large media in the project R2 bucket or external storage',
        };
      }
      fileCount += 1;
      if (fileCount > caps.maxFiles) {
        return {
          ok: false,
          kind: 'too-many-files',
          message: `more than ${caps.maxFiles} files under ${assetsDir}`,
          hint: 'exclude generated/vendored trees from the assets dir',
        };
      }
      totalAssetBytes += size;
      if (totalAssetBytes > caps.maxTotalBytes) {
        return {
          ok: false,
          kind: 'bundle-too-large',
          message: `total assets exceed ${formatBytes(caps.maxTotalBytes)} (at ${relPosix})`,
          hint: 'host large media in the project R2 bucket or external storage',
        };
      }

      const manifestPath = '/' + relPosix;
      const hash = cfAssetHash(readFileSync(absPath), manifestPath);
      manifest[manifestPath] = { hash, size };
      assetPaths[manifestPath] = absPath;
      assets.push({ path: manifestPath, hash, size, absPath });
    }
    if (rootShipSkipped.length > 0) {
      warnings.push(
        `root-dir ship: excluded ${rootShipSkipped.sort().join(', ')} from the public bundle ` +
          `(tests, README, and lane files don't ship from a repo-root assets dir; ` +
          `use a dist/ publish dir to control exactly what ships)`,
      );
    }
  } else if (shape.type === 'static') {
    // Type system prevents this (static requires assetsDir), but guard anyway.
    return { ok: false, kind: 'build-failed', message: 'static project has no assetsDir' };
  }

  return {
    ok: true,
    type: shape.type,
    manifest,
    assetPaths,
    assets,
    module,
    workerModules: module === null ? [] : [module],
    moduleSource,
    sourceMap, // sidecar — intentionally excluded from workerModules + the digest below
    fileCount,
    totalAssetBytes,
    bundleDigest: computeBundleDigest(module === null ? [] : [module], manifest),
    warnings,
  };
}

/**
 * `sha256:<hex>` over name-framed module bytes + the sorted manifest.
 *
 * ⚠️ MIRROR — the CANONICAL implementation is the server verifier
 * (`common-api/src/services/hosting/release-service.ts` computeBundleDigest);
 * finalize recomputes with this exact recipe and refuses on mismatch
 * (`bundle-digest-mismatch`). Recipe: modules sorted by name, each hashed as
 * `name‖0x00‖bytes‖0x00`; then `JSON.stringify` of path-sorted entries shaped
 * `[path, {hash, size}]`. The golden-vector test pins all three copies
 * (this, the server, yolo-studio-mcp/src/lib/static-bundle.ts) to the same
 * output — change one, change all.
 */
export function computeBundleDigest(
  modules: Array<{ name: string; contents: Uint8Array }>,
  manifest: Record<string, AssetManifestEntry>,
): string {
  const hash = createHash('sha256');
  const sorted = [...modules].sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const mod of sorted) {
    hash.update(mod.name, 'utf8');
    hash.update(Buffer.from([0]));
    hash.update(mod.contents);
    hash.update(Buffer.from([0]));
  }
  const entries = Object.keys(manifest)
    .sort()
    .map((path) => [path, { hash: manifest[path]!.hash, size: manifest[path]!.size }]);
  hash.update(JSON.stringify(entries), 'utf8');
  return `sha256:${hash.digest('hex')}`;
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * The distinct `node:` builtin specifiers esbuild left external for this
 * bundle (deduped, sorted). Empty when the Worker imports none. Used to warn
 * when `nodejs_compat` is absent — the runtime, not the bundler, is where a
 * missing flag bites.
 */
function collectExternalNodeBuiltins(metafile: Metafile | undefined): string[] {
  if (!metafile) return [];
  const found = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const imp of input.imports) {
      if (imp.external && imp.path.startsWith('node:')) found.add(imp.path);
    }
  }
  return [...found].sort();
}

/**
 * Ensure the sourcemap JSON carries a `file` field naming the module it maps
 * (`index.js`) — CF associates a map to its module by this field (verified live)
 * and esbuild omits it. Returns the map text unchanged if it isn't parseable
 * JSON (defensive; the map still ships, just possibly un-symbolicated).
 */
function withMapFile(mapText: string, moduleName: string): string {
  try {
    const parsed = JSON.parse(mapText) as Record<string, unknown>;
    if (parsed.file === moduleName) return mapText;
    parsed.file = moduleName;
    return JSON.stringify(parsed);
  } catch {
    return mapText;
  }
}

/**
 * The distinct `node:` builtins loaded via a CommonJS `require()` (esbuild
 * import kind `require-call`) in this bundle. esbuild compiles these to
 * `__require(...)`, which throws in an ESM Worker unless the call is guarded by
 * try/catch — so we WARN (not fail), preserving the guarded optional-dependency
 * pattern. Deduped, sorted.
 */
function collectExternalNodeRequires(metafile: Metafile | undefined): string[] {
  if (!metafile) return [];
  const found = new Set<string>();
  for (const input of Object.values(metafile.inputs)) {
    for (const imp of input.imports) {
      if (imp.external && imp.kind === 'require-call' && imp.path.startsWith('node:')) found.add(imp.path);
    }
  }
  return [...found].sort();
}

type BuildModuleResult =
  | {
      ok: true;
      module: { name: string; contents: Uint8Array };
      source: 'esbuild' | 'prebuilt';
      sourceMap?: { name: string; content: string };
    }
  | BundleFailure;

async function buildWorkerModule(
  entry: string,
  cwd: string,
  prebuilt: boolean,
  caps: Required<BundleCeilings>,
  warnings: string[],
  compatibilityFlags: string[],
  sourcemaps: boolean,
): Promise<BuildModuleResult> {
  const entryAbs = path.resolve(cwd, entry);
  let contents: Uint8Array;
  let name: string;
  let source: 'esbuild' | 'prebuilt';
  let sourceMap: { name: string; content: string } | undefined;

  // Ship as-is ONLY for an explicitly-configured built output (deploy.json
  // worker.entry → .js/.mjs). Auto-detected `src/index.js` is SOURCE and must
  // be bundled or its imports are dropped (codex P2 r6).
  if (prebuilt) {
    try {
      contents = readFileSync(entryAbs);
    } catch {
      return {
        ok: false,
        kind: 'build-failed',
        message: `worker entry not found: ${entry} (resolved ${entryAbs})`,
        hint: 'run the framework build first, or fix worker.entry in .yolo/deploy.json',
      };
    }
    name = path.basename(entryAbs);
    source = 'prebuilt';
    // esbuild never runs for prebuilt output (vinext/OpenNext), so its define +
    // node: externalization can't apply — scan the shipped text directly and
    // WARN instead. Mutating an opaque framework bundle would break the
    // ship-as-is contract; the fix belongs in the framework build.
    const prebuiltText = Buffer.from(contents).toString('utf8');
    warnMissingNodejsCompat(collectNodeBuiltinsFromText(prebuiltText), compatibilityFlags, warnings);
    // A require()/__require() of a node: builtin throws in an ESM Worker no
    // matter what nodejs_compat is — the esbuild path rejects it, so warn here
    // independently of the missing-compat warning above (which nodejs_compat
    // suppresses). The framework build should emit ESM imports instead.
    const nodeRequires = collectNodeRequireCalls(prebuiltText);
    if (nodeRequires.length > 0) {
      warnings.push(
        `prebuilt worker uses require() of node: builtins (${nodeRequires.join(', ')}) — a CommonJS ` +
          `require of a builtin throws in an ESM Worker. Rebuild it to emit ESM \`import\`s.`,
      );
    }
    if (prebuiltText.includes('process.env.NODE_ENV')) {
      // A pinned build would have replaced this literal with "production"; its
      // survival means NODE_ENV is unpinned → risks shipping a dev build.
      warnings.push(
        `prebuilt worker references process.env.NODE_ENV — workerd has no runtime process.env, so an ` +
          `unpinned NODE_ENV can ship a dev build (e.g. development React). Pin it in your framework ` +
          `build (esbuild define 'process.env.NODE_ENV'='"production"').`,
      );
    }
  } else {
    // Lazy-load so non-deploy verbs never pay esbuild's startup cost.
    const esbuild = await import('esbuild');
    // Vendor @yolo-labs/flexdb (not yet published) so a customer Worker can
    // `import { FlexDB } from '@yolo-labs/flexdb'` without installing it.
    const flexdbPlugin = vendoredFlexdbPlugin();
    let result;
    try {
      result = await esbuild.build({
        entryPoints: [entryAbs],
        bundle: true,
        format: 'esm',
        platform: 'browser',
        conditions: ['workerd', 'worker'],
        target: 'es2022',
        write: false,
        minify: true,
        metafile: true,
        // Pin production so libraries that gate on process.env.NODE_ENV (React
        // et al.) never emit their dev build — workerd has no runtime
        // process.env, so an unpinned NODE_ENV silently ships dev code.
        define: { 'process.env.NODE_ENV': '"production"' },
        absWorkingDir: path.resolve(cwd),
        logLevel: 'silent',
        // sourcemaps: 'linked' adds a `//# sourceMappingURL=index.js.map`
        // comment (which CF uses to associate the uploaded map) + emits the
        // .map as a second output. A fixed outfile makes that comment's name
        // deterministic so it matches the uploaded sidecar. OFF → the exact
        // prior options → byte-identical module → stable digest.
        ...(sourcemaps ? { sourcemap: 'linked' as const, outfile: path.resolve(cwd, 'index.js') } : {}),
        // nodeBuiltinExternalPlugin leaves real node: builtins external
        // (nodejs_compat serves them); only a non-builtin misspelling fails the
        // build. Ordered first so it wins over default resolve.
        plugins: [nodeBuiltinExternalPlugin(), ...(flexdbPlugin ? [flexdbPlugin] : [])],
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        kind: 'build-failed',
        message: `esbuild failed for ${entry}: ${msg}`,
      };
    }
    const outputs = result.outputFiles ?? [];
    // The module is the non-.map output; the .map (present only with sourcemaps)
    // is the sidecar.
    const out = outputs.find((o) => !o.path.endsWith('.map'));
    const mapOut = outputs.find((o) => o.path.endsWith('.map'));
    if (out === undefined) {
      return { ok: false, kind: 'build-failed', message: `esbuild produced no output for ${entry}` };
    }
    // node: builtins were left external above; if the Worker actually imports
    // any and nodejs_compat isn't enabled, they resolve to nothing at runtime.
    warnMissingNodejsCompat(collectExternalNodeBuiltins(result.metafile), compatibilityFlags, warnings);
    // A require()-kind load of a builtin becomes __require(...), which throws in
    // an ESM Worker unless guarded — advisory (guarded probes stay valid).
    const nodeRequires = collectExternalNodeRequires(result.metafile);
    if (nodeRequires.length > 0) {
      warnings.push(
        `worker loads node: builtins via require() (${nodeRequires.join(', ')}) — require() throws in an ` +
          `ESM Worker unless wrapped in try/catch. Prefer an ESM \`import\`.`,
      );
    }
    contents = out.contents;
    name = 'index.js';
    source = 'esbuild';
    if (sourcemaps && mapOut !== undefined) {
      // Name matches the `//# sourceMappingURL=index.js.map` comment esbuild
      // wrote into the module (deterministic via the fixed outfile).
      // CF associates the sourcemap to the module by the map's `file` field —
      // verified against the live account: esbuild OMITS `file`, and without it
      // CF returns minified exception stacks; adding `file` = the module name
      // makes it symbolicate. (wrangler's map carries `file` too.)
      const content = withMapFile(Buffer.from(mapOut.contents).toString('utf8'), name);
      if (Buffer.byteLength(content, 'utf8') > caps.maxSourceMapBytes) {
        // Too big to upload — drop it (the module is valid) so the deploy still
        // ships, just without symbolicated stacks. Better than a late 413.
        warnings.push(
          `sourcemap is ${formatBytes(Buffer.byteLength(content, 'utf8'))} (> ${formatBytes(caps.maxSourceMapBytes)}) — ` +
            `skipping it; exceptions in deploy.logs won't be source-mapped for this release`,
        );
      } else {
        sourceMap = { name: 'index.js.map', content };
      }
    }
  }

  if (contents.byteLength > caps.maxModuleBytes) {
    return {
      ok: false,
      kind: 'bundle-too-large',
      message: `worker module is ${formatBytes(contents.byteLength)} — limit is ${formatBytes(caps.maxModuleBytes)}`,
      hint: 'split vendored data out of the module (assets or R2), or trim dependencies',
    };
  }
  const gzipBytes = gzipSync(contents).byteLength;
  if (gzipBytes > caps.warnModuleGzipBytes) {
    warnings.push(
      `worker module is ${formatBytes(gzipBytes)} gzipped (> ${formatBytes(caps.warnModuleGzipBytes)}) — cold starts will suffer`,
    );
  }

  return { ok: true, module: { name, contents }, source, ...(sourceMap ? { sourceMap } : {}) };
}

/**
 * Top-level names excluded from a ROOT-DIR ship (assetsDir == project root).
 * Repo-rooted static sites otherwise serve their tests, README, and the
 * substrate's LANE.md publicly (2026-07-22 field report). Applies ONLY at the
 * top level of a root ship — never inside an explicit dist/public dir, and a
 * nested docs/README.md still ships. (`.yolo/` and other dot-entries are
 * already dropped by the dotfile rule in walkAssetFiles.)
 */
function isRootShipExcludedName(name: string): boolean {
  if (name === 'LANE.md') return true;
  if (name.toLowerCase() === 'readme.md') return true;
  return /\.test\.(js|mjs|cjs|ts|tsx|jsx)$/i.test(name);
}

/**
 * Depth-first walk returning sorted posix-relative file paths. Skips
 * dotfiles/dot-dirs and node_modules at every level. Symlinked DIRS are
 * skipped (cycle safety). Symlinked FILES are included only when their
 * realpath stays INSIDE the asset root (codex P1 r12) — a
 * `public/token.txt -> ~/.config/yolo/token` link would otherwise publish a
 * credential as a public asset.
 */
function walkAssetFiles(rootAbs: string): string[] {
  // Resolve the root once (it may itself be reached through a symlink) so the
  // containment check compares real paths on both sides.
  let rootReal: string;
  try {
    rootReal = realpathSync(rootAbs);
  } catch {
    rootReal = rootAbs;
  }
  const within = (abs: string): boolean => {
    try {
      const real = realpathSync(abs);
      return real === rootReal || real.startsWith(rootReal + path.sep);
    } catch {
      return false; // dangling / unreadable → don't include
    }
  };
  const files: string[] = [];
  const walk = (relPosix: string): void => {
    const dirAbs = relPosix === '' ? rootAbs : path.join(rootAbs, ...relPosix.split('/'));
    const entries = readdirSync(dirAbs, { withFileTypes: true })
      .filter((e) => !e.name.startsWith('.') && e.name !== 'node_modules')
      .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const childRel = relPosix === '' ? entry.name : `${relPosix}/${entry.name}`;
      if (entry.isDirectory()) {
        walk(childRel);
      } else if (entry.isFile()) {
        files.push(childRel);
      } else if (entry.isSymbolicLink()) {
        // Follow file symlinks ONLY when they resolve to a regular file that
        // stays under the asset root.
        const abs = path.join(dirAbs, entry.name);
        try {
          if (statSync(abs).isFile() && within(abs)) files.push(childRel);
        } catch {
          // dangling symlink — skip
        }
      }
    }
  };
  walk('');
  return files;
}

/**
 * Cloudflare Workers-Assets manifest hash (wrangler's scheme, verified against
 * the CF assets-upload-session API 2026-06-13): `sha256(base64(contents) +
 * extension-without-dot)` hex-encoded, truncated to 32 chars. CF rejects a
 * full 64-hex sha256 ("file hash size of 64 is too large", code 10304) and
 * content-addresses uploaded assets by THIS value — it must match exactly or
 * the bucket upload / serve fails. The server keeps this value verbatim in the
 * manifest (it never recomputes asset hashes), so the CLI is canonical here.
 */
function cfAssetHash(bytes: Uint8Array, manifestPath: string): string {
  const ext = path.extname(manifestPath).slice(1); // 'html', 'css', '' …
  return createHash('sha256')
    .update(Buffer.from(bytes).toString('base64') + ext)
    .digest('hex')
    .slice(0, 32);
}

function formatBytes(n: number): string {
  if (n >= 1024 * 1024) return `${(n / (1024 * 1024)).toFixed(1)} MiB`;
  if (n >= 1024) return `${(n / 1024).toFixed(1)} KiB`;
  return `${n} B`;
}

function definedOnly<T extends object>(obj: T): Partial<T> {
  const out: Partial<T> = {};
  for (const [k, v] of Object.entries(obj)) {
    if (v !== undefined) (out as Record<string, unknown>)[k] = v;
  }
  return out;
}
