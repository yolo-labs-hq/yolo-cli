/**
 * `yolo artifact list` — enumerate workspace artifacts (newest-first).
 *
 * Default summary is a table per artifact: key, latest version,
 * artifactType, latestTimestamp. `--prefix <prefix>` server-side
 * filters by key prefix; `--limit <n>` caps result count (1-500,
 * default 100). `--json` emits the raw `artifacts[]` array.
 *
 * Exit codes:
 *   - 0  = success (zero artifacts is also success — empty list,
 *          not an error)
 *   - 1  = http (server error, etc.)
 *   - 64 = usage (bad --limit, missing env, --workspace mismatch)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_ARTIFACT_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface ArtifactListOptions {
  workspaceFlag?: string;
  /** Server-side filter on artifact key prefix. */
  prefix?: string;
  /** 1-500. Default 100 (matches the server cap). */
  limit?: number;
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface ArtifactListEntry {
  key: string;
  latestVersion: number;
  artifactType: string;
  latestTimestamp: string;
}

export interface ArtifactListSuccess {
  ok: true;
  output: string;
  artifacts: ArtifactListEntry[];
  workspaceId: string;
}

export interface ArtifactListFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type ArtifactListResult = ArtifactListSuccess | ArtifactListFailure;

// ─── Public entry ─────────────────────────────────────────────────────────

export async function runArtifactList(options: ArtifactListOptions): Promise<ArtifactListResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (options.limit !== undefined) {
    if (!Number.isInteger(options.limit) || options.limit < 1 || options.limit > 500) {
      return fail('usage', `invalid --limit '${options.limit}': must be an integer between 1 and 500`);
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
      scopes: SUBSTRATE_CLI_ARTIFACT_SCOPES,
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
  const params: string[] = [];
  if (options.prefix) params.push(`prefix=${encodeURIComponent(options.prefix)}`);
  if (options.limit !== undefined) params.push(`limit=${options.limit}`);
  const query = params.length > 0 ? `?${params.join('&')}` : '';
  const path = `/workspaces/${mint.workspaceId}/artifacts${query}`;
  const response = await authenticatedRequest(ctx, path, { method: 'GET' });
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.list_artifacts failed: HTTP ${response.status} — ${text}`, {
      status: response.status,
    });
  }
  const json = (await response.json()) as { artifacts?: ArtifactListEntry[] };
  if (!Array.isArray(json.artifacts)) {
    return fail('http', 'work.list_artifacts response missing `artifacts` array');
  }

  return {
    ok: true,
    output: format === 'json'
      ? formatJson(json.artifacts)
      : formatSummary(json.artifacts, mint.workspaceId, options.prefix),
    artifacts: json.artifacts,
    workspaceId: mint.workspaceId,
  };
}

// ─── Output formatting ────────────────────────────────────────────────────

/**
 * Header + table row per artifact. Columns auto-pad to longest key
 * and artifactType. Empty workspace renders "(no artifacts)" rather
 * than just a header.
 */
export function formatSummary(
  artifacts: ArtifactListEntry[],
  workspaceId: string,
  prefix?: string,
): string {
  const lines: string[] = [];
  const filterTag = prefix ? ` (prefix: ${prefix})` : '';
  lines.push(`Artifacts in workspace ${workspaceId}${filterTag}: ${artifacts.length}`);

  if (artifacts.length === 0) {
    lines.push('  (no artifacts)');
    return lines.join('\n');
  }

  const keyCol = Math.max(3, ...artifacts.map((a) => a.key.length));
  const typeCol = Math.max(4, ...artifacts.map((a) => a.artifactType.length));

  lines.push(
    `  ${'key'.padEnd(keyCol)}  v#     ${'type'.padEnd(typeCol)}  latestTimestamp`,
  );
  for (const a of artifacts) {
    const key = a.key.padEnd(keyCol);
    const v = `v${a.latestVersion}`.padEnd(5);
    const type = a.artifactType.padEnd(typeCol);
    lines.push(`  ${key}  ${v}  ${type}  ${a.latestTimestamp}`);
  }
  return lines.join('\n');
}

function formatJson(artifacts: ArtifactListEntry[]): string {
  return JSON.stringify(artifacts, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: ArtifactListFailure['kind'], message: string, detail?: Record<string, unknown>): ArtifactListFailure {
  return { ok: false, kind, message, detail };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try { return await response.text(); } catch { return '<no body>'; }
}

export function exitCodeForFailure(kind: ArtifactListFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
