/**
 * `yolo plan open <planId>` — print the webapp Plan-DAG URL for the
 * given Plan in the calling session's workspace.
 *
 * Mints a substrate token to get the workspaceId, calls work.get_plan
 * just to confirm the Plan exists (so a typo'd planId surfaces an
 * `http` error instead of printing a URL that 404s in the browser),
 * then prints the URL. No file I/O, no canonicalization, no Run.
 *
 * Output modes:
 *   - default: prints the URL on a single line — handy for piping
 *     into clipboard tools or `open`.
 *   - `--json`: emits `{ ok, planId, workspaceId, url }`.
 *
 * Exit codes (via the CLI wrapper):
 *   - 0  = success
 *   - 1  = http (plan not found, etc.)
 *   - 64 = usage error (bad planId, missing env trio, --workspace
 *          mismatch, derivation failed)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_PLAN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';
import { planDagUrl } from './webapp-url.js';

export interface OpenOptions {
  planId: string;
  workspaceFlag?: string;
  outputFormat?: 'text' | 'json';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface OpenSuccess {
  ok: true;
  planId: string;
  workspaceId: string;
  url: string;
  /** Pretty text the CLI writes to stdout in --text mode. */
  output: string;
}

export interface OpenFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type OpenResult = OpenSuccess | OpenFailure;

const PLAN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export async function runPlanOpen(options: OpenOptions): Promise<OpenResult> {
  const env = options.env ?? process.env;

  if (!PLAN_ID_REGEX.test(options.planId)) {
    return fail(
      'usage',
      `invalid planId '${options.planId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`,
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
      scopes: SUBSTRATE_CLI_PLAN_SCOPES,
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

  // Existence check — keeps the CLI honest about typo'd planIds.
  // Cheaper than fetching the full plan: just rely on the HTTP status.
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

  const url = planDagUrl(env, mint.workspaceId, options.planId);
  if (!url) {
    return fail(
      'usage',
      'could not derive webapp URL from YOLO_COMMON_API_URL — set YOLO_WEBAPP_URL to override.',
    );
  }

  return {
    ok: true,
    planId: options.planId,
    workspaceId: mint.workspaceId,
    url,
    output: url,
  };
}

function fail(kind: OpenFailure['kind'], message: string, detail?: Record<string, unknown>): OpenFailure {
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

export function exitCodeForFailure(kind: OpenFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
