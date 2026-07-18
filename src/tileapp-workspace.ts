/**
 * `yolo tileapp install` + `yolo tileapp add-tile` — workspace-side app
 * management (field-retro follow-up: agents had to hand-roll curl for both).
 *
 *   yolo tileapp install <appId> --workspace <wsId> [--accept-optional <perm>]…
 *     → POST /v1/tileapps/<appId>/install { workspaceId, acceptedOptional? }.
 *       Records the grant; prints the granted permissions.
 *
 *   yolo tileapp add-tile <appId> --workspace <wsId> [--name <n>] [--version <v>]
 *     → POST /v1/workspaces/<wsId>/tiles { id, type: 'app', name, app }.
 *       The tiles route REQUIRES a client-generated tile id ("Tile id, type,
 *       and name are required"), so we mint one: app-<appId-slug>-<suffix>.
 *       When --version (or --name) is omitted we resolve the app's current
 *       manifest via GET /v1/tileapps/<appId> first.
 *
 * Auth: user JWT (no SESSION_ID needed — these are user-authed /v1 routes),
 * same resolution as `tileapp publish --personal`.
 */

import { resolveUserToken } from './auth-context.js';

export type FetchLike = typeof fetch;

export type CmdResult =
  | { ok: true; output: string }
  | { ok: false; kind: 'usage' | 'auth' | 'http'; message: string };

export function exitCodeForFailure(kind: 'usage' | 'auth' | 'http'): number {
  return kind === 'http' ? 1 : 64; // EX_USAGE for usage/auth (tileapp-personal precedent)
}

function apiBase(commonApiUrl: string): string {
  const base = commonApiUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

type Auth = { ok: true; commonApiUrl: string; userToken: string } | { ok: false; message: string };
function resolveAuth(env: Record<string, string | undefined>): Auth {
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!commonApiUrl) return { ok: false, message: 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required' };
  const userToken = resolveUserToken(env);
  if (!userToken) return { ok: false, message: 'no user token: set YOLO_API_TOKEN or sign in (~/.config/yolo/token)' };
  return { ok: true, commonApiUrl, userToken };
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try { return await res.text(); } catch { return '<no body>'; }
}

// ── install ─────────────────────────────────────────────────────────────────

export interface InstallOptions {
  appId: string;
  workspaceId: string;
  /** Optional permissions the user accepts (repeatable --accept-optional). */
  acceptOptional?: string[];
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export async function runTileAppInstall(opts: InstallOptions): Promise<CmdResult> {
  const env = opts.env ?? process.env;
  const auth = resolveAuth(env);
  if (!auth.ok) return { ok: false, kind: 'auth', message: auth.message };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBase(auth.commonApiUrl);
  const body: Record<string, unknown> = { workspaceId: opts.workspaceId };
  if (opts.acceptOptional && opts.acceptOptional.length > 0) body.acceptedOptional = opts.acceptOptional;

  let json: { installed?: boolean; grant?: { appId?: string; version?: string; grantedPermissions?: string[] } };
  try {
    const res = await fetchImpl(`${base}/tileapps/${encodeURIComponent(opts.appId)}/install`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.userToken}` },
      body: JSON.stringify(body),
    });
    if (!res.ok) return { ok: false, kind: 'http', message: `install failed: HTTP ${res.status} — ${await safeText(res)}` };
    json = (await res.json()) as typeof json;
  } catch (e) {
    return { ok: false, kind: 'http', message: `install request failed: ${(e as Error).message}` };
  }
  if (!json.installed || !json.grant) {
    return { ok: false, kind: 'http', message: 'install response missing grant' };
  }

  const granted = Array.isArray(json.grant.grantedPermissions) ? json.grant.grantedPermissions : [];
  const lines = [
    `Installed ${json.grant.appId ?? opts.appId}@${json.grant.version ?? '?'} into workspace ${opts.workspaceId}`,
    `Granted permissions (${granted.length}):`,
    ...(granted.length > 0 ? granted.map((p) => `  - ${p}`) : ['  (none)']),
  ];
  return { ok: true, output: lines.join('\n') };
}

// ── add-tile ────────────────────────────────────────────────────────────────

export interface AddTileOptions {
  appId: string;
  workspaceId: string;
  /** Tile display name. Default: the app manifest's displayName (or appId). */
  name?: string;
  /** App version to pin. Default: resolved from GET /v1/tileapps/<appId>. */
  version?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  /** Injectable suffix generator so tests get deterministic tile ids. */
  idSuffixImpl?: () => string;
}

/** `app-<appId-slug>-<random>` — the client-generated id the tiles route requires. */
export function generateTileId(appId: string, suffixImpl?: () => string): string {
  const slug = appId.toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/^-+|-+$/g, '');
  const suffix = (suffixImpl ?? defaultSuffix)();
  return `app-${slug}-${suffix}`;
}

function defaultSuffix(): string {
  return Math.random().toString(36).slice(2, 8);
}

export async function runTileAppAddTile(opts: AddTileOptions): Promise<CmdResult> {
  const env = opts.env ?? process.env;
  const auth = resolveAuth(env);
  if (!auth.ok) return { ok: false, kind: 'auth', message: auth.message };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBase(auth.commonApiUrl);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.userToken}` };

  // Resolve the manifest when --version (or --name) is omitted — the tiles
  // route requires both a version and a name.
  let version = opts.version;
  let name = opts.name;
  if (!version || !name) {
    try {
      const res = await fetchImpl(`${base}/tileapps/${encodeURIComponent(opts.appId)}`, { headers });
      if (!res.ok) return { ok: false, kind: 'http', message: `resolve app failed: HTTP ${res.status} — ${await safeText(res)}` };
      const json = (await res.json()) as { app?: { version?: string; displayName?: string } };
      if (!version) {
        if (typeof json.app?.version !== 'string' || !json.app.version) {
          return { ok: false, kind: 'http', message: 'resolve app response missing app.version — pass --version explicitly' };
        }
        version = json.app.version;
      }
      if (!name) name = json.app?.displayName || opts.appId;
    } catch (e) {
      return { ok: false, kind: 'http', message: `resolve app request failed: ${(e as Error).message}` };
    }
  }

  const tileId = generateTileId(opts.appId, opts.idSuffixImpl);
  try {
    const res = await fetchImpl(`${base}/workspaces/${encodeURIComponent(opts.workspaceId)}/tiles`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: tileId, type: 'app', name, app: { appId: opts.appId, version } }),
    });
    if (!res.ok) return { ok: false, kind: 'http', message: `add-tile failed: HTTP ${res.status} — ${await safeText(res)}` };
  } catch (e) {
    return { ok: false, kind: 'http', message: `add-tile request failed: ${(e as Error).message}` };
  }

  return { ok: true, output: `Added app tile ${tileId} (${opts.appId}@${version}, "${name}") to workspace ${opts.workspaceId}` };
}
