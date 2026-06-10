/**
 * `yolo run pause / resume / cancel <runId>` — lifecycle transitions.
 *
 * The three verbs share a single runner because the routes share a
 * single transition handler on the server (common-api/src/routes/
 * workspaces.ts:transitionPlanRunForUser). They differ only in
 * target state, valid source states, and whether they accept a
 * `--reason`.
 *
 * Auth model: hits the user-facing route at
 * `/v1/workspaces/:id/runs/:planRunId/{verb}` via X-Internal-Auth +
 * X-User-Id (the substrate CLI is by definition invoked by the
 * workspace owner — operating as them is the right default). The
 * user route checks workspace ownership only and skips R4 operator
 * binding, so this works regardless of which agent (if any) is
 * bound to the run.
 *
 * Why not the MCP path: that path's R4 binding makes sense for
 * agent-to-agent calls (claude pausing its own run) but produces
 * 403 NOT_AUTHORIZED whenever the user wants to cancel a run owned
 * by a different agent or by the webapp launcher. Forcing the user
 * to know which side of that fence they're on is bad UX. The CLI
 * decides automatically.
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (404, 409 INVALID_STATE, 5xx)
 *   - 64 = usage (bad runId, missing env trio, --workspace mismatch,
 *          reason too long pre-network, bad target verb)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_RUN_SCOPES,
  WorkClientError,
  mintSubstrateToken,
  userRouteRequest,
} from './work-client.js';
import { resolveSubstrateContext } from './auth-context.js';

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

  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return fail('auth', auth.message);
  const { sessionId, commonApiUrl, userToken } = auth.context;

  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      userToken,
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

  const body: { reason?: string } = {};
  if (options.reason !== undefined && options.verb !== 'resume') {
    body.reason = options.reason;
  }
  const path = `/workspaces/${mint.workspaceId}/runs/${options.planRunId}/${options.verb}`;
  const response = await userRouteRequest(
    {
      commonApiUrl,
      userToken,
      fetchImpl: options.fetchImpl,
    },
    path,
    { method: 'POST', jsonBody: body },
  );
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
