/**
 * `yolo plan get <planId>` — read a Plan from the substrate.
 *
 * The thinnest of the three workflow commands. No file I/O, no
 * lockfile mutation, no canonicalization. Mints a session-bound
 * delegated token (work.get_plan scope) and prints the plan.
 *
 * Three output modes:
 *   - default (`--summary`): one-line plan header + per-step rows
 *     in declared order, with stepId, mode, and dependency
 *     stepIds. Good for an operator's "is the import what I
 *     expected" sanity check.
 *   - `--waves`: same header, but steps grouped by topological
 *     wave (computed from dependency gates). A wave is the set of
 *     steps whose dependencies are all satisfied by earlier waves;
 *     a step's wave is `1 + max(wave of any dependency)`. Good for
 *     "what runs in parallel at each stage" reading.
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
import { resolveSubstrateContext } from './auth-context.js';
import { planDagUrl } from './webapp-url.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface GetOptions {
  planId: string;
  workspaceFlag?: string;
  /**
   * 'json'    = pretty-print the raw response.
   * 'summary' = one-line header + per-step rows in declared order.
   * 'waves'   = same header + steps grouped by topological wave.
   * Default 'summary'.
   */
  outputFormat?: 'json' | 'summary' | 'waves';
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
  state: 'draft' | 'active' | 'archived';
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
  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return fail('auth', auth.message);
  const { sessionId, commonApiUrl, userToken } = auth.context;

  // 3) Mint token
  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      userToken,
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

  let output: string;
  if (format === 'json') output = formatJson(json.plan);
  else if (format === 'waves') output = formatWaves(json.plan, mint.workspaceId, env);
  else output = formatSummary(json.plan, mint.workspaceId, env);

  return {
    ok: true,
    output,
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
export function formatSummary(
  plan: GetPlanResponse,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const lines: string[] = [];
  lines.push(
    `Plan '${plan.planId}' (workspace ${workspaceId}, version ${plan.version}, ${plan.state})`,
  );
  const dagUrl = planDagUrl(env, workspaceId, plan.planId);
  if (dagUrl) lines.push(`  view: ${dagUrl}`);
  if (plan.failurePolicy) lines.push(`  failurePolicy: ${plan.failurePolicy}`);
  if (typeof plan.autoRetryCap === 'number') lines.push(`  autoRetryCap: ${plan.autoRetryCap}`);
  const inputCount = Array.isArray(plan.inputs) ? plan.inputs.length : 0;
  lines.push(`  inputs: ${inputCount}`);
  lines.push(`  steps: ${plan.steps.length}`);
  for (const step of plan.steps) {
    const deps = depStepIds(step);
    const depTag = deps.length > 0 ? `  ← deps: ${deps.join(', ')}` : '';
    lines.push(`    - ${step.stepId} (${step.mode ?? '?'})${depTag}`);
  }
  return lines.join('\n');
}

/**
 * Wave-grouped renderer. Same header as formatSummary, then steps
 * grouped by their topological wave. Within a wave, step order
 * matches the declared order in `plan.steps` so output is stable
 * across runs.
 *
 * Defensive on bad shapes the substrate would normally reject:
 * unknown predecessor stepIds collapse to wave 1, cycles short-circuit
 * to wave 1 for the visiting node (so we never recurse forever).
 */
export function formatWaves(
  plan: GetPlanResponse,
  workspaceId: string,
  env: Record<string, string | undefined> = process.env,
): string {
  const lines: string[] = [];
  lines.push(
    `Plan '${plan.planId}' (workspace ${workspaceId}, version ${plan.version}, ${plan.state})`,
  );
  const dagUrl = planDagUrl(env, workspaceId, plan.planId);
  if (dagUrl) lines.push(`  view: ${dagUrl}`);
  if (plan.failurePolicy) lines.push(`  failurePolicy: ${plan.failurePolicy}`);
  if (typeof plan.autoRetryCap === 'number') lines.push(`  autoRetryCap: ${plan.autoRetryCap}`);
  const inputCount = Array.isArray(plan.inputs) ? plan.inputs.length : 0;
  lines.push(`  inputs: ${inputCount}`);

  const waves = computeWaves(plan.steps);
  const waveCount = waves.length;
  const stepWord = plan.steps.length === 1 ? 'step' : 'steps';
  lines.push(`  steps: ${plan.steps.length} ${stepWord} in ${waveCount} ${waveCount === 1 ? 'wave' : 'waves'}`);
  lines.push('');

  for (let i = 0; i < waves.length; i++) {
    const stepsInWave = waves[i]!;
    const count = stepsInWave.length;
    const parallelTag = count > 1 ? ', parallel' : '';
    lines.push(`  Wave ${i + 1} (${count} ${count === 1 ? 'step' : 'steps'}${parallelTag}):`);
    for (const step of stepsInWave) {
      const deps = depStepIds(step);
      const depTag = deps.length > 0 ? `  ← deps: ${deps.join(', ')}` : '';
      lines.push(`    - ${step.stepId} (${step.mode ?? '?'})${depTag}`);
    }
  }
  return lines.join('\n');
}

/**
 * Topological wave grouping. Returns an array of arrays — index 0 is
 * wave 1, index 1 is wave 2, etc. Within each wave, steps appear in
 * the order they were declared in `plan.steps`.
 */
function computeWaves(
  steps: GetPlanResponse['steps'],
): GetPlanResponse['steps'][number][][] {
  const stepById = new Map<string, GetPlanResponse['steps'][number]>();
  for (const s of steps) stepById.set(s.stepId, s);

  const waveOfStep = new Map<string, number>();
  const waveOf = (stepId: string, visiting: Set<string>): number => {
    const cached = waveOfStep.get(stepId);
    if (cached !== undefined) return cached;
    const step = stepById.get(stepId);
    if (!step) return 1; // unknown predecessor — substrate rejects on import
    visiting.add(stepId);
    let max = 0;
    for (const dep of depStepIds(step)) {
      if (!stepById.has(dep)) continue; // unknown predecessor → ignore
      if (visiting.has(dep)) continue; // cycle: ignore the back-edge
      const w = waveOf(dep, visiting);
      if (w > max) max = w;
    }
    visiting.delete(stepId);
    const wave = max + 1;
    waveOfStep.set(stepId, wave);
    return wave;
  };

  for (const s of steps) waveOf(s.stepId, new Set());

  const grouped: GetPlanResponse['steps'][number][][] = [];
  for (const s of steps) {
    const w = waveOfStep.get(s.stepId) ?? 1;
    while (grouped.length < w) grouped.push([]);
    grouped[w - 1]!.push(s);
  }
  return grouped;
}

function depStepIds(step: GetPlanResponse['steps'][number]): string[] {
  const out: string[] = [];
  for (const gate of step.gates ?? []) {
    if (gate.type === 'dependency') {
      const predId = (gate.config as { stepId?: unknown } | undefined)?.stepId;
      if (typeof predId === 'string') out.push(predId);
    }
  }
  return out;
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
