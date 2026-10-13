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

/**
 * Set by the worker-domain launcher (container-api `execution-domain-launcher.js`) to the execution's
 * broker socket. Its presence can only take authority away from the CLI; its absence grants nothing.
 */
export const EXECUTION_BROKER_SOCKET_ENV = 'YOLO_EXECUTION_BROKER_SOCKET';

/** The launcher also names the execution and its lane; either alone marks one as plainly as the socket does. */
export const EXECUTION_MARKER_ENVS = [EXECUTION_BROKER_SOCKET_ENV, 'YOLO_EXECUTION_ID', 'YOLO_EXECUTION_LANE'] as const;

/**
 * The uid every restricted worker container runs as (common-api `execution-domain-template.ts`,
 * `EXECUTION_WORKER_UID`). It is fixed by the pod template, not by anything a process in that container can
 * set or unset, and no interactive session or ordinary lane ever runs under it.
 */
export const EXECUTION_WORKER_UID = 20001;

/** What the CLI reads about its own process that is not an environment variable. Injectable for tests. */
export interface ExecutionDomainProbe { uid(): number | undefined }
const processProbe: ExecutionDomainProbe = { uid: () => (typeof process.getuid === 'function' ? process.getuid() : undefined) };

/**
 * Is this CLI running inside a restricted Runner execution?
 *
 * Yes when ANY marker the launcher sets is present — and also when none is, if the process runs as the
 * worker container's uid. So an execution whose environment was scrubbed, or that starts the CLI with its
 * own environment, is still an execution: dropping the markers does not turn it into an ordinary session.
 * Every answer here can only take authority away; nothing about it grants any.
 */
export function inRestrictedExecution(env: Record<string, string | undefined>, probe: ExecutionDomainProbe = processProbe): boolean {
  if (EXECUTION_MARKER_ENVS.some((name) => Boolean(env[name]))) return true;
  return probe.uid() === EXECUTION_WORKER_UID;
}

/** Why the CLI holds no credential inside an execution. One message, so every command says the same thing. */
export const RESTRICTED_EXECUTION_MESSAGE =
  'this is a restricted Runner execution: the substrate CLI has no credential here and does not use the workspace ' +
  'owner\'s. Studio tools are reached through the execution\'s own broker.';

/** Injectable file reader so unit tests don't touch the real FS. */
export type ReadFileImpl = (filePath: string) => string | undefined;

export function resolveSubstrateContext(
  env: Record<string, string | undefined>,
  readFileImpl: ReadFileImpl = defaultReadFile,
  probe: ExecutionDomainProbe = processProbe,
): ResolveResult {
  const sessionId = env.SESSION_ID;
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!sessionId) {
    return { ok: false, message: 'SESSION_ID env var is required (substrate CLI is container-only in v1)' };
  }
  if (!commonApiUrl) {
    return { ok: false, message: 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required' };
  }

  // Inside a restricted Runner execution (docs/RUNNER_EXECUTION_BOOTSTRAP_PROTOCOL.md) the CLI has no
  // credential to offer and must not go looking for one: the workspace owner's token is not the
  // execution's identity, wherever a copy of it might be found. Checked BEFORE the token file and the
  // environment are read. This is not what keeps the token away from an execution — the worker domain
  // holds no copy of it, with or without a marker — it only makes the CLI say so plainly instead of
  // presenting whatever it finds.
  if (inRestrictedExecution(env, probe)) {
    return { ok: false, message: RESTRICTED_EXECUTION_MESSAGE };
  }

  const userToken = resolveUserToken(env, readFileImpl, probe);
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

/**
 * The user token, or undefined. EVERY client that needs the owner's token comes through here — the
 * substrate context above, `yolo context`, deploy, the tile-app publisher and workspace commands — so the
 * execution check lives here as well: inside a restricted execution this returns undefined without reading
 * the token file or `YOLO_API_TOKEN`, whichever command asked.
 */
export function resolveUserToken(
  env: Record<string, string | undefined>,
  readFileImpl: ReadFileImpl = defaultReadFile,
  probe: ExecutionDomainProbe = processProbe,
): string | undefined {
  if (inRestrictedExecution(env, probe)) return undefined;
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
