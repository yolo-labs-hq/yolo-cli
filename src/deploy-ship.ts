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
import {
  defaultPendingStore,
  PENDING_MAX_AGE_MS,
  type DeployPendingRecord,
  type PendingStore,
} from './deploy-pending.js';

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
  /** Staged-ship resume store (T3 approval round-trip). Default: ~/.config/yolo. */
  pendingStoreImpl?: PendingStore;
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
  /**
   * What the shipped page did in a real browser. Present ONLY when the backend
   * actually ran the check — its absence means "not checked" (no session pod,
   * an older pod image, kill-switched, timed out), NEVER "page clean". Do not
   * print a reassuring line on absence.
   *
   * Separate from `bootCheck` on purpose: a Worker can boot perfectly and still
   * serve a page whose every request dies in a CORS preflight, which is exactly
   * the failure `curl` cannot see.
   */
  pageCheck?: {
    consoleErrors: number;
    failedRequests: number;
    samples: string[];
    url: string;
  };
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

  const pendingStore = deps.pendingStoreImpl ?? defaultPendingStore(options.env ?? process.env);
  const resolveCtx = (): { ok: true; ctx: DeployContext } | DeployShipFailure => {
    const auth = resolveDeployContext(options.env ?? process.env, options.readFileImpl, options.fetchImpl);
    if (!auth.ok) return fail('auth', auth.message);
    // Bounded auto-retry for transient edge/origin 5xx (incl. CF 522) on the
    // ship legs — a single transient blip shouldn't hard-fail a prod deploy.
    return {
      ok: true,
      ctx: {
        ...auth.context,
        retry: {
          onRetry: ({ leg, attempt, maxAttempts, delayMs, failure }) =>
            progress(
              `deploy: ${leg} transient error (${failure.message}); retrying ${attempt}/${maxAttempts - 1} in ${Math.round(delayMs)}ms`,
            ),
        },
      },
    };
  };

  // 1.5 Resume a staged, approval-parked ship BEFORE building. A rebuild is
  // not digest-stable for every project (timestamps/salts), and the operator
  // approved the EXACT staged bytes — so a rerun after PENDING re-finalizes
  // the original ship session (no build, no bundle, no re-upload; codex
  // gpt-5.6-sol P1 round 3). Falls through to a fresh build only when the
  // server says the session/approval is gone.
  if (!dryRun) {
    // Try EVERY staged record for this project+env, newest first — two
    // concurrent same-project deploys each stage their own record, and either
    // may be the one the operator granted (codex P2 r7). A record that
    // finalizes (granted) wins; a still-pending one is remembered; the rest
    // fall through. Only when NONE finalizes and NONE is still pending do we
    // build fresh.
    const staged = pendingStore.loadAll(projectId).filter((r) => r.env === envFlag);
    let anyStillPending: DeployShipResult | null = null;
    for (const rec of staged) {
      if (Date.now() - Date.parse(rec.createdAt) > PENDING_MAX_AGE_MS) {
        pendingStore.clear(projectId, rec.shipId);
        progress(`deploy: staged ship ${rec.shipId} discarded (older than 24h)`);
        continue;
      }
      const resolved = resolveCtx();
      if (!resolved.ok) return resolved;
      const resumed = await resumeStagedShip(resolved.ctx, rec, {
        projectId,
        slug: config.slug,
        envFlag,
        channel,
        finalizeLeg,
        pendingStore,
        progress,
      });
      if (!resumed) continue; // this record not resumable (cleared) — try the next
      if (resumed.ok) {
        // A staged ship went LIVE. Every OTHER staged record for this
        // project+env is now stale — auto-resuming one on a future
        // `yolo deploy` would unexpectedly repoint prod to a prior concurrent
        // attempt's bundle (codex P1 r11). Purge the whole set so the next
        // deploy builds CURRENT code. Re-load at purge time (NOT the
        // pre-finalize `staged` snapshot) so a record a CONCURRENT deploy saved
        // DURING this resume's finalize is cleared too (codex P1 r19).
        // (resumeStagedShip already cleared `rec`.)
        for (const other of pendingStore.loadAll(projectId)) {
          if (other.env === envFlag && other.shipId !== rec.shipId) {
            pendingStore.clear(projectId, other.shipId);
          }
        }
        return resumed;
      }
      // A denial or the ambiguous upload-expired are terminal answers about a
      // real staged ship — return immediately (leave siblings for their own
      // resolution; nothing went live).
      if (resumed.kind !== 'awaiting-approval') return resumed;
      // Still awaiting the grant — remember it, but keep checking the others
      // (a LATER record may already be granted).
      anyStillPending = resumed;
    }
    if (anyStillPending) return anyStillPending;
    // No staged record finalized or is pending → build fresh below.
  }

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
  //    Request a sourcemap so CF can symbolicate exception stacks in deploy.logs
  //    (the .map ships as a sidecar, out of the module + the digest).
  const bundled = await bundle(shape, cwd, undefined, {
    compatibilityFlags: config.compatibilityFlags,
    sourcemaps: true,
  });
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

  const resolved = resolveCtx();
  if (!resolved.ok) return resolved;
  const ctx: DeployContext = resolved.ctx;

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

  // 8. Finalize — worker modules multipart / empty JSON for pure-static. The
  //    sourcemap sidecar rides alongside the modules (out of the digest).
  const finalized = await finalizeLeg(ctx, projectId, shipId, workerModules, bundled.sourceMap);
  if (!finalized.ok) {
    if (finalized.kind === 'awaiting-approval' && 'approvalId' in finalized) {
      progress('deploy: finalize → pending operator approval (T3 prod ship)');
      // Persist the staged ship so the post-grant rerun re-finalizes THESE
      // exact bytes instead of rebuilding (a rebuild may change the digest and
      // orphan the grant). Best-effort: a failed save just means the rerun
      // rebuilds — same as before this existed.
      try {
        pendingStore.save({
          $version: 1,
          projectId,
          shipId,
          env: envFlag,
          ...(config.slug !== undefined ? { slug: config.slug } : {}),
          type: shape.type,
          bundleDigest: bundled.bundleDigest,
          approvalId: finalized.approvalId,
          fileCount,
          totalAssetBytes: bundled.totalAssetBytes,
          createdAt: new Date().toISOString(),
          ...(workerModules.length > 0
            ? {
                workerModules: workerModules.map((m) => ({
                  name: m.name,
                  contentsBase64: Buffer.from(m.contents).toString('base64'),
                })),
              }
            : {}),
          ...(bundled.sourceMap ? { sourceMap: bundled.sourceMap } : {}),
        });
        progress('deploy: staged bundle saved — a rerun after the grant resumes this exact bundle (no rebuild)');
      } catch (err) {
        progress(`deploy: warn — could not save the staged-ship resume record (${describeErrorMessage(err)}); a rerun will rebuild`);
      }
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
  const pageCheck = parsePageCheck(finalized.value.pageCheck);
  if (pageCheck && (pageCheck.consoleErrors > 0 || pageCheck.failedRequests > 0)) {
    progress(
      `deploy: warn — page reported ${pageCheck.consoleErrors} console error(s), ` +
      `${pageCheck.failedRequests} failed request(s)`,
    );
  }

  return {
    ok: true,
    dryRun: false,
    ...base,
    shipId,
    releaseId: finalized.value.releaseId,
    url: finalized.value.url,
    ...(bootCheck ? { bootCheck } : {}),
    ...(pageCheck ? { pageCheck } : {}),
  };
}

/**
 * Re-finalize a staged, approval-parked ship session with the operator's
 * grant. Returns a terminal DeployShipResult, or null ⇒ the staged session is
 * unusable (expired/consumed/denied-and-cleared cases that warrant a fresh
 * build) and the caller falls through to the normal pipeline.
 */
async function resumeStagedShip(
  ctx: DeployContext,
  resume: DeployPendingRecord,
  io: {
    projectId: string;
    slug: string | undefined;
    envFlag: 'staging' | 'prod';
    channel: 'preview' | 'prod';
    finalizeLeg: typeof finalizeShip;
    pendingStore: PendingStore;
    progress: (line: string) => void;
  },
): Promise<DeployShipResult | null> {
  const { projectId, envFlag, channel, finalizeLeg, pendingStore, progress } = io;
  progress(
    `deploy: resuming staged ship ${resume.shipId} (digest ${shortDigest(resume.bundleDigest)}, approval ${resume.approvalId})`,
  );
  const modules = (resume.workerModules ?? []).map((m) => ({
    name: m.name,
    contents: new Uint8Array(Buffer.from(m.contentsBase64, 'base64')),
  }));
  const finalized = await finalizeLeg(ctx, projectId, resume.shipId, modules, resume.sourceMap ?? null, {
    approvalId: resume.approvalId,
  });

  if (finalized.ok) {
    pendingStore.clear(projectId, resume.shipId);
    progress('deploy: finalize ok (resumed the approved bundle — no rebuild)');
    const bootCheck = parseBootCheck(finalized.value.bootCheck);
    if (bootCheck) progress(`deploy: warn — deployed Worker failed to boot (HTTP ${bootCheck.status})`);
    const pageCheck = parsePageCheck(finalized.value.pageCheck);
    if (pageCheck && (pageCheck.consoleErrors > 0 || pageCheck.failedRequests > 0)) {
      progress(
        `deploy: warn — page reported ${pageCheck.consoleErrors} console error(s), ` +
        `${pageCheck.failedRequests} failed request(s)`,
      );
    }
    return {
      ok: true,
      dryRun: false,
      projectId,
      slug: resume.slug ?? io.slug,
      env: envFlag,
      channel,
      type: resume.type,
      fileCount: resume.fileCount,
      totalAssetBytes: resume.totalAssetBytes,
      bundleDigest: resume.bundleDigest,
      shipId: resume.shipId,
      releaseId: finalized.value.releaseId,
      url: finalized.value.url,
      ...(bootCheck ? { bootCheck } : {}),
      // Must be on the RESULT, not only the progress line: under --json the
      // warning goes to stderr and the structured verdict + samples would
      // otherwise be lost entirely for a resumed (approval-parked) ship.
      ...(pageCheck ? { pageCheck } : {}),
    };
  }

  // Still parked: the grant hasn't landed yet (approval-pending), or the
  // server re-issued the pending envelope. Keep the staged record — the next
  // rerun retries the SAME session.
  if (finalized.kind === 'approval-pending') {
    progress('deploy: staged ship still awaiting the operator grant');
    return {
      ok: false,
      kind: 'awaiting-approval',
      projectId,
      slug: resume.slug ?? io.slug,
      approvalId: resume.approvalId,
      message: finalized.message,
    };
  }
  if (finalized.kind === 'awaiting-approval' && 'approvalId' in finalized) {
    progress('deploy: staged ship still awaiting the operator grant');
    return {
      ok: false,
      kind: 'awaiting-approval',
      projectId,
      slug: resume.slug ?? io.slug,
      approvalId: finalized.approvalId,
      approvalUrl: finalized.approvalUrl,
      releaseId: finalized.releaseId,
      statement: finalized.statement,
      expiresAt: finalized.expiresAt,
      message: finalized.message,
    };
  }

  // Denied is a terminal answer about THIS bundle — surface it; don't
  // silently rebuild what the operator just rejected.
  if (finalized.kind === 'approval-denied') {
    pendingStore.clear(projectId, resume.shipId);
    return clientFail(finalized as DeployClientFailure);
  }

  // Transient transport / auth: keep the staged record and surface the error
  // — the session may still be perfectly resumable.
  if (finalized.kind === 'network' || finalized.kind === 'auth' || finalized.kind === 'session-required') {
    return clientFail(finalized as DeployClientFailure);
  }

  // AMBIGUOUS-on-resume outcomes — the staged session/grant may have been
  // completed by a CONCURRENT retry that's still finalizing or already went
  // live, so auto-rebuilding could duplicate a live release / re-mint the
  // approval. Surface and require a status check; never rebuild automatically.
  //   - upload-expired  (codex P2 r4): the open→finalized CAS answers every
  //     retry of an already-finalized session with 410 — a prior resume may
  //     have gone live with a lost response.
  //   - approval-consumed (codex P2 r14): two post-grant retries raced; the
  //     WINNER consumed the nonce and may still be finalizing, the LOSER lands
  //     here. The deployment is (being) applied — a fresh ship would orphan a
  //     session and re-apply the same bundle.
  if (finalized.kind === 'upload-expired' || finalized.kind === 'approval-consumed') {
    pendingStore.clear(projectId, resume.shipId);
    return {
      ok: false,
      kind: finalized.kind,
      message: `staged ship ${resume.shipId} is finished or already being applied by a concurrent retry — a prior resume may have gone live`,
      hint: "run 'yolo deploy status' first: if the release is live you are done; otherwise rerun 'yolo deploy --env prod' for a fresh ship",
      status: finalized.kind === 'upload-expired' ? 410 : 409,
    };
  }

  // Everything else (approval-expired/-required, bundle-invalid, …): the staged
  // grant is gone but nothing finalized — fall back to a fresh build+ship,
  // which re-enters the normal approval flow if needed.
  pendingStore.clear(projectId, resume.shipId);
  progress(
    `deploy: staged ship not resumable (${finalized.kind}: ${finalized.message}) — building fresh`,
  );
  return null;
}

function describeErrorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/** Narrow the backend's optional `bootCheck` envelope; ignore anything malformed. */
function parseBootCheck(raw: unknown): { status: number; detail: string } | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.status !== 'number' || typeof r.detail !== 'string') return undefined;
  return { status: r.status, detail: r.detail };
}

/**
 * Narrow the backend's optional `pageCheck` envelope; ignore anything malformed.
 *
 * A malformed payload narrows to `undefined`, which the caller renders as "not
 * checked" — the safe direction. Inventing zeros instead would manufacture a
 * clean bill of health out of a parse failure.
 */
function parsePageCheck(raw: unknown): DeployShipSuccess['pageCheck'] | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const r = raw as Record<string, unknown>;
  if (typeof r.consoleErrors !== 'number' || typeof r.failedRequests !== 'number') return undefined;
  const samples = Array.isArray(r.samples) ? r.samples.filter((s): s is string => typeof s === 'string') : [];
  return {
    consoleErrors: r.consoleErrors,
    failedRequests: r.failedRequests,
    samples,
    url: typeof r.url === 'string' ? r.url : '',
  };
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
 * Two independent "not-an-error, don't blind-loop" signals: the PENDING
 * prefix (not FAIL) and exit 3. The correct resume is a re-run AFTER the
 * grant — the server redeems the granted approval automatically for the same
 * bundle (exact-digest match), and staged assets hash-skip so the re-run is
 * cheap. A premature re-run is idempotent server-side (re-issues this
 * PENDING with the SAME approval id — no duplicate approvals). The CLI has
 * no approval-status poll (`yolo deploy status` can't see pre-finalize
 * approvals — no release row exists yet); the operator's grant surface is
 * the notification + Approvals panel, and MCP agents have
 * deploy.approval_status.
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
    '  then: after the operator approves (they got a notification; the Approvals panel is the surface),',
    '  rerun `yolo deploy --env prod` — it RESUMES this exact staged bundle (no rebuild, no re-upload;',
    '  the grant is redeemed automatically). Rerun with --env prod: a bare `yolo deploy` targets STAGING',
    '  and will NOT resume this prod bundle. A rerun BEFORE the grant is harmless (same PENDING, same',
    '  approval id). MCP callers can poll deploy.approval_status; the CLI has no approval poll.',
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

export function defaultRunBuild(command: string, cwd: string, onOutput: (chunk: string) => void): Promise<{ code: number }> {
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
