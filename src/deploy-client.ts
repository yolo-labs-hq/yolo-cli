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
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/ship/${enc(shipId)}/assets`, {
    method: 'POST',
    jsonBody: { files },
  });
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
export async function finalizeShip(
  ctx: DeployContext,
  projectId: string,
  shipId: string,
  modules: WorkerModuleUpload[] = [],
): Promise<FinalizeShipResult> {
  const token = currentToken(ctx);
  if (!token) return missingTokenFailure();
  const fetchImpl = resolveFetch(ctx);
  if (!fetchImpl) return noFetchFailure();
  const url = `${stripTrailingSlash(ctx.commonApiUrl)}/v1/deploy/projects/${enc(projectId)}/ship/${enc(shipId)}/finalize`;

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
      // No explicit Content-Type — fetch sets the multipart boundary itself.
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}` },
        body: form,
      });
    } else {
      response = await fetchImpl(url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
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

/** POST /v1/deploy/projects/:id/rollback */
export async function rollbackProject(
  ctx: DeployContext,
  projectId: string,
  request: { releaseId?: string } = {},
): Promise<ClientResult<unknown>> {
  return jsonLeg(ctx, `/deploy/projects/${enc(projectId)}/rollback`, { method: 'POST', jsonBody: request });
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

/**
 * GET /v1/deploy/projects/:id/logs?tail=true — streams NDJSON from the
 * response body; `onLine` is invoked once per complete (non-empty) line.
 * Resolves when the stream ends (server hangup) or errors.
 */
export async function tailLogs(
  ctx: DeployContext,
  projectId: string,
  options: { sinceMinutes?: number } = {},
  onLine: (line: string) => void,
): Promise<ClientResult<void>> {
  const token = currentToken(ctx);
  if (!token) return missingTokenFailure();
  const fetchImpl = resolveFetch(ctx);
  if (!fetchImpl) return noFetchFailure();

  const params = new URLSearchParams({ tail: 'true' });
  if (options.sinceMinutes !== undefined) params.set('sinceMinutes', String(options.sinceMinutes));
  const url = `${stripTrailingSlash(ctx.commonApiUrl)}/v1/deploy/projects/${enc(projectId)}/logs?${params.toString()}`;

  let response;
  try {
    response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}`, Accept: 'application/x-ndjson' },
    });
  } catch (err) {
    return networkFailure(err);
  }
  if (!response.ok) return mapErrorResponse(response);
  const stream = response.body;
  if (!stream) {
    return { ok: false, kind: 'network', message: 'log stream unavailable (response has no body)' };
  }

  const decoder = new TextDecoder();
  let buffered = '';
  try {
    for await (const chunk of stream) {
      buffered += decoder.decode(chunk, { stream: true });
      let newline;
      while ((newline = buffered.indexOf('\n')) !== -1) {
        const line = buffered.slice(0, newline).replace(/\r$/, '').trim();
        buffered = buffered.slice(newline + 1);
        if (line) onLine(line);
      }
    }
  } catch (err) {
    return networkFailure(err);
  }
  const rest = (buffered + decoder.decode()).trim();
  if (rest) onLine(rest);
  return { ok: true, value: undefined };
}

// ─── Internals ────────────────────────────────────────────────────────────

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
  init: { method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; jsonBody?: unknown },
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
