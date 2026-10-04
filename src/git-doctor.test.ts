/**
 * git-doctor tests. Real git against a temp HOME and repository; the GitHub
 * API and `git ls-remote` are stubbed, so nothing leaves the machine.
 *
 * Coverage:
 *   - a healthy setup passes every check (exit 0)
 *   - an unreadable ~/.git-credentials fails; --fix replaces it (0600, current
 *     token, forge line from the env) and exit becomes 0
 *   - --fix refuses to rewrite under the Auth V2 purge fence, with a rejected
 *     token, and under --offline
 *   - a stale token in the store warns; --fix rewrites it keeping other hosts
 *   - missing store helper / gh fallback fail/warn; --fix sets both
 *   - a gh fallback that bypasses the wrapper (/usr/bin/gh, a '' reset, a bare
 *     gh) is flagged; --fix leaves exactly one wrapper value
 *   - credentials embedded in the remote URL warn; --fix strips them
 *   - no raw token ever appears in the output
 *   - resolveToken follows the gh wrapper's precedence; maskToken/redact; arg parsing
 */

import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { spawnSync } from 'node:child_process';

import {
  runGitDoctor,
  runGitCmd,
  parseGitDoctorArgs,
  resolveToken,
  maskToken,
  redact,
  type GitDoctorOptions,
  type GithubFetch,
  type GitRunner,
} from './git-doctor.js';

const TOKEN = 'ghp_currentTOKEN0000000000000000000001';
const OLD = 'ghp_staleTOKEN00000000000000000000000002';
const isRoot = process.getuid?.() === 0;

let root: string;
let home: string;
let repo: string;
let env: Record<string, string | undefined>;
/** Stand-ins for the token-refreshing wrapper and the real gh binary. */
let wrapper: string;
let realGh: string;

function gitIn(cwd: string, args: string[]) {
  const r = spawnSync('git', args, { cwd, env: { ...env, GIT_TERMINAL_PROMPT: '0' } as NodeJS.ProcessEnv, encoding: 'utf8' });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** Real git, except `ls-remote`, which answers `lsRemote`. */
function gitWith(lsRemote: { status: number; stderr?: string } = { status: 0 }): GitRunner {
  return (args) => args[0] === 'ls-remote'
    ? { status: lsRemote.status, stdout: '', stderr: lsRemote.stderr ?? '' }
    : gitIn(repo, args);
}

function github(status = 200): GithubFetch {
  return async () => ({
    status,
    headers: { get: (h: string) => ({ 'x-oauth-scopes': 'repo, workflow', 'github-authentication-token-expiration': '2026-11-20 23:00:33 UTC' } as Record<string, string>)[h] ?? null },
    json: async () => ({ login: 'octo' }),
  });
}

async function run(opts: Partial<GitDoctorOptions>, extra: { fetchImpl?: GithubFetch; git?: GitRunner; hasGh?: boolean; ghOnPath?: string; noWrapper?: boolean } = {}) {
  const hasGh = extra.hasGh ?? true;
  let output = '';
  const code = await runGitDoctor({ fix: false, json: false, offline: false, remote: 'origin', ...opts }, {
    env, home, cwd: repo,
    git: extra.git ?? gitWith(),
    fetchImpl: extra.fetchImpl ?? github(),
    which: (name) => (name === 'gh' && hasGh ? extra.ghOnPath ?? realGh : undefined),
    ghWrapper: hasGh && !extra.noWrapper ? wrapper : path.join(root, 'missing', 'gh'),
    stdout: (t) => { output += t; },
  });
  return { code, output };
}

async function runJson(opts: Partial<GitDoctorOptions>, extra: Parameters<typeof run>[1] = {}) {
  const { code, output } = await run({ ...opts, json: true }, extra);
  const parsed = JSON.parse(output) as { checks: Array<{ id: string; status: string; detail: string }>; fixed: string[]; refused: string[] };
  const status = Object.fromEntries(parsed.checks.map((c) => [c.id, c.status]));
  return { code, output, status, ...parsed };
}

const credFile = () => path.join(home, '.git-credentials');
const FALLBACK_KEY = 'credential.https://github.com.helper';
const wrapperValue = () => `!${wrapper} auth git-credential`;
const fallbackValues = () => gitIn(repo, ['config', '--global', '--get-all', FALLBACK_KEY]).stdout;

function healthySetup() {
  fs.writeFileSync(credFile(), `https://oauth2:${TOKEN}@github.com\n`, { mode: 0o600 });
  gitIn(repo, ['config', '--global', 'credential.helper', 'store']);
  gitIn(repo, ['config', '--global', FALLBACK_KEY, wrapperValue()]);
}

beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'git-doctor-'));
  home = path.join(root, 'home');
  repo = path.join(root, 'repo');
  fs.mkdirSync(home);
  for (const dir of ['wrapper', 'usr-bin']) fs.mkdirSync(path.join(root, dir));
  wrapper = path.join(root, 'wrapper', 'gh');
  realGh = path.join(root, 'usr-bin', 'gh');
  for (const f of [wrapper, realGh]) fs.writeFileSync(f, '#!/bin/sh\n', { mode: 0o755 });
  env = { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1', GH_TOKEN: TOKEN };
  gitIn(root, ['init', '-q', repo]);
  gitIn(repo, ['remote', 'add', 'origin', 'https://github.com/acme/app.git']);
});

afterEach(() => {
  try { fs.chmodSync(credFile(), 0o600); } catch { /* absent */ }
  fs.rmSync(root, { recursive: true, force: true });
});

describe('yolo git doctor', () => {
  it('passes a healthy setup', async () => {
    healthySetup();
    const { code, status, output } = await runJson({});
    assert.equal(code, 0);
    assert.deepEqual(status, { token: 'ok', 'credentials-file': 'ok', helper: 'ok', remote: 'ok', 'ls-remote': 'ok' });
    assert.ok(!output.includes(TOKEN));
  });

  it('reports a failing ls-remote with its redacted error', async () => {
    healthySetup();
    const { code, checks } = await runJson({}, { git: gitWith({ status: 128, stderr: `fatal: could not read Username for 'https://github.com': terminal prompts disabled\n` }) });
    assert.equal(code, 1);
    assert.match(checks.find((c) => c.id === 'ls-remote')!.detail, /could not read Username/);
  });

  it('replaces an unreadable ~/.git-credentials with --fix, keeping the forge line', { skip: isRoot && 'root reads mode 000' }, async () => {
    healthySetup();
    fs.chmodSync(credFile(), 0o000);
    env.FORGEJO_TOKEN = 'forge_tok';
    env.FORGEJO_HOST = 'git.example.test';

    const before = await runJson({});
    assert.equal(before.code, 1);
    assert.equal(before.status['credentials-file'], 'fail');
    assert.match(before.checks.find((c) => c.id === 'credentials-file')!.detail, /not readable/);

    const after = await run({ fix: true });
    assert.equal(after.code, 0, after.output);
    assert.match(after.output, /rewrote ~\/\.git-credentials/);
    assert.equal(fs.statSync(credFile()).mode & 0o777, 0o600);
    assert.equal(fs.readFileSync(credFile(), 'utf8'),
      `https://oauth2:${TOKEN}@github.com\nhttps://oauth2:forge_tok@git.example.test\n`);
    assert.ok(!after.output.includes(TOKEN));
    assert.deepEqual(fs.readdirSync(home).filter((f) => f.endsWith('.tmp')), []);
  });

  it('does not reinstall the token while the Auth V2 purge fence is up', async () => {
    fs.mkdirSync(path.join(home, '.yolo'));
    fs.writeFileSync(path.join(home, '.yolo', 'auth-v2-github-purge-fence.json'), '{"fenced":true}');
    const { code, refused } = await runJson({ fix: true });
    assert.equal(code, 1);
    assert.match(refused.join('\n'), /withdrawn/);
    assert.equal(fs.existsSync(credFile()), false);
  });

  it('does not write a token GitHub rejected', async () => {
    const { code, status, refused } = await runJson({ fix: true }, { fetchImpl: github(401) });
    assert.equal(code, 1);
    assert.equal(status.token, 'fail');
    assert.match(refused.join('\n'), /did not accept/);
    assert.equal(fs.existsSync(credFile()), false);
  });

  it('does not write under --offline', async () => {
    const { status, refused } = await runJson({ fix: true, offline: true });
    assert.equal(status.token, 'skip');
    assert.equal(status['ls-remote'], 'skip');
    assert.match(refused.join('\n'), /--offline/);
    assert.equal(fs.existsSync(credFile()), false);
  });

  it('warns on a stale store token; --fix rewrites it and keeps other hosts', async () => {
    healthySetup();
    fs.writeFileSync(credFile(), `https://oauth2:${OLD}@github.com\nhttps://oauth2:forge_tok@git.example.test\n`);
    const before = await runJson({});
    assert.equal(before.code, 0);
    assert.equal(before.status['credentials-file'], 'warn');
    assert.ok(!before.output.includes(OLD));

    const after = await runJson({ fix: true });
    assert.equal(after.status['credentials-file'], 'ok');
    assert.equal(fs.readFileSync(credFile(), 'utf8'),
      `https://oauth2:${TOKEN}@github.com\nhttps://oauth2:forge_tok@git.example.test\n`);
  });

  it('sets the store helper and the gh fallback with --fix', async () => {
    fs.writeFileSync(credFile(), `https://oauth2:${TOKEN}@github.com\n`, { mode: 0o600 });
    const before = await runJson({});
    assert.equal(before.status.helper, 'fail');

    const after = await runJson({ fix: true });
    assert.equal(after.status.helper, 'ok');
    assert.equal(gitIn(repo, ['config', '--global', 'credential.helper']).stdout.trim(), 'store');
    assert.equal(fallbackValues(), `${wrapperValue()}\n`);
  });

  it("flags what `gh auth setup-git` writes (a '' reset + the real gh); --fix points it at the wrapper", async () => {
    healthySetup();
    gitIn(repo, ['config', '--global', '--unset-all', FALLBACK_KEY]);
    gitIn(repo, ['config', '--global', '--add', FALLBACK_KEY, '']);
    gitIn(repo, ['config', '--global', '--add', FALLBACK_KEY, `!${realGh} auth git-credential`]);
    gitIn(repo, ['config', '--global', '--add', FALLBACK_KEY, 'cache']);

    const before = await runJson({});
    assert.equal(before.code, 1);
    assert.equal(before.status.helper, 'fail');
    const detail = before.checks.find((c) => c.id === 'helper')!.detail;
    assert.match(detail, /'' reset/);
    assert.match(detail, /bypasses the token-refreshing wrapper/);

    const after = await runJson({ fix: true });
    assert.equal(after.code, 0, after.output);
    assert.equal(after.status.helper, 'ok');
    assert.equal(fallbackValues(), `cache\n${wrapperValue()}\n`);

    const again = await runJson({ fix: true });
    assert.deepEqual(again.fixed, []);
    assert.equal(fallbackValues(), `cache\n${wrapperValue()}\n`);
  });

  it('flags a bare gh that resolves to the real binary; --fix rewrites it', async () => {
    healthySetup();
    gitIn(repo, ['config', '--global', FALLBACK_KEY, '!gh auth git-credential']);
    const before = await runJson({});
    assert.equal(before.status.helper, 'fail');
    assert.match(before.checks.find((c) => c.id === 'helper')!.detail, new RegExp(`resolves to ${realGh}`));

    const after = await runJson({ fix: true });
    assert.equal(after.status.helper, 'ok');
    assert.equal(fallbackValues(), `${wrapperValue()}\n`);
  });

  it('warns on a bare gh that resolves to the wrapper only through PATH', async () => {
    healthySetup();
    gitIn(repo, ['config', '--global', FALLBACK_KEY, '!gh auth git-credential']);
    const { code, status, checks } = await runJson({}, { ghOnPath: wrapper });
    assert.equal(code, 0);
    assert.equal(status.helper, 'warn');
    assert.match(checks.find((c) => c.id === 'helper')!.detail, /depends on PATH/);
  });

  it('accepts a bare gh where no wrapper is installed', async () => {
    healthySetup();
    gitIn(repo, ['config', '--global', FALLBACK_KEY, '!gh auth git-credential']);
    const { status } = await runJson({}, { noWrapper: true });
    assert.equal(status.helper, 'ok');
  });

  it('does not add the gh fallback when gh is not on PATH', async () => {
    fs.writeFileSync(credFile(), `https://oauth2:${TOKEN}@github.com\n`, { mode: 0o600 });
    gitIn(repo, ['config', '--global', 'credential.helper', 'store']);
    const { status, checks } = await runJson({ fix: true }, { hasGh: false });
    assert.equal(status.helper, 'warn');
    assert.match(checks.find((c) => c.id === 'helper')!.detail, /gh is not on PATH/);
    assert.equal(gitIn(repo, ['config', '--global', FALLBACK_KEY]).status, 1);
  });

  it("flags a repository-level '' helper reset (anonymous mode)", async () => {
    healthySetup();
    gitIn(repo, ['config', 'credential.helper', '']);
    const { status, checks } = await runJson({});
    assert.equal(status.helper, 'warn');
    assert.match(checks.find((c) => c.id === 'helper')!.detail, /anonymous mode/);
  });

  it('strips credentials embedded in the remote URL with --fix, without printing them', async () => {
    healthySetup();
    gitIn(repo, ['remote', 'set-url', 'origin', `https://x-access-token:${OLD}@github.com/acme/app.git`]);
    const before = await runJson({});
    assert.equal(before.status.remote, 'warn');
    assert.ok(!before.output.includes(OLD));

    const after = await runJson({ fix: true });
    assert.equal(after.status.remote, 'ok');
    assert.equal(gitIn(repo, ['remote', 'get-url', 'origin']).stdout.trim(), 'https://github.com/acme/app.git');
    assert.ok(!after.output.includes(OLD));
  });
});

describe('resolveToken', () => {
  it("prefers ~/.yolo-env's GH_TOKEN over the env, like the gh wrapper", () => {
    fs.writeFileSync(path.join(home, '.yolo-env'), `export GH_TOKEN='${OLD}'\nexport OTHER='x'\n`);
    assert.deepEqual(resolveToken({ GH_TOKEN: TOKEN }, home), { token: OLD, source: 'GH_TOKEN (~/.yolo-env)' });
  });
  it('falls back to GITHUB_TOKEN, then reports none', () => {
    assert.deepEqual(resolveToken({ GITHUB_TOKEN: TOKEN }, home), { token: TOKEN, source: 'GITHUB_TOKEN (env)' });
    assert.deepEqual(resolveToken({}, home), { source: 'none' });
  });
});

describe('masking and args', () => {
  it('masks tokens to prefix…last4', () => {
    assert.equal(maskToken(TOKEN), 'ghp_…0001');
    assert.equal(maskToken('short'), '****');
    assert.equal(redact(`https://oauth2:${TOKEN}@github.com x ${OLD}`), 'https://oauth2:****@github.com x ghp_…0002');
  });
  it('parses options and rejects unknown ones', () => {
    assert.deepEqual(parseGitDoctorArgs(['--fix', '--remote', 'upstream']), { fix: true, json: false, offline: false, remote: 'upstream' });
    assert.deepEqual(parseGitDoctorArgs(['--remote']), { error: '--remote needs a value' });
    assert.deepEqual(parseGitDoctorArgs(['--bogus']), { error: "unknown option '--bogus'" });
  });
  it('exits 64 on an unknown subcommand', async () => {
    let err = '';
    assert.equal(await runGitCmd(['nope'], { stderr: (t) => { err += t; } }), 64);
    assert.match(err, /unknown subcommand 'nope'/);
  });
});
