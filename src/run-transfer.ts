/**
 * `yolo run transfer <runId> --to <agentId>` — change a Run's bound
 * Operator. The handoff verb that closes the loop on the lifecycle
 * slice's operator-binding implication.
 *
 * Natural use case: `yolo run start <planId>` makes substrate-cli
 * the Operator; `yolo run transfer <runId> --to claude` hands the
 * Run off to claude/codex for actual execution. The route's R4
 * matrix permits self-transfer (current Operator → new agent),
 * claim-user-driven (taking over a Run with operatorAgentId=null),
 * and force-transfer of an unresponsive Operator.
 *
 * Target validation: the route enforces `isValidOperatorTarget` —
 * target must be in OPERATOR_TIER_AGENT_IDS (claude, codex) or
 * null (user-driven). Substrate-cli is NOT Operator-tier, so
 * `--to substrate-cli` always fails at the route layer with 403
 * NOT_AUTHORIZED + reason=invalid_transfer_target.
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (404, 403 NOT_AUTHORIZED, 409 INVALID_STATE, 5xx)
 *   - 64 = usage (bad runId, missing env trio, --workspace mismatch,
 *          --to + --user-driven mutex violation, missing target)
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

export interface RunTransferOptions {
  planRunId: string;
  /**
   * Target agent. Use `null` for user-driven (route accepts null
   * explicitly; bare omission is rejected by the route per its
   * v1 contract — caller can't accidentally clear the binding).
   */
  newOperatorAgentId: string | null;
  workspaceFlag?: string;
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface RunTransferSuccess {
  ok: true;
  output: string;
  response: TransferResponse;
  workspaceId: string;
}

export interface RunTransferFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type RunTransferResult = RunTransferSuccess | RunTransferFailure;

interface TransferResponse {
  planRunId: string;
  // Item 16 — `operatorAgentId` mirrors `primaryOperator` for
  // backwards-compat single-operator readers. `operatorCount`
  // replaces the legacy `operatorHistoryLength` field (since
  // operators[] is the audit trail itself, not a per-binding
  // linked list).
  operatorAgentId: string | null;
  primaryOperator?: string | null;
  operatorCount?: number;
}

// ─── Public entry ─────────────────────────────────────────────────────────

const PLAN_RUN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}$/;
const AGENT_ID_MAX_LEN = 128;

export async function runRunTransfer(options: RunTransferOptions): Promise<RunTransferResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (!PLAN_RUN_ID_REGEX.test(options.planRunId)) {
    return fail(
      'usage',
      `invalid planRunId '${options.planRunId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,191}$/`,
    );
  }

  // Target must be a non-empty string ≤128 chars or explicit null.
  // Mirrors the route's pre-store check so we fail fast without a
  // network round-trip.
  if (
    options.newOperatorAgentId !== null &&
    (typeof options.newOperatorAgentId !== 'string' ||
      options.newOperatorAgentId.length === 0 ||
      options.newOperatorAgentId.length > AGENT_ID_MAX_LEN)
  ) {
    return fail(
      'usage',
      `newOperatorAgentId must be a non-empty string ≤${AGENT_ID_MAX_LEN} chars or null`,
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
  const response = await authenticatedRequest(
    ctx,
    `/workspaces/${mint.workspaceId}/runs/${options.planRunId}/operator/transfer`,
    { method: 'POST', jsonBody: { newOperatorAgentId: options.newOperatorAgentId } },
  );
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.transfer_run_operator failed: HTTP ${response.status} — ${text}`, {
      status: response.status,
    });
  }
  const json = (await response.json()) as TransferResponse;
  if (typeof json.planRunId !== 'string') {
    return fail('http', 'work.transfer_run_operator response missing planRunId');
  }

  return {
    ok: true,
    output: format === 'json' ? formatJson(json) : formatSummary(json),
    response: json,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

export function formatSummary(response: TransferResponse): string {
  const target = response.operatorAgentId === null
    ? 'user-driven (primaryOperator=null)'
    : response.operatorAgentId;
  // operatorCount surfaces the size of the additive operators[];
  // the legacy operatorHistoryLength was removed in item 16.
  const count = response.operatorCount ?? 0;
  return `OK: transferred run ${response.planRunId} primary to ${target} (operatorCount=${count})`;
}

function formatJson(response: TransferResponse): string {
  return JSON.stringify(response, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: RunTransferFailure['kind'], message: string, detail?: Record<string, unknown>): RunTransferFailure {
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

export function exitCodeForFailure(kind: RunTransferFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
