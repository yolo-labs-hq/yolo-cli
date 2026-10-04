/** Session-bound CLI for the workspace-owned branch preview service. */
import { resolveSubstrateContext } from './auth-context.js';
import { mintSubstrateToken, type FetchLike } from './work-client.js';

export const PREVIEW_HELP = `Usage:
  yolo preview create --name <name> --branch <branch> --command <command> [options]
  yolo preview status [tile-id] [--json]
  yolo preview logs <tile-id> [--tail 50] [--json]
  yolo preview stop <tile-id> [--json]
  yolo preview update <tile-id> [--env KEY=VALUE ...] [--unset-env KEY ...] [options]

Create options:
  --cwd <dir>             Repository-relative app directory (default: .)
  --setup <command>       Install dependencies in each candidate checkout
  --build <command>       Build each candidate
  --health-path <path>    Readiness endpoint (default: /)
  --port <auto|number>    Public preview port (default: auto)
  --poll-seconds <n>      Branch polling interval, 5..3600 (default: 30)
  --timeout-seconds <n>   Setup/build timeout, 1..1800 (default: 300)
  --ready-seconds <n>     Server readiness timeout, 1..300 (default: 60)
  --wait-for <path>       Repository-relative file to wait for on the branch
                          before checkout/build (e.g. app/package.json)
  --request-id <id>       Reuse for retrying the same create request
  --desktop <id>         Destination desktop
  --json                 Print structured output

Update options (same tile and port; rebuilds the branch head once and
forgets the failed commit):
  --env KEY=VALUE         Set an environment variable (repeatable)
  --unset-env KEY         Remove an environment variable (repeatable)
  --command <command>     Server start command
  --setup <command>       Setup command
  --build <command>       Build command
  --health-path <path>    Readiness endpoint
  --ready-seconds <n>     Server readiness timeout, 1..300
  --timeout-seconds <n>   Setup/build timeout, 1..1800

Run inside a Studio workspace. Quote commands so $PORT and $HOST reach the
managed server unchanged. Stop keeps the tile and prevents automatic restart.
`;

type Parsed = { action: 'create' | 'status' | 'logs' | 'stop' | 'update'; id?: string; json: boolean; tail: number; body?: Record<string, unknown> };
function parse(args: string[]): Parsed {
  const action = args[0];
  if (!['create', 'status', 'logs', 'stop', 'update'].includes(action || '')) throw new Error('Choose create, status, logs, stop, or update');
  const values: Record<string, string> = {};
  const env: Record<string, string> = {}; const unsetEnv: string[] = [];
  let id: string | undefined, json = false;
  const allowed = action === 'create' ? ['name','branch','command','cwd','setup','build','health-path','port','poll-seconds','timeout-seconds','ready-seconds','wait-for','request-id','desktop'] : action === 'logs' ? ['tail']
    : action === 'update' ? ['env','unset-env','command','setup','build','health-path','ready-seconds','timeout-seconds'] : [];
  for (let i = 1; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--json') { json = true; continue; }
    if (!arg.startsWith('-')) {
      if (action === 'create' || id) throw new Error(`Unexpected argument: ${arg}`);
      id = arg; continue;
    }
    const match = /^--([^=]+)(?:=(.*))?$/.exec(arg);
    if (!match || !allowed.includes(match[1]!)) throw new Error(`Unknown option: ${arg}`);
    const key = match[1]!;
    if (values[key] !== undefined) throw new Error(`Repeated option: --${key}`);
    const value = match[2] ?? args[++i];
    if (key === 'env') {
      // `--env KEY=` sets an empty value; the name is checked here, the rest by the service.
      const pair = value === undefined ? null : /^([A-Za-z_][A-Za-z0-9_]{0,127})=(.*)$/s.exec(value);
      if (!pair) throw new Error('--env requires KEY=VALUE');
      env[pair[1]!] = pair[2]!; continue;
    }
    if (!value || (match[2] === undefined && value.startsWith('--'))) throw new Error(`--${key} requires a value`);
    if (key === 'unset-env') {
      if (!/^[A-Za-z_][A-Za-z0-9_]{0,127}$/.test(value)) throw new Error('--unset-env requires a variable name');
      unsetEnv.push(value); continue;
    }
    values[key] = value;
  }
  if (id && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid preview tile ID');
  if ((action === 'logs' || action === 'stop' || action === 'update') && !id) throw new Error(`${action} requires a preview tile ID`);
  const number = (key: string, min: number, max: number, fallback: number): number => {
    const raw = values[key];
    if (raw === undefined) return fallback;
    const n = Number(raw);
    if (!/^\d+$/.test(raw) || !Number.isInteger(n) || n < min || n > max) throw new Error(`--${key} must be an integer in ${min}..${max}`);
    return n;
  };
  const result: Parsed = { action: action as Parsed['action'], id, json, tail: number('tail', 1, 200, 50) };
  if (action === 'create') {
    for (const key of ['name', 'branch', 'command']) if (!values[key]?.trim()) throw new Error(`--${key} is required`);
    const cwd = values.cwd || '.';
    if (cwd.startsWith('/') || cwd.split(/[\\/]/).includes('..')) throw new Error('--cwd must stay inside the repository');
    const waitFor = values['wait-for'];
    if (waitFor !== undefined && (waitFor.length > 1024 || waitFor.startsWith('/') || waitFor.split(/[\\/]/).includes('..') || /[\r\n]/.test(waitFor))) throw new Error('--wait-for must be a repository-relative path');
    result.body = { name: values.name, command: values.command, cwd,
      port: !values.port || values.port === 'auto' ? 'auto' : number('port', 1024, 65535, 3100),
      ...(values['request-id'] && { requestId: values['request-id'] }), ...(values.desktop && { desktopId: values.desktop }),
      followBranch: { branch: values.branch, ...(values.setup && { setup: values.setup }), ...(values.build && { build: values.build }),
        healthPath: values['health-path'] || '/', pollSeconds: number('poll-seconds', 5, 3600, 30),
        timeoutSeconds: number('timeout-seconds', 1, 1800, 300), readySeconds: number('ready-seconds', 1, 300, 60),
        ...(waitFor && { waitFor }) } };
  }
  if (action === 'update') {
    const healthPath = values['health-path'];
    if (healthPath !== undefined && (!healthPath.startsWith('/') || healthPath.startsWith('//'))) throw new Error('--health-path must start with a single /');
    const body: Record<string, unknown> = {
      ...(Object.keys(env).length && { env }), ...(unsetEnv.length && { unsetEnv }),
      ...(values.command !== undefined && { command: values.command }), ...(values.setup !== undefined && { setup: values.setup }),
      ...(values.build !== undefined && { build: values.build }), ...(healthPath !== undefined && { healthPath }),
      ...(values['ready-seconds'] !== undefined && { readySeconds: number('ready-seconds', 1, 300, 60) }),
      ...(values['timeout-seconds'] !== undefined && { timeoutSeconds: number('timeout-seconds', 1, 1800, 300) }),
    };
    if (!Object.keys(body).length) throw new Error('update needs at least one change (e.g. --env KEY=VALUE)');
    result.body = body;
  }
  return result;
}

export async function runPreviewCmd(args: string[], deps: {
  env?: NodeJS.ProcessEnv; fetchImpl?: FetchLike; stdout?: (text: string) => void; stderr?: (text: string) => void;
} = {}): Promise<number> {
  const out = deps.stdout ?? (text => process.stdout.write(text));
  const err = deps.stderr ?? (text => process.stderr.write(text));
  if (args[0] === '--help' || args[0] === '-h' || args.slice(1).includes('--help')) { out(PREVIEW_HELP); return 0; }
  let input: Parsed;
  try { input = parse(args); } catch (error) { err(`yolo preview: ${(error as Error).message}\n${PREVIEW_HELP}`); return 64; }
  const auth = resolveSubstrateContext(deps.env ?? process.env);
  if (!auth.ok) { err(`yolo preview: ${auth.message}\n`); return 78; }
  try {
    const scope = input.action === 'create' || input.action === 'update' ? 'studio.create_preview' : input.action === 'stop' ? 'studio.stop_preview' : 'studio.read_preview';
    const token = await mintSubstrateToken({ ...auth.context, scopes: [scope], fetchImpl: deps.fetchImpl });
    const base = `${auth.context.commonApiUrl.replace(/\/+$/, '')}/internal/mcp/workspaces/${encodeURIComponent(token.workspaceId)}`;
    const route = input.action === 'create' ? '/tiles/preview' : input.action === 'status'
      ? `/previews${input.id ? `/${encodeURIComponent(input.id)}` : ''}`
      : `/previews/${encodeURIComponent(input.id!)}/${input.action}${input.action === 'logs' ? `?tail=${input.tail}` : ''}`;
    const response = await (deps.fetchImpl ?? globalThis.fetch as unknown as FetchLike)(base + route, {
      method: input.action === 'status' || input.action === 'logs' ? 'GET' : 'POST',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      ...(input.body && { body: JSON.stringify(input.body) }),
    });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(`${body.code || response.status}: ${body.error || 'Preview request failed'}`);
    if (input.json) out(JSON.stringify(body, null, 2) + '\n');
    else if (input.action === 'create') out(`Preview ${body.tile?.id || body.previewId} follows ${input.body!.followBranch && (input.body!.followBranch as any).branch} on port ${body.preview?.port}.\nUse yolo preview status to check build progress.\n`);
    else if (input.action === 'stop') out(`Stopped preview ${input.id}. The tile is retained.\n`);
    else if (input.action === 'update') out(`Updated preview ${input.id} on port ${body.port}${body.version ? ` (config v${body.version})` : ''}; ${body.confirmed === false
      ? 'saved; the workspace has not confirmed it yet and will be sent it again on the next status check.'
      : 'rebuilding the branch head with the new configuration.'}\nUse yolo preview status ${input.id} to follow it.\n`);
    else if (input.action === 'logs') out((body.lines?.map((line: any) => line.text).join('') || '(no logs)') + '\n');
    else {
      const previews = body.previews || [body.preview];
      out(previews.length ? previews.map((p: any) => `${p.tileId}\t${p.name}\t${p.status}\t${p.branchStatus?.phase || '-'}\t${p.branch}\t:${p.port}\t${p.branchStatus?.servedCommit?.slice(0,12) || '-'}${p.update && p.update.state !== 'applied' ? `\n  Config v${p.update.version} update ${p.update.state}${p.update.error ? `: ${p.update.error}` : ''}` : ''}${p.branchStatus?.error ? `\n  ${p.branchStatus.error}\n  See: yolo preview logs ${p.tileId}` : ''}`).join('\n') + '\n' : 'No managed branch previews.\n');
    }
    return 0;
  } catch (error) { err(`yolo preview: ${(error as Error).message}\n`); return 1; }
}
