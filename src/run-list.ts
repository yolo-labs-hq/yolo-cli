/**
 * `yolo run list` — list Plan Runs in the current workspace.
 *
 * Read companion to the run lifecycle slice. After starting/transitioning
 * runs, an operator wants a "what runs are in this workspace?" view
 * without remembering planRunIds. Maps to `work.list_runs` (added on
 * the server side as part of this slice).
 *
 * Two output modes:
 *   - default (`--summary`): one row per run with planRunId, planId,
 *     run #, executionState, operator, startedAt.
 *   - `--json`: pretty-printed raw `runs[]` for jq pipelines.
 *
 * Filter: `--state <pending|running|paused|succeeded|failed|cancelled|superseded>`
 * passed as `?executionState=` query string for server-side filtering.
 *
 * Exit codes:
 *   - 0  = success (zero runs is also success — empty list, not an error)
 *   - 1  = http (e.g., 401 from a revoked token)
 *   - 64 = usage (bad --state, missing env, --workspace mismatch)
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

export type RunExecutionState =
  | 'pending'
  | 'running'
  | 'paused'
  | 'succeeded'
  | 'failed'
  | 'cancelled'
  | 'superseded';

export interface RunListOptions {
  workspaceFlag?: string;
  /** Server-side filter on executionState. */
  stateFilter?: RunExecutionState;
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface RunListEntry {
  planRunId: string;
  planId: string;
  planVersion: number;
  runNumber: number;
  executionState: RunExecutionState;
  operatorAgentId: string | null;
  operatorResponsive: boolean;
  startedAt: string;
  endedAt: string | null;
}

export interface RunListSuccess {
  ok: true;
  output: string;
  runs: RunListEntry[];
  workspaceId: string;
}

export interface RunListFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type RunListResult = RunListSuccess | RunListFailure;

const ALLOWED_STATES: ReadonlyArray<RunExecutionState> = [
  'pending',
  'running',
  'paused',
  'succeeded',
  'failed',
  'cancelled',
  'superseded',
];

// ─── Public entry ─────────────────────────────────────────────────────────

export async function runRunList(options: RunListOptions): Promise<RunListResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (options.stateFilter !== undefined && !ALLOWED_STATES.includes(options.stateFilter)) {
    return fail(
      'usage',
      `invalid --state '${options.stateFilter}': must be one of ${ALLOWED_STATES.join(', ')}`,
    );
  }

  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return fail('auth', auth.message);
  const { sessionId, commonApiUrl, userToken, internalApiKey } = auth.context;

  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      userToken,
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
  const path = options.stateFilter
    ? `/workspaces/${mint.workspaceId}/runs?executionState=${options.stateFilter}`
    : `/workspaces/${mint.workspaceId}/runs`;
  const response = await authenticatedRequest(ctx, path, { method: 'GET' });
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.list_runs failed: HTTP ${response.status} — ${text}`, {
      status: response.status,
    });
  }
  const json = (await response.json()) as { runs?: RunListEntry[] };
  if (!Array.isArray(json.runs)) {
    return fail('http', 'work.list_runs response missing `runs` array');
  }

  return {
    ok: true,
    output: format === 'json'
      ? formatJson(json.runs)
      : formatSummary(json.runs, mint.workspaceId, options.stateFilter),
    runs: json.runs,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

/**
 * Header + one row per run. Columns (auto-padded):
 *   planRunId  planId  #N  state  operator  startedAt
 * Empty list renders "(no runs)" instead of just a header.
 */
export function formatSummary(
  runs: RunListEntry[],
  workspaceId: string,
  stateFilter?: RunExecutionState,
): string {
  const lines: string[] = [];
  const filterTag = stateFilter ? ` (filter: ${stateFilter})` : '';
  lines.push(`Plan Runs in workspace ${workspaceId}${filterTag}: ${runs.length}`);

  if (runs.length === 0) {
    lines.push('  (no runs)');
    return lines.join('\n');
  }

  const idCol = Math.max(9, ...runs.map((r) => r.planRunId.length));
  const planCol = Math.max(6, ...runs.map((r) => r.planId.length));
  const stateCol = Math.max(5, ...runs.map((r) => r.executionState.length));
  const operatorCol = Math.max(8, ...runs.map((r) => (r.operatorAgentId ?? '(unbound)').length));

  const header =
    `  ${'planRunId'.padEnd(idCol)}  ${'planId'.padEnd(planCol)}  run#   ${'state'.padEnd(stateCol)}  ${'operator'.padEnd(operatorCol)}  startedAt`;
  lines.push(header);

  for (const r of runs) {
    const id = r.planRunId.padEnd(idCol);
    const plan = r.planId.padEnd(planCol);
    const runNum = `#${r.runNumber}`.padEnd(5);
    const state = r.executionState.padEnd(stateCol);
    const operator = (r.operatorAgentId ?? '(unbound)').padEnd(operatorCol);
    lines.push(`  ${id}  ${plan}  ${runNum}  ${state}  ${operator}  ${r.startedAt}`);
  }
  return lines.join('\n');
}

function formatJson(runs: RunListEntry[]): string {
  return JSON.stringify(runs, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: RunListFailure['kind'], message: string, detail?: Record<string, unknown>): RunListFailure {
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

export function exitCodeForFailure(kind: RunListFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
