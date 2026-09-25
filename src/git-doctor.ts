/**
 * `yolo git doctor [--fix]` — diagnose, and optionally repair, how git in this
 * workspace authenticates to github.com over HTTPS.
 *
 * git and `gh` resolve credentials differently. `gh` (the /usr/local/bin
 * wrapper) re-reads ~/.yolo-env on every call, so it always holds the current
 * token. git asks its credential helpers: `store` (~/.git-credentials), then
 * the github.com-scoped `gh auth git-credential` fallback from setup-git.sh.
 * When the two disagree, `gh` works and `git push` fails with "could not read
 * Username" — which is what a root exec leaving ~/.git-credentials root-owned
 * 0600 looked like (the lane-gc probe, until #1181). This command looks at
 * every link in git's chain and says which one is broken.
 *
 * Checks: the token (and, online, whether GitHub accepts it), the store file
 * (present, readable, owned by the HOME owner, 0600, holding the current
 * token), the helper config, the push URL of the remote, and — online, in a
 * repository — a real `git ls-remote`.
 *
 * --fix repairs what it safely can, then re-runs every check:
 *   - rewrites ~/.git-credentials from the current token by temp file + rename
 *     (a rename replaces a file we cannot write through; we own the directory),
 *     keeping readable non-github lines, or the forge line from the pod env
 *   - sets `credential.helper store` / the github.com gh fallback if missing
 *   - strips credentials embedded in a github.com remote URL
 * It only writes a token GitHub accepted in this run, and never while the
 * Auth V2 purge fence is up: that fence means GitHub access was withdrawn, and
 * reinstalling the token would undo the revocation.
 *
 * Tokens are never printed; they are masked to prefix…last4.
 *
 * Exit codes: 0 = no failing check; 1 = a check still fails; 64 = usage.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

export type CheckStatus = 'ok' | 'warn' | 'fail' | 'skip';

export interface DoctorCheck {
  id: 'token' | 'credentials-file' | 'helper' | 'remote' | 'ls-remote';
  status: CheckStatus;
  detail: string;
}

export interface GitResult { status: number | null; stdout: string; stderr: string }

export type GitRunner = (args: string[], opts?: { timeoutMs?: number }) => GitResult;

export type GithubFetch = (url: string, init: { headers: Record<string, string> }) => Promise<{
  status: number;
  headers: { get(name: string): string | null };
  json(): Promise<unknown>;
}>;

export interface GitDoctorDeps {
  env?: Record<string, string | undefined>;
  /** Defaults to $HOME. */
  home?: string;
  cwd?: string;
  git?: GitRunner;
  fetchImpl?: GithubFetch;
  getuid?: () => number;
  hasCommand?: (name: string) => boolean;
  stdout?: (text: string) => void;
  stderr?: (text: string) => void;
}

export interface GitDoctorOptions {
  fix: boolean;
  json: boolean;
  offline: boolean;
  remote: string;
}

export const GIT_DOCTOR_HELP = `Usage: yolo git doctor [--fix] [--offline] [--remote <name>] [--json]

Diagnose why git (not gh) can't authenticate to github.com over HTTPS.

  --fix             Repair what can be repaired safely, then re-check.
  --offline         Skip the GitHub API token check and git ls-remote.
                    (--fix won't rewrite ~/.git-credentials without the token check.)
  --remote <name>   Remote to inspect and probe (default: origin).
  --json            Print {checks, fixed} as JSON.
`;

const GH_FALLBACK_KEY = 'credential.https://github.com.helper';
const GH_FALLBACK_VALUE = '!gh auth git-credential';
const GITHUB_LINE = /^https:\/\/[^:@/\s]+:([^@\s]+)@github\.com\/?$/;

/** prefix…last4, so two tokens can be told apart without either being shown. */
export function maskToken(token: string): string {
  if (token.length <= 12) return '****';
  const prefix = /^(github_pat_|gh[pousr]_)/.exec(token)?.[1] ?? token.slice(0, 4);
  return `${prefix}…${token.slice(-4)}`;
}

/** Mask anything token-shaped in free text (git stderr, URLs). */
export function redact(text: string): string {
  return text
    .replace(/(github_pat_|gh[pousr]_)[A-Za-z0-9_]+/g, (t) => maskToken(t))
    .replace(/(\/\/[^:@/\s]+:)[^@\s]+@/g, '$1****@');
}

/**
 * The token `gh` would use: the wrapper sources ~/.yolo-env over the process
 * env, then falls back from GH_TOKEN to GITHUB_TOKEN.
 */
export function resolveToken(env: Record<string, string | undefined>, home: string): { token?: string; source: string } {
  const file = env.YOLO_ENV_FILE || path.join(home, '.yolo-env');
  const fromFile: Record<string, string> = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split('\n')) {
      const m = /^export (GH_TOKEN|GITHUB_TOKEN)='([^']*)'$/.exec(line.trim());
      if (m && m[2]) fromFile[m[1]!] = m[2];
    }
  } catch { /* no ~/.yolo-env */ }
  const candidates: Array<[string | undefined, string]> = [
    [fromFile.GH_TOKEN, 'GH_TOKEN (~/.yolo-env)'],
    [env.GH_TOKEN, 'GH_TOKEN (env)'],
    [fromFile.GITHUB_TOKEN, 'GITHUB_TOKEN (~/.yolo-env)'],
    [env.GITHUB_TOKEN, 'GITHUB_TOKEN (env)'],
  ];
  for (const [token, source] of candidates) if (token) return { token, source };
  return { source: 'none' };
}

function defaultGit(cwd: string, env: Record<string, string | undefined>): GitRunner {
  return (args, opts = {}) => {
    const r = spawnSync('git', args, {
      cwd,
      env: { ...env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv,
      encoding: 'utf8',
      timeout: opts.timeoutMs ?? 10_000,
    });
    return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? (r.error ? String(r.error.message) : '') };
  };
}

function defaultHasCommand(env: Record<string, string | undefined>) {
  return (name: string) => (env.PATH ?? '').split(':').some((dir) => {
    try { fs.accessSync(path.join(dir, name), fs.constants.X_OK); return true; } catch { return false; }
  });
}

function getAll(git: GitRunner, args: string[]): string[] {
  const r = git(['config', ...args]);
  // One value per line; an empty value (the anonymous-mode reset) is a blank line.
  return r.status === 0 ? r.stdout.replace(/\n$/, '').split('\n') : [];
}

interface Context {
  env: Record<string, string | undefined>;
  home: string;
  git: GitRunner;
  fetchImpl: GithubFetch;
  getuid: () => number;
  hasCommand: (name: string) => boolean;
  opts: GitDoctorOptions;
}

interface Diagnosis {
  checks: DoctorCheck[];
  /** Set when GitHub accepted the token in this run — the only token --fix will write. */
  acceptedToken?: string;
  inRepo: boolean;
  credsNeedRewrite: boolean;
  needStoreHelper: boolean;
  needFallback: boolean;
  embeddedUrl?: { key: 'url' | 'pushurl'; clean: string };
}

async function checkToken(ctx: Context, d: Diagnosis): Promise<string | undefined> {
  const { token, source } = resolveToken(ctx.env, ctx.home);
  if (!token) {
    d.checks.push({ id: 'token', status: 'fail', detail: 'no GitHub token (GH_TOKEN / GITHUB_TOKEN, env or ~/.yolo-env)' });
    return undefined;
  }
  const label = `${maskToken(token)} from ${source}`;
  if (ctx.opts.offline) {
    d.checks.push({ id: 'token', status: 'skip', detail: `${label}; not verified (--offline)` });
    return token;
  }
  try {
    const res = await ctx.fetchImpl('https://api.github.com/user', {
      headers: { Authorization: `token ${token}`, 'User-Agent': 'yolo-git-doctor', Accept: 'application/vnd.github+json' },
    });
    if (res.status === 200) {
      const login = ((await res.json()) as { login?: string })?.login ?? '?';
      const scopes = res.headers.get('x-oauth-scopes');
      const expires = res.headers.get('github-authentication-token-expiration');
      d.acceptedToken = token;
      d.checks.push({ id: 'token', status: 'ok', detail: `${label}: ${login}` +
        (scopes !== null ? `, scopes: ${scopes || '(none)'}` : '') + (expires ? `, expires ${expires}` : '') });
    } else if (res.status === 401) {
      d.checks.push({ id: 'token', status: 'fail', detail: `${label}: GitHub rejected it (401: revoked or expired)` });
    } else {
      d.checks.push({ id: 'token', status: 'warn', detail: `${label}: GitHub API answered ${res.status}` });
    }
  } catch (err) {
    d.checks.push({ id: 'token', status: 'warn', detail: `${label}: could not reach the GitHub API (${(err as Error).message})` });
  }
  return token;
}

function describeOwner(st: fs.Stats): string {
  return `uid ${st.uid}:${st.gid}, mode ${(st.mode & 0o777).toString(8)}`;
}

function checkCredentialsFile(ctx: Context, d: Diagnosis, token: string | undefined): void {
  const file = path.join(ctx.home, '.git-credentials');
  let st: fs.Stats;
  try { st = fs.statSync(file); } catch {
    d.checks.push({ id: 'credentials-file', status: 'fail', detail: '~/.git-credentials does not exist' });
    d.credsNeedRewrite = true;
    return;
  }
  let content: string;
  try { content = fs.readFileSync(file, 'utf8'); } catch (err) {
    d.checks.push({ id: 'credentials-file', status: 'fail', detail:
      `~/.git-credentials is not readable by uid ${ctx.getuid()} (${describeOwner(st)}): git's store helper finds nothing` });
    d.credsNeedRewrite = true;
    return;
  }
  const problems: string[] = [];
  let status: CheckStatus = 'ok';
  let homeUid: number | undefined;
  try { homeUid = fs.statSync(ctx.home).uid; } catch { /* leave undefined */ }
  if (homeUid !== undefined && st.uid !== homeUid) {
    problems.push(`owned by uid ${st.uid}, not the HOME owner (uid ${homeUid})`);
    status = 'warn';
    d.credsNeedRewrite = true;
  }
  if ((st.mode & 0o077) !== 0) {
    problems.push(`mode ${(st.mode & 0o777).toString(8)} is readable by others (want 600)`);
    status = 'warn';
    d.credsNeedRewrite = true;
  }
  const stored = content.split('\n').map((l) => GITHUB_LINE.exec(l.trim())?.[1]).filter(Boolean) as string[];
  if (stored.length === 0) {
    problems.push('has no github.com line');
    status = 'fail';
    d.credsNeedRewrite = true;
  } else if (token && !stored.includes(token)) {
    problems.push(`github.com token ${maskToken(stored[0]!)} is not the current token ${maskToken(token)}`);
    if (status === 'ok') status = 'warn';
    d.credsNeedRewrite = true;
  }
  d.checks.push({ id: 'credentials-file', status, detail: problems.length
    ? `~/.git-credentials ${problems.join('; ')}`
    : `~/.git-credentials readable, 0600, holds the current github.com token` });
}

function checkHelpers(ctx: Context, d: Diagnosis): void {
  const helpers = getAll(ctx.git, ['--global', '--get-all', 'credential.helper']);
  const fallback = getAll(ctx.git, ['--global', '--get-all', GH_FALLBACK_KEY]);
  const problems: string[] = [];
  let status: CheckStatus = 'ok';
  if (!helpers.includes('store')) {
    problems.push(`global credential.helper is ${helpers.length ? helpers.map((h) => `'${h}'`).join(', ') : 'unset'}, not 'store'`);
    status = 'fail';
    d.needStoreHelper = true;
  }
  if (helpers.length > 1) {
    problems.push(`credential.helper has ${helpers.length} values; the setup scripts' \`git config --global credential.helper store\` exits 5 on that`);
    if (status === 'ok') status = 'warn';
  }
  if (!fallback.includes(GH_FALLBACK_VALUE)) {
    if (ctx.hasCommand('gh')) {
      problems.push(`no github.com gh fallback (${GH_FALLBACK_KEY})`);
      d.needFallback = true;
    } else {
      problems.push('no github.com gh fallback, and gh is not on PATH');
    }
    if (status === 'ok') status = 'warn';
  }
  if (d.inRepo) {
    const local = getAll(ctx.git, ['--local', '--get-all', 'credential.helper']);
    if (local.includes('')) {
      problems.push("this repository resets credential.helper to '' (anonymous mode): git sends no credentials here");
      if (status === 'ok') status = 'warn';
    }
  }
  d.checks.push({ id: 'helper', status, detail: problems.length ? problems.join('; ')
    : `store, then ${GH_FALLBACK_VALUE} for github.com` });
}

function checkRemote(ctx: Context, d: Diagnosis): void {
  if (!d.inRepo) {
    d.checks.push({ id: 'remote', status: 'skip', detail: 'not inside a git repository' });
    return;
  }
  const name = ctx.opts.remote;
  const url = ctx.git(['remote', 'get-url', '--push', name]);
  if (url.status !== 0) {
    d.checks.push({ id: 'remote', status: 'skip', detail: `no remote named '${name}'` });
    return;
  }
  const pushUrl = url.stdout.trim();
  const m = /^https:\/\/([^@/]+)@(github\.com\/.*)$/.exec(pushUrl);
  if (m) {
    const hasPushUrl = getAll(ctx.git, ['--get-all', `remote.${name}.pushurl`]).length > 0;
    d.embeddedUrl = { key: hasPushUrl ? 'pushurl' : 'url', clean: `https://${m[2]}` };
    d.checks.push({ id: 'remote', status: 'warn', detail:
      `${name} push URL embeds credentials (${redact(pushUrl)}); they override the credential helpers and go stale` });
  } else if (/^(git@|ssh:\/\/)/.test(pushUrl)) {
    d.checks.push({ id: 'remote', status: 'ok', detail: `${name} pushes over SSH (${pushUrl}); HTTPS credentials aren't used for it` });
  } else {
    d.checks.push({ id: 'remote', status: 'ok', detail: `${name} → ${redact(pushUrl)}` });
  }
}

function checkLsRemote(ctx: Context, d: Diagnosis): void {
  if (ctx.opts.offline) { d.checks.push({ id: 'ls-remote', status: 'skip', detail: 'skipped (--offline)' }); return; }
  if (!d.inRepo || d.checks.find((c) => c.id === 'remote')?.status === 'skip') {
    d.checks.push({ id: 'ls-remote', status: 'skip', detail: 'no remote to probe' });
    return;
  }
  // ls-remote authenticates like a fetch; a push additionally needs push rights,
  // which the token check's repo scope covers.
  const r = ctx.git(['ls-remote', '--exit-code', ctx.opts.remote, 'HEAD'], { timeoutMs: 20_000 });
  if (r.status === 0) {
    d.checks.push({ id: 'ls-remote', status: 'ok', detail: `git ls-remote ${ctx.opts.remote} authenticated` });
  } else {
    const last = redact(r.stderr.trim().split('\n').filter(Boolean).pop() ?? `exit ${r.status}`);
    d.checks.push({ id: 'ls-remote', status: 'fail', detail: `git ls-remote ${ctx.opts.remote} failed: ${last}` });
  }
}

async function diagnose(ctx: Context): Promise<Diagnosis> {
  const inRepo = ctx.git(['rev-parse', '--is-inside-work-tree']).stdout.trim() === 'true';
  const d: Diagnosis = { checks: [], inRepo, credsNeedRewrite: false, needStoreHelper: false, needFallback: false };
  const token = await checkToken(ctx, d);
  checkCredentialsFile(ctx, d, token);
  checkHelpers(ctx, d);
  checkRemote(ctx, d);
  checkLsRemote(ctx, d);
  return d;
}

/** Temp file + rename: replaces a file we can't write through, as long as we own the directory. */
function writeCredentialsFile(ctx: Context, token: string): void {
  const file = path.join(ctx.home, '.git-credentials');
  let others: string[];
  try {
    others = fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim() && !/@github\.com\/?$/.test(l.trim()));
  } catch {
    const { FORGEJO_TOKEN, FORGEJO_HOST } = ctx.env;
    others = FORGEJO_TOKEN && FORGEJO_HOST ? [`https://oauth2:${FORGEJO_TOKEN}@${FORGEJO_HOST}`] : [];
  }
  const content = [`https://oauth2:${token}@github.com`, ...others].join('\n') + '\n';
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(tmp, content, { mode: 0o600, flag: 'wx' });
    if (ctx.getuid() === 0) {
      const owner = fs.statSync(ctx.home);
      fs.chownSync(tmp, owner.uid, owner.gid);
    }
    fs.renameSync(tmp, file);
  } finally {
    try { fs.unlinkSync(tmp); } catch { /* renamed */ }
  }
}

function fencePath(home: string): string {
  return path.join(home, '.yolo', 'auth-v2-github-purge-fence.json');
}

function applyFixes(ctx: Context, d: Diagnosis): { fixed: string[]; refused: string[] } {
  const fixed: string[] = [];
  const refused: string[] = [];
  if (d.credsNeedRewrite) {
    if (fs.existsSync(fencePath(ctx.home))) {
      refused.push('~/.git-credentials: GitHub access was withdrawn (Auth V2 purge fence is up); not reinstalling the token');
    } else if (!d.acceptedToken) {
      refused.push(ctx.opts.offline
        ? '~/.git-credentials: not rewritten under --offline (the token must be verified first)'
        : '~/.git-credentials: not rewritten, because GitHub did not accept the current token');
    } else {
      try {
        writeCredentialsFile(ctx, d.acceptedToken);
        fixed.push(`rewrote ~/.git-credentials with ${maskToken(d.acceptedToken)}, 0600, owned by the HOME owner`);
      } catch (err) {
        refused.push(`~/.git-credentials: rewrite failed (${(err as Error).message})`);
      }
    }
  }
  if (d.needStoreHelper) {
    // --add keeps any other helper the user configured; a single value becomes 'store'.
    const hasAny = getAll(ctx.git, ['--global', '--get-all', 'credential.helper']).length > 0;
    const r = ctx.git(['config', '--global', ...(hasAny ? ['--add'] : []), 'credential.helper', 'store']);
    (r.status === 0 ? fixed : refused).push(r.status === 0 ? "set global credential.helper 'store'"
      : `credential.helper: git config failed (${r.stderr.trim()})`);
  }
  if (d.needFallback) {
    const r = ctx.git(['config', '--global', GH_FALLBACK_KEY, GH_FALLBACK_VALUE]);
    (r.status === 0 ? fixed : refused).push(r.status === 0 ? `set ${GH_FALLBACK_KEY} '${GH_FALLBACK_VALUE}'`
      : `${GH_FALLBACK_KEY}: git config failed (${r.stderr.trim()})`);
  }
  if (d.embeddedUrl) {
    const { key, clean } = d.embeddedUrl;
    const args = key === 'url' ? ['remote', 'set-url', ctx.opts.remote, clean] : ['remote', 'set-url', '--push', ctx.opts.remote, clean];
    const r = ctx.git(args);
    (r.status === 0 ? fixed : refused).push(r.status === 0 ? `removed credentials from ${ctx.opts.remote} ${key} (${clean})`
      : `remote ${key}: git remote set-url failed (${redact(r.stderr.trim())})`);
  }
  return { fixed, refused };
}

const ICON: Record<CheckStatus, string> = { ok: '✓', warn: '!', fail: '✗', skip: '-' };

export function parseGitDoctorArgs(args: string[]): GitDoctorOptions | { error: string } {
  const opts: GitDoctorOptions = { fix: false, json: false, offline: false, remote: 'origin' };
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--fix') opts.fix = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--offline') opts.offline = true;
    else if (a === '--remote') {
      const v = args[++i];
      if (!v || v.startsWith('-')) return { error: '--remote needs a value' };
      opts.remote = v;
    } else return { error: `unknown option '${a}'` };
  }
  return opts;
}

export async function runGitDoctor(opts: GitDoctorOptions, deps: GitDoctorDeps = {}): Promise<number> {
  const env = deps.env ?? process.env;
  const home = deps.home ?? env.HOME ?? '/home/yolo';
  const cwd = deps.cwd ?? process.cwd();
  const out = deps.stdout ?? ((t) => process.stdout.write(t));
  const ctx: Context = {
    env,
    home,
    git: deps.git ?? defaultGit(cwd, { ...env, HOME: home }),
    fetchImpl: deps.fetchImpl ?? (globalThis.fetch as unknown as GithubFetch),
    getuid: deps.getuid ?? (() => process.getuid?.() ?? -1),
    hasCommand: deps.hasCommand ?? defaultHasCommand(env),
    opts,
  };

  let d = await diagnose(ctx);
  let fixed: string[] = [];
  let refused: string[] = [];
  if (opts.fix) {
    ({ fixed, refused } = applyFixes(ctx, d));
    if (fixed.length) d = await diagnose(ctx);
  }
  const failing = d.checks.filter((c) => c.status === 'fail').length;

  if (opts.json) {
    out(JSON.stringify({ checks: d.checks, fixed, refused }, null, 2) + '\n');
    return failing ? 1 : 0;
  }
  const width = Math.max(...d.checks.map((c) => c.id.length));
  const lines = ['yolo git doctor', ...d.checks.map((c) => `  ${ICON[c.status]} ${c.id.padEnd(width)}  ${c.detail}`)];
  if (fixed.length) lines.push('', 'Fixed:', ...fixed.map((f) => `  - ${f}`));
  if (refused.length) lines.push('', 'Not fixed:', ...refused.map((f) => `  - ${f}`));
  const warns = d.checks.filter((c) => c.status === 'warn').length;
  lines.push('');
  if (failing) {
    lines.push(`${failing} failing check${failing > 1 ? 's' : ''}.` + (opts.fix ? '' : ' Run `yolo git doctor --fix` to repair.'));
  } else if (warns) {
    lines.push(`No failures; ${warns} warning${warns > 1 ? 's' : ''}.` + (opts.fix ? '' : ' `yolo git doctor --fix` repairs the fixable ones.'));
  } else {
    lines.push('git can authenticate to github.com.');
  }
  out(lines.join('\n') + '\n');
  return failing ? 1 : 0;
}

export async function runGitCmd(args: string[], deps: GitDoctorDeps = {}): Promise<number> {
  const err = deps.stderr ?? ((t) => process.stderr.write(t));
  const out = deps.stdout ?? ((t) => process.stdout.write(t));
  if (args[0] !== 'doctor') {
    err(args[0] ? `yolo git: unknown subcommand '${args[0]}'\n${GIT_DOCTOR_HELP}` : `yolo git: requires a subcommand (doctor)\n${GIT_DOCTOR_HELP}`);
    return 64;
  }
  if (args.includes('--help') || args.includes('-h')) { out(GIT_DOCTOR_HELP); return 0; }
  const opts = parseGitDoctorArgs(args.slice(1));
  if ('error' in opts) { err(`yolo git doctor: ${opts.error}\n${GIT_DOCTOR_HELP}`); return 64; }
  return runGitDoctor(opts, deps);
}
