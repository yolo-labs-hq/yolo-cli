/**
 * `yolo plan list` — list Plans in the current workspace.
 *
 * The third read-path verb after `plan get` and `plan validate`.
 * Closes the "what's even in this workspace?" gap that operators
 * hit immediately after `yolo context` (no in-CLI way to discover
 * planIds without a curl detour). Maps directly to the substrate's
 * `work.list_plans` route, which is already in
 * `SUBSTRATE_CLI_PLAN_SCOPES`.
 *
 * Two output modes:
 *   - default (`--summary`): one-line table per plan with planId,
 *     state, version, latestRunId (or `—`), updatedAt (relative ISO
 *     date for at-a-glance recency).
 *   - `--json`: pretty-printed raw `plans[]` array. For jq /
 *     scripted operator pipelines.
 *
 * Filter: `--state <draft|active|archived>` server-side filter
 * (passed as `?state=` query param; renamed from `authoringState`
 * 2026-05-09, item 17). Avoids client-side filtering on workspaces
 * with many plans.
 *
 * Exit codes:
 *   - 0  = success (zero plans is also success — empty list, not an error)
 *   - 1  = http (e.g., 401 from a token that's been revoked mid-session)
 *   - 64 = usage (bad --state, missing env, --workspace mismatch)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_PLAN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';
import { resolveSubstrateContext } from './auth-context.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type PlanState = 'draft' | 'active' | 'archived';

export interface ListOptions {
  workspaceFlag?: string;
  /** Server-side filter on Plan.state. */
  stateFilter?: PlanState;
  /**
   * 'json' = pretty-print the raw response. 'summary' = one-line
   * row per plan. Default 'summary'.
   */
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface PlanListEntry {
  planId: string;
  name: string;
  state: PlanState;
  version: number;
  latestRunId: string | null;
  updatedAt: string;
}

export interface ListSuccess {
  ok: true;
  /** The text written to stdout. */
  output: string;
  /** Raw response — useful for tests / callers driving programmatically. */
  plans: PlanListEntry[];
  workspaceId: string;
}

export interface ListFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type ListResult = ListSuccess | ListFailure;

const ALLOWED_STATES: ReadonlyArray<PlanState> = ['draft', 'active', 'archived'];

// ─── Public entry ─────────────────────────────────────────────────────────

export async function runPlanList(options: ListOptions): Promise<ListResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  // 1) --state value (validated even though the server also validates,
  //    so we can fail fast without a network round-trip).
  if (options.stateFilter !== undefined && !ALLOWED_STATES.includes(options.stateFilter)) {
    return fail(
      'usage',
      `invalid --state '${options.stateFilter}': must be one of ${ALLOWED_STATES.join(', ')}`,
    );
  }

  // 2) Substrate context
  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return fail('auth', auth.message);
  const { sessionId, commonApiUrl, userToken, internalApiKey } = auth.context;

  // 3) Mint token
  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      userToken,
      internalApiKey,
      sessionId,
      scopes: SUBSTRATE_CLI_PLAN_SCOPES,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    if (err instanceof WorkClientError) {
      return fail('auth', `failed to mint substrate token: ${err.message}`, { status: err.status, code: err.code });
    }
    return fail('auth', `failed to mint substrate token: ${describeError(err)}`);
  }

  // 4) --workspace assertion
  if (options.workspaceFlag && options.workspaceFlag !== mint.workspaceId) {
    return fail(
      'workspace_mismatch',
      `--workspace ${options.workspaceFlag} does not match the workspace bound to this session (${mint.workspaceId}).`,
    );
  }

  // 5) GET /workspaces/<wsId>/plans (with optional ?state=)
  const ctx = {
    commonApiUrl,
    internalApiKey,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };
  const path = options.stateFilter
    ? `/workspaces/${mint.workspaceId}/plans?state=${options.stateFilter}`
    : `/workspaces/${mint.workspaceId}/plans`;
  const response = await authenticatedRequest(ctx, path, { method: 'GET' });
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.list_plans failed: HTTP ${response.status} — ${text}`, {
      status: response.status,
    });
  }
  const json = (await response.json()) as { plans?: PlanListEntry[] };
  if (!Array.isArray(json.plans)) {
    return fail('http', 'work.list_plans response missing `plans` array');
  }

  return {
    ok: true,
    output: format === 'json'
      ? formatJson(json.plans)
      : formatSummary(json.plans, mint.workspaceId, options.stateFilter),
    plans: json.plans,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

/**
 * One-line header + one row per plan, columns:
 * `planId  state    v#   latestRun  updatedAt`. Right-padded so
 * planIds align even when they vary in length. When the list is
 * empty, prints a clear "(no plans)" hint instead of just a header.
 */
export function formatSummary(
  plans: PlanListEntry[],
  workspaceId: string,
  stateFilter?: PlanState,
): string {
  const lines: string[] = [];
  const filterTag = stateFilter ? ` (filter: ${stateFilter})` : '';
  lines.push(`Plans in workspace ${workspaceId}${filterTag}: ${plans.length}`);

  if (plans.length === 0) {
    lines.push('  (no plans)');
    return lines.join('\n');
  }

  // Column widths from data — keeps short workspaces compact, won't
  // visually break at scale.
  const planIdCol = Math.max(8, ...plans.map((p) => p.planId.length));
  const nameCol = Math.max(4, ...plans.map((p) => p.name.length));

  const header =
    `  ${'planId'.padEnd(planIdCol)}  ${'name'.padEnd(nameCol)}  state     version  latestRun  updatedAt`;
  lines.push(header);

  for (const p of plans) {
    const planId = p.planId.padEnd(planIdCol);
    const name = p.name.padEnd(nameCol);
    const state = p.state.padEnd(8);
    const version = `v${p.version}`.padEnd(7);
    const latestRun = (p.latestRunId ?? '—').padEnd(9);
    lines.push(`  ${planId}  ${name}  ${state}  ${version}  ${latestRun}  ${p.updatedAt}`);
  }
  return lines.join('\n');
}

function formatJson(plans: PlanListEntry[]): string {
  return JSON.stringify(plans, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: ListFailure['kind'], message: string, detail?: Record<string, unknown>): ListFailure {
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

export function exitCodeForFailure(kind: ListFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
