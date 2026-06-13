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
 *     minify:true}`). If the entry already points at a BUILT `.js`/`.mjs`
 *     module (vinext/OpenNext output, skill-directed), esbuild is
 *     SKIPPED and the module ships byte-for-byte as-is — the size
 *     ceilings still apply. esbuild is lazy-imported so `yolo plan`
 *     startup never pays for it (the `serve.ts` lazy-load precedent).
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
import { readdirSync, readFileSync, statSync } from 'node:fs';
import path from 'node:path';
import { gzipSync } from 'node:zlib';

import type { ProjectShape } from './deploy-detect.js';

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
} as const;

export interface BundleCeilings {
  maxFileBytes?: number;
  maxFiles?: number;
  maxTotalBytes?: number;
  maxModuleBytes?: number;
  warnModuleGzipBytes?: number;
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

export async function bundleProject(
  shape: ProjectShape,
  cwd: string,
  ceilings: BundleCeilings = {},
): Promise<BundleResult> {
  const caps = { ...DEPLOY_CEILINGS, ...definedOnly(ceilings) };
  const warnings: string[] = [];

  // ── Worker module (esbuild, or as-is for pre-built entries) ────────────
  let module: BundleSuccess['module'] = null;
  let moduleSource: BundleSuccess['moduleSource'] = null;
  if (shape.type === 'worker') {
    const built = await buildWorkerModule(shape.entry, cwd, shape.prebuilt === true, caps, warnings);
    if (!built.ok) return built;
    module = built.module;
    moduleSource = built.source;
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
      const hash = sha256Hex(readFileSync(absPath));
      manifest[manifestPath] = { hash, size };
      assetPaths[manifestPath] = absPath;
      assets.push({ path: manifestPath, hash, size, absPath });
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

type BuildModuleResult =
  | { ok: true; module: { name: string; contents: Uint8Array }; source: 'esbuild' | 'prebuilt' }
  | BundleFailure;

async function buildWorkerModule(
  entry: string,
  cwd: string,
  prebuilt: boolean,
  caps: Required<BundleCeilings>,
  warnings: string[],
): Promise<BuildModuleResult> {
  const entryAbs = path.resolve(cwd, entry);
  let contents: Uint8Array;
  let name: string;
  let source: 'esbuild' | 'prebuilt';

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
  } else {
    // Lazy-load so non-deploy verbs never pay esbuild's startup cost.
    const esbuild = await import('esbuild');
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
        absWorkingDir: path.resolve(cwd),
        logLevel: 'silent',
      });
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        ok: false,
        kind: 'build-failed',
        message: `esbuild failed for ${entry}: ${msg}`,
      };
    }
    const out = result.outputFiles?.[0];
    if (out === undefined) {
      return { ok: false, kind: 'build-failed', message: `esbuild produced no output for ${entry}` };
    }
    contents = out.contents;
    name = 'index.js';
    source = 'esbuild';
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

  return { ok: true, module: { name, contents }, source };
}

/**
 * Depth-first walk returning sorted posix-relative file paths. Skips
 * dotfiles/dot-dirs and node_modules at every level. Symlinks to files
 * are included (resolved); symlinked dirs are skipped (cycle safety).
 */
function walkAssetFiles(rootAbs: string): string[] {
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
        try {
          if (statSync(path.join(dirAbs, entry.name)).isFile()) files.push(childRel);
        } catch {
          // dangling symlink — skip
        }
      }
    }
  };
  walk('');
  return files;
}

function sha256Hex(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
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
