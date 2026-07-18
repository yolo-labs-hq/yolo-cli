/**
 * `yolo mcp scopes` — inspect what the current session principal can mint.
 *
 * Calls GET /internal/mcp/scopes (a pure read — nothing is minted) with the
 * user JWT, the same auth contract as the token mint the CLI already uses
 * (`mintSubstrateToken`). The server partitions ALL known MCP scopes by the
 * agent's registry `allowedScopes` and returns
 * `{ agentId, allowed: [...], denied: [...] }`.
 *
 * `--agent <agentId>` inspects another HTTP-mintable agent identity
 * (default: substrate-cli, the CLI's own principal).
 *
 * Exit codes: 0 success · 1 http · 64 usage/auth.
 */

import { resolveSubstrateContext } from './auth-context.js';
import { SUBSTRATE_CLI_AGENT_ID, type FetchLike } from './work-client.js';

export interface McpScopesOptions {
  /** Agent identity to inspect. Default: substrate-cli. */
  agentId?: string;
  outputFormat?: 'json' | 'summary';
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface McpScopesSuccess {
  ok: true;
  output: string;
  agentId: string;
  allowed: string[];
  denied: string[];
}

export interface McpScopesFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type McpScopesResult = McpScopesSuccess | McpScopesFailure;

export async function runMcpScopes(options: McpScopesOptions): Promise<McpScopesResult> {
  const env = options.env ?? process.env;
  const format = options.outputFormat ?? 'summary';
  const agentId = options.agentId ?? SUBSTRATE_CLI_AGENT_ID;

  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return fail('auth', auth.message);
  const { sessionId, commonApiUrl, userToken } = auth.context;

  const fetchImpl = options.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const base = commonApiUrl.replace(/\/$/, '');
  const url = `${base}/internal/mcp/scopes?sessionId=${encodeURIComponent(sessionId)}&agentId=${encodeURIComponent(agentId)}`;

  let json: { agentId?: string; allowed?: unknown; denied?: unknown };
  try {
    const response = await fetchImpl(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${userToken}` },
    });
    if (!response.ok) {
      const text = await safeReadText(response);
      return fail('http', `mcp.scopes failed: HTTP ${response.status} — ${text}`, { status: response.status });
    }
    json = (await response.json()) as typeof json;
  } catch (err) {
    return fail('http', `mcp.scopes request failed: ${describeError(err)}`);
  }

  if (!Array.isArray(json.allowed) || !Array.isArray(json.denied)) {
    return fail('http', 'mcp.scopes response missing `allowed`/`denied` arrays');
  }
  const allowed = (json.allowed as unknown[]).filter((s): s is string => typeof s === 'string');
  const denied = (json.denied as unknown[]).filter((s): s is string => typeof s === 'string');
  const resolvedAgentId = typeof json.agentId === 'string' && json.agentId ? json.agentId : agentId;

  return {
    ok: true,
    output: format === 'json'
      ? JSON.stringify({ agentId: resolvedAgentId, allowed, denied }, null, 2)
      : formatSummary(resolvedAgentId, sessionId, allowed, denied),
    agentId: resolvedAgentId,
    allowed,
    denied,
  };
}

// ── Output formatting ─────────────────────────────────────────────────────

export function formatSummary(agentId: string, sessionId: string, allowed: string[], denied: string[]): string {
  const lines: string[] = [];
  lines.push(`Mintable MCP scopes for agent '${agentId}' (session ${sessionId}):`);
  lines.push(`Allowed (${allowed.length}):`);
  lines.push(...(allowed.length > 0 ? allowed.map((s) => `  - ${s}`) : ['  (none)']));
  lines.push(`Not mintable (${denied.length}):`);
  lines.push(...(denied.length > 0 ? denied.map((s) => `  - ${s}`) : ['  (none)']));
  return lines.join('\n');
}

// ── Helpers ───────────────────────────────────────────────────────────────

function fail(kind: McpScopesFailure['kind'], message: string, detail?: Record<string, unknown>): McpScopesFailure {
  return { ok: false, kind, message, detail };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try { return await response.text(); } catch { return '<no body>'; }
}

export function exitCodeForFailure(kind: McpScopesFailure['kind']): number {
  return kind === 'http' ? 1 : 64;
}
