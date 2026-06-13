/**
 * deploy-cli — arg parsing + subcommand dispatch for `yolo deploy`
 * (docs/MANAGED_HOSTING_CLI_SPEC.md §1).
 *
 *   yolo deploy [--env <staging|prod>] [--dry-run] [--json]   ← bare = ship
 *   yolo deploy init [--slug <slug>] [--type <static|worker>]
 *   yolo deploy status [--json]
 *   yolo deploy logs [--tail] [--since <dur>] [--json]
 *   yolo deploy rollback [releaseId] [--json]
 *   (yolo deploy db query — Phase 2, deliberately NOT wired)
 *
 * Output contract (spec §4/§5):
 *   - Progress lines `deploy: …` go to stdout, or stderr under --json (one
 *     final JSON object on stdout is the machine-readable result).
 *   - Failures: single structured stderr line `FAIL [<reason>]: <msg> | hint: …`
 *   - awaiting-approval: `PENDING [awaiting-approval]: …` (NOT FAIL) + exit 3
 *     + the approval URL + the "do NOT rerun" hint. Two independent signals
 *     so neither prefix-matching nor exit-code-matching agents retry-loop.
 *
 * Exit codes are EXACTLY spec §5 via deploy-ship's `exitCodeForFailure`:
 * 0 ok / 64 usage / 78 env / 1 local / 2 backend-rejected / 3 pending / 4 network.
 */

import * as path from 'node:path';

import {
  runDeployShip,
  exitCodeForFailure,
  formatShipSuccess,
  formatPending,
  formatFail,
  type DeployShipDeps,
  type DeployShipResult,
} from './deploy-ship.js';
import {
  resolveDeployContext,
  createProject,
  getProjectStatus,
  rollbackProject,
  getLogs,
  tailLogs,
  type DeployContext,
  type DeployFetchLike,
} from './deploy-client.js';
import { readDeployConfig, writeDeployConfig, type DeployConfig } from './deploy-config.js';
import type { ReadFileImpl } from './auth-context.js';

// ─── Injectable surface ───────────────────────────────────────────────────

export interface DeployIo {
  out: (text: string) => void;
  err: (text: string) => void;
}

export interface DeployCliDeps {
  cwd?: string;
  env?: Record<string, string | undefined>;
  io?: DeployIo;
  readFileImpl?: ReadFileImpl;
  fetchImpl?: DeployFetchLike;
  runShipImpl?: typeof runDeployShip;
  readDeployConfigImpl?: typeof readDeployConfig;
  writeDeployConfigImpl?: typeof writeDeployConfig;
  createProjectImpl?: typeof createProject;
  getProjectStatusImpl?: typeof getProjectStatus;
  rollbackProjectImpl?: typeof rollbackProject;
  getLogsImpl?: typeof getLogs;
  tailLogsImpl?: typeof tailLogs;
  shipDeps?: DeployShipDeps;
}

const USAGE = [
  'Usage: yolo deploy [--env <staging|prod>] [--dry-run] [--json]',
  '       yolo deploy init [--slug <slug>] [--type <static|worker>]',
  '       yolo deploy status [--json]',
  '       yolo deploy logs [--tail] [--since <dur>] [--json]',
  '       yolo deploy rollback [releaseId] [--json]',
].join('\n');

// ─── Entry ────────────────────────────────────────────────────────────────

/** `args` = everything after the `deploy` verb. */
export async function runDeployCmd(args: string[], deps: DeployCliDeps = {}): Promise<number> {
  const io = deps.io ?? defaultIo();
  const sub = args[0];

  if (sub === '--help' || sub === '-h') {
    io.out(`${USAGE}\n`);
    return 0;
  }
  if (sub === 'init') return runInitCmd(args.slice(1), deps, io);
  if (sub === 'status') return runStatusCmd(args.slice(1), deps, io);
  if (sub === 'logs') return runLogsCmd(args.slice(1), deps, io);
  if (sub === 'rollback') return runRollbackCmd(args.slice(1), deps, io);
  if (sub === 'db') {
    io.err('yolo deploy: `db query` is not available yet (Phase 2)\n');
    return 64;
  }
  if (sub && !sub.startsWith('--')) {
    io.err(`yolo deploy: unknown subcommand '${sub}'\n${USAGE}\n`);
    return 64;
  }
  return runShipCmd(args, deps, io);
}

// ─── Bare ship ────────────────────────────────────────────────────────────

interface ParsedShipArgs {
  ok: true;
  envFlag: 'staging' | 'prod';
  dryRun: boolean;
  jsonOutput: boolean;
}

interface ParseError {
  ok: false;
  message: string;
}

export function parseShipArgs(args: string[]): ParsedShipArgs | ParseError {
  let envFlag: 'staging' | 'prod' = 'staging';
  let dryRun = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--env') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--env requires a value (staging|prod)' };
      if (v !== 'staging' && v !== 'prod') return { ok: false, message: `--env must be 'staging' or 'prod' (got '${v}')` };
      envFlag = v;
    } else if (a.startsWith('--env=')) {
      const v = a.slice('--env='.length);
      if (v !== 'staging' && v !== 'prod') return { ok: false, message: `--env must be 'staging' or 'prod' (got '${v}')` };
      envFlag = v;
    } else if (a === '--dry-run') {
      dryRun = true;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, envFlag, dryRun, jsonOutput };
}

async function runShipCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseShipArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy: ${parsed.message}\n${USAGE}\n`);
    return 64;
  }
  // Under --json, progress lines route to stderr; the single final JSON
  // object on stdout is the machine-readable result (spec §4).
  const progressSink = parsed.jsonOutput ? io.err : io.out;
  const ship = deps.runShipImpl ?? runDeployShip;
  const result = await ship({
    cwd: deps.cwd,
    envFlag: parsed.envFlag,
    dryRun: parsed.dryRun,
    env: deps.env,
    readFileImpl: deps.readFileImpl,
    fetchImpl: deps.fetchImpl,
    progress: (line) => progressSink(`${line}\n`),
    deps: deps.shipDeps,
  });

  if (result.ok) {
    io.out(parsed.jsonOutput ? `${formatJsonResult(result)}\n` : `${formatShipSuccess(result)}\n`);
    return 0;
  }
  if (result.kind === 'awaiting-approval' && 'approvalId' in result) {
    // NOT an error — PENDING prefix + exit 3, never FAIL (spec §5).
    if (parsed.jsonOutput) {
      io.out(
        `${formatJsonResult({
          ...result,
          hint: "poll 'yolo deploy status'; do NOT rerun 'yolo deploy' — the bundle is already staged",
        })}\n`,
      );
    } else {
      io.err(`${formatPending(result)}\n`);
    }
    return 3;
  }
  io.err(parsed.jsonOutput ? `${formatJsonResult(result)}\n` : `${formatFail(result)}\n`);
  return exitCodeForFailure(result.kind);
}

// ─── init ─────────────────────────────────────────────────────────────────

interface ParsedInitArgs {
  ok: true;
  slug?: string;
  type?: 'static' | 'worker';
}

export function parseInitArgs(args: string[]): ParsedInitArgs | ParseError {
  let slug: string | undefined;
  let type: 'static' | 'worker' | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--slug') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--slug requires a value' };
      slug = v;
    } else if (a.startsWith('--slug=')) {
      slug = a.slice('--slug='.length);
    } else if (a === '--type') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--type requires a value (static|worker)' };
      if (v !== 'static' && v !== 'worker') return { ok: false, message: `--type must be 'static' or 'worker' (got '${v}')` };
      type = v;
    } else if (a.startsWith('--type=')) {
      const v = a.slice('--type='.length);
      if (v !== 'static' && v !== 'worker') return { ok: false, message: `--type must be 'static' or 'worker' (got '${v}')` };
      type = v;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, slug, type };
}

async function runInitCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseInitArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy init: ${parsed.message}\nUsage: yolo deploy init [--slug <slug>] [--type <static|worker>]\n`);
    return 64;
  }
  const cwd = deps.cwd ?? process.cwd();
  const readConfig = deps.readDeployConfigImpl ?? readDeployConfig;
  const writeConfig = deps.writeDeployConfigImpl ?? writeDeployConfig;

  const readResult = readConfig(cwd);
  if (!readResult.ok) {
    // Never silently clobber a malformed/invalid link file.
    io.err(`${formatFail({ kind: readResult.kind, message: readResult.message })}\n`);
    return exitCodeForFailure(readResult.kind);
  }
  const existing: DeployConfig | null = readResult.config;
  if (existing?.projectId) {
    // Idempotent: a committed link means future sessions ship to the SAME
    // project instead of forking a new slug — never silently re-create.
    io.out(
      `OK: already linked to project ${existing.projectId}${existing.slug ? ` (slug ${existing.slug})` : ''} — .yolo/deploy.json left unchanged\n`,
    );
    return 0;
  }

  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const create = deps.createProjectImpl ?? createProject;
  const created = await create(auth.context, {
    name: parsed.slug ?? path.basename(cwd),
    ...(parsed.slug ? { slug: parsed.slug } : {}),
  });
  if (!created.ok) {
    io.err(`${formatFail(created)}\n`);
    return exitCodeForFailure(created.kind);
  }

  const raw = created.value as Record<string, unknown>;
  const project = (raw.project && typeof raw.project === 'object' ? raw.project : raw) as Record<string, unknown>;
  const projectId = str(project.projectId) ?? str(project.id) ?? str(project._id);
  const slug = str(project.slug) ?? parsed.slug;
  if (!projectId) {
    io.err(`${formatFail({ kind: 'invalid-response', message: 'create-project response missing a project id' })}\n`);
    return 2;
  }

  const config: DeployConfig = {
    ...(existing ?? {}),
    $version: 1,
    projectId,
    ...(slug ? { slug } : {}),
    ...(parsed.type ? { type: parsed.type } : {}),
  };
  try {
    writeConfig(cwd, config);
  } catch (err) {
    io.err(
      `${formatFail({ kind: 'config-write-failed', message: `failed to write .yolo/deploy.json: ${describeError(err)}` })}\n`,
    );
    return 1;
  }

  io.out(`OK: linked project ${projectId}${slug ? ` (slug ${slug})` : ''} — wrote .yolo/deploy.json\n`);
  io.out('note: .yolo/deploy.json is committed by design; it contains no secrets — commit it so future sessions, teammates, and CI ship to the same project.\n');
  return 0;
}

// ─── status ───────────────────────────────────────────────────────────────

async function runStatusCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseFlagOnlyArgs(args, 'status');
  if (!parsed.ok) {
    io.err(`yolo deploy status: ${parsed.message}\nUsage: yolo deploy status [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const status = deps.getProjectStatusImpl ?? getProjectStatus;
  const result = await status(auth.context, linked.projectId);
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  io.out(parsed.jsonOutput ? `${JSON.stringify(result.value, null, 2)}\n` : `${formatStatusSummary(result.value, linked.projectId)}\n`);
  return 0;
}

export function formatStatusSummary(value: unknown, projectId: string): string {
  const raw = (value && typeof value === 'object' ? value : {}) as Record<string, unknown>;
  const project = (raw.project && typeof raw.project === 'object' ? raw.project : raw) as Record<string, unknown>;
  const lines: string[] = [];
  const name = str(project.slug) ?? str(project.name) ?? projectId;
  lines.push(`project ${name} (${str(project.status) ?? 'unknown'})`);
  const hostname = str(project.hostname) ?? str(project.url);
  if (hostname) lines.push(`url: ${hostname.startsWith('http') ? hostname : `https://${hostname}`}`);

  const current = (raw.currentRelease && typeof raw.currentRelease === 'object' ? raw.currentRelease : undefined) as
    | Record<string, unknown>
    | undefined;
  if (current) {
    lines.push(`release ${releaseLabel(current)}: ${str(current.status) ?? 'unknown'} (current)`);
  }
  const recent = Array.isArray(raw.recentReleases) ? raw.recentReleases : Array.isArray(raw.releases) ? raw.releases : [];
  for (const entry of recent) {
    if (!entry || typeof entry !== 'object') continue;
    const release = entry as Record<string, unknown>;
    if (current && releaseLabel(release) === releaseLabel(current)) continue;
    lines.push(`release ${releaseLabel(release)}: ${str(release.status) ?? 'unknown'}`);
  }
  return lines.join('\n');
}

function releaseLabel(release: Record<string, unknown>): string {
  return str(release.releaseId) ?? str(release.id) ?? str(release._id) ?? (release.seq !== undefined ? `r${String(release.seq)}` : '(unknown)');
}

// ─── logs ─────────────────────────────────────────────────────────────────

interface ParsedLogsArgs {
  ok: true;
  tail: boolean;
  sinceMinutes?: number;
  jsonOutput: boolean;
}

export function parseLogsArgs(args: string[]): ParsedLogsArgs | ParseError {
  let tail = false;
  let sinceMinutes: number | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--tail') {
      tail = true;
    } else if (a === '--since') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--since requires a duration value (e.g. 30m, 2h, 1d)' };
      const minutes = parseSinceMinutes(v);
      if (minutes === undefined) return { ok: false, message: `invalid --since duration '${v}' (expected e.g. 30m, 2h, 1d)` };
      sinceMinutes = minutes;
    } else if (a.startsWith('--since=')) {
      const v = a.slice('--since='.length);
      const minutes = parseSinceMinutes(v);
      if (minutes === undefined) return { ok: false, message: `invalid --since duration '${v}' (expected e.g. 30m, 2h, 1d)` };
      sinceMinutes = minutes;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, tail, sinceMinutes, jsonOutput };
}

/** '30m' | '2h' | '1d' | bare minutes → minutes. */
export function parseSinceMinutes(raw: string): number | undefined {
  const match = /^(\d+)\s*(m|min|mins|h|hr|hrs|d)?$/.exec(raw.trim());
  if (!match) return undefined;
  const n = Number(match[1]);
  if (!Number.isInteger(n) || n <= 0) return undefined;
  const unit = match[2] ?? 'm';
  if (unit.startsWith('h')) return n * 60;
  if (unit === 'd') return n * 1440;
  return n;
}

async function runLogsCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseLogsArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy logs: ${parsed.message}\nUsage: yolo deploy logs [--tail] [--since <dur>] [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  if (parsed.tail) {
    const tailImpl = deps.tailLogsImpl ?? tailLogs;
    const result = await tailImpl(auth.context, linked.projectId, { sinceMinutes: parsed.sinceMinutes }, (line) => {
      io.out(`${parsed.jsonOutput ? line : formatLogLine(line)}\n`);
    });
    if (!result.ok) {
      io.err(`${formatFail(result)}\n`);
      return exitCodeForFailure(result.kind);
    }
    return 0;
  }

  const logsImpl = deps.getLogsImpl ?? getLogs;
  const result = await logsImpl(auth.context, linked.projectId, { sinceMinutes: parsed.sinceMinutes });
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  const raw = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
  const entries = Array.isArray(result.value)
    ? (result.value as unknown[])
    : Array.isArray(raw.logs)
      ? (raw.logs as unknown[])
      : Array.isArray(raw.entries)
        ? (raw.entries as unknown[])
        : [];
  if (entries.length === 0) {
    io.out('(no log entries)\n');
    return 0;
  }
  for (const entry of entries) io.out(`${formatLogEntry(entry)}\n`);
  return 0;
}

function formatLogLine(rawLine: string): string {
  try {
    return formatLogEntry(JSON.parse(rawLine));
  } catch {
    return rawLine;
  }
}

function formatLogEntry(entry: unknown): string {
  if (typeof entry === 'string') return entry;
  if (!entry || typeof entry !== 'object') return JSON.stringify(entry);
  const e = entry as Record<string, unknown>;
  const ts = str(e.timestamp) ?? str(e.ts) ?? str(e.time);
  const level = str(e.level);
  const message = str(e.message) ?? str(e.msg) ?? JSON.stringify(entry);
  return [ts ? `[${ts}]` : undefined, level, message].filter(Boolean).join(' ');
}

// ─── rollback ─────────────────────────────────────────────────────────────

interface ParsedRollbackArgs {
  ok: true;
  releaseId?: string;
  jsonOutput: boolean;
}

export function parseRollbackArgs(args: string[]): ParsedRollbackArgs | ParseError {
  let releaseId: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!releaseId) {
      releaseId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, releaseId, jsonOutput };
}

async function runRollbackCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseRollbackArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy rollback: ${parsed.message}\nUsage: yolo deploy rollback [releaseId] [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const rollback = deps.rollbackProjectImpl ?? rollbackProject;
  const result = await rollback(auth.context, linked.projectId, parsed.releaseId ? { releaseId: parsed.releaseId } : {});
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  const raw = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
  const release = (raw.release && typeof raw.release === 'object' ? raw.release : raw) as Record<string, unknown>;
  const releaseId = str(release.releaseId) ?? str(release.id) ?? parsed.releaseId ?? '(previous live)';
  const url = str(raw.url) ?? str(release.url);
  io.out(`OK: rolled back ${linked.slug ?? linked.projectId} to release ${releaseId}${url ? ` → ${url}` : ''}\n`);
  return 0;
}

// ─── Shared helpers ───────────────────────────────────────────────────────

function parseFlagOnlyArgs(args: string[], _name: string): { ok: true; jsonOutput: boolean } | ParseError {
  let jsonOutput = false;
  for (const a of args) {
    if (a === '--json') jsonOutput = true;
    else if (a.startsWith('--')) return { ok: false, message: `unknown option: ${a}` };
    else return { ok: false, message: `unexpected positional argument: ${a}` };
  }
  return { ok: true, jsonOutput };
}

function requireLink(
  deps: DeployCliDeps,
  io: DeployIo,
): { ok: true; projectId: string; slug?: string } | { ok: false; exitCode: number } {
  const cwd = deps.cwd ?? process.cwd();
  const readConfig = deps.readDeployConfigImpl ?? readDeployConfig;
  const readResult = readConfig(cwd);
  if (!readResult.ok) {
    io.err(`${formatFail({ kind: readResult.kind, message: readResult.message })}\n`);
    return { ok: false, exitCode: exitCodeForFailure(readResult.kind) };
  }
  const config: DeployConfig | null = readResult.config;
  if (!config?.projectId) {
    io.err(
      `${formatFail({
        kind: 'not-linked',
        message: 'this directory is not linked to a hosting project (.yolo/deploy.json missing or has no projectId)',
        hint: "run 'yolo deploy init' to create or link a hosting project",
      })}\n`,
    );
    return { ok: false, exitCode: exitCodeForFailure('not-linked') };
  }
  return { ok: true, projectId: config.projectId, slug: config.slug };
}

function resolveAuth(deps: DeployCliDeps): { ok: true; context: DeployContext } | { ok: false; message: string } {
  const resolved = resolveDeployContext(deps.env ?? process.env, deps.readFileImpl, deps.fetchImpl);
  if (!resolved.ok) return { ok: false, message: resolved.message };
  return { ok: true, context: resolved.context };
}

/**
 * Serialize a result for --json output: strip the internal `ok` discriminant
 * (the exit code conveys success/failure; `kind` is enough for branching) —
 * the cli.ts `formatJsonResult` convention.
 */
function formatJsonResult(result: DeployShipResult | Record<string, unknown>): string {
  const { ok: _ok, ...payload } = result as { ok?: boolean } & Record<string, unknown>;
  return JSON.stringify(payload, null, 2);
}

function defaultIo(): DeployIo {
  return {
    out: (text) => process.stdout.write(text),
    err: (text) => process.stderr.write(text),
  };
}

function str(value: unknown): string | undefined {
  return typeof value === 'string' && value.length > 0 ? value : undefined;
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
