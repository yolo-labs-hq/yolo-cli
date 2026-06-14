/**
 * Substrate CLI auth-context resolution (AUTH_AND_ONBOARDING Slice 0).
 *
 * The CLI used to accept `INTERNAL_API_KEY` — the service-to-service master
 * key — from the shell env as a fallback. That master key should never be the
 * credential a user-controlled shell wields, and the JWT path has fully
 * replaced it (the mint + work routes accept the user JWT, ownership-checked).
 * The fallback is now REMOVED: the CLI is user-JWT-only.
 *
 * Token precedence:
 *   1. `~/.config/yolo/token` — the rotated user JWT, rewritten every
 *      ~10 min by container-api's yolo-token-refresh. Reading the FILE
 *      (not the `YOLO_API_TOKEN` env var) sidesteps the stale-shell
 *      problem: a long-lived shell holds whatever token was in scope at
 *      its own launch, but the file is always fresh.
 *   2. `YOLO_API_TOKEN` env — the pod-injected user JWT (≤24h TTL).
 *
 * Auth requires SESSION_ID + a common-api URL + a user access JWT.
 */

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface SubstrateContext {
  sessionId: string;
  commonApiUrl: string;
  /** The user's rotated access JWT — the sole credential. */
  userToken: string;
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
  if (!userToken) {
    return {
      ok: false,
      message:
        'no user token available: expected a user access JWT in ~/.config/yolo/token or the YOLO_API_TOKEN env var. ' +
        'The substrate CLI is user-JWT-only — the INTERNAL_API_KEY fallback was removed.',
    };
  }

  return { ok: true, context: { sessionId, commonApiUrl, userToken } };
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

export function defaultReadFile(filePath: string): string | undefined {
  try {
    return fs.readFileSync(filePath, 'utf-8');
  } catch {
    return undefined;
  }
}
