/**
 * Which YOLO environment the CLI is talking to, and which credential it may
 * use there.
 *
 * A Studio sandbox carries ONE credential: the pod's own user JWT, in
 * `~/.config/yolo/token` (rotated) and `$YOLO_API_TOKEN`. In a production pod
 * that is a production token. Pointing the CLI at another API
 * (`YOLO_API_URL=https://api-staging.yolo.studio yolo deploy ...`) used to send
 * that production token to the other host, and `yolo deploy link`/`init` used
 * to stamp the production `$WORKSPACE_ID` onto a project there.
 *
 * The rule, for any API that is not production:
 *   - `$YOLO_API_TOKEN` is never used.
 *   - The token comes from `$YOLO_API_TOKEN_NONPROD`, or from the file named by
 *     `$YOLO_API_TOKEN_FILE`.
 *   - The default token file `~/.config/yolo/token` is used only when the pod
 *     itself was provisioned for that same API (its env file `$YOLO_ENV_FILE`,
 *     default `/run/yolo/env`, records that `YOLO_API_URL`). That is the case
 *     in a staging sandbox, whose rotated token IS a staging token. A prod pod
 *     pointed at staging falls through to a clear failure instead.
 *   - `$WORKSPACE_ID` is never defaulted onto a server-side project.
 *
 * Production behaviour is unchanged.
 */

import { DEFAULT_YOLO_API_URL, resolveCommonApiUrl } from './api-url.js';

export const PRODUCTION_API_URL = DEFAULT_YOLO_API_URL;

/** The env var holding an explicit token for a non-production API. */
export const NONPROD_TOKEN_ENV = 'YOLO_API_TOKEN_NONPROD';
/** The env var naming a token file to use for a non-production API. */
export const NONPROD_TOKEN_FILE_ENV = 'YOLO_API_TOKEN_FILE';
/** The pod's env-profile file, which records the API it was provisioned for. */
export const DEFAULT_POD_ENV_FILE = '/run/yolo/env';

type Env = Record<string, string | undefined>;

/**
 * The API the CLI will call: `YOLO_COMMON_API_URL`, then `YOLO_API_URL`, then
 * production when neither is set (api-url.ts, the CLI's single URL resolver).
 */
export function targetApiUrl(env: Env): string {
  return resolveCommonApiUrl(env);
}

function originOf(url: string): string | undefined {
  try {
    return new URL(url.trim()).origin.toLowerCase();
  } catch {
    return undefined;
  }
}

/** True only for the production API origin. Anything unparseable is NOT production. */
export function isProductionApiUrl(url: string): boolean {
  return originOf(url) === PRODUCTION_API_URL;
}

export function isProductionTarget(env: Env): boolean {
  return isProductionApiUrl(targetApiUrl(env));
}

/** Same origin, both parseable. */
export function sameApiOrigin(a: string, b: string): boolean {
  const oa = originOf(a);
  return oa !== undefined && oa === originOf(b);
}

/**
 * The `YOLO_API_URL` the pod was provisioned with, read from its env-profile
 * file (lines like `export YOLO_API_URL='https://...'`). Undefined outside a
 * pod or when the file does not say.
 */
export function podProvisionedApiUrl(env: Env, readFileImpl: (p: string) => string | undefined): string | undefined {
  const text = readFileImpl(env.YOLO_ENV_FILE || DEFAULT_POD_ENV_FILE);
  if (!text) return undefined;
  let found: string | undefined;
  for (const line of text.split('\n')) {
    const m = /^\s*(?:export\s+)?(YOLO_COMMON_API_URL|YOLO_API_URL)=(.*)$/.exec(line);
    if (!m) continue;
    const value = m[2].trim().replace(/^(['"])(.*)\1$/, '$2').trim();
    // YOLO_COMMON_API_URL outranks YOLO_API_URL, as it does in targetApiUrl.
    if (value && (m[1] === 'YOLO_COMMON_API_URL' || found === undefined)) found = value;
    if (value && m[1] === 'YOLO_COMMON_API_URL') break;
  }
  return found;
}

/** The failure message when no usable token exists for a non-production API. */
export function nonProdTokenMessage(env: Env): string {
  const url = targetApiUrl(env);
  return (
    `no token for the non-production API ${url}: the sandbox credential (~/.config/yolo/token, $YOLO_API_TOKEN) ` +
    `belongs to this pod's own environment and is never sent to another API. ` +
    `Set ${NONPROD_TOKEN_ENV}=<token for ${url}> or ${NONPROD_TOKEN_FILE_ENV}=<path to a file holding it>, ` +
    `or unset YOLO_API_URL / YOLO_COMMON_API_URL to use production.`
  );
}

/**
 * Why the user token came back empty, in one sentence every command can print. For a non-production API
 * it names the explicit token variables, since the sandbox credential is deliberately withheld there.
 */
export function missingUserTokenMessage(env: Env): string {
  if (!isProductionTarget(env)) return nonProdTokenMessage(env);
  return 'no user token available: expected a user access JWT in ~/.config/yolo/token or the YOLO_API_TOKEN env var';
}
