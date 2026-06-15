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
import { statSync } from 'node:fs';

/** Path kind for `validate`: a file, a directory, something else, or missing. */
export type PathKind = 'file' | 'dir' | 'other' | 'missing';

function defaultStatPath(p: string): PathKind {
  try {
    const s = statSync(p);
    return s.isFile() ? 'file' : s.isDirectory() ? 'dir' : 'other';
  } catch {
    return 'missing';
  }
}

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
  listProjects,
  rollbackProject,
  renameProject,
  addAlias,
  removeAlias,
  setRedirect,
  deleteProject,
  cloneProject,
  getLogs,
  tailLogs,
  queryD1,
  type DeployClientFailure,
  type DeployContext,
  type DeployFetchLike,
  type DeployProjectSummary,
  type D1QueryRow,
} from './deploy-client.js';
import { readDeployConfig, writeDeployConfig, type DeployConfig } from './deploy-config.js';
import { adaptWrangler, detectProjectShape, type ProjectShape } from './deploy-detect.js';
import { defaultReadFile, type ReadFileImpl } from './auth-context.js';

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
  /** Path-kind probe (for `validate`'s entry/assets checks); defaults to a statSync wrapper. */
  statPathImpl?: (p: string) => PathKind;
  fetchImpl?: DeployFetchLike;
  runShipImpl?: typeof runDeployShip;
  readDeployConfigImpl?: typeof readDeployConfig;
  writeDeployConfigImpl?: typeof writeDeployConfig;
  createProjectImpl?: typeof createProject;
  getProjectStatusImpl?: typeof getProjectStatus;
  listProjectsImpl?: typeof listProjects;
  rollbackProjectImpl?: typeof rollbackProject;
  renameProjectImpl?: typeof renameProject;
  addAliasImpl?: typeof addAlias;
  removeAliasImpl?: typeof removeAlias;
  setRedirectImpl?: typeof setRedirect;
  deleteProjectImpl?: typeof deleteProject;
  cloneProjectImpl?: typeof cloneProject;
  getLogsImpl?: typeof getLogs;
  tailLogsImpl?: typeof tailLogs;
  queryD1Impl?: typeof queryD1;
  shipDeps?: DeployShipDeps;
}

const USAGE = [
  'Usage: yolo deploy [--env <staging|prod>] [--dry-run] [--json]',
  '       yolo deploy init [--slug <slug>] [--type <static|worker>]',
  '       yolo deploy link (--project-id <id> | --slug <slug>) [--type <static|worker>]',
  '       yolo deploy validate [--json]',
  '       yolo deploy status [--json]',
  '       yolo deploy logs [--tail] [--since <dur>] [--json]',
  '       yolo deploy rollback [releaseId] [--json]',
  '       yolo deploy rename <newslug> [--no-redirect] [--json]',
  '       yolo deploy alias <slug> [--json]',
  '       yolo deploy alias rm <slug> [--json]',
  '       yolo deploy redirect <slug> <url> [--json]',
  '       yolo deploy delete [--confirm <slug>] [--json]',
  '       yolo deploy clone [--name <name>] [--slug <slug>] [--json]',
  '       yolo deploy db query "<sql>" [--json]',
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
  if (sub === 'link') return runLinkCmd(args.slice(1), deps, io);
  if (sub === 'validate') return runValidateCmd(args.slice(1), deps, io);
  if (sub === 'status') return runStatusCmd(args.slice(1), deps, io);
  if (sub === 'logs') return runLogsCmd(args.slice(1), deps, io);
  if (sub === 'rollback') return runRollbackCmd(args.slice(1), deps, io);
  if (sub === 'rename') return runRenameCmd(args.slice(1), deps, io);
  if (sub === 'alias') return runAliasCmd(args.slice(1), deps, io);
  if (sub === 'redirect') return runRedirectCmd(args.slice(1), deps, io);
  if (sub === 'delete') return runDeleteCmd(args.slice(1), deps, io);
  if (sub === 'clone') return runCloneCmd(args.slice(1), deps, io);
  if (sub === 'db') return runDbCmd(args.slice(1), deps, io);
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

  // Fresh init in a project that has a wrangler config but no .yolo/deploy.json:
  // migrate it onto the canonical format (init-only adaptation — the recommended
  // setup move; the CLI reads wrangler only as a fallback). A pre-existing
  // (shape-bearing) deploy.json is respected, so we only adapt when none exists.
  const adapted = existing == null ? adaptWrangler(cwd, deps.readFileImpl) : undefined;

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
    // create-or-LINK: a `slug-taken` on a slug the caller ALREADY OWNS means a
    // prior create (commonly via the deploy_create_project MCP tool, which
    // doesn't write the link file). Reconcile by linking to it instead of
    // dead-ending — `init` should never strand an owned project. The slug is
    // the explicit `--slug` OR (when omitted) the server-derived slug, which
    // the refusal carries in `detail.slug` — so bare `yolo deploy init` also
    // reconciles.
    if (created.kind === 'slug-taken') {
      const takenSlug = parsed.slug ?? str((created.detail as Record<string, unknown> | undefined)?.slug);
      if (takenSlug) {
        // Best-effort: if the lookup itself fails (auth/network), don't mask
        // the genuine slug-taken — fall through to it below.
        const lookup = await findOwnedProjectBySlug(deps, auth.context, takenSlug);
        const owned = lookup.ok ? lookup.project : undefined;
        const projectId = owned ? resolveProjectId(owned) : undefined;
        if (projectId) {
          return writeLinkFile(
            cwd,
            writeConfig,
            io,
            { projectId, slug: str(owned!.slug) ?? takenSlug, type: parsed.type, existing, adapted },
            `OK: slug '${takenSlug}' was already yours — linked existing project ${projectId} — wrote .yolo/deploy.json`,
          );
        }
      }
    }
    io.err(`${formatFail(created)}\n`);
    return exitCodeForFailure(created.kind);
  }

  const raw = created.value as Record<string, unknown>;
  const project = (raw.project && typeof raw.project === 'object' ? raw.project : raw) as Record<string, unknown>;
  const projectId = resolveProjectId(project);
  const slug = str(project.slug) ?? parsed.slug;
  if (!projectId) {
    io.err(`${formatFail({ kind: 'invalid-response', message: 'create-project response missing a project id' })}\n`);
    return 2;
  }

  return writeLinkFile(
    cwd,
    writeConfig,
    io,
    { projectId, slug, type: parsed.type, existing, adapted },
    `OK: linked project ${projectId}${slug ? ` (slug ${slug})` : ''} — wrote .yolo/deploy.json`,
  );
}

// ─── link ─────────────────────────────────────────────────────────────────
//
// Link this directory to an EXISTING hosting project without creating one —
// the reconciliation path for a project made out-of-band (e.g. the
// deploy_create_project MCP tool, which claims a slug but doesn't write the
// link file). `init` link-on-conflict covers the common case; `link` is the
// explicit verb when you already hold the projectId or slug.

interface ParsedLinkArgs {
  ok: true;
  projectId?: string;
  slug?: string;
  type?: 'static' | 'worker';
}

export function parseLinkArgs(args: string[]): ParsedLinkArgs | ParseError {
  let projectId: string | undefined;
  let slug: string | undefined;
  let type: 'static' | 'worker' | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--project-id') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--project-id requires a value' };
      projectId = v;
    } else if (a.startsWith('--project-id=')) {
      projectId = a.slice('--project-id='.length);
    } else if (a === '--slug') {
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
  if (!projectId && !slug) {
    return { ok: false, message: 'provide --project-id <id> or --slug <slug> to identify the existing project' };
  }
  if (projectId && slug) {
    // Either/or: accepting both would let a mismatched --slug write misleading
    // link metadata that disagrees with the project the id resolves to.
    return { ok: false, message: 'pass either --project-id or --slug, not both (the project\'s slug is resolved server-side)' };
  }
  return { ok: true, projectId, slug, type };
}

async function runLinkCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseLinkArgs(args);
  if (!parsed.ok) {
    io.err(
      `yolo deploy link: ${parsed.message}\nUsage: yolo deploy link (--project-id <id> | --slug <slug>) [--type <static|worker>]\n`,
    );
    return 64;
  }
  const cwd = deps.cwd ?? process.cwd();
  const readConfig = deps.readDeployConfigImpl ?? readDeployConfig;
  const writeConfig = deps.writeDeployConfigImpl ?? writeDeployConfig;

  const readResult = readConfig(cwd);
  if (!readResult.ok) {
    io.err(`${formatFail({ kind: readResult.kind, message: readResult.message })}\n`);
    return exitCodeForFailure(readResult.kind);
  }
  const existing: DeployConfig | null = readResult.config;

  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  // Resolve the target project — verify ownership server-side either way so we
  // never write a link to a project the caller can't actually reach.
  let projectId: string | undefined;
  let slug: string | undefined = parsed.slug;
  if (parsed.projectId) {
    const status = deps.getProjectStatusImpl ?? getProjectStatus;
    const result = await status(auth.context, parsed.projectId);
    if (!result.ok) {
      io.err(`${formatFail(result)}\n`);
      return exitCodeForFailure(result.kind);
    }
    const raw = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
    const project = (raw.project && typeof raw.project === 'object' ? raw.project : raw) as Record<string, unknown>;
    projectId = resolveProjectId(project) ?? parsed.projectId;
    slug = parsed.slug ?? str(project.slug);
  } else {
    const lookup = await findOwnedProjectBySlug(deps, auth.context, parsed.slug!);
    if (!lookup.ok) {
      // A list failure (auth/network) is NOT "not found" — surface the real
      // error + its exit code so the caller can retry or re-auth.
      io.err(`${formatFail(lookup)}\n`);
      return exitCodeForFailure(lookup.kind);
    }
    const owned = lookup.project;
    projectId = owned ? resolveProjectId(owned) : undefined;
    if (!projectId) {
      io.err(
        `${formatFail({
          kind: 'not-found',
          message: `no hosting project you own has slug '${parsed.slug}'`,
          hint: "run 'yolo deploy status' from a linked dir, or pass --project-id",
        })}\n`,
      );
      return exitCodeForFailure('not-found');
    }
    slug = str(owned!.slug) ?? parsed.slug;
  }

  // Refuse to silently repoint an existing link at a DIFFERENT project.
  if (existing?.projectId && existing.projectId !== projectId) {
    io.err(
      `${formatFail({
        kind: 'already-linked',
        message: `this directory is already linked to project ${existing.projectId}; refusing to repoint to ${projectId}`,
        hint: 'edit or remove .yolo/deploy.json by hand if the repoint is intentional',
      })}\n`,
    );
    return exitCodeForFailure('already-linked');
  }
  if (existing?.projectId === projectId) {
    // Already linked to this project. Still honor a requested --type that isn't
    // already set (the deploy_create_project link block has no `type`, so the
    // advertised `link --type …` must be able to pin detection here). Pure
    // no-op only when --type adds nothing.
    if (!parsed.type || existing.type === parsed.type) {
      io.out(`OK: already linked to project ${projectId}${slug ? ` (slug ${slug})` : ''} — .yolo/deploy.json left unchanged\n`);
      return 0;
    }
    return writeLinkFile(
      cwd,
      writeConfig,
      io,
      { projectId: projectId!, slug: slug ?? existing.slug, type: parsed.type, existing },
      `OK: already linked to project ${projectId} — set type ${parsed.type} in .yolo/deploy.json`,
    );
  }

  return writeLinkFile(
    cwd,
    writeConfig,
    io,
    { projectId: projectId!, slug, type: parsed.type, existing },
    `OK: linked project ${projectId}${slug ? ` (slug ${slug})` : ''} — wrote .yolo/deploy.json`,
  );
}

// ─── validate ─────────────────────────────────────────────────────────────

/**
 * `yolo deploy validate [--json]` — check `.yolo/deploy.json` + the resolved
 * project shape WITHOUT bundling, uploading, or any network call. Catches config
 * problems (bad `$version`/`type`, malformed JSON, missing `worker.entry`, a
 * static project with no assets dir, a `prebuilt` entry that doesn't exist, …)
 * before a real `yolo deploy` would fail mid-ship. Exit 0 = valid, 1 = invalid.
 */
async function runValidateCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const jsonOutput = args.includes('--json');
  // Reject unknown flags/positionals (consistent with the other subcommands).
  const unexpected = args.filter((a) => a !== '--json');
  if (unexpected.length > 0) {
    io.err(`yolo deploy validate: unexpected argument(s): ${unexpected.join(' ')}\nUsage: yolo deploy validate [--json]\n`);
    return 64;
  }
  const cwd = deps.cwd ?? process.cwd();
  const readFileImpl = deps.readFileImpl;
  const readConfig = deps.readDeployConfigImpl ?? readDeployConfig;

  const issues: Array<{ path?: string; message: string }> = [];

  // 1. Parse + schema-validate .yolo/deploy.json (absent is allowed — detection
  //    can still infer the shape; surfaced as a hint, not an error).
  const readResult = readConfig(cwd, readFileImpl);
  let config: DeployConfig | null = null;
  let configMissing = false;
  if (!readResult.ok) {
    if (readResult.errors && readResult.errors.length > 0) {
      for (const e of readResult.errors) issues.push({ path: e.path, message: e.message });
    } else {
      issues.push({ message: readResult.message });
    }
  } else {
    config = readResult.config;
    configMissing = config === null;
  }

  // 2. Resolve the project shape (static-vs-worker, entry/assets), only if the
  //    config itself parsed.
  let shape: ProjectShape | null = null;
  if (readResult.ok) {
    const det = detectProjectShape({ cwd, config: config ?? null, readFileImpl });
    if (!det.ok) issues.push({ message: det.message });
    else shape = det.shape;
  }

  // 3. Verify the resolved entry / assets exist AND are the right kind on disk —
  //    detection trusts an EXPLICIT worker.entry without checking it, so a
  //    typo'd or wrong-kind path (e.g. entry pointing at a directory) would
  //    otherwise only fail mid-ship. BUT a missing path is fine when a build
  //    command will PRODUCE it (clean checkout, output dir not committed) —
  //    `yolo deploy` runs the build before bundling — so that's a note, not an
  //    error (codex P2). A present-but-wrong-kind path is always an error.
  const notes: string[] = [];
  // Prefer the shape's resolved buildCommand — `detectProjectShape` infers one
  // from package.json even when `.yolo/deploy.json` has no explicit
  // `build.command` (both static and worker shapes carry it) — and fall back to
  // the raw config command when there's no detected shape.
  const buildCmd = shape?.buildCommand ?? config?.build?.command;
  const statPath = deps.statPathImpl ?? defaultStatPath;
  // `producedByBuild` = is this path an OUTPUT the build command creates (a
  // prebuilt worker module, a built assets dir) vs a SOURCE input esbuild
  // bundles in place (a `src/index.ts` worker entry)? A missing OUTPUT with a
  // build command pending is a note; a missing SOURCE entry is always an error
  // — the build does not create it, so a typo must still fail validate (codex).
  const checkPath = (
    rel: string,
    field: string,
    want: 'file' | 'dir',
    missingMsg: string,
    producedByBuild: boolean,
  ) => {
    const kind = statPath(path.resolve(cwd, rel));
    if (kind === 'missing') {
      if (buildCmd && producedByBuild) {
        notes.push(`'${rel}' not present yet — produced by the build (\`${buildCmd}\`) at deploy time`);
      } else {
        issues.push({ path: field, message: missingMsg });
      }
    } else if ((want === 'file' && kind !== 'file') || (want === 'dir' && kind !== 'dir')) {
      issues.push({ path: field, message: `'${rel}' is not a ${want === 'file' ? 'file' : 'directory'} (it's a ${kind})` });
    }
  };
  if (shape) {
    if (shape.type === 'worker') {
      checkPath(
        shape.entry,
        'worker.entry',
        'file',
        `entry '${shape.entry}' does not exist${shape.prebuilt ? ' (prebuilt entries must be built before deploy)' : ' — build it or fix the path'}`,
        // Only a PREBUILT worker entry is a build output; a source entry is
        // bundled by esbuild, so a missing source entry stays a hard error.
        shape.prebuilt === true,
      );
      if (shape.assetsDir) checkPath(shape.assetsDir, 'worker.assetsDir', 'dir', `assets dir '${shape.assetsDir}' does not exist`, true);
    } else if (shape.type === 'static') {
      checkPath(shape.assetsDir, 'build.outputDir', 'dir', `static assets dir '${shape.assetsDir}' does not exist — run the build first`, true);
    }
  }

  // 4. wrangler.toml is read only by a minimal line-based extractor (top-level
  //    `main` + `[assets].directory`); real-world toml — e.g. `main` sitting
  //    under a `[table]` — is silently missed. `.yolo/deploy.json` is the
  //    canonical format. Surface a NOTE so a present-but-unread toml isn't
  //    silent (the retro gotcha: "wrangler.toml silently ignored").
  if ((readFileImpl ?? defaultReadFile)(path.join(cwd, 'wrangler.toml')) !== undefined) {
    notes.push(
      'wrangler.toml found — YOLO Host reads only top-level `main` + `[assets].directory` from toml; ' +
        'run `yolo deploy init` to adapt it into `.yolo/deploy.json` (the canonical format)',
    );
  }

  const ok = issues.length === 0;

  if (jsonOutput) {
    io.out(`${JSON.stringify({ ok, configMissing, config, shape, issues, notes })}\n`);
    return ok ? 0 : 1;
  }

  if (!ok) {
    io.err('FAIL: deploy config is not valid\n');
    for (const it of issues) io.err(`  - ${it.path ? `${it.path}: ` : ''}${it.message}\n`);
    if (configMissing) io.err("  hint: run 'yolo deploy init' to create .yolo/deploy.json\n");
    return 1;
  }

  io.out('OK: deploy config is valid\n');
  if (config) {
    const link = config.projectId
      ? `${config.projectId}${config.slug ? ` (${config.slug})` : ''}`
      : '(unlinked — run `yolo deploy link`)';
    io.out(`  project: ${link}\n`);
  } else {
    io.out('  project: no .yolo/deploy.json — shape auto-detected\n');
  }
  if (shape) {
    if (shape.type === 'static') {
      io.out(`  type: static · assets: ${shape.assetsDir}\n`);
    } else {
      const bits = [`entry: ${shape.entry}`];
      if (shape.prebuilt) bits.push('prebuilt');
      if (shape.assetsDir) bits.push(`assets: ${shape.assetsDir}`);
      if (shape.buildCommand) bits.push(`build: ${shape.buildCommand}`);
      io.out(`  type: worker · ${bits.join(' · ')}\n`);
    }
  }
  if (config?.compatibilityFlags?.length) {
    io.out(`  compatibilityFlags: ${config.compatibilityFlags.join(', ')}\n`);
  }
  for (const n of notes) io.out(`  note: ${n}\n`);
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
    // Honest degradation (codex P2 r3): the backend logs route is a buffered
    // Phase-1 stub — there is no NDJSON stream to tail yet. A tail that
    // silently exits after one buffered response would read as "no more
    // logs"; say what's happening and fall through to the buffered fetch.
    // tailLogs (deploy-client) stays for when the streaming route lands.
    io.err('deploy: --tail is not available yet (log streaming lands with Phase 3 observability); showing recent entries instead\n');
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

// ─── rename ───────────────────────────────────────────────────────────────

interface ParsedRenameArgs {
  ok: true;
  slug: string;
  keepOldAsRedirect: boolean;
  jsonOutput: boolean;
}

export function parseRenameArgs(args: string[]): ParsedRenameArgs | ParseError {
  let slug: string | undefined;
  let keepOldAsRedirect = true;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--no-redirect') {
      keepOldAsRedirect = false;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (slug === undefined) {
      slug = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  if (slug === undefined || slug.trim() === '') {
    return { ok: false, message: 'a new slug is required: yolo deploy rename <newslug>' };
  }
  return { ok: true, slug, keepOldAsRedirect, jsonOutput };
}

async function runRenameCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseRenameArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy rename: ${parsed.message}\nUsage: yolo deploy rename <newslug> [--no-redirect] [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const rename = deps.renameProjectImpl ?? renameProject;
  const result = await rename(auth.context, linked.projectId, {
    slug: parsed.slug,
    keepOldAsRedirect: parsed.keepOldAsRedirect,
  });
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  const raw = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
  const project = (raw.project && typeof raw.project === 'object' ? raw.project : raw) as Record<string, unknown>;
  const newSlug = str(project.slug) ?? parsed.slug;
  const url = str(project.hostname) ?? str(project.url) ?? str(raw.url);
  const newUrl = url ? (url.startsWith('http') ? url : `https://${url}`) : `https://${newSlug}`;
  io.out(`OK: renamed to slug ${newSlug} → ${newUrl}\n`);
  if (parsed.keepOldAsRedirect && linked.slug) {
    io.out(`  old slug '${linked.slug}' now 308 → ${newUrl}\n`);
  }
  return 0;
}

// ─── alias ──────────────────────────────────────────────────────────────────

interface ParsedAliasArgs {
  ok: true;
  remove: boolean;
  slug: string;
  jsonOutput: boolean;
}

export function parseAliasArgs(args: string[]): ParsedAliasArgs | ParseError {
  let remove = false;
  let slug: string | undefined;
  let jsonOutput = false;

  // `alias rm <slug>` — a leading `rm` positional flips to removal.
  let rest = args;
  if (rest[0] === 'rm') {
    remove = true;
    rest = rest.slice(1);
  }

  for (let i = 0; i < rest.length; i++) {
    const a = rest[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (slug === undefined) {
      slug = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  if (slug === undefined || slug.trim() === '') {
    return {
      ok: false,
      message: remove ? 'a slug is required: yolo deploy alias rm <slug>' : 'a slug is required: yolo deploy alias <slug>',
    };
  }
  return { ok: true, remove, slug, jsonOutput };
}

async function runAliasCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseAliasArgs(args);
  if (!parsed.ok) {
    io.err(
      `yolo deploy alias: ${parsed.message}\nUsage: yolo deploy alias <slug> [--json]\n       yolo deploy alias rm <slug> [--json]\n`,
    );
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const result = parsed.remove
    ? await (deps.removeAliasImpl ?? removeAlias)(auth.context, linked.projectId, parsed.slug)
    : await (deps.addAliasImpl ?? addAlias)(auth.context, linked.projectId, parsed.slug);
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  if (parsed.remove) {
    io.out(`OK: removed alias '${parsed.slug}' from ${linked.slug ?? linked.projectId}\n`);
  } else {
    io.out(`OK: added alias '${parsed.slug}' to ${linked.slug ?? linked.projectId}\n`);
  }
  return 0;
}

// ─── redirect ───────────────────────────────────────────────────────────────

interface ParsedRedirectArgs {
  ok: true;
  slug: string;
  url: string;
  jsonOutput: boolean;
}

export function parseRedirectArgs(args: string[]): ParsedRedirectArgs | ParseError {
  const positionals: string[] = [];
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      positionals.push(a);
    }
  }
  if (positionals.length < 2) {
    return { ok: false, message: 'a slug and a target URL are required: yolo deploy redirect <slug> <url>' };
  }
  if (positionals.length > 2) {
    return { ok: false, message: `unexpected positional argument: ${positionals[2]}` };
  }
  return { ok: true, slug: positionals[0]!, url: positionals[1]!, jsonOutput };
}

async function runRedirectCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseRedirectArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy redirect: ${parsed.message}\nUsage: yolo deploy redirect <slug> <url> [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const redirect = deps.setRedirectImpl ?? setRedirect;
  const result = await redirect(auth.context, linked.projectId, parsed.slug, parsed.url);
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  io.out(`OK: '${parsed.slug}' now 308 → ${parsed.url}\n`);
  return 0;
}

// ─── delete ─────────────────────────────────────────────────────────────────

interface ParsedDeleteArgs {
  ok: true;
  confirmSlug?: string;
  jsonOutput: boolean;
}

export function parseDeleteArgs(args: string[]): ParsedDeleteArgs | ParseError {
  let confirmSlug: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--confirm') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--confirm requires the current slug as its value' };
      confirmSlug = v;
    } else if (a.startsWith('--confirm=')) {
      confirmSlug = a.slice('--confirm='.length);
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, confirmSlug, jsonOutput };
}

async function runDeleteCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseDeleteArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy delete: ${parsed.message}\nUsage: yolo deploy delete [--confirm <slug>] [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const del = deps.deleteProjectImpl ?? deleteProject;
  const result = await del(
    auth.context,
    linked.projectId,
    parsed.confirmSlug !== undefined ? { confirmSlug: parsed.confirmSlug } : {},
  );
  if (!result.ok) {
    // A live site is refused with `not-confirmed` + a hint — surfaced verbatim
    // by formatFail (the backend's message tells the operator to pass --confirm).
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  io.out(`OK: deleted project ${linked.slug ?? linked.projectId}\n`);
  return 0;
}

// ─── clone ──────────────────────────────────────────────────────────────────
//
// Duplicate the linked project's config (env + secrets + fresh D1/KV/R2
// bindings) into a new EMPTY project. No release is copied — re-ship the clone
// to populate it. Optional --name/--slug name the clone; the backend derives
// defaults otherwise.

interface ParsedCloneArgs {
  ok: true;
  name?: string;
  slug?: string;
  jsonOutput: boolean;
}

export function parseCloneArgs(args: string[]): ParsedCloneArgs | ParseError {
  let name: string | undefined;
  let slug: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--name') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--name requires a value' };
      name = v;
    } else if (a.startsWith('--name=')) {
      name = a.slice('--name='.length);
    } else if (a === '--slug') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--slug requires a value' };
      slug = v;
    } else if (a.startsWith('--slug=')) {
      slug = a.slice('--slug='.length);
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, name, slug, jsonOutput };
}

async function runCloneCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const parsed = parseCloneArgs(args);
  if (!parsed.ok) {
    io.err(`yolo deploy clone: ${parsed.message}\nUsage: yolo deploy clone [--name <name>] [--slug <slug>] [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const clone = deps.cloneProjectImpl ?? cloneProject;
  const result = await clone(auth.context, linked.projectId, {
    ...(parsed.name !== undefined ? { name: parsed.name } : {}),
    ...(parsed.slug !== undefined ? { slug: parsed.slug } : {}),
  });
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  const raw = (result.value && typeof result.value === 'object' ? result.value : {}) as Record<string, unknown>;
  const project = (raw.project && typeof raw.project === 'object' ? raw.project : raw) as Record<string, unknown>;
  const newSlug = str(project.slug) ?? parsed.slug;
  const newId = str(project.id) ?? str(project.projectId);
  const url = str(project.hostname) ?? str(project.url);
  const newUrl = url ? (url.startsWith('http') ? url : `https://${url}`) : newSlug ? `https://${newSlug}` : undefined;
  io.out(
    `OK: cloned ${linked.slug ?? linked.projectId} → ${newSlug ?? '(new project)'}${newUrl ? ` (${newUrl})` : ''}\n`,
  );
  // The clone is a separate, EMPTY project (no release). This directory is still
  // linked to the SOURCE in .yolo/deploy.json, so a plain `yolo deploy` here would
  // ship to the source, not the clone — and `yolo deploy link` refuses to repoint
  // an existing link. So don't say "re-ship"; print the explicit relink step
  // (codex P2 r5) the user must run to start shipping code into the clone.
  io.out(
    `The clone is empty. To ship into it, link a checkout to ${newId ?? 'the new project'}:\n` +
      `  yolo deploy link --project-id ${newId ?? '<clone-id>'}` +
      `   (in a fresh directory, or after removing this directory's .yolo/deploy.json)\n`,
  );
  return 0;
}

// ─── db query (Phase 2) ─────────────────────────────────────────────────────
//
// The ONE ergonomic in-pod data verb. Provisioning + env/secret writes are
// MCP-only (T2/T3, no cwd dependency) — `db query` is here because it's a
// frequent inspect-your-data loop and reads the linked project from
// .yolo/deploy.json like every other CLI verb. It targets the project's sole
// D1; multi-D1 selection stays an MCP concern (deploy.db_query resourceId).

interface ParsedDbQueryArgs {
  ok: true;
  sql: string;
  jsonOutput: boolean;
}

export function parseDbQueryArgs(args: string[]): ParsedDbQueryArgs | ParseError {
  let sql: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (sql === undefined) {
      sql = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a} (quote the whole SQL statement as one argument)` };
    }
  }
  if (sql === undefined || sql.trim() === '') {
    return { ok: false, message: 'a SQL statement is required: yolo deploy db query "<sql>"' };
  }
  return { ok: true, sql, jsonOutput };
}

async function runDbCmd(args: string[], deps: DeployCliDeps, io: DeployIo): Promise<number> {
  const verb = args[0];
  // Only `db query` is a CLI verb. Provisioning/env/secret are MCP-only;
  // reject other db subcommands with usage + exit 64.
  if (verb !== 'query') {
    io.err(
      `yolo deploy db: unknown subcommand '${verb ?? ''}'\n` +
        'Usage: yolo deploy db query "<sql>" [--json]\n' +
        'note: provisioning (db_provision/kv_create/bucket_create), env_set and set_secret are MCP-only (no CLI verb).\n',
    );
    return 64;
  }

  const parsed = parseDbQueryArgs(args.slice(1));
  if (!parsed.ok) {
    io.err(`yolo deploy db query: ${parsed.message}\nUsage: yolo deploy db query "<sql>" [--json]\n`);
    return 64;
  }
  const linked = requireLink(deps, io);
  if (!linked.ok) return linked.exitCode;
  const auth = resolveAuth(deps);
  if (!auth.ok) {
    io.err(`${formatFail({ kind: 'auth', message: auth.message })}\n`);
    return 78;
  }

  const query = deps.queryD1Impl ?? queryD1;
  const result = await query(auth.context, linked.projectId, parsed.sql);
  if (!result.ok) {
    io.err(`${formatFail(result)}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (parsed.jsonOutput) {
    io.out(`${JSON.stringify(result.value, null, 2)}\n`);
    return 0;
  }
  io.out(`${formatRowsTable(result.value.results)}\n`);
  return 0;
}

/**
 * Render D1 rows as a simple aligned text table. Columns are the union of
 * keys across rows (first-seen order). Empty result → a friendly "(0 rows)".
 */
export function formatRowsTable(rows: D1QueryRow[]): string {
  if (!rows || rows.length === 0) return '(0 rows)';
  const columns: string[] = [];
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!columns.includes(key)) columns.push(key);
    }
  }
  if (columns.length === 0) return `(${rows.length} row${rows.length === 1 ? '' : 's'}, no columns)`;

  const cell = (value: unknown): string => {
    if (value === null || value === undefined) return 'NULL';
    if (typeof value === 'object') return JSON.stringify(value);
    return String(value);
  };

  const widths = columns.map((col) =>
    Math.max(col.length, ...rows.map((row) => cell(row[col]).length)),
  );
  const pad = (text: string, width: number) => text + ' '.repeat(Math.max(0, width - text.length));

  const header = columns.map((col, i) => pad(col, widths[i]!)).join(' | ');
  const separator = widths.map((w) => '-'.repeat(w)).join('-+-');
  const body = rows.map((row) => columns.map((col, i) => pad(cell(row[col]), widths[i]!)).join(' | '));

  const footer = `(${rows.length} row${rows.length === 1 ? '' : 's'})`;
  return [header, separator, ...body, footer].join('\n');
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

/** projectId from a serialized project (server emits `id`; tolerate variants). */
function resolveProjectId(project: Record<string, unknown>): string | undefined {
  return str(project.projectId) ?? str(project.id) ?? str(project._id);
}

/**
 * Find one of the caller's OWN projects by slug (for init/link reconcile).
 * Distinguishes a list FAILURE (auth/network — propagated so the caller can
 * surface the real, possibly-retryable error) from a clean not-found
 * (`{ ok:true, project: undefined }`).
 */
async function findOwnedProjectBySlug(
  deps: DeployCliDeps,
  ctx: DeployContext,
  slug: string,
): Promise<{ ok: true; project?: DeployProjectSummary } | DeployClientFailure> {
  const list = deps.listProjectsImpl ?? listProjects;
  const result = await list(ctx);
  if (!result.ok) return result;
  return { ok: true, project: result.value.find((p) => str(p.slug) === slug) };
}

/**
 * Write `.yolo/deploy.json` in canonical form, preserving any existing fields,
 * and print the success message + the commit note. Shared by init + link.
 */
function writeLinkFile(
  cwd: string,
  writeConfig: typeof writeDeployConfig,
  io: DeployIo,
  params: {
    projectId: string;
    slug?: string;
    type?: 'static' | 'worker';
    existing?: DeployConfig | null;
    adapted?: { config: Partial<DeployConfig>; sourceFile: string; migrated: string[]; warnings: string[] };
  },
  message: string,
): number {
  const config: DeployConfig = {
    ...(params.existing ?? {}),
    // Wrangler-adapted shape (worker/build/type/compatibilityFlags) goes BELOW
    // existing — there is no existing on a fresh init — and ABOVE the explicit
    // --slug/--type so an operator's explicit `--type` still wins.
    ...(params.adapted?.config ?? {}),
    $version: 1,
    projectId: params.projectId,
    ...(params.slug ? { slug: params.slug } : {}),
    ...(params.type ? { type: params.type } : {}),
  };
  try {
    writeConfig(cwd, config);
  } catch (err) {
    io.err(
      `${formatFail({ kind: 'config-write-failed', message: `failed to write .yolo/deploy.json: ${describeError(err)}` })}\n`,
    );
    return 1;
  }
  io.out(`${message}\n`);
  if (params.adapted) {
    io.out(`note: adapted ${params.adapted.sourceFile} → .yolo/deploy.json (${params.adapted.migrated.join(', ')})\n`);
    for (const w of params.adapted.warnings) io.out(`warn: ${w}\n`);
  }
  io.out('note: .yolo/deploy.json is committed by design; it contains no secrets — commit it so future sessions, teammates, and CI ship to the same project.\n');
  return 0;
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
