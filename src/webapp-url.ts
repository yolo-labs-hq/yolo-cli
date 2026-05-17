/**
 * Webapp URL derivation for CLI link-print.
 *
 * The substrate CLI runs in a container that has `YOLO_COMMON_API_URL`
 * but no first-class webapp URL var. To keep `yolo plan import` / `yolo
 * plan get` able to print a clickable Plan-DAG link without requiring
 * operators to set a new env var, derive the webapp host from the
 * common-api host: prod is `api.yolo.studio` → `yolo.studio`, staging
 * is `api-staging.yolo.studio` → `staging.yolo.studio`. Operators can
 * override via `YOLO_WEBAPP_URL` for local dev / custom deployments.
 *
 * When derivation fails (an unrecognized API URL shape, e.g. a raw
 * localhost port), `deriveWebappUrl` returns null and the caller is
 * expected to skip the URL line — printing a bogus URL would be worse
 * than printing nothing.
 */

export interface DeriveWebappUrlInput {
  /** Value of `YOLO_COMMON_API_URL` (or `YOLO_API_URL`). */
  commonApiUrl: string;
  /** Optional explicit override (`YOLO_WEBAPP_URL`). Wins when present. */
  webappUrlOverride?: string;
}

export function deriveWebappUrl(input: DeriveWebappUrlInput): string | null {
  if (input.webappUrlOverride && input.webappUrlOverride.length > 0) {
    return stripTrailingSlash(input.webappUrlOverride);
  }

  let parsed: URL;
  try {
    parsed = new URL(input.commonApiUrl);
  } catch {
    return null;
  }

  const host = parsed.hostname;

  // Recognized prod shape: api.<rest> → <rest>
  if (host.startsWith('api.')) {
    return `${parsed.protocol}//${host.slice('api.'.length)}`;
  }
  // Recognized env-suffixed shape: api-<env>.<rest> → <env>.<rest>
  const envMatch = /^api-([^.]+)\.(.+)$/.exec(host);
  if (envMatch) {
    return `${parsed.protocol}//${envMatch[1]}.${envMatch[2]}`;
  }

  // Unknown shape (raw localhost, IPs, custom hosts). Don't guess.
  return null;
}

/**
 * Convenience for the CLI flows: derive the webapp URL from
 * `process.env`-style inputs and format the Plan-DAG path. Returns
 * null when derivation fails so the caller can omit the URL line
 * entirely.
 */
export function planDagUrl(
  env: Record<string, string | undefined>,
  workspaceId: string,
  planId: string,
): string | null {
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!commonApiUrl) return null;
  const base = deriveWebappUrl({
    commonApiUrl,
    webappUrlOverride: env.YOLO_WEBAPP_URL,
  });
  if (!base) return null;
  return `${base}/workspaces/${workspaceId}/plans/${planId}`;
}

function stripTrailingSlash(s: string): string {
  return s.endsWith('/') ? s.slice(0, -1) : s;
}
