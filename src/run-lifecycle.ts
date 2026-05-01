/**
 * `yolo run pause / resume / cancel <runId>` — lifecycle transitions.
 *
 * The three verbs share a single runner because the routes share a
 * single transition handler on the server (common-api/src/routes/
 * work.ts:transitionRunHandler). They differ only in target state,
 * valid source states, and whether they accept a `--reason`.
 *
 * Auth model: pause/resume/cancel via MCP require the caller to be
 * the bound Operator (Phase 6 R4). For the substrate CLI that means
 * a Run started via `yolo run start` (substrate-cli IS the Operator)
 * works; a Run started by claude / codex / etc. returns 403
 * NOT_AUTHORIZED. That hazard is surfaced through the http-failure
 * path with the route's friendly NOT_AUTHORIZED message.
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (404, 403 NOT_AUTHORIZED, 409 INVALID_STATE, 5xx)
 *   - 64 = usage (bad runId, missing env trio, --workspace mismatch,
 *          reason too long pre-network, bad target verb)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_RUN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type RunLifecycleVerb = 'pause' | 'resume' | 'cancel';

export interface RunLifecycleOptions {
  verb: RunLifecycleVerb;
  planRunId: string;
  workspaceFlag?: string;
  /** Optional reason — accepted by pause/cancel only, ignored by resume. */
  reason?: string;
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface RunLifecycleSuccess {
  ok: true;
  output: string;
  response: TransitionResponse;
  workspaceId: string;
}

export interface RunLifecycleFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type RunLifecycleResult = RunLifecycleSuccess | RunLifecycleFailure;

interface TransitionResponse {
  planRunId: string;
  executionState: string;
}

// ─── Public entry ─────────────────────────────────────────────────────────

const PLAN_RUN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}$/;
const REASON_MAX_LEN = 1024;

export async function runRunLifecycle(options: RunLifecycleOptions): Promise<RunLifecycleResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (options.verb !== 'pause' && options.verb !== 'resume' && options.verb !== 'cancel') {
    return fail('usage', `unknown verb '${options.verb}': must be pause, resume, or cancel`);
  }
  if (!PLAN_RUN_ID_REGEX.test(options.planRunId)) {
    return fail(
      'usage',
      `invalid planRunId '${options.planRunId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}$/`,
    );
  }
  if (options.reason !== undefined) {
    if (typeof options.reason !== 'string' || options.reason.length > REASON_MAX_LEN) {
      return fail('usage', `--reason must be a string of at most ${REASON_MAX_LEN} chars`);
    }
    if (options.verb === 'resume') {
      return fail('usage', '--reason is not accepted by `run resume`');
    }
  }

  const sessionId = env.SESSION_ID;
  const internalApiKey = env.INTERNAL_API_KEY;
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!sessionId) return fail('auth', 'SESSION_ID env var is required (substrate CLI is container-only in v1)');
  if (!internalApiKey) return fail('auth', 'INTERNAL_API_KEY env var is required');
  if (!commonApiUrl) return fail('auth', 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required');

  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      internalApiKey,
      sessionId,
      scopes: SUBSTRATE_CLI_RUN_SCOPES,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    if (err instanceof WorkClientError) {
      return fail('auth', `failed to mint substrate token: ${err.message}`, { status: err.status, code: err.code });
    }
    return fail('auth', `failed to mint substrate token: ${describeError(err)}`);
  }

  if (options.workspaceFlag && options.workspaceFlag !== mint.workspaceId) {
    return fail(
      'workspace_mismatch',
      `--workspace ${options.workspaceFlag} does not match the workspace bound to this session (${mint.workspaceId}).`,
    );
  }

  const ctx = {
    commonApiUrl,
    internalApiKey,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };
  const body: { reason?: string } = {};
  if (options.reason !== undefined && options.verb !== 'resume') {
    body.reason = options.reason;
  }
  const path = `/workspaces/${mint.workspaceId}/runs/${options.planRunId}/${options.verb}`;
  const response = await authenticatedRequest(ctx, path, { method: 'POST', jsonBody: body });
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.${options.verb}_run failed: HTTP ${response.status} — ${text}`, { status: response.status });
  }
  const json = (await response.json()) as TransitionResponse;
  if (typeof json.planRunId !== 'string' || typeof json.executionState !== 'string') {
    return fail('http', `work.${options.verb}_run response missing planRunId or executionState`);
  }

  return {
    ok: true,
    output: format === 'json' ? formatJson(json) : formatSummary(options.verb, json),
    response: json,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

export function formatSummary(verb: RunLifecycleVerb, response: TransitionResponse): string {
  const past = verb === 'pause' ? 'paused' : verb === 'resume' ? 'resumed' : 'cancelled';
  return `OK: ${past} run ${response.planRunId} (executionState=${response.executionState})`;
}

function formatJson(response: TransitionResponse): string {
  return JSON.stringify(response, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: RunLifecycleFailure['kind'], message: string, detail?: Record<string, unknown>): RunLifecycleFailure {
  return { ok: false, kind, message, detail };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

export function exitCodeForFailure(kind: RunLifecycleFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
