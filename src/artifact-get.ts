/**
 * `yolo artifact get <key>` — fetch a single artifact version.
 *
 * Returns the latest version by default; `--version <n>` pins to a
 * specific version. Default summary renders metadata only (key,
 * version, type, producer, fingerprint, contentLength, createdAt).
 * `--content` flag emits ONLY the artifact content body to stdout
 * (suitable for piping). `--json` emits the full record including
 * content.
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = http (artifact not found, etc.)
 *   - 64 = usage (bad key, bad --version, missing env trio,
 *          --workspace mismatch, --content + --json conflict)
 */

import {
  type FetchLike,
  SUBSTRATE_CLI_ARTIFACT_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface ArtifactGetOptions {
  key: string;
  /** Optional pin to a specific version. If omitted, latest is returned. */
  version?: number;
  workspaceFlag?: string;
  /**
   * 'json'    = pretty-print the full response (including content).
   * 'summary' = metadata-only header (default).
   * 'content' = stdout the raw artifact body (for piping).
   */
  outputFormat?: 'json' | 'summary' | 'content';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface ArtifactGetSuccess {
  ok: true;
  output: string;
  artifact: GetArtifactResponse;
  workspaceId: string;
}

export interface ArtifactGetFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type ArtifactGetResult = ArtifactGetSuccess | ArtifactGetFailure;

interface GetArtifactResponse {
  key: string;
  version: number;
  artifactType: string;
  contentLength: number;
  content: string;
  producedByAgentId: string;
  producedByTileId: string | null;
  producerType: string | null;
  producerId: string | null;
  fingerprint: string | null;
  refPath: string | null;
  meta: Record<string, unknown> | null;
  createdAt: string;
}

// ─── Public entry ─────────────────────────────────────────────────────────

const ARTIFACT_KEY_REGEX = /^[a-z0-9][a-z0-9/_.\-]{0,127}$/;

export async function runArtifactGet(options: ArtifactGetOptions): Promise<ArtifactGetResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';

  if (!ARTIFACT_KEY_REGEX.test(options.key)) {
    return fail(
      'usage',
      `invalid artifact key '${options.key}': must match /^[a-z0-9][a-z0-9/_.\\-]{0,127}$/`,
    );
  }
  if (options.version !== undefined) {
    if (!Number.isInteger(options.version) || options.version < 1) {
      return fail('usage', `invalid --version '${options.version}': must be a positive integer`);
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
  const path = options.version !== undefined
    ? `/workspaces/${mint.workspaceId}/artifacts/${encodeURIComponent(options.key)}?version=${options.version}`
    : `/workspaces/${mint.workspaceId}/artifacts/${encodeURIComponent(options.key)}`;
  const response = await authenticatedRequest(ctx, path, { method: 'GET' });
  if (!response.ok) {
    const text = await safeReadText(response);
    return fail('http', `work.get_artifact failed: HTTP ${response.status} — ${text}`, { status: response.status });
  }
  const artifact = (await response.json()) as GetArtifactResponse;
  if (typeof artifact.key !== 'string' || typeof artifact.version !== 'number') {
    return fail('http', 'work.get_artifact response missing required fields');
  }

  let output: string;
  if (format === 'json') output = formatJson(artifact);
  else if (format === 'content') output = artifact.content;
  else output = formatSummary(artifact, mint.workspaceId);

  return { ok: true, output, artifact, workspaceId: mint.workspaceId };
}

// ─── Output formatting ────────────────────────────────────────────────────

/**
 * Header with metadata — no content body. The producer block tells
 * the operator who emitted the artifact (agent + tile) and provenance
 * fingerprint for cross-run identity.
 */
export function formatSummary(artifact: GetArtifactResponse, workspaceId: string): string {
  const lines: string[] = [];
  lines.push(`Artifact ${artifact.key} v${artifact.version} (workspace ${workspaceId})`);
  lines.push(`  type:           ${artifact.artifactType}`);
  lines.push(`  contentLength:  ${artifact.contentLength}`);
  lines.push(`  producedBy:     ${artifact.producedByAgentId}${artifact.producedByTileId ? ` (tile ${artifact.producedByTileId})` : ''}`);
  if (artifact.producerType) lines.push(`  producerType:   ${artifact.producerType}`);
  if (artifact.producerId) lines.push(`  producerId:     ${artifact.producerId}`);
  if (artifact.fingerprint) lines.push(`  fingerprint:    ${artifact.fingerprint}`);
  if (artifact.refPath) lines.push(`  refPath:        ${artifact.refPath}`);
  lines.push(`  createdAt:      ${artifact.createdAt}`);
  return lines.join('\n');
}

function formatJson(artifact: GetArtifactResponse): string {
  return JSON.stringify(artifact, null, 2);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: ArtifactGetFailure['kind'], message: string, detail?: Record<string, unknown>): ArtifactGetFailure {
  return { ok: false, kind, message, detail };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try { return await response.text(); } catch { return '<no body>'; }
}

export function exitCodeForFailure(kind: ArtifactGetFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
