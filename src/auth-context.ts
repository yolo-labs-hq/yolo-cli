/**
 * Substrate CLI auth-context resolution (AUTH_AND_ONBOARDING Slice 0).
 *
 * The CLI used to require `INTERNAL_API_KEY` — the service-to-service
 * master key — from the shell env to mint delegated tokens. That key
 * should never live in a user-controlled shell. This module resolves a
 * **user access JWT** as the preferred credential and keeps the
 * internal key only as a fallback for genuine service callers
 * (lane-runner) and during the transition.
 *
 * Token precedence:
 *   1. `~/.config/yolo/token` — the rotated user JWT, rewritten every
 *      ~10 min by container-api's yolo-token-refresh. Reading the FILE
 *      (not the `YOLO_API_TOKEN` env var) sidesteps the stale-shell
 *      problem: a long-lived shell holds whatever token was in scope at
 *      its own launch, but the file is always fresh.
 *   2. `YOLO_API_TOKEN` env — the pod-injected user JWT (≤24h TTL).
 *   3. `INTERNAL_API_KEY` env — service master key fallback.
 *
 * Auth requires SESSION_ID + a common-api URL + at least one credential.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SubstrateContext {
  sessionId: string;
  commonApiUrl: string;
  /** Preferred credential: the user's rotated access JWT. */
  userToken?: string;
  /** Fallback credential: the service master key. */
  internalApiKey?: string;
}

export type ResolveResult =
  | { ok: true; context: SubstrateContext }
  | { ok: false; message: string };

/** Injectable file reader so unit tests don't touch the real FS. */
export type ReadFileImpl = (filePath: string) => string | undefined;

export function resolveSubstrateContext(
  env: Record<string, string | undefined>,
  readFileImpl: ReadFileImpl = defaultReadFile,
): ResolveResult {
  const sessionId = env.SESSION_ID;
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!sessionId) {
    return { ok: false, message: 'SESSION_ID env var is required (substrate CLI is container-only in v1)' };
  }
  if (!commonApiUrl) {
    return { ok: false, message: 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required' };
  }

  const userToken = resolveUserToken(env, readFileImpl);
  const internalApiKey = env.INTERNAL_API_KEY;
  if (!userToken && !internalApiKey) {
    return {
      ok: false,
      message:
        'no credential available: expected a user token (~/.config/yolo/token or YOLO_API_TOKEN) or INTERNAL_API_KEY in the environment',
    };
  }

  // When a user token wins, it is the SOLE credential — do not also carry
  // INTERNAL_API_KEY. Otherwise authenticatedRequest would send
  // X-Internal-Auth alongside the bearer, and requireMcpAuth rejects a
  // present-but-wrong service key BEFORE checking the JWT — so a stale or
  // wrong INTERNAL_API_KEY in the shell would mint fine (via the JWT) then
  // 401 every subsequent work call. (codex P2)
  if (userToken) {
    return { ok: true, context: { sessionId, commonApiUrl, userToken } };
  }
  return { ok: true, context: { sessionId, commonApiUrl, internalApiKey } };
}

export function resolveUserToken(
  env: Record<string, string | undefined>,
  readFileImpl: ReadFileImpl = defaultReadFile,
): string | undefined {
  const home = env.HOME || os.homedir();
  const tokenFile = path.join(home, '.config', 'yolo', 'token');
  const fromFile = readFileImpl(tokenFile);
  if (fromFile && fromFile.trim()) return fromFile.trim();
  const fromEnv = env.YOLO_API_TOKEN;
  if (fromEnv && fromEnv.trim()) return fromEnv.trim();
  return undefined;
}

function defaultReadFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
