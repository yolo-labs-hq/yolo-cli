/**
 * Container ambient context resolver for the substrate CLI.
 *
 * Reads the Round 5 env trio (`SESSION_ID`, `YOLO_COMMON_API_URL`,
 * `INTERNAL_API_KEY`) and exposes a typed result. Exits with
 * `session-required` (exit code 78 = EX_CONFIG) if `SESSION_ID` is
 * missing — outside-container invocation is out of scope for v1.
 *
 * `WORKSPACE_ID` is read for display purposes (operators want a
 * fast "what workspace is this" answer in `yolo context`).
 * The authoritative workspaceId for any *write* still comes from
 * the session record at token-mint time — that's what the CLI's
 * `--workspace` sanity check is comparing against. So
 * `WORKSPACE_ID` is best-effort env state, not the source of
 * truth, but in practice the session container sets both
 * consistently from the same source.
 */

export interface SessionContext {
  sessionId: string;
  commonApiUrl: string;
  internalApiKeyPresent: boolean;
  workspaceIdHint: string | null;
}

export class ContextResolutionError extends Error {
  readonly exitCode: number;
  constructor(message: string, exitCode: number) {
    super(message);
    this.name = 'ContextResolutionError';
    this.exitCode = exitCode;
  }
}

export function readSessionContext(): SessionContext {
  const sessionId = process.env.SESSION_ID;
  if (!sessionId || sessionId.length === 0) {
    throw new ContextResolutionError(
      'session-required: SESSION_ID env var is empty or missing. The substrate CLI requires a Studio container session; outside-container invocation is out of scope for v1.',
      78,
    );
  }

  const commonApiUrl = process.env.YOLO_COMMON_API_URL || process.env.YOLO_API_URL;
  if (!commonApiUrl || commonApiUrl.length === 0) {
    throw new ContextResolutionError(
      'session-required: YOLO_COMMON_API_URL env var is empty or missing.',
      78,
    );
  }

  const internalApiKey = process.env.INTERNAL_API_KEY;
  return {
    sessionId,
    commonApiUrl,
    internalApiKeyPresent: !!internalApiKey && internalApiKey.length > 0,
    workspaceIdHint: process.env.WORKSPACE_ID ?? null,
  };
}

export function formatContext(ctx: SessionContext): string {
  // The "(unset)" branch is for the rare-but-possible case where
  // SESSION_ID is set but WORKSPACE_ID isn't — substrate ops will
  // still work (mint resolves workspace from the session record),
  // they just can't be sanity-checked against ambient env.
  const workspace = ctx.workspaceIdHint ?? '(unset — will resolve from session at mint time)';
  return [
    'yolo substrate CLI — context',
    `  sessionId          ${ctx.sessionId}`,
    `  commonApiUrl       ${ctx.commonApiUrl}`,
    `  internalApiKey     ${ctx.internalApiKeyPresent ? '(set)' : '(missing)'}`,
    `  workspaceId        ${workspace}`,
    '',
  ].join('\n');
}
