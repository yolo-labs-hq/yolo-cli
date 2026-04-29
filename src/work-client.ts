/**
 * Work client (Phase 8a Group 9 scaffold).
 *
 * Stub for the substrate CLI's session-bound mint + Work-route
 * caller. Full implementation lands in Phase 8c with
 * `yolo plan import/export/validate`.
 *
 * Auth flow when implemented (Round 5 design):
 *   1. POST {commonApiUrl}/internal/mcp/tokens
 *      Headers: X-Internal-Auth: ${INTERNAL_API_KEY}
 *      Body:    { sessionId, agentId: 'substrate-cli', scopes: [...] }
 *      → returns delegated JWT bound to the session's workspaceId.
 *   2. Call /internal/work/* with both X-Internal-Auth and
 *      Authorization: Bearer <delegated JWT>.
 *
 * v1 substrate scopes (capped per agents.json substrate-cli entry):
 *   - work.create_plan
 *   - work.update_plan
 *   - work.get_plan
 *   - work.list_plans
 */

export const SUBSTRATE_CLI_AGENT_ID = 'substrate-cli';

export const SUBSTRATE_CLI_PLAN_SCOPES = [
  'work.create_plan',
  'work.update_plan',
  'work.get_plan',
  'work.list_plans',
] as const;

export interface MintTokenOptions {
  commonApiUrl: string;
  internalApiKey: string;
  sessionId: string;
  scopes: ReadonlyArray<string>;
}

export interface MintTokenResult {
  token: string;
  expiresAt: string;
}

/**
 * Phase 8c TODO: implement against the existing
 * `POST /internal/mcp/tokens` endpoint. v1 stub throws so any
 * accidental early call surfaces clearly.
 */
export async function mintSubstrateToken(_options: MintTokenOptions): Promise<MintTokenResult> {
  throw new Error('mintSubstrateToken is not implemented yet — lands in Phase 8c');
}
