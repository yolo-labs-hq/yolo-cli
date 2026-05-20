/**
 * Substrate-CLI work client (Phase 8c.2).
 *
 * Replaces the 8a Group 9 scaffold stub with the real auth flow:
 *
 *   1. `mintSubstrateToken` POSTs to `/internal/mcp/tokens` with
 *      `X-Internal-Auth: ${INTERNAL_API_KEY}` and the session-bound
 *      payload `{ sessionId, agentId: 'substrate-cli', scopes: [...] }`.
 *      The endpoint looks up the session, derives `workspaceId`, and
 *      returns a delegated JWT in `result.token` plus
 *      `result.claims.workspaceId`. The substrate CLI's lockfile is
 *      keyed by that workspaceId — `--workspace` is optional in
 *      containers because the session record IS the source of truth.
 *
 *   2. `authenticatedRequest` is the helper used by `yolo plan
 *      import/export` (8c.3+) to call `/internal/work/*`. It sends
 *      both `X-Internal-Auth` (so common-api accepts the request as
 *      service-to-service) AND `Authorization: Bearer <delegated>`
 *      (so the per-agent allowedScopes check at the work routes
 *      passes — Phase 8a F8.14).
 *
 * Both calls take an injectable `fetchImpl` so unit tests can stub
 * the transport without touching real `globalThis.fetch`. In v1 the
 * substrate CLI requires Node 20+, which guarantees `fetch` exists
 * globally — `engines: ">=20"` is pinned in package.json.
 *
 * Substrate-CLI v1 scopes (capped per agents.json `substrate-cli`):
 *   - Plan authoring: work.create_plan, work.update_plan,
 *     work.get_plan, work.list_plans
 *   - Run lifecycle:  work.start_run, work.get_run,
 *     work.list_runs, work.pause_run, work.resume_run,
 *     work.cancel_run, work.transfer_run_operator
 *   - Artifact reads: work.get_artifact, work.list_artifacts, work.transfer_run_operator
 *
 * Run-lifecycle implication: `work.start_run` binds the calling agent
 * as the Run's Operator (route handler, Phase 4/6 R4). So a Run started
 * via `yolo run start` has `operatorAgentId === 'substrate-cli'`, and
 * only the substrate CLI can pause/resume/cancel it via MCP. The
 * natural handoff loop is `yolo run transfer <runId> --to claude` —
 * substrate-cli is the current Operator, claude/codex is an
 * Operator-tier target, route's R4 self-transfer path applies.
 * Substrate-cli is NOT itself Operator-tier (per
 * `OPERATOR_TIER_AGENT_IDS` in operator-binding.ts), so `--to
 * substrate-cli` is rejected by the route's `isValidOperatorTarget`
 * check.
 */

export const SUBSTRATE_CLI_AGENT_ID = 'substrate-cli';

export const SUBSTRATE_CLI_PLAN_SCOPES = [
  'work.create_plan',
  'work.update_plan',
  'work.get_plan',
  'work.list_plans',
] as const;

export const SUBSTRATE_CLI_RUN_SCOPES = [
  'work.start_run',
  'work.get_run',
  'work.list_runs',
  'work.pause_run',
  'work.resume_run',
  'work.cancel_run',
  'work.transfer_run_operator',
] as const;

export const SUBSTRATE_CLI_ARTIFACT_SCOPES = [
  'work.get_artifact',
  'work.list_artifacts',
] as const;

export type SubstrateCliPlanScope = (typeof SUBSTRATE_CLI_PLAN_SCOPES)[number];
export type SubstrateCliRunScope = (typeof SUBSTRATE_CLI_RUN_SCOPES)[number];
export type SubstrateCliArtifactScope = (typeof SUBSTRATE_CLI_ARTIFACT_SCOPES)[number];
export type SubstrateCliScope =
  | SubstrateCliPlanScope
  | SubstrateCliRunScope
  | SubstrateCliArtifactScope;

/**
 * Minimal subset of the global `fetch` shape the work client needs.
 * Declared locally so tests can supply a stub without depending on
 * lib.dom's Response/Request types.
 */
export type FetchLike = (input: string, init?: {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}) => Promise<{
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
  text(): Promise<string>;
}>;

export interface MintTokenOptions {
  commonApiUrl: string;
  /**
   * Preferred credential: the user's access JWT. When present, the mint
   * request authenticates with `Authorization: Bearer <userToken>` and
   * common-api enforces that the JWT's userId owns the session
   * (AUTH_AND_ONBOARDING Slice 0). Falls back to `internalApiKey` when
   * absent (service callers / transition).
   */
  userToken?: string;
  /** Service master-key fallback. Optional once a userToken is available. */
  internalApiKey?: string;
  sessionId: string;
  scopes: ReadonlyArray<string>;
  /** Test-injectable fetch. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
}

/**
 * Build the auth header for a mint request: prefer the user JWT, fall
 * back to the service key. Returns null when neither is present.
 */
function mintAuthHeaders(opts: { userToken?: string; internalApiKey?: string }): Record<string, string> | null {
  if (opts.userToken) {
    return { Authorization: `Bearer ${opts.userToken}` };
  }
  if (opts.internalApiKey) {
    return { 'X-Internal-Auth': opts.internalApiKey };
  }
  return null;
}

export interface MintTokenResult {
  /** Delegated JWT (HS256, signed with the substrate `JWT_SECRET`). */
  token: string;
  /** ISO-8601 expiry; substrate CLI re-mints if it ever crosses this. */
  expiresAt: string;
  /** Resolved from the session record at mint time — keys the lockfile. */
  workspaceId: string;
  /** Resolved from the session record at mint time. Used by user-driven
   *  CLI fallbacks (e.g. `yolo run cancel --user-driven`) to address
   *  the user-facing routes via `X-Internal-Auth` + `X-User-Id`,
   *  bypassing the MCP delegated path's R4 operator-binding check. */
  userId: string;
  /** Audit-trace correlation id; logged but not used for routing. */
  jti: string;
}

export class WorkClientError extends Error {
  readonly status: number;
  readonly code: string;
  constructor(message: string, status: number, code: string) {
    super(message);
    this.name = 'WorkClientError';
    this.status = status;
    this.code = code;
  }
}

/**
 * Mint a session-bound delegated token for the substrate CLI.
 * Server-derived workspaceId comes back in `claims.workspaceId`.
 *
 * Throws `WorkClientError` with `status` and `code` from the
 * common-api error envelope (`{ error, code }`); networks failures
 * surface as plain `Error` from the underlying fetch.
 */
export async function mintSubstrateToken(options: MintTokenOptions): Promise<MintTokenResult> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new WorkClientError('fetch is not available; substrate CLI requires Node 20+', 0, 'INTERNAL');
  }
  const authHeaders = mintAuthHeaders(options);
  if (!authHeaders) {
    throw new WorkClientError('no credential available to mint a substrate token (need userToken or internalApiKey)', 0, 'INTERNAL');
  }
  const url = `${stripTrailingSlash(options.commonApiUrl)}/internal/mcp/tokens`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      ...authHeaders,
    },
    body: JSON.stringify({
      sessionId: options.sessionId,
      agentId: SUBSTRATE_CLI_AGENT_ID,
      scopes: options.scopes,
    }),
  });

  if (!response.ok) {
    let parsed: { error?: string; code?: string } = {};
    try {
      parsed = (await response.json()) as { error?: string; code?: string };
    } catch {
      // body wasn't JSON — fall through to a generic message
    }
    throw new WorkClientError(
      parsed.error ?? `mint failed: HTTP ${response.status}`,
      response.status,
      parsed.code ?? 'INTERNAL',
    );
  }

  const json = (await response.json()) as {
    token?: unknown;
    expiresAt?: unknown;
    jti?: unknown;
    claims?: { workspaceId?: unknown; userId?: unknown };
  };

  if (typeof json.token !== 'string' || json.token.length === 0) {
    throw new WorkClientError('mint response missing string `token`', 502, 'INTERNAL');
  }
  if (typeof json.expiresAt !== 'string' || json.expiresAt.length === 0) {
    throw new WorkClientError('mint response missing string `expiresAt`', 502, 'INTERNAL');
  }
  if (typeof json.jti !== 'string' || json.jti.length === 0) {
    throw new WorkClientError('mint response missing string `jti`', 502, 'INTERNAL');
  }
  const workspaceId = json.claims?.workspaceId;
  if (typeof workspaceId !== 'string' || workspaceId.length === 0) {
    throw new WorkClientError('mint response missing string `claims.workspaceId`', 502, 'INTERNAL');
  }
  const userId = json.claims?.userId;
  if (typeof userId !== 'string' || userId.length === 0) {
    throw new WorkClientError('mint response missing string `claims.userId`', 502, 'INTERNAL');
  }

  return {
    token: json.token,
    expiresAt: json.expiresAt,
    workspaceId,
    userId,
    jti: json.jti,
  };
}

export interface AuthenticatedRequestOptions {
  commonApiUrl: string;
  /**
   * Optional service master key. When present it's sent as
   * `X-Internal-Auth` for backwards-compat; the delegated bearer below
   * is the actual capability (requireMcpAuth no longer requires the
   * header post-Slice-0), so calls work header-less too.
   */
  internalApiKey?: string;
  /** Delegated bearer from `mintSubstrateToken`. */
  delegatedToken: string;
  /** Test-injectable fetch. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
}

export interface AuthenticatedRequestInit {
  method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** Sent as JSON; Content-Type is auto-set. */
  jsonBody?: unknown;
  /** Extra headers; overrides anything except auth headers. */
  headers?: Record<string, string>;
}

/**
 * Make an authenticated request to `/internal/work/*`. Sends BOTH
 * `X-Internal-Auth` (service auth) and `Authorization: Bearer …`
 * (delegated). `workPath` is appended verbatim to
 * `${commonApiUrl}/internal/work` — start it with a slash, e.g.,
 * `/workspaces/${workspaceId}/plans/${planId}`.
 */
export async function authenticatedRequest(
  options: AuthenticatedRequestOptions,
  workPath: string,
  init: AuthenticatedRequestInit = {},
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new WorkClientError('fetch is not available; substrate CLI requires Node 20+', 0, 'INTERNAL');
  }
  const url = `${stripTrailingSlash(options.commonApiUrl)}/internal/work${workPath}`;
  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    ...(options.internalApiKey ? { 'X-Internal-Auth': options.internalApiKey } : {}),
    Authorization: `Bearer ${options.delegatedToken}`,
  };
  const fetchInit: { method?: string; headers: Record<string, string>; body?: string } = {
    method: init.method ?? 'GET',
    headers,
  };
  if (init.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchInit.body = JSON.stringify(init.jsonBody);
  }
  return fetchImpl(url, fetchInit);
}

/**
 * Make a service-to-service request to a user-facing route that uses
 * `flexibleAuth`. Sends `X-Internal-Auth` + `X-User-Id` so the route
 * resolves a user identity without going through the delegated token
 * path (which would carry MCP scope + R4 operator-binding semantics).
 *
 * `routePath` is appended verbatim to `${commonApiUrl}/v1` — start
 * with a slash, e.g. `/workspaces/${workspaceId}/runs/${planRunId}/cancel`.
 *
 * Use this only when the substrate CLI deliberately wants to act as
 * the workspace owner (e.g. `yolo run cancel --user-driven` for a Run
 * the user started from the webapp). Default lifecycle calls go
 * through `authenticatedRequest` and the MCP path.
 */
export interface UserRouteRequestOptions {
  commonApiUrl: string;
  /**
   * Preferred: the user's own access JWT. `flexibleAuth` falls through
   * to `userAuth` for a plain bearer, so the JWT IS the user identity —
   * no `X-Internal-Auth` + `X-User-Id` impersonation needed. Falls back
   * to the internal-key path when no userToken is available.
   */
  userToken?: string;
  /** Service master-key fallback (paired with `userId`). */
  internalApiKey?: string;
  userId: string;
  fetchImpl?: FetchLike;
}

export async function userRouteRequest(
  options: UserRouteRequestOptions,
  routePath: string,
  init: AuthenticatedRequestInit = {},
): Promise<{ ok: boolean; status: number; json: () => Promise<unknown>; text: () => Promise<string> }> {
  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  if (!fetchImpl) {
    throw new WorkClientError('fetch is not available; substrate CLI requires Node 20+', 0, 'INTERNAL');
  }
  const authHeaders: Record<string, string> = options.userToken
    ? { Authorization: `Bearer ${options.userToken}` }
    : options.internalApiKey
      ? { 'X-Internal-Auth': options.internalApiKey, 'X-User-Id': options.userId }
      : (() => { throw new WorkClientError('no credential available for user-route request', 0, 'INTERNAL'); })();
  const url = `${stripTrailingSlash(options.commonApiUrl)}/v1${routePath}`;
  const headers: Record<string, string> = {
    ...(init.headers ?? {}),
    ...authHeaders,
  };
  const fetchInit: { method?: string; headers: Record<string, string>; body?: string } = {
    method: init.method ?? 'GET',
    headers,
  };
  if (init.jsonBody !== undefined) {
    headers['Content-Type'] = 'application/json';
    fetchInit.body = JSON.stringify(init.jsonBody);
  }
  return fetchImpl(url, fetchInit);
}

function stripTrailingSlash(url: string): string {
  return url.endsWith('/') ? url.slice(0, -1) : url;
}
