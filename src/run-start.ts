/**
 * `yolo run start <planId>` — bootstrap a Plan Run via work.start_run.
 *
 * Mints a session-bound delegated token (work.start_run scope) and
 * POSTs to `/internal/work/workspaces/<wsId>/runs` with the planId
 * and (optional) inputs. The route handler (common-api/src/routes/
 * work.ts) binds `operatorAgentId: ctx.agentId` — so a Run started
 * via this verb has `operatorAgentId === 'substrate-cli'` and only
 * the substrate CLI can pause/resume/cancel it via MCP.
 *
 * Inputs: passed as a JSON object literal via `--inputs '<json>'`.
 * If absent, defaults to `{}` (the route accepts that and lets Plan
 * input validation reject if any inputs were declared as required).
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (plan not found, plan not active, validation failure)
 *   - 64 = usage (bad planId, malformed --inputs JSON, missing env
 *          trio, --workspace mismatch)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_RUN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';
import { resolveSubstrateContext } from './auth-context.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface RunStartOptions {
  planId: string;
  workspaceFlag?: string;
  /** Optional inputs object — passed through to work.start_run. */
  inputs?: Record<string, unknown>;
  /** 'json' = raw response. 'summary' = one-line OK message. Default 'summary'. */
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface RunStartSuccess {
  ok: true;
  output: string;
  response: StartRunResponse;
  workspaceId: string;
}

export interface RunStartFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type RunStartResult = RunStartSuccess | RunStartFailure;

interface StartRunResponse {
  planRunId: string;
  runNumber: number;
  runDesktopId: string;
  executionState: string;
  operatorAgentId: string | null;
}

// ─── Public entry ─────────────────────────────────────────────────────────

const PLAN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export async function runRunStart(options: RunStartOptions): Promise<RunStartResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (!PLAN_ID_REGEX.test(options.planId)) {
    return fail(
      'usage',
      `invalid planId '${options.planId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`,
    );
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

  const ctx = {
    commonApiUrl,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };
  const body: { planId: string; inputs?: Record<string, unknown> } = { planId: options.planId };
  if (options.inputs !== undefined) body.inputs = options.inputs;
  const response = await authenticatedRequest(
    ctx,
    `/workspaces/${mint.workspaceId}/runs`,
    { method: 'POST', jsonBody: body },
  );
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.start_run failed: HTTP ${response.status} — ${text}`, { status: response.status });
  }
  const json = (await response.json()) as StartRunResponse;
  if (typeof json.planRunId !== 'string' || !json.planRunId) {
    return fail('http', 'work.start_run response missing planRunId');
  }

  return {
    ok: true,
    output: format === 'json' ? formatJson(json) : formatSummary(json, options.planId),
    response: json,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

export function formatSummary(response: StartRunResponse, planId: string): string {
  const operatorTag = response.operatorAgentId ? `operator=${response.operatorAgentId}` : 'operator=(unbound)';
  return `OK: started run ${response.planRunId} for plan ${planId} (run #${response.runNumber}, executionState=${response.executionState}, ${operatorTag})`;
}

function formatJson(response: StartRunResponse): string {
  return JSON.stringify(response, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: RunStartFailure['kind'], message: string, detail?: Record<string, unknown>): RunStartFailure {
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

export function exitCodeForFailure(kind: RunStartFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
