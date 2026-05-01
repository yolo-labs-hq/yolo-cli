/**
 * `yolo run get <runId>` — read a Plan Run from the substrate.
 *
 * Mints a session-bound delegated token (work.get_run scope) and
 * GETs `/internal/work/workspaces/<wsId>/runs/<planRunId>`. Prints
 * a human-readable summary by default; `--json` for the raw response
 * (useful for jq pipelines).
 *
 * No file I/O, no lockfile mutation. Pure read.
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (run not found, etc.)
 *   - 64 = usage (bad runId, missing env trio, --workspace mismatch)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_RUN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface RunGetOptions {
  planRunId: string;
  workspaceFlag?: string;
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface RunGetSuccess {
  ok: true;
  output: string;
  run: GetRunResponse;
  workspaceId: string;
}

export interface RunGetFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type RunGetResult = RunGetSuccess | RunGetFailure;

interface GetRunResponse {
  planRunId: string;
  planId: string;
  planVersion: number;
  runNumber: number;
  executionState: string;
  inputs?: Record<string, unknown>;
  operatorAgentId: string | null;
  operatorResponsive?: boolean;
  runDesktopId?: string | null;
  overviewTileId?: string | null;
  steps: Array<{
    stepId: string;
    latestStepRunId: string | null;
    state: string;
    tileId: string | null;
  }>;
  startedAt?: string | null;
  endedAt?: string | null;
}

// ─── Public entry ─────────────────────────────────────────────────────────

const PLAN_RUN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}$/;

export async function runRunGet(options: RunGetOptions): Promise<RunGetResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (!PLAN_RUN_ID_REGEX.test(options.planRunId)) {
    return fail(
      'usage',
      `invalid planRunId '${options.planRunId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}$/`,
    );
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
  const response = await authenticatedRequest(
    ctx,
    `/workspaces/${mint.workspaceId}/runs/${options.planRunId}`,
    { method: 'GET' },
  );
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.get_run failed: HTTP ${response.status} — ${text}`, { status: response.status });
  }
  const json = (await response.json()) as { run?: GetRunResponse };
  if (!json.run) {
    return fail('http', 'work.get_run response missing `run` field');
  }

  return {
    ok: true,
    output: format === 'json' ? formatJson(json.run) : formatSummary(json.run, mint.workspaceId),
    run: json.run,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

/**
 * Header + per-step table. Table columns auto-size to the longest
 * stepId / state / stepRunId / tileId so output stays aligned even
 * for plans with mixed-width identifiers.
 */
export function formatSummary(run: GetRunResponse, workspaceId: string): string {
  const lines: string[] = [];
  lines.push(
    `Plan Run ${run.planRunId} (workspace ${workspaceId}, run #${run.runNumber}, plan ${run.planId} v${run.planVersion}, executionState=${run.executionState})`,
  );

  const operatorTag = run.operatorAgentId
    ? `${run.operatorAgentId}${run.operatorResponsive === false ? ' (unresponsive)' : run.operatorResponsive === true ? ' (responsive)' : ''}`
    : '(unbound)';
  lines.push(`  operator: ${operatorTag}`);
  if (run.startedAt) lines.push(`  startedAt: ${run.startedAt}`);
  if (run.endedAt) lines.push(`  endedAt:   ${run.endedAt}`);

  const inputCount = run.inputs ? Object.keys(run.inputs).length : 0;
  if (inputCount > 0) lines.push(`  inputs: ${inputCount}`);

  lines.push(`  steps: ${run.steps.length}`);
  if (run.steps.length === 0) return lines.join('\n');

  const stepIdW = Math.max(6, ...run.steps.map((s) => s.stepId.length));
  const stateW = Math.max(5, ...run.steps.map((s) => s.state.length));
  const stepRunW = Math.max(8, ...run.steps.map((s) => (s.latestStepRunId ?? '—').length));
  for (const step of run.steps) {
    const stepRun = step.latestStepRunId ?? '—';
    const tile = step.tileId ?? '—';
    lines.push(
      `    - ${step.stepId.padEnd(stepIdW)}  ${step.state.padEnd(stateW)}  ${stepRun.padEnd(stepRunW)}  ${tile}`,
    );
  }
  return lines.join('\n');
}

function formatJson(run: GetRunResponse): string {
  return JSON.stringify(run, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: RunGetFailure['kind'], message: string, detail?: Record<string, unknown>): RunGetFailure {
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

export function exitCodeForFailure(kind: RunGetFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
