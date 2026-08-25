/**
 * Substrate-CLI work client (Phase 8c.2).
 *
 * Replaces the 8a Group 9 scaffold stub with the real auth flow:
 *
 *   1. `mintSubstrateToken` POSTs to `/internal/mcp/tokens` with
 *      `Authorization: Bearer <user JWT>` and the session-bound payload
 *      `{ sessionId, agentId: 'substrate-cli', scopes: [...] }`. The endpoint
 *      (`internalOrUserAuth`) verifies the JWT's userId owns the session,
 *      derives `workspaceId`, and returns a delegated JWT in `result.token`
 *      plus `result.claims.workspaceId`. The substrate CLI's lockfile is
 *      keyed by that workspaceId — `--workspace` is optional in containers
 *      because the session record IS the source of truth.
 *
 *   2. `authenticatedRequest` is the helper used by `yolo run list` /
 *      `yolo artifact get/list` to call `/internal/work/*`. It sends
 *      `Authorization: Bearer <delegated>` — the delegated MCP token is the
 *      capability (the per-agent allowedScopes check at the work routes is
 *      satisfied by the token's claims). The CLI is user-JWT-only; the
 *      INTERNAL_API_KEY / X-Internal-Auth path was removed.
 *
 * Both calls take an injectable `fetchImpl` so unit tests can stub
 * the transport without touching real `globalThis.fetch`. In v1 the
 * substrate CLI requires Node 20+, which guarantees `fetch` exists
 * globally — `engines: ">=20"` is pinned in package.json.
 *
 * Substrate-CLI v1 scopes (capped per agents.json `substrate-cli`):
 *   - Run lifecycle:  work.start_run, work.get_run,
 *     work.list_runs, work.pause_run, work.resume_run,
 *     work.cancel_run, work.transfer_run_operator
 *   - Artifact reads: work.get_artifact, work.list_artifacts, work.transfer_run_operator
 *
 * (The Plan-authoring scopes — work.create_plan/update_plan/get_plan/
 * list_plans — backed `yolo plan import/export/get/list/open/activate/
 * archive`. Those subcommands had no backing `/internal/work` route and
 * were removed as dead CLI surface during the Plan Run substrate
 * tear-down; `SUBSTRATE_CLI_PLAN_SCOPES` was removed with them. `yolo
 * plan validate` is unaffected — it's a pure offline file check with no
 * network call and no scope requirement.)
 *
 * Run-lifecycle implication: `work.start_run` binds the calling agent
 * as the Run's Operator (route handler, Phase 4/6 R4). Historically a Run
 * started via `yolo run start` had `operatorAgentId === 'substrate-cli'`,
 * and only the substrate CLI could pause/resume/cancel it via MCP, with
 * `yolo run transfer <runId> --to claude` as the handoff. `run start`,
 * `run get`, `run pause/resume/cancel`, and `run transfer` were all
 * removed as dead CLI surface (no backing route) in the same tear-down;
 * `yolo run list` is the only survivor.
 */

export const SUBSTRATE_CLI_AGENT_ID = 'substrate-cli';

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

export type SubstrateCliRunScope = (typeof SUBSTRATE_CLI_RUN_SCOPES)[number];
export type SubstrateCliArtifactScope = (typeof SUBSTRATE_CLI_ARTIFACT_SCOPES)[number];
export type SubstrateCliScope =
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
   * The user's access JWT. The mint request authenticates with
   * `Authorization: Bearer <userToken>` and common-api enforces that the
   * JWT's userId owns the session (AUTH_AND_ONBOARDING Slice 0). This is the
   * sole credential — the INTERNAL_API_KEY fallback was removed.
   */
  userToken: string;
  sessionId: string;
  scopes: ReadonlyArray<string>;
  /** Test-injectable fetch. Defaults to `globalThis.fetch`. */
  fetchImpl?: FetchLike;
}

export interface MintTokenResult {
  /** Delegated JWT (HS256, signed with the substrate `JWT_SECRET`). */
  token: string;
  /** ISO-8601 expiry; substrate CLI re-mints if it ever crosses this. */
  expiresAt: string;
  /** Resolved from the session record at mint time — keys the lockfile. */
  workspaceId: string;
  /** Resolved from the session record at mint time. Historically used by
   *  user-driven CLI fallbacks (`yolo run cancel --user-driven` and its
   *  pause/resume siblings — removed as dead CLI surface in the Plan Run
   *  substrate tear-down) to address the user-facing routes, bypassing the
   *  MCP delegated path's R4 operator-binding check. Still part of the mint
   *  response contract; validated below even though no current subcommand
   *  consumes it. */
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
  if (!options.userToken) {
    throw new WorkClientError('no user token available to mint a substrate token', 0, 'INTERNAL');
  }
  const url = `${stripTrailingSlash(options.commonApiUrl)}/internal/mcp/tokens`;
  const response = await fetchImpl(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${options.userToken}`,
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
  /** Delegated bearer from `mintSubstrateToken` — the sole capability. */
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
 * Make an authenticated request to `/internal/work/*` with
 * `Authorization: Bearer <delegated token>` (the delegated MCP token is the
 * capability; requireMcpAuth accepts it without any service header). `workPath`
 * is appended verbatim to `${commonApiUrl}/internal/work` — start it with a
 * slash, e.g., `/workspaces/${workspaceId}/plans/${planId}`.
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
 * Make a request to a user-facing `/v1/...` route (`flexibleAuth`) AS THE USER,
 * with `Authorization: Bearer <user JWT>` — `flexibleAuth` falls through to
 * `userAuth`, so the JWT IS the user identity (no `X-Internal-Auth` + `X-User-Id`
 * impersonation). `routePath` is appended verbatim to `${commonApiUrl}/v1` —
 * start with a slash, e.g. `/workspaces/${workspaceId}/runs/${planRunId}/cancel`.
 *
 * Use this when the substrate CLI deliberately acts as the workspace owner
 * rather than a delegated MCP agent — today that's `deploy-client.ts`'s
 * `/v1/...` hosting routes. (It also historically backed `yolo run cancel
 * --user-driven` and its pause/resume siblings, removed as dead CLI surface
 * in the Plan Run substrate tear-down.) Delegated MCP calls go through
 * `authenticatedRequest` instead.
 */
export interface UserRouteRequestOptions {
  commonApiUrl: string;
  /** The user's own access JWT — the sole credential. */
  userToken: string;
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
  if (!options.userToken) {
    throw new WorkClientError('no user token available for user-route request', 0, 'INTERNAL');
  }
  const authHeaders: Record<string, string> = { Authorization: `Bearer ${options.userToken}` };
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
