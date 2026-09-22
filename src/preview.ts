/** Session-bound CLI for the workspace-owned branch preview service. */
import { resolveSubstrateContext } from './auth-context.js';
import { mintSubstrateToken, type FetchLike } from './work-client.js';

export const PREVIEW_HELP = `Usage:
  yolo preview create --name <name> --branch <branch> --command <command> [options]
  yolo preview status [tile-id] [--json]
  yolo preview logs <tile-id> [--tail 50] [--json]
  yolo preview stop <tile-id> [--json]

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

Run inside a Studio workspace. Quote commands so $PORT and $HOST reach the
managed server unchanged. Stop keeps the tile and prevents automatic restart.
`;

type Parsed = { action: 'create' | 'status' | 'logs' | 'stop'; id?: string; json: boolean; tail: number; body?: Record<string, unknown> };
function parse(args: string[]): Parsed {
  const action = args[0];
  if (!['create', 'status', 'logs', 'stop'].includes(action || '')) throw new Error('Choose create, status, logs, or stop');
  const values: Record<string, string> = {};
  let id: string | undefined, json = false;
  const allowed = action === 'create' ? ['name','branch','command','cwd','setup','build','health-path','port','poll-seconds','timeout-seconds','ready-seconds','wait-for','request-id','desktop'] : action === 'logs' ? ['tail'] : [];
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
    if (!value || (match[2] === undefined && value.startsWith('--'))) throw new Error(`--${key} requires a value`);
    values[key] = value;
  }
  if (id && !/^[a-zA-Z0-9_-]{1,128}$/.test(id)) throw new Error('Invalid preview tile ID');
  if ((action === 'logs' || action === 'stop') && !id) throw new Error(`${action} requires a preview tile ID`);
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
    const scope = input.action === 'create' ? 'studio.create_preview' : input.action === 'stop' ? 'studio.stop_preview' : 'studio.read_preview';
    const token = await mintSubstrateToken({ ...auth.context, scopes: [scope], fetchImpl: deps.fetchImpl });
    const base = `${auth.context.commonApiUrl.replace(/\/+$/, '')}/internal/mcp/workspaces/${encodeURIComponent(token.workspaceId)}`;
    const route = input.action === 'create' ? '/tiles/preview' : input.action === 'status'
      ? `/previews${input.id ? `/${encodeURIComponent(input.id)}` : ''}`
      : `/previews/${encodeURIComponent(input.id!)}/${input.action}${input.action === 'logs' ? `?tail=${input.tail}` : ''}`;
    const response = await (deps.fetchImpl ?? globalThis.fetch as unknown as FetchLike)(base + route, {
      method: input.action === 'create' || input.action === 'stop' ? 'POST' : 'GET',
      headers: { Authorization: `Bearer ${token.token}`, 'Content-Type': 'application/json' },
      ...(input.body && { body: JSON.stringify(input.body) }),
    });
    const body = await response.json() as any;
    if (!response.ok) throw new Error(`${body.code || response.status}: ${body.error || 'Preview request failed'}`);
    if (input.json) out(JSON.stringify(body, null, 2) + '\n');
    else if (input.action === 'create') out(`Preview ${body.tile?.id || body.previewId} follows ${input.body!.followBranch && (input.body!.followBranch as any).branch} on port ${body.preview?.port}.\nUse yolo preview status to check build progress.\n`);
    else if (input.action === 'stop') out(`Stopped preview ${input.id}. The tile is retained.\n`);
    else if (input.action === 'logs') out((body.lines?.map((line: any) => line.text).join('') || '(no logs)') + '\n');
    else {
      const previews = body.previews || [body.preview];
      out(previews.length ? previews.map((p: any) => `${p.tileId}\t${p.name}\t${p.status}\t${p.branchStatus?.phase || '-'}\t${p.branch}\t:${p.port}\t${p.branchStatus?.servedCommit?.slice(0,12) || '-'}${p.branchStatus?.error ? `\n  ${p.branchStatus.error}` : ''}`).join('\n') + '\n' : 'No managed branch previews.\n');
    }
    return 0;
  } catch (error) { err(`yolo preview: ${(error as Error).message}\n`); return 1; }
}
