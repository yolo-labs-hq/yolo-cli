/**
 * `yolo workspace set-repository <url>` — point this workspace at a different
 * repository. A thin client over `POST /v1/workspaces/:id/repository`
 * (docs/plans/workspace-set-repository.md §7.2), the operator's own
 * user-token route, so it mints no delegated token and needs no MCP scope.
 *
 * Two steps, like the MCP tool:
 *   - without `--confirm` it prints the preview and its snapshot; nothing changes;
 *   - `--confirm <snapshot>` applies, and is refused if anything moved since.
 *
 * Exit codes: 0 success (a preview with blockers included) · 1 http/refused · 64 usage/auth.
 */

import { type FetchLike, userRouteRequest } from './work-client.js';
import { resolveSubstrateContext } from './auth-context.js';

export interface SetRepositoryArgs {
  url: string;
  defaultBranch?: string;
  authMethod?: 'https' | 'ssh';
  /** Absent = server default (`yolo-studio`); null = drop the old remote. */
  keepOldRemoteAs?: string | null;
  confirm?: string;
  json: boolean;
  workspaceFlag?: string;
}

export interface ParseError { ok: false; message: string }

export const SET_REPOSITORY_USAGE = [
  'Usage: yolo workspace set-repository <url> [options]',
  '',
  '  --default-branch <b>        Branch to check out (default: the new remote\'s HEAD). Alias: --branch',
  '  --auth <https|ssh>          Transport (default: keep the current one when the host supports it)',
  '  --keep-old-remote-as <n>    Name for the old origin remote (default: yolo-studio). Alias: --keep-old-as',
  '  --drop-old-remote           Remove the old origin instead of keeping it',
  '  --confirm <snapshot>        Apply the preview that returned this snapshot',
  '  --json                      Print the raw response',
  '  --workspace <wsId>          Defaults to this session\'s workspace',
  '',
  'Without --confirm nothing changes: the command prints what would happen and the snapshot to confirm.',
  '',
].join('\n');

const WORKSPACE_USAGE = [
  'Usage: yolo workspace <subcommand>',
  '',
  'Subcommands:',
  '  set-repository <url>   Point this workspace at a different repository (preview, then --confirm)',
  '',
].join('\n');

export function parseSetRepositoryArgs(args: string[]): ({ ok: true } & SetRepositoryArgs) | ParseError {
  let url: string | undefined;
  const out: Omit<SetRepositoryArgs, 'url'> = { json: false };
  let keep: string | undefined;
  let drop = false;
  for (let i = 0; i < args.length; i++) {
    const raw = args[i]!;
    const eq = raw.startsWith('--') ? raw.indexOf('=') : -1;
    const flag = eq > 0 ? raw.slice(0, eq) : raw;
    const value = () => {
      const v = eq > 0 ? raw.slice(eq + 1) : args[++i];
      if (!v || (eq < 0 && v.startsWith('--'))) throw new Error(`${flag} requires a value`);
      return v;
    };
    try {
      if (flag === '--default-branch' || flag === '--branch') out.defaultBranch = value();
      else if (flag === '--auth') {
        const v = value();
        if (v !== 'https' && v !== 'ssh') return { ok: false, message: '--auth must be https or ssh' };
        out.authMethod = v;
      } else if (flag === '--keep-old-remote-as' || flag === '--keep-old-as') keep = value();
      else if (flag === '--drop-old-remote') drop = true;
      else if (flag === '--confirm') {
        const v = value();
        if (!/^[a-f0-9]{64}$/.test(v)) return { ok: false, message: '--confirm takes the 64-character snapshot a preview printed' };
        out.confirm = v;
      } else if (flag === '--json') out.json = true;
      else if (flag === '--workspace') out.workspaceFlag = value();
      else if (raw.startsWith('-')) return { ok: false, message: `unknown option: ${raw}` };
      else if (url === undefined) url = raw;
      else return { ok: false, message: `unexpected positional argument: ${raw}` };
    } catch (error) {
      return { ok: false, message: (error as Error).message };
    }
  }
  if (!url) return { ok: false, message: 'a repository <url> is required' };
  if (keep !== undefined && drop) return { ok: false, message: '--keep-old-remote-as and --drop-old-remote are mutually exclusive' };
  return { ok: true, url, ...out, ...(drop ? { keepOldRemoteAs: null } : keep !== undefined ? { keepOldRemoteAs: keep } : {}) };
}

interface Preview {
  applied?: boolean; snapshot?: string; error?: string; code?: string;
  from?: { url?: string | null }; to?: { url?: string; defaultBranch?: string | null; authMethod?: string };
  credential?: { method?: string | null; probe?: string };
  oldRemote?: { keptAs?: string; dropped?: boolean };
  lanes?: Array<{ name: string }>;
  blockers?: Array<{ code: string; message: string }>;
  warnings?: string[];
  restart?: { required?: boolean; reason?: string; message?: string };
  lanesFlagged?: string[];
  preview?: Preview;
}

/** What an operator reads before confirming; `--json` prints the response as-is. */
export function formatSetRepository(body: Preview, url: string): string {
  if (body.error) {
    const lines = [`Refused (${body.code ?? 'error'}): ${body.error}`];
    for (const blocker of body.preview?.blockers ?? []) lines.push(`  ✗ ${blocker.code}: ${blocker.message}`);
    return lines.join('\n');
  }
  const oldRemote = body.oldRemote?.dropped ? 'dropped' : `kept as '${body.oldRemote?.keptAs ?? 'yolo-studio'}'`;
  const lines = [
    `${body.applied ? 'Switched' : 'Would switch'}: ${body.from?.url ?? '(none)'} → ${body.to?.url ?? url}`,
    `  default branch: ${body.to?.defaultBranch ?? '(unknown)'}   transport: ${body.to?.authMethod ?? '?'}   old remote: ${oldRemote}`,
  ];
  if (body.credential) lines.push(`  access: ${body.credential.method ?? 'none'} (${body.credential.probe ?? 'unchecked'})`);
  const lanes = body.applied ? body.lanesFlagged ?? [] : (body.lanes ?? []).map((lane) => lane.name);
  if (lanes.length) lines.push(`  lanes staying on the previous repository: ${lanes.join(', ')}`);
  for (const blocker of body.blockers ?? []) lines.push(`  ✗ ${blocker.code}: ${blocker.message}`);
  for (const warning of body.warnings ?? []) lines.push(`  ! ${warning}`);
  if (body.restart?.required) lines.push(`  ↻ restart required (${body.restart.reason ?? 'credentials'})${body.restart.message ? `: ${body.restart.message}` : ''}`);
  if (!body.applied) {
    lines.push(body.blockers?.length
      ? 'Blocked: resolve the items marked ✗, then preview again.'
      : `To apply: yolo workspace set-repository ${url} --confirm ${body.snapshot}`);
  }
  return lines.join('\n');
}

export interface WorkspaceCmdDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export async function runSetRepository(args: SetRepositoryArgs, deps: WorkspaceCmdDeps = {}): Promise<{ code: number; stdout?: string; stderr?: string }> {
  const env = deps.env ?? process.env;
  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return { code: 64, stderr: `FAIL [auth]: ${auth.message}` };
  const sessionWorkspace = env.WORKSPACE_ID?.trim() || undefined;
  if (args.workspaceFlag && sessionWorkspace && args.workspaceFlag !== sessionWorkspace) {
    return { code: 64, stderr: `FAIL [workspace_mismatch]: --workspace ${args.workspaceFlag} does not match this session's workspace (${sessionWorkspace}).` };
  }
  const workspaceId = args.workspaceFlag ?? sessionWorkspace;
  if (!workspaceId) return { code: 64, stderr: 'FAIL [usage]: no workspace: WORKSPACE_ID is unset — pass --workspace <workspaceId>' };

  const body = {
    url: args.url,
    ...(args.defaultBranch ? { defaultBranch: args.defaultBranch } : {}),
    ...(args.authMethod ? { authMethod: args.authMethod } : {}),
    ...(args.keepOldRemoteAs !== undefined ? { keepOldRemoteAs: args.keepOldRemoteAs } : {}),
    ...(args.confirm ? { expectedSnapshot: args.confirm } : {}),
  };
  let response: Awaited<ReturnType<typeof userRouteRequest>>;
  try {
    response = await userRouteRequest({ commonApiUrl: auth.context.commonApiUrl, userToken: auth.context.userToken, fetchImpl: deps.fetchImpl },
      `/workspaces/${encodeURIComponent(workspaceId)}/repository`, { method: 'POST', jsonBody: body });
  } catch (err) {
    return { code: 1, stderr: `FAIL [http]: workspace.set_repository failed: ${err instanceof Error ? err.message : String(err)}` };
  }
  const text = await response.text().catch(() => '');
  let parsed: Preview | null = null;
  try { parsed = JSON.parse(text) as Preview; } catch { /* reported raw below */ }
  if (args.json) return { code: response.ok ? 0 : 1, stdout: text };
  if (!parsed) return { code: 1, stderr: `FAIL [http]: HTTP ${response.status} — ${text}` };
  return response.ok ? { code: 0, stdout: formatSetRepository(parsed, args.url) } : { code: 1, stderr: formatSetRepository(parsed, args.url) };
}

/** `args` is everything after `workspace`. */
export async function runWorkspaceCmd(args: string[], deps: WorkspaceCmdDeps = {}): Promise<number> {
  const sub = args[0];
  if (!sub || sub === '--help' || sub === '-h' || sub === 'help') {
    process.stdout.write(WORKSPACE_USAGE);
    return sub ? 0 : 64;
  }
  if (sub !== 'set-repository') {
    process.stderr.write(`yolo: unknown workspace subcommand '${sub}'\n${WORKSPACE_USAGE}`);
    return 64;
  }
  if (args.slice(1).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(SET_REPOSITORY_USAGE);
    return 0;
  }
  const parsed = parseSetRepositoryArgs(args.slice(1));
  if (!parsed.ok) {
    process.stderr.write(`yolo: workspace set-repository: ${parsed.message}\n${SET_REPOSITORY_USAGE}`);
    return 64;
  }
  const result = await runSetRepository(parsed, deps);
  if (result.stdout) process.stdout.write(`${result.stdout}\n`);
  if (result.stderr) process.stderr.write(`${result.stderr}\n`);
  return result.code;
}
