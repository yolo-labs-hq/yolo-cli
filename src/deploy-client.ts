/**
 * deploy-client — transport legs for `yolo deploy` (managed hosting, Phase 1).
 *
 * Implements the two-phase manifest-then-missing-files ship protocol from
 * `docs/MANAGED_HOSTING_CLI_SPEC.md` §4 (THE contract) against the
 * `/v1/deploy/*` routes (`docs/MANAGED_HOSTING_BACKEND_SPEC.md` §3 routes
 * 1–8), plus thin wrappers for createProject / status / rollback / logs.
 *
 * Transport notes:
 *   - Deploy routes are user-facing `/v1/deploy/*` — the user access JWT is
 *     the credential (Bearer), same as `userRouteRequest` in work-client.ts.
 *     No MCP-token mint is needed.
 *   - The token is RE-RESOLVED from the rotation file (~/.config/yolo/token,
 *     rewritten every ~10 min by yolo-token-refresh) before EVERY leg, so a
 *     long upload can't ride a token that expired mid-ship.
 *   - 4xx refusal envelopes ({ok:false, reason, message, detail?, hint?} or
 *     the legacy {error, code}) pass through VERBATIM as structured failures
 *     — the CLI and backend reason taxonomies are the same identifiers
 *     (spec §5).
 *   - 401 → kind 'auth' (exit 78); 5xx and transport errors → kind 'network'
 *     (exit 4, transient); other 4xx → the backend reason (exit 2).
 *   - finalize is the only non-JSON leg: worker modules go up as multipart
 *     FormData (Node 20 global FormData/Blob); pure-static sends empty JSON
 *     and the server attaches the canonical assets-only shim.
 *
 * All legs take an injectable `fetchImpl` (and the context an injectable
 * `readFileImpl` for the token file) so unit tests never touch real network
 * or the real FS — the work-client.test.ts convention.
 */

import { resolveUserToken, type ReadFileImpl } from './auth-context.js';
import { userRouteRequest } from './work-client.js';

// ─── Fetch shape ──────────────────────────────────────────────────────────

/**
 * Superset of work-client's FetchLike: finalize needs a FormData body and
 * `logs --tail` needs the streaming `body` of the response (NDJSON). A stub
 * implementing this shape is assignable wherever FetchLike is expected.
 */
export type DeployFetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string | FormData;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
  /** Streaming body for NDJSON responses (logs --tail). */
  body?: AsyncIterable<Uint8Array> | null;
}>;

// ─── Context ──────────────────────────────────────────────────────────────

export interface DeployContext {
  commonApiUrl: string;
  /** Env snapshot used for per-leg token re-resolution. */
  env: Record<string, string | undefined>;
  /** Test-injectable token-file reader (auth-context convention). */
  readFileImpl?: ReadFileImpl;
  /** Test-injectable fetch. Defaults to `globalThis.fetch`. */
  fetchImpl?: DeployFetchLike;
  /**
   * Bounded auto-retry for TRANSIENT transport faults on the ship legs.
   * Absent ⇒ no retry (single attempt). See `withRetry`.
   */
  retry?: RetryConfig;
}

/**
 * Retry policy for transient ship-leg failures (kind 'network' — 5xx, CF 522,
 * or a transport error). Deterministic outcomes (4xx refusals, auth,
 * invalid-response, awaiting-approval) are NEVER retried.
 *
 * Applied to ship/start (mints a fresh `shp_…` session each call — a
 * superseded one just expires on its TTL) and the assets leg (content-
 * addressed, idempotent). Deliberately NOT applied to finalize: it is single-
 * shot, so a retry after a lost-response success would mask a live release as
 * `upload-expired` (see `finalizeShip`).
 */
export interface RetryConfig {
  /** Total attempts INCLUDING the first. Default 3. */
  maxAttempts?: number;
  /** Base backoff in ms; doubles each retry (600 → 1200). Default 600. */
  baseDelayMs?: number;
  /** Injectable sleep (tests pass a no-op). Default setTimeout-based. */
  sleepImpl?: (ms: number) => Promise<void>;
  /** Notified just before each retry sleep — e.g. to emit a progress line. */
  onRetry?: (info: {
    leg: string;
    attempt: number;
    maxAttempts: number;
    delayMs: number;
    failure: DeployClientFailure;
  }) => void;
}

export type DeployContextResult =
  | { ok: true; context: DeployContext }
  | { ok: false; kind: 'auth'; message: string };

/**
 * Resolve the deploy transport context. Checks the env trio once up front
 * (fail fast with a single auth message); the token itself is still
 * re-resolved per leg by every client function.
 */
export function resolveDeployContext(
  env: Record<string, string | undefined> = process.env,
  readFileImpl?: ReadFileImpl,
  fetchImpl?: DeployFetchLike,
): DeployContextResult {
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!commonApiUrl) {
    return { ok: false, kind: 'auth', message: 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required' };
  }
  const token = currentTokenFrom(env, readFileImpl);
  if (!token) {
    return {
      ok: false,
      kind: 'auth',
      message:
        'no user token available: expected a user access JWT in ~/.config/yolo/token or the YOLO_API_TOKEN env var',
    };
  }
  return { ok: true, context: { commonApiUrl, env, readFileImpl, fetchImpl } };
}

// ─── Failure envelope ─────────────────────────────────────────────────────

export interface DeployClientFailure {
  ok: false;
  /**
   * 'auth' | 'network' | a backend refusal reason passed through VERBATIM
   * (e.g. 'quota-exceeded', 'upload-expired', 'slug-taken').
   */
  kind: string;
  message: string;
  status?: number;
  detail?: Record<string, unknown>;
  hint?: string;
  /** The full parsed 4xx body, for callers that need extra fields. */
  body?: Record<string, unknown>;
}

export type ClientResult<T> = { ok: true; value: T } | DeployClientFailure;

// ─── Ship legs (spec §4) ──────────────────────────────────────────────────

/** CF-shaped manifest: path → {hash, size}. */
export interface AssetManifest {
  [path: string]: { hash: string; size: number };
}

export interface ShipCaps {
  maxFileBytes: number;
  maxTotalBytes: number;
  maxFiles: number;
}

export interface StartShipRequest {
  /** Channel: staging maps to 'preview', prod to 'prod' (CLI layer maps). */
  env: 'preview' | 'prod';
  type: 'static' | 'worker';
  manifest: AssetManifest;
  worker?: { mainModule: string; sizeBytes: number };
  compatibilityFlags?: string[];
  gitSha?: string;
  /**
   * `git remote get-url origin` for the bundled directory — the source repo
   * these bytes came from. Sent RAW; the server normalizes it and strips any
   * credentials in the userinfo before storing.
   */
  repoUrl?: string;
  /** The branch that was checked out at ship time. Absent when detached. */
  branch?: string;
  bundleDigest: string;
}

export interface StartShipResponse {
  shipId: string;
  /** CF-shaped buckets of asset hashes the server does NOT yet have. */
  missing: string[][];
  /** Authoritative tier caps (the bundle layer pre-checks local defaults). */
  caps: ShipCaps;
}

/** Leg 1 — POST /v1/deploy/projects/:id/ship/start */
export async function startShip(
  ctx: DeployContext,
  projectId: string,
  request: StartShipRequest,
): Promise<ClientResult<StartShipResponse>> {
  return withRetry(ctx, 'ship/start', async () => {
    const result = await jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/ship/start`, {
      method: 'POST',
      jsonBody: request,
    });
    if (!result.ok) return result;
    const value = result.value as Partial<StartShipResponse> | null;
    if (!value || typeof value.shipId !== 'string' || !Array.isArray(value.missing)) {
      return {
        ok: false,
        kind: 'invalid-response',
        message: 'ship/start response missing shipId / missing buckets',
      };
    }
    return {
      ok: true,
      value: {
        shipId: value.shipId,
        missing: value.missing as string[][],
        caps: (value.caps ?? { maxFileBytes: 0, maxTotalBytes: 0, maxFiles: 0 }) as ShipCaps,
      },
    };
  });
}

export interface AssetUploadFile {
  hash: string;
  base64: string;
  contentType: string;
}

/** Leg 2 — POST /v1/deploy/projects/:id/ship/:shipId/assets (base64 bucket). */
export async function uploadAssetBucket(
  ctx: DeployContext,
  projectId: string,
  shipId: string,
  files: AssetUploadFile[],
): Promise<ClientResult<unknown>> {
  return withRetry(ctx, 'assets', () =>
    jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/ship/${enc(shipId)}/assets`, {
      method: 'POST',
      jsonBody: { files },
    }),
  );
}

export interface WorkerModuleUpload {
  name: string;
  contents: Uint8Array;
}

export interface FinalizeSuccess {
  releaseId: string;
  url?: string;
  status?: string;
  [key: string]: unknown;
}

export interface FinalizePending {
  ok: false;
  kind: 'awaiting-approval';
  approvalId: string;
  approvalUrl?: string;
  statement?: string;
  expiresAt?: string;
  releaseId?: string;
  message: string;
  status: number;
}

export type FinalizeShipResult =
  | { ok: true; value: FinalizeSuccess }
  | FinalizePending
  | DeployClientFailure;

/**
 * Leg 3 — POST /v1/deploy/projects/:id/ship/:shipId/finalize.
 *
 * Worker modules go as multipart FormData (Node 20 global FormData/Blob,
 * busboy on the server route); pure-static sends empty JSON and the server
 * attaches the canonical assets-only shim. Distinguished outcomes:
 *   success | 409 awaiting-approval (T3 prod gate — NOT an error)
 *           | 410 upload-expired (ship session lapsed → rerun)
 */
/**
 * Caller-reported session provenance for hosting audit metadata.
 * This header never authorizes a deployment or rollback.
 */
export function sessionContextHeaders(env: Record<string, string | undefined>): Record<string, string> {
  const headers: Record<string, string> = {};
  if (env.SESSION_ID) headers['X-Yolo-Session-Id'] = env.SESSION_ID;
  return headers;
}

export async function finalizeShip(
  ctx: DeployContext,
  projectId: string,
  shipId: string,
  modules: WorkerModuleUpload[] = [],
  sourceMap?: { name: string; content: string } | null,
  opts: { approvalId?: string } = {},
): Promise<FinalizeShipResult> {
  // NOT auto-retried (unlike ship/start + assets). finalize is single-shot per
  // ship session: if the first request reached the server and created the
  // release but the response was lost to a transient 5xx/522, a blind retry
  // hits the open→finalized CAS and returns a deterministic 410 upload-expired
  // — masking a deploy that actually SUCCEEDED. So a transient finalize fault
  // surfaces as kind 'network' (exit 4); the operator checks `yolo deploy
  // status` before rerunning rather than auto-looping into a misleading error.
  const token = currentToken(ctx);
  if (!token) return missingTokenFailure();
  const fetchImpl = resolveFetch(ctx);
  if (!fetchImpl) return noFetchFailure();
  const url = `${stripTrailingSlash(ctx.commonApiUrl)}/v1/deploy/projects/${enc(projectId)}/ship/${enc(shipId)}/finalize`;
  // Optional session provenance for the hosting audit record.
  const requestHeaders = sessionContextHeaders(ctx.env);
  // Resume-after-grant: the pending-store rerun redeems the operator's grant
  // explicitly (x-approval-id → approvalNonce server-side), which yields crisp
  // approval-pending/-denied/-expired outcomes instead of the nonce-less
  // retry-redeem's blended ones.
  if (opts.approvalId) requestHeaders['x-approval-id'] = opts.approvalId;

  let response;
  try {
    if (modules.length > 0) {
      const form = new FormData();
      for (const module of modules) {
        form.append(
          module.name,
          new Blob([module.contents], { type: 'application/javascript+module' }),
          module.name,
        );
      }
      // Sourcemap sidecar — the server distinguishes it from modules by the
      // `application/source-map` content-type (never a worker module / digest input).
      if (sourceMap) {
        form.append(
          sourceMap.name,
          new Blob([sourceMap.content], { type: 'application/source-map' }),
          sourceMap.name,
        );
      }
      // No explicit Content-Type — fetch sets the multipart boundary itself.
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, ...requestHeaders },
        body: form,
      });
    } else {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json', ...requestHeaders },
        body: JSON.stringify({}),
      });
    }
  } catch (err) {
    return networkFailure(err);
  }

  if (response.ok) {
    let value: Record<string, unknown> = {};
    try {
      value = (await response.json()) as Record<string, unknown>;
    } catch {
      // empty/non-JSON success body — tolerate
    }
    const release = (value.release ?? {}) as Record<string, unknown>;
    const releaseId = str(value.releaseId) ?? str(release.releaseId) ?? str(release.id);
    if (!releaseId) {
      return { ok: false, kind: 'invalid-response', message: 'finalize response missing releaseId' };
    }
    return {
      ok: true,
      value: { ...value, releaseId, url: str(value.url) ?? str(release.url), status: str(value.status) ?? str(release.status) },
    };
  }

  const failure = await mapErrorResponse(response);
  // T3 prod gate: 409 awaiting-approval is a distinct, NOT-an-error outcome
  // (spec §5 — exit 3, PENDING prefix, never blind-retried). The backend may
  // spell the reason 'awaiting-approval' (CLI spec §4) or 'approval-required'
  // (backend spec route 4c) — normalize to 'awaiting-approval'.
  if (failure.status === 409 && (failure.kind === 'awaiting-approval' || failure.kind === 'approval-required')) {
    const body = failure.body ?? {};
    const detail = (failure.detail ?? {}) as Record<string, unknown>;
    const approvalId = str(body.approvalId) ?? str(detail.approvalId);
    if (approvalId) {
      return {
        ok: false,
        kind: 'awaiting-approval',
        approvalId,
        approvalUrl: str(body.approvalUrl) ?? str(detail.approvalUrl),
        statement: str(body.statement) ?? str(detail.statement),
        expiresAt: str(body.expiresAt) ?? str(detail.expiresAt),
        releaseId: str(body.releaseId) ?? str(detail.releaseId),
        message: failure.message,
        status: 409,
      };
    }
    // 409 claiming approval but without an approvalId — fall through as a
    // plain backend failure so the caller doesn't print a broken PENDING.
  }
  return failure;
}

// ─── Thin wrappers (routes 1, 3, 6, 8) ────────────────────────────────────

export interface CreateProjectRequest {
  name: string;
  slug?: string;
  workspaceId?: string;
  /**
   * Nest this project under an existing one (nesting S4). Server-verified —
   * the CLI only passes the id through. Not persisted in `.yolo/deploy.json`:
   * the parent link lives on the project document, and duplicating it locally
   * would just create a second thing to drift.
   */
  parentProjectId?: string;
}

/** POST /v1/deploy/projects */
export async function createProject(
  ctx: DeployContext,
  request: CreateProjectRequest,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, '/deploy/projects', { method: 'POST', jsonBody: request });
}

/** GET /v1/deploy/projects/:id — project + currentRelease + recentReleases + usage/caps. */
export async function getProjectStatus(
  ctx: DeployContext,
  projectId: string,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}`, { method: 'GET' });
}

/** One project as returned by GET /v1/deploy/projects (the caller's own). */
export interface DeployProjectSummary {
  projectId?: string;
  slug?: string;
  type?: string;
  [key: string]: unknown;
}

/**
 * GET /v1/deploy/projects — the caller's OWN hosting projects (owner-scoped
 * server-side). Used by `yolo deploy init`/`link` to reconcile a slug-taken
 * error: if the taken slug is one the caller already owns, link to it instead
 * of failing.
 */
export async function listProjects(
  ctx: DeployContext,
): Promise<ClientResult<DeployProjectSummary[]>> {
  const result = await jsonLeg(ctx, '/deploy/projects', { method: 'GET' });
  if (!result.ok) return result;
  const raw = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
  const projects = Array.isArray(result.value)
    ? (result.value as DeployProjectSummary[])
    : Array.isArray(raw.projects)
      ? (raw.projects as DeployProjectSummary[])
      : [];
  return { ok: true, value: projects };
}

/** POST /v1/deploy/projects/:id/rollback */
export async function rollbackProject(
  ctx: DeployContext,
  projectId: string,
  request: { releaseId?: string } = {},
): Promise<ClientResult<unknown>> {
  // Rollback is a prod re-activation — forward session context so the server can
  // stamp `rollback.provenance` (same audit basis as a ship's finalize leg).
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/rollback`, {
    method: 'POST',
    jsonBody: request,
    headers: sessionContextHeaders(ctx.env),
  });
}

/** POST /v1/deploy/projects/:id/unpublish — take a live project offline (reversible). */
export async function unpublishProject(
  ctx: DeployContext,
  projectId: string,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/unpublish`, { method: 'POST' });
}

/** POST /v1/deploy/projects/:id/republish — bring an offline project back online. */
export async function republishProject(
  ctx: DeployContext,
  projectId: string,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/republish`, { method: 'POST' });
}

export interface D1QueryRow {
  [column: string]: unknown;
}

export interface D1QueryResult {
  /** Result rows (SELECT) — empty for writes. */
  results: D1QueryRow[];
  /** Optional CF/D1 meta (rows_read, changes, …) — passed through as-is. */
  meta?: Record<string, unknown>;
  [key: string]: unknown;
}

/**
 * POST /v1/deploy/projects/:id/resources/:rid/query (Phase 2).
 *
 * The CLI does NOT know the resourceId — it targets the project's SOLE
 * D1 by sending the `default` segment (the route's `resourceId?`
 * contract; the server resolves the lone D1). Writes need
 * `allowWrite:true`; DDL/PRAGMA/ATTACH are blocked server-side
 * (`sql-not-allowed`). 4xx refusal reasons pass through verbatim as the
 * structured failure `kind`.
 */
export async function queryD1(
  ctx: DeployContext,
  projectId: string,
  sql: string,
  options: { params?: Array<string | number | boolean | null>; allowWrite?: boolean } = {},
): Promise<ClientResult<D1QueryResult>> {
  const result = await jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/resources/default/query`, {
    method: 'POST',
    jsonBody: {
      sql,
      ...(options.params !== undefined ? { params: options.params } : {}),
      allowWrite: options.allowWrite ?? false,
    },
  });
  if (!result.ok) return result;
  const value = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
  const results = Array.isArray(value.results)
    ? (value.results as D1QueryRow[])
    : Array.isArray(value.rows)
      ? (value.rows as D1QueryRow[])
      : [];
  return {
    ok: true,
    value: { ...value, results, meta: value.meta && typeof value.meta === 'object' ? (value.meta as Record<string, unknown>) : undefined },
  };
}

/**
 * PUT /v1/deploy/projects/:id/slug — rename the project's primary slug.
 * `keepOldAsRedirect` (default true) makes the old slug 308 → the new URL.
 */
export async function renameProject(
  ctx: DeployContext,
  projectId: string,
  request: { slug: string; keepOldAsRedirect?: boolean },
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/slug`, { method: 'PUT', jsonBody: request });
}

/**
 * PUT /v1/deploy/projects/:id/parent — re-parent the project (nesting S5).
 *
 * `null` DETACHES it to a root. The CLI only passes the id through: the server
 * resolves the parent via an ownership-asserted read and enforces depth,
 * child-count and project-state, so its 4xx `reason` is the authority
 * (`project-nesting-disabled`, `project-nesting-too-deep`,
 * `project-has-children`, `project-not-active`, `not-published`,
 * `project-busy`, `project-not-found`).
 */
export async function setProjectParent(
  ctx: DeployContext,
  projectId: string,
  parentProjectId: string | null,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/parent`, {
    method: 'PUT',
    jsonBody: { parentProjectId },
  });
}

/** POST /v1/deploy/projects/:id/aliases — add an alias hostname (slug). */
export async function addAlias(
  ctx: DeployContext,
  projectId: string,
  slug: string,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/aliases`, { method: 'POST', jsonBody: { slug } });
}

/** DELETE /v1/deploy/projects/:id/aliases/:slug — remove an alias/redirect binding. */
export async function removeAlias(
  ctx: DeployContext,
  projectId: string,
  slug: string,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/aliases/${enc(slug)}`, { method: 'DELETE' });
}

/** PUT /v1/deploy/projects/:id/redirects/:slug — 308 a slug to an external URL. */
export async function setRedirect(
  ctx: DeployContext,
  projectId: string,
  slug: string,
  target: string,
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/redirects/${enc(slug)}`, {
    method: 'PUT',
    jsonBody: { target },
  });
}

/**
 * DELETE /v1/deploy/projects/:id — delete the project. A live site is refused
 * server-side (a `not-confirmed` refusal with a hint) unless the caller passes
 * the current slug as `confirmSlug`; a throwaway/never-shipped project deletes
 * without confirmation.
 */
export async function deleteProject(
  ctx: DeployContext,
  projectId: string,
  request: { confirmSlug?: string } = {},
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}`, {
    method: 'DELETE',
    ...(request.confirmSlug !== undefined ? { jsonBody: { confirmSlug: request.confirmSlug } } : {}),
  });
}

/**
 * POST /v1/deploy/projects/:id/clone — duplicate a project's config (env +
 * secrets + fresh D1/KV/R2 bindings) into a new EMPTY project. No release is
 * copied — the clone must be re-shipped to populate it. Optional `name`/`slug`
 * name the clone; the backend derives defaults otherwise. Returns
 * `{ project, sourceSlug, resourcesCloned, secretsCloned }`. 4xx refusal
 * reasons (slug-taken, hosting-disabled, …) pass through as the failure `kind`.
 */
export async function cloneProject(
  ctx: DeployContext,
  projectId: string,
  request: { name?: string; slug?: string } = {},
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/clone`, {
    method: 'POST',
    jsonBody: {
      ...(request.name !== undefined ? { name: request.name } : {}),
      ...(request.slug !== undefined ? { slug: request.slug } : {}),
    },
  });
}

/** GET /v1/deploy/projects/:id/logs (buffered variant). */
export async function getLogs(
  ctx: DeployContext,
  projectId: string,
  options: { sinceMinutes?: number; limit?: number } = {},
): Promise<ClientResult<unknown>> {
  const params = new URLSearchParams();
  if (options.sinceMinutes !== undefined) params.set('sinceMinutes', String(options.sinceMinutes));
  if (options.limit !== undefined) params.set('limit', String(options.limit));
  const qs = params.toString();
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/logs${qs ? `?${qs}` : ''}`, { method: 'GET' });
}

export interface TailPollResult {
  events: Array<Record<string, unknown>>;
  cursor: string | null;
  note?: string;
}

/**
 * GET /v1/deploy/projects/:id/tail — ONE long-poll over the live-tail buffer
 * (signal C). The server waits up to ~`waitMs` for new lines and returns them
 * plus a `cursor`; the `--tail` loop calls this repeatedly, threading the cursor
 * so there are no gaps or duplicates. Long-poll (not an infinite stream) so it
 * survives proxy/ingress idle timeouts.
 */
export async function pollTail(
  ctx: DeployContext,
  projectId: string,
  options: { releaseId?: string; cursor?: string; waitMs?: number } = {},
): Promise<ClientResult<TailPollResult>> {
  const params = new URLSearchParams();
  if (options.releaseId !== undefined) params.set('releaseId', options.releaseId);
  if (options.cursor !== undefined) params.set('cursor', options.cursor);
  if (options.waitMs !== undefined) params.set('waitMs', String(options.waitMs));
  const qs = params.toString();
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/tail${qs ? `?${qs}` : ''}`, {
    method: 'GET',
  }) as Promise<ClientResult<TailPollResult>>;
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Run a ship leg with bounded-backoff retry on TRANSIENT transport faults.
 *
 * Retries only `{ ok:false, kind:'network' }` (5xx / CF 522 / transport error
 * — see `mapErrorResponse`). Every other result — success, a 4xx refusal,
 * auth, invalid-response, or awaiting-approval — returns immediately. The leg
 * `fn` re-resolves the token per call, so a retry can't ride a token that
 * expired mid-ship.
 */
async function withRetry<T extends { ok: boolean; kind?: string }>(
  ctx: DeployContext,
  leg: string,
  fn: () => Promise<T>,
): Promise<T> {
  const cfg = ctx.retry;
  // Opt-in: a context with no `retry` config runs exactly once (no retry).
  if (!cfg) return fn();
  const maxAttempts = Math.max(1, cfg.maxAttempts ?? 3);
  const baseDelayMs = cfg.baseDelayMs ?? 600;
  const sleep = cfg.sleepImpl ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  let attempt = 0;
  for (;;) {
    attempt++;
    const result = await fn();
    if (result.ok || result.kind !== 'network' || attempt >= maxAttempts) return result;
    const delayMs = baseDelayMs * 2 ** (attempt - 1);
    cfg.onRetry?.({
      leg,
      attempt,
      maxAttempts,
      delayMs,
      failure: result as unknown as DeployClientFailure,
    });
    await sleep(delayMs);
  }
}

/**
 * Re-resolve the user token (rotation file → YOLO_API_TOKEN env). Called at
 * the top of EVERY leg — never cache across legs (spec §0: the ~10-min
 * rotation must not expire a multi-leg ship mid-flight).
 */
function currentToken(ctx: DeployContext): string | undefined {
  return currentTokenFrom(ctx.env, ctx.readFileImpl);
}

function currentTokenFrom(
  env: Record<string, string | undefined>,
  readFileImpl?: ReadFileImpl,
): string | undefined {
  return readFileImpl ? resolveUserToken(env, readFileImpl) : resolveUserToken(env);
}

function resolveFetch(ctx: DeployContext): DeployFetchLike | undefined {
  return ctx.fetchImpl ?? (globalThis.fetch as unknown as DeployFetchLike | undefined);
}

/** Shared JSON leg: re-resolve token, hit /v1<path> via userRouteRequest, map outcomes. */
async function jsonLeg(
  ctx: DeployContext,
  routePath: string,
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; jsonBody?: unknown; headers?: Record<string, string> },
): Promise<ClientResult<unknown>> {
  const token = currentToken(ctx);
  if (!token) return missingTokenFailure();
  let response;
  try {
    response = await userRouteRequest(
      { commonApiUrl: ctx.commonApiUrl, userToken: token, fetchImpl: ctx.fetchImpl },
      routePath,
      init,
    );
  } catch (err) {
    return networkFailure(err);
  }
  if (response.ok) {
    try {
      return { ok: true, value: await response.json() };
    } catch {
      return { ok: true, value: {} };
    }
  }
  return mapErrorResponse(response);
}

/**
 * Map a non-2xx response onto the structured failure envelope. The backend's
 * 4xx refusal body ({ok:false, reason, message, detail?, hint?} — or the
 * legacy {error, code}) passes through verbatim: `kind` IS the reason.
 */
async function mapErrorResponse(response: {
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}): Promise<DeployClientFailure> {
  const status = response.status;
  let body: Record<string, unknown> = {};
  try {
    const parsed = await response.json();
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      body = parsed as Record<string, unknown>;
    }
  } catch {
    try {
      const text = await response.text();
      if (text) body = { message: text };
    } catch {
      // no readable body
    }
  }
  const message = str(body.message) ?? str(body.error) ?? `HTTP ${status}`;
  if (status === 401) {
    return { ok: false, kind: 'auth', message: `authentication failed: ${message}`, status, body };
  }
  if (status >= 500) {
    // Genuine server/upstream fault — transient, retry with backoff (exit 4).
    return { ok: false, kind: 'network', message: `server error (HTTP ${status}): ${message}`, status, body };
  }
  let reason = str(body.reason) ?? str(body.code);
  if (!reason && status === 410) reason = 'upload-expired';
  return {
    ok: false,
    kind: reason ?? `http-${status}`,
    message,
    status,
    detail: body.detail && typeof body.detail === 'object' ? (body.detail as Record<string, unknown>) : undefined,
    hint: str(body.hint),
    body,
  };
}

function missingTokenFailure(): DeployClientFailure {
  return {
    ok: false,
    kind: 'auth',
    message:
      'no user token available: expected a user access JWT in ~/.config/yolo/token or the YOLO_API_TOKEN env var',
  };
}

function noFetchFailure(): DeployClientFailure {
  return { ok: false, kind: 'network', message: 'fetch is not available; the substrate CLI requires Node 20+' };
}

function networkFailure(err: unknown): DeployClientFailure {
  return { ok: false, kind: 'network', message: `request failed: ${err instanceof Error ? err.message : String(err)}` };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function enc(value: string): string {
  return encodeURIComponent(value);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
