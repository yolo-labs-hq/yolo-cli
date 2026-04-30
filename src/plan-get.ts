/**
 * `yolo plan get <planId>` — read a Plan from the substrate.
 *
 * The thinnest of the three workflow commands. No file I/O, no
 * lockfile mutation, no canonicalization. Mints a session-bound
 * delegated token (work.get_plan scope) and prints the plan.
 *
 * Two output modes:
 *   - default (`--summary`): one-line plan header + per-step rows
 *     with stepId, mode, and dependency stepIds. Good for an
 *     operator's "is the import what I expected" sanity check.
 *   - `--json`: pretty-printed `work.get_plan` response. Useful in
 *     pipelines / for `jq` consumers.
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (plan not found, etc.)
 *   - 64 = usage error (bad planId, missing env trio,
 *          --workspace mismatch)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_PLAN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface GetOptions {
  planId: string;
  workspaceFlag?: string;
  /**
   * 'json' = pretty-print the raw response. 'summary' = one-line
   * header + per-step rows. Default 'summary'.
   */
  outputFormat?: 'json' | 'summary';
  /** Test-injectable fetch. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Test-injectable env reader. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
}

export interface GetSuccess {
  ok: true;
  /** Pretty-printed text the CLI writes to stdout. */
  output: string;
  /** Raw plan response — useful for tests / future scripting. */
  plan: GetPlanResponse;
  workspaceId: string;
}

export interface GetFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type GetResult = GetSuccess | GetFailure;

interface GetPlanResponse {
  planId: string;
  name: string;
  description?: string | null;
  authoringState: 'draft' | 'active' | 'archived';
  version: number;
  inputs?: unknown[];
  failurePolicy?: string;
  autoRetryCap?: number | null;
  autoRetryFallback?: string | null;
  integrationPolicy?: Record<string, unknown> | null;
  steps: Array<{
    stepId: string;
    name?: string;
    mode?: string;
    gates?: Array<{ gateId: string; type: string; config?: Record<string, unknown> }>;
  }>;
  latestRunId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

// ─── Public entry ─────────────────────────────────────────────────────────

const PLAN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export async function runPlanGet(options: GetOptions): Promise<GetResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  // 1) planId shape (matches substrate's PLAN_ID_REGEX)
  if (!PLAN_ID_REGEX.test(options.planId)) {
    return fail(
      'usage',
      `invalid planId '${options.planId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`,
    );
  }

  // 2) Substrate context
  const sessionId = env.SESSION_ID;
  const internalApiKey = env.INTERNAL_API_KEY;
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!sessionId) return fail('auth', 'SESSION_ID env var is required (substrate CLI is container-only in v1)');
  if (!internalApiKey) return fail('auth', 'INTERNAL_API_KEY env var is required');
  if (!commonApiUrl) return fail('auth', 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required');

  // 3) Mint token
  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
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

  // 5) work.get_plan
  const ctx = {
    commonApiUrl,
    internalApiKey,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };
  const response = await authenticatedRequest(
    ctx,
    `/workspaces/${mint.workspaceId}/plans/${options.planId}`,
    { method: 'GET' },
  );
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.get_plan failed: HTTP ${response.status} — ${text}`, { status: response.status });
  }
  const json = (await response.json()) as { plan?: GetPlanResponse };
  if (!json.plan) {
    return fail('http', 'work.get_plan response missing `plan` field');
  }

  return {
    ok: true,
    output: format === 'json' ? formatJson(json.plan) : formatSummary(json.plan, mint.workspaceId),
    plan: json.plan,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

/**
 * One-line header + per-step rows. Each row: `<stepId> (<mode>)`
 * with `← deps: <predId1>, <predId2>` if the step has dependency
 * gates. Matches the substrate's actual gate shape (single
 * `config.stepId` per dependency gate, per gate-readiness.ts:180);
 * one row per step lists ALL its dependency-gate stepIds.
 */
export function formatSummary(plan: GetPlanResponse, workspaceId: string): string {
  const lines: string[] = [];
  lines.push(
    `Plan '${plan.planId}' (workspace ${workspaceId}, version ${plan.version}, ${plan.authoringState})`,
  );
  if (plan.failurePolicy) lines.push(`  failurePolicy: ${plan.failurePolicy}`);
  if (typeof plan.autoRetryCap === 'number') lines.push(`  autoRetryCap: ${plan.autoRetryCap}`);
  const inputCount = Array.isArray(plan.inputs) ? plan.inputs.length : 0;
  lines.push(`  inputs: ${inputCount}`);
  lines.push(`  steps: ${plan.steps.length}`);
  for (const step of plan.steps) {
    const deps: string[] = [];
    for (const gate of step.gates ?? []) {
      if (gate.type === 'dependency') {
        const predId = (gate.config as { stepId?: unknown } | undefined)?.stepId;
        if (typeof predId === 'string') deps.push(predId);
      }
    }
    const depTag = deps.length > 0 ? `  ← deps: ${deps.join(', ')}` : '';
    lines.push(`    - ${step.stepId} (${step.mode ?? '?'})${depTag}`);
  }
  return lines.join('\n');
}

function formatJson(plan: GetPlanResponse): string {
  return JSON.stringify(plan, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: GetFailure['kind'], message: string, detail?: Record<string, unknown>): GetFailure {
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

export function exitCodeForFailure(kind: GetFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
