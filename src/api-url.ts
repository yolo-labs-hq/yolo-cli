/**
 * The YOLO API origin every CLI command talks to.
 *
 * `YOLO_COMMON_API_URL` wins, then `YOLO_API_URL` (both set in a Studio session
 * pod, staging or prod). When neither is set, the CLI talks to production
 * instead of failing with "env var is required": a fresh shell outside a pod
 * (or one whose env was not inherited) otherwise could not run anything.
 *
 * Only the URL defaults. The token and workspace are still resolved as before
 * and are never guessed, so an unset URL cannot pair a staging credential with
 * prod by itself (staging/prod safety is tracked separately).
 */
export const DEFAULT_YOLO_API_URL = 'https://api.yolo.studio';

export function resolveCommonApiUrl(env: Record<string, string | undefined>): string {
  return env.YOLO_COMMON_API_URL || env.YOLO_API_URL || DEFAULT_YOLO_API_URL;
}
