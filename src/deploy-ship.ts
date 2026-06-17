/**
 * deploy-ship — orchestration for bare `yolo deploy` (the one-move ship).
 *
 * Pipeline (docs/MANAGED_HOSTING_CLI_SPEC.md §4):
 *   link (.yolo/deploy.json) → detect → build (if buildCommand) → bundle
 *   → ship/start (manifest) → upload ONLY the missing-hash buckets
 *   → finalize → live release (or 409 awaiting-approval on the T3 prod gate).
 *
 * `--dry-run` stops after bundle and is fully offline (no auth resolution,
 * no network) — it prints the manifest summary and returns success.
 *
 * Progress is line-oriented and agent-parseable: every line starts with
 * `deploy: ` and goes through the injected `progress` sink (the CLI layer
 * routes it to stdout, or stderr under --json). The final OK / PENDING /
 * FAIL line is the CLI layer's job (formatters exported from here).
 *
 * Exit-code mapping (spec §5) lives in `exitCodeForFailure` — backend
 * refusal reasons pass through verbatim as failure kinds and default to
 * exit 2 (backend rejected — don't blind-retry).
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import { spawn, execFileSync } from 'node:child_process';

import { readDeployConfig, type DeployConfig } from './deploy-config.js';
import { detectProjectShape, type ProjectShape } from './deploy-detect.js';
import { bundleProject, type BundleAsset } from './deploy-bundle.js';
import {
  resolveDeployContext,
  startShip,
  uploadAssetBucket,
  finalizeShip,
  type AssetManifest,
  type AssetUploadFile,
  type DeployClientFailure,
  type DeployContext,
  type DeployFetchLike,
  type StartShipRequest,
} from './deploy-client.js';
import type { ReadFileImpl } from './auth-context.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type RunBuildImpl = (
  command: string,
  cwd: string,
  onOutput: (chunk: string) => void,
) => Promise<{ code: number }>;

/** Test seams. Every default is the real sibling/leg implementation. */
export interface DeployShipDeps {
  readDeployConfigImpl?: typeof readDeployConfig;
  detectProjectShapeImpl?: typeof detectProjectShape;
  bundleProjectImpl?: typeof bundleProject;
  startShipImpl?: typeof startShip;
  uploadAssetBucketImpl?: typeof uploadAssetBucket;
  finalizeShipImpl?: typeof finalizeShip;
  runBuildImpl?: RunBuildImpl;
  /** Read one asset file's bytes for upload. Default: fs.readFileSync. */
  readAssetFileImpl?: (absolutePath: string) => Uint8Array;
  /** Best-effort git sha for the ship/start body. Default: `git rev-parse HEAD`. */
  resolveGitShaImpl?: (cwd: string) => string | undefined;
}

export interface DeployShipOptions {
  cwd?: string;
  /** `--env` flag value. Default 'staging' (→ channel 'preview'). */
  envFlag?: 'staging' | 'prod';
  dryRun?: boolean;
  env?: Record<string, string | undefined>;
  readFileImpl?: ReadFileImpl;
  fetchImpl?: DeployFetchLike;
  /** Line sink for `deploy: …` progress (no trailing newline). */
  progress?: (line: string) => void;
  deps?: DeployShipDeps;
}

export interface DeployShipSuccess {
  ok: true;
  dryRun: boolean;
  projectId: string;
  slug?: string;
  env: 'staging' | 'prod';
  channel: 'preview' | 'prod';
  type: 'static' | 'worker';
  fileCount: number;
  totalAssetBytes: number;
  bundleDigest: string;
  shipId?: string;
  releaseId?: string;
  url?: string;
  /**
   * Present only when the backend's post-ship probe found the deployed Worker
   * failed to boot (Cloudflare 522). The ship still SUCCEEDED (the release is
   * staged/live); this is an advisory that the live URL won't serve until fixed.
   */
  bootCheck?: { status: number; detail: string };
}

/** The T3 prod gate outcome — NOT an error; never blind-retried (exit 3). */
export interface DeployShipPending {
  ok: false;
  kind: 'awaiting-approval';
  projectId: string;
  slug?: string;
  approvalId: string;
  approvalUrl?: string;
  releaseId?: string;
  statement?: string;
  expiresAt?: string;
  message: string;
}

export interface DeployShipFailure {
  ok: false;
  kind: string;
  message: string;
  hint?: string;
  status?: number;
  detail?: Record<string, unknown>;
}

export type DeployShipResult = DeployShipSuccess | DeployShipPending | DeployShipFailure;

const NOT_LINKED_HINT = "run 'yolo deploy init' to create or link a hosting project";

// ─── Orchestration ────────────────────────────────────────────────────────

export async function runDeployShip(options: DeployShipOptions): Promise<DeployShipResult> {
  const cwd = options.cwd ?? process.cwd();
  const envFlag = options.envFlag ?? 'staging';
  const channel: 'preview' | 'prod' = envFlag === 'prod' ? 'prod' : 'preview';
  const dryRun = options.dryRun ?? false;
  const progress = options.progress ?? ((line: string) => process.stdout.write(`${line}\n`));
  const deps = options.deps ?? {};
  const readConfig = deps.readDeployConfigImpl ?? readDeployConfig;
  const detect = deps.detectProjectShapeImpl ?? detectProjectShape;
  const bundle = deps.bundleProjectImpl ?? bundleProject;
  const startShipLeg = deps.startShipImpl ?? startShip;
  const uploadLeg = deps.uploadAssetBucketImpl ?? uploadAssetBucket;
  const finalizeLeg = deps.finalizeShipImpl ?? finalizeShip;
  const runBuild = deps.runBuildImpl ?? defaultRunBuild;
  const readAssetFile = deps.readAssetFileImpl ?? defaultReadAssetFile;
  const resolveGitSha = deps.resolveGitShaImpl ?? defaultResolveGitSha;

  // 1. Link — .yolo/deploy.json with a projectId is the durable bond.
  const readResult = readConfig(cwd);
  if (!readResult.ok) {
    // 'malformed' | 'invalid' — a broken link file is a local failure
    // (exit 1), distinct from the not-linked first-ship case.
    return fail(readResult.kind, readResult.message);
  }
  const config: DeployConfig | null = readResult.config;
  if (!config || !config.projectId) {
    return fail(
      'not-linked',
      'this directory is not linked to a hosting project (.yolo/deploy.json missing or has no projectId)',
      NOT_LINKED_HINT,
    );
  }
  const projectId = config.projectId;
  progress(
    `deploy: link ok (project ${projectId}${config.slug ? `, slug ${config.slug}` : ''}${config.type ? `, type ${config.type}` : ''})`,
  );

  // 2. Detect.
  const detected = detect({ cwd, config });
  if (!detected.ok) return fail('detect-failed', detected.message);
  const shape = detected.shape;

  // 3. Build (if the shape carries a build command).
  if (shape.buildCommand) {
    const startedAt = Date.now();
    const buildResult = await runBuild(shape.buildCommand, cwd, (chunk) => {
      for (const line of chunk.split(/\r?\n/)) {
        if (line.trim()) progress(`deploy: build> ${line}`);
      }
    });
    if (buildResult.code !== 0) {
      return fail('build-failed', `build command \`${shape.buildCommand}\` exited with code ${buildResult.code}`);
    }
    progress(`deploy: build \`${shape.buildCommand}\` ... ok (${((Date.now() - startedAt) / 1000).toFixed(1)}s)`);
  }

  // 4. Bundle — all size/count ceilings fire locally in here, pre-network.
  const bundled = await bundle(shape, cwd);
  if (!bundled.ok) {
    return { ok: false, kind: bundled.kind, message: bundled.message, hint: bundled.hint, detail: bundled.detail };
  }
  const fileCount = bundled.fileCount;
  for (const warning of bundled.warnings) progress(`deploy: warn ${warning}`);
  progress(
    `deploy: bundle ok (${bundleLabel(shape)}, ${fileCount} files, ${formatMiB(bundled.totalAssetBytes)}, digest ${shortDigest(bundled.bundleDigest)})`,
  );

  const base = {
    projectId,
    slug: config.slug,
    env: envFlag,
    channel,
    type: shape.type,
    fileCount,
    totalAssetBytes: bundled.totalAssetBytes,
    bundleDigest: bundled.bundleDigest,
  } as const;

  // 5. Dry-run stops here — fully offline by construction (auth + network
  //    resolution happen below this line).
  if (dryRun) return { ok: true, dryRun: true, ...base };

  const auth = resolveDeployContext(options.env ?? process.env, options.readFileImpl, options.fetchImpl);
  if (!auth.ok) return fail('auth', auth.message);
  // Bounded auto-retry for transient edge/origin 5xx (incl. CF 522) on the
  // ship legs — a single transient blip shouldn't hard-fail a prod deploy.
  const ctx: DeployContext = {
    ...auth.context,
    retry: {
      onRetry: ({ leg, attempt, maxAttempts, delayMs, failure }) =>
        progress(
          `deploy: ${leg} transient error (${failure.message}); retrying ${attempt}/${maxAttempts - 1} in ${Math.round(delayMs)}ms`,
        ),
    },
  };

  // 6. ship/start — manifest up, missing-hash buckets back.
  const manifest: AssetManifest = bundled.manifest;
  const request: StartShipRequest = {
    env: channel,
    type: shape.type,
    manifest,
    bundleDigest: bundled.bundleDigest,
  };
  const workerModules = bundled.workerModules;
  if (workerModules.length > 0) {
    request.worker = {
      mainModule: workerModules[0]!.name,
      sizeBytes: workerModules.reduce((total, module) => total + module.contents.byteLength, 0),
    };
  }
  if (config.compatibilityFlags && config.compatibilityFlags.length > 0) {
    request.compatibilityFlags = config.compatibilityFlags;
  }
  const gitSha = resolveGitSha(cwd);
  if (gitSha) request.gitSha = gitSha;

  const started = await startShipLeg(ctx, projectId, request);
  if (!started.ok) return clientFail(started);
  const { shipId, missing } = started.value;

  const assetsByHash = new Map(bundled.assets.map((asset) => [asset.hash, asset]));
  const missingHashes = new Set(missing.flat());
  let missingBytes = 0;
  for (const hash of missingHashes) missingBytes += assetsByHash.get(hash)?.size ?? 0;
  progress(
    `deploy: ship/start ok (shipId ${shipId}, ${missingHashes.size}/${fileCount} assets missing, ${formatMiB(missingBytes)} to upload)`,
  );

  // 7. Upload ONLY the missing buckets — hash-matched unchanged assets never
  //    leave the pod (the incremental-redeploy hot loop).
  const buckets = missing.filter((bucket) => bucket.length > 0);
  if (buckets.length === 0) {
    progress('deploy: assets 0/0 buckets ok (0.0 MiB)');
  } else {
    let uploadedBytes = 0;
    for (let i = 0; i < buckets.length; i++) {
      const files = readBucketFiles(buckets[i]!, assetsByHash, readAssetFile);
      if (!files.ok) return files;
      const uploaded = await uploadLeg(ctx, projectId, shipId, files.files);
      if (!uploaded.ok) return clientFail(uploaded);
      uploadedBytes += files.bytes;
      progress(`deploy: assets ${i + 1}/${buckets.length} buckets ok (${formatMiB(uploadedBytes)})`);
    }
  }

  // 8. Finalize — worker modules multipart / empty JSON for pure-static.
  const finalized = await finalizeLeg(ctx, projectId, shipId, workerModules);
  if (!finalized.ok) {
    if (finalized.kind === 'awaiting-approval' && 'approvalId' in finalized) {
      progress('deploy: finalize → pending operator approval (T3 prod ship)');
      return {
        ok: false,
        kind: 'awaiting-approval',
        projectId,
        slug: config.slug,
        approvalId: finalized.approvalId,
        approvalUrl: finalized.approvalUrl,
        releaseId: finalized.releaseId,
        statement: finalized.statement,
        expiresAt: finalized.expiresAt,
        message: finalized.message,
      };
    }
    return clientFail(finalized as DeployClientFailure);
  }
  progress('deploy: finalize ok');

  const bootCheck = parseBootCheck(finalized.value.bootCheck);
  if (bootCheck) progress(`deploy: warn — deployed Worker failed to boot (HTTP ${bootCheck.status})`);

  return {
    ok: true,
    dryRun: false,
    ...base,
    shipId,
    releaseId: finalized.value.releaseId,
    url: finalized.value.url,
    ...(bootCheck ? { bootCheck } : {}),
  };
}

/** Narrow the backend's optional `bootCheck` envelope; ignore anything malformed. */
function parseBootCheck(raw: unknown): { status: number; detail: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'number' || typeof r.detail !== 'string') return undefined;
  return { status: r.status, detail: r.detail };
}

// ─── Exit codes (spec §5 — EXACT) ─────────────────────────────────────────

/**
 * | Exit | Meaning                                  |
 * |------|------------------------------------------|
 * | 0    | success                                  |
 * | 64   | usage (bad flags/args)                   |
 * | 78   | environment (session-required, auth)     |
 * | 1    | local failure (fix project, retry)       |
 * | 2    | backend rejected (don't blind-retry)     |
 * | 3    | awaiting-approval (T3 — NOT an error)    |
 * | 4    | transient transport (retry w/ backoff)   |
 *
 * Backend refusal reasons not listed locally (slug-taken, quota-exceeded,
 * upload-expired, …) fall through to 2 — backend rejected.
 */
export function exitCodeForFailure(kind: string): number {
  switch (kind) {
    case 'usage':
      return 64;
    case 'session-required':
    case 'auth':
      return 78;
    case 'not-linked':
    case 'detect-failed':
    case 'build-failed':
    case 'file-too-large':
    case 'too-many-files':
    case 'bundle-too-large':
    case 'asset-read-failed':
    case 'config-write-failed':
    case 'malformed': // .yolo/deploy.json unparseable (deploy-config kind)
    case 'invalid': // .yolo/deploy.json schema-invalid (deploy-config kind)
      return 1;
    case 'awaiting-approval':
      return 3;
    case 'network':
      return 4;
    default:
      return 2;
  }
}

// ─── Final-line formatters (rendered by the CLI layer) ────────────────────

export function formatShipSuccess(result: DeployShipSuccess): string {
  const name = result.slug ?? result.projectId;
  if (result.dryRun) {
    return (
      `OK: dry-run — would ship ${name} (${result.type}, ${result.fileCount} files, ` +
      `${formatMiB(result.totalAssetBytes)}, digest ${shortDigest(result.bundleDigest)}) to ${result.env}; nothing was uploaded`
    );
  }
  return `OK: shipped ${name} release ${result.releaseId ?? '(unknown)'} → ${result.url ?? '(no url reported)'} (${result.env})`;
}

/**
 * Two independent "do not retry" signals: the PENDING prefix (not FAIL) and
 * exit 3 — so neither prefix-matching nor exit-code-matching agents loop.
 */
export function formatPending(result: DeployShipPending): string {
  const name = result.slug ?? result.projectId;
  const releaseTag = result.releaseId ? ` (release-candidate ${result.releaseId})` : '';
  const approveLine = result.approvalUrl
    ? `  approve: ${result.approvalUrl}  (single-use, states action+project)`
    : `  approve: approval ${result.approvalId} in the Studio approvals panel (single-use, states action+project)`;
  return [
    `PENDING [awaiting-approval]: prod ship of ${name}${releaseTag} needs operator confirmation.`,
    approveLine,
    '  then: poll `yolo deploy status` — do NOT rerun `yolo deploy`; the bundle is already staged.',
  ].join('\n');
}

export function formatFail(result: { kind: string; message: string; hint?: string }): string {
  return `FAIL [${result.kind}]: ${result.message}${result.hint ? ` | hint: ${result.hint}` : ''}`;
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: string, message: string, hint?: string): DeployShipFailure {
  return { ok: false, kind, message, hint };
}

/** Pass a deploy-client failure through verbatim (reason taxonomy is shared). */
function clientFail(failure: DeployClientFailure): DeployShipFailure {
  return {
    ok: false,
    kind: failure.kind,
    message: failure.message,
    hint: failure.hint,
    status: failure.status,
    detail: failure.detail,
  };
}

function readBucketFiles(
  bucket: string[],
  assetsByHash: Map<string, BundleAsset>,
  readAssetFile: (absolutePath: string) => Uint8Array,
): { ok: true; files: AssetUploadFile[]; bytes: number } | DeployShipFailure {
  const files: AssetUploadFile[] = [];
  let bytes = 0;
  for (const hash of bucket) {
    const asset = assetsByHash.get(hash);
    if (!asset) {
      return fail('bundle-rejected', `server requested an asset hash not in the local manifest: ${hash}`);
    }
    let contents: Uint8Array;
    try {
      contents = readAssetFile(asset.absPath);
    } catch (err) {
      return fail('asset-read-failed', `failed to read asset ${asset.path}: ${describeError(err)}`);
    }
    bytes += contents.byteLength;
    files.push({
      hash,
      base64: Buffer.from(contents).toString('base64'),
      contentType: contentTypeFor(asset.path),
    });
  }
  return { ok: true, files, bytes };
}

function bundleLabel(shape: ProjectShape): string {
  if (shape.type === 'static') return `${shape.assetsDir.replace(/\/+$/, '')}/`;
  return shape.entry;
}

export function formatMiB(bytes: number): string {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

export function shortDigest(digest: string): string {
  const hex = digest.startsWith('sha256:') ? digest.slice('sha256:'.length) : digest;
  return `sha256:${hex.slice(0, 8)}…`;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function defaultRunBuild(command: string, cwd: string, onOutput: (chunk: string) => void): Promise<{ code: number }> {
  return new Promise((resolve) => {
    const child = spawn(command, { cwd, shell: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env });
    child.stdout?.on('data', (data) => onOutput(String(data)));
    child.stderr?.on('data', (data) => onOutput(String(data)));
    child.on('error', (err) => {
      onOutput(`spawn failed: ${err.message}`);
      resolve({ code: 127 });
    });
    child.on('close', (code) => resolve({ code: code ?? 1 }));
  });
}

function defaultReadAssetFile(absolutePath: string): Uint8Array {
  return fs.readFileSync(absolutePath);
}

function defaultResolveGitSha(cwd: string): string | undefined {
  try {
    const out = execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd,
      stdio: ['ignore', 'pipe', 'ignore'],
      timeout: 5000,
    })
      .toString()
      .trim();
    return /^[0-9a-f]{40}$/.test(out) ? out : undefined;
  } catch {
    return undefined;
  }
}

const CONTENT_TYPES: Record<string, string> = {
  '.html': 'text/html',
  '.htm': 'text/html',
  '.css': 'text/css',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.avif': 'image/avif',
  '.ico': 'image/x-icon',
  '.txt': 'text/plain',
  '.xml': 'application/xml',
  '.pdf': 'application/pdf',
  '.wasm': 'application/wasm',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json',
  '.webmanifest': 'application/manifest+json',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

function contentTypeFor(assetPath: string): string {
  return CONTENT_TYPES[path.extname(assetPath).toLowerCase()] ?? 'application/octet-stream';
}
