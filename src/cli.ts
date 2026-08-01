#!/usr/bin/env node
/**
 * `yolo` — YOLO Studio substrate CLI (Phase 8a Group 9 scaffold).
 *
 * Owns substrate-tooling subcommands (plan import/export/validate;
 * future: workspace, artifact). v1 ships only `yolo --version` and
 * `yolo context`; full plan import/export lands in Phase 8c.
 *
 * NOT the agent CLI. The agent CLI is `yolo-code`. NOT the LLM router
 * client. The LLM router client is `yolo-router`.
 *
 * Auth contract (AUTH_AND_ONBOARDING Slice 0 — user-JWT-only):
 * `SESSION_ID` + `YOLO_COMMON_API_URL` + a USER ACCESS JWT, resolved by
 * `auth-context.ts` from `~/.config/yolo/token` (rotated) → `YOLO_API_TOKEN`.
 * That JWT is the SOLE credential — it's sent as `Authorization: Bearer` and
 * `X-Internal-Auth` is never sent. The `INTERNAL_API_KEY` fallback was REMOVED;
 * the CLI fails with an auth error if no user token is available. The CLI exits
 * with `session-required` if `SESSION_ID` is missing — outside-container
 * invocation is out of scope for v1 (future external-login flow). Workspace
 * binding is derived from the session record, not from env or args.
 */

import { readSessionContext, formatContext, ContextResolutionError } from './context.js';
import { validatePlanFile, formatErrors } from './plan-validate.js';
import {
  runPlanImport,
  formatSuccess as formatImportSuccess,
  exitCodeForFailure as importExitCode,
} from './plan-import.js';
import {
  runPlanExport,
  formatSuccess as formatExportSuccess,
  exitCodeForFailure as exportExitCode,
} from './plan-export.js';
import {
  runPlanStateTransition,
  formatSuccess as formatStateSuccess,
  exitCodeForFailure as stateExitCode,
  type OperatorTargetState,
} from './plan-state.js';
import {
  runPlanGet,
  exitCodeForFailure as getExitCode,
} from './plan-get.js';
import {
  runPlanOpen,
  exitCodeForFailure as openExitCode,
} from './plan-open.js';
import {
  runPlanList,
  exitCodeForFailure as listExitCode,
  type PlanState,
} from './plan-list.js';
import {
  runRunStart,
  exitCodeForFailure as runStartExitCode,
} from './run-start.js';
import {
  runRunLifecycle,
  exitCodeForFailure as runLifecycleExitCode,
  type RunLifecycleVerb,
} from './run-lifecycle.js';
import {
  runRunGet,
  exitCodeForFailure as runGetExitCode,
} from './run-get.js';
import {
  runRunList,
  exitCodeForFailure as runListExitCode,
  type RunExecutionState,
} from './run-list.js';
import {
  runRunTransfer,
  exitCodeForFailure as runTransferExitCode,
} from './run-transfer.js';
import {
  runArtifactGet,
  exitCodeForFailure as artifactGetExitCode,
} from './artifact-get.js';
import {
  runArtifactList,
  exitCodeForFailure as artifactListExitCode,
} from './artifact-list.js';
import {
  runTileAppSign,
  runTileAppPublish,
  exitCodeForFailure as tileAppExitCode,
} from './tileapp-publisher.js';

// Resolved at startup from the package's own package.json so the
// `--version` output can never drift from the npm version. Touching
// only one of the two used to silently emit stale info.
//
// We read the file via `createRequire` rather than `import …
// assert/with { type: 'json' }` because our tsconfig pins module:
// Node16, which doesn't support import attributes. The file lives
// next to dist/cli.js in the installed package layout
// (/opt/yolo-cli/package.json + /opt/yolo-cli/dist/cli.js), so the
// `../package.json` relative path resolves correctly both during
// tests (src/) and in production (dist/).
import { createRequire } from 'module';
const PKG_VERSION: string = (createRequire(import.meta.url)('../package.json') as { version: string }).version;

/**
 * Serialize an orchestration result for `--json` output. Strips the
 * internal `ok` discriminant — exit code already conveys success vs
 * failure, and a `kind` field on failures is enough for scripts to
 * branch on. Leaves `--summary` outputs (the human-readable
 * single-line success messages, `FAIL [kind]: …` errors) untouched.
 */
function formatJsonResult(result: { ok: boolean }): string {
  const { ok: _ok, ...payload } = result as { ok: boolean } & Record<string, unknown>;
  return JSON.stringify(payload, null, 2);
}

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: yolo <command> [options]',
      '',
      'Commands:',
      '  context                                   Print resolved session/workspace/API context.',
      '  plan validate <file>                      Validate a .yolo/plans/<slug>.md plan file (offline).',
      '  plan import <file> [opts]                 Import file → DB (work.create_plan / update_plan).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--lockfile <name>]                     Use .imports.<name>.json instead of the gitignored default.',
      '    [--force]                               Override divergence (DB ahead of lockfile) or 409 on create.',
      '    [--json]                                Emit the result as JSON (for scripting).',
      '  plan export <planId> [opts]               Export DB → file (work.get_plan + canonicalize).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--lockfile <name>]                     Refresh .imports.<name>.json instead of the default.',
      '    [-o <file>]                             Output path. Default: <plansDir>/<planId>.md.',
      '    [--json]                                Emit the result as JSON.',
      '  plan activate <planId> [opts]             Transition Plan.state → active (work.update_plan).',
      '  plan archive <planId> [opts]              Transition Plan.state → archived (work.update_plan).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--lockfile <name>]                     Refresh .imports.<name>.json lockfile entry post-update.',
      '    [--json]                                Emit the result as JSON.',
      '  plan get <planId> [opts]                  Read a Plan from the DB (work.get_plan, no file write).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--waves]                               Group steps by topological wave (parallel-execution view).',
      '    [--json]                                Pretty-print raw JSON instead of the summary.',
      '  plan list [opts]                          List Plans in the current workspace (work.list_plans).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--state <draft|active|archived>]       Server-side Plan.state filter.',
      '    [--json]                                Pretty-print raw JSON instead of the table.',
      '  plan open <planId> [opts]                 Print the Plan-DAG URL for the given Plan (no Run).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--json]                                Emit {planId, workspaceId, url} as JSON.',
      '  run start <planId> [opts]                 Bootstrap a Plan Run (work.start_run).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--inputs <json>]                       JSON object of Plan inputs. Default: {}.',
      '    [--json]                                Emit the response as JSON.',
      '  run get <runId> [opts]                    Read a Plan Run (work.get_run, no mutation).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--json]                                Pretty-print raw JSON instead of the summary.',
      '  run list [opts]                           List Plan Runs in the current workspace (work.list_runs).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--state <pending|running|paused|...>]  Server-side executionState filter.',
      '    [--json]                                Pretty-print raw JSON instead of the table.',
      '  run pause <runId> [opts]                  Pause a running Plan Run.',
      '  run resume <runId> [opts]                 Resume a paused Plan Run.',
      '  run cancel <runId> [opts]                 Cancel a Plan Run.',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--reason <text>]                       Optional reason (pause/cancel only). ≤1024 chars.',
      '    [--json]                                Emit the response as JSON.',
      '  run transfer <runId> [opts]               Reassign the Operator (work.transfer_run_operator).',
      '    --to <agentId>                          Target Operator (Operator-tier: claude, codex).',
      '    --user-driven                           Transfer to user-driven (operatorAgentId=null). Mutex with --to.',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--json]                                Emit the response as JSON.',
      '  artifact get <key> [opts]                 Read a workspace artifact (work.get_artifact).',
      '    [--version <n>]                         Pin to a specific version. Default: latest.',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--content]                             Stdout the raw artifact body only (for piping).',
      '    [--json]                                Pretty-print the full record as JSON.',
      '  artifact list [opts]                      List workspace artifacts (work.list_artifacts).',
      '    [--prefix <prefix>]                     Server-side key prefix filter.',
      '    [--limit <n>]                           Cap result count (1-500, default 100).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--json]                                Pretty-print raw JSON instead of the table.',
      '  tileapp init <name>                       Scaffold a personal app (./<name>/tileapp.json + index.html).',
      '  tileapp validate <manifest> [opts]        Offline lint: manifest schema + bundle layout (no auth).',
      '  tileapp media push <manifest> [--dir d]   Upload store screenshots (additive — leaves the rest of the bundle alone).',
      '    [--bundle-dir <dir>]                    Override the static-bundle directory to check.',
      '  tileapp dev <manifest> [opts]             Serve the bundle locally + a mock broker (offline iterate).',
      '    [--port N] [--host H]                   Bind (default: 127.0.0.1:$PORT|3000).',
      '    [--bundle-dir <dir>] [--deny]           Override bundle dir; --deny = mock broker denies all.',
      '  tileapp sign <manifest> --publisher <id>  KMS-sign a tile-app manifest (POST /v1/publisher/sign).',
      '    [--key <keyId>]                         Pick a specific signing key (default: the only active one).',
      '    [--stdout]                              Print the signed manifest instead of rewriting the file.',
      '  tileapp publish <manifest> --personal     Register a PERSONAL app (no signing/review). Pure-UI: uploads the',
      '                                            bundle. Runtime (manifest has `runtime`): builds the image in-pod',
      '                                            + mediated-push to your registry namespace.',
      '    [--bundle-dir <dir>]                    Pure-UI: override the static-bundle directory to upload.',
      '    [--context <dir>] [--dockerfile <f>]    Runtime: build context + Dockerfile (default: the manifest dir).',
      '    [--builder auto|podman|skopeo]          Runtime build engine. auto (default): skopeo assembler for RUN-less',
      '                                            Dockerfiles (no container engine — works in-pod), else podman.',
      '  tileapp publish <manifest> [opts]         Submit a SIGNED manifest for marketplace review (POST /v1/publisher/publish).',
      '    [--channel beta|stable]                 Target channel (default: stable).',
      '    [--image-digest <d>]                    Consistency check: must equal the signed manifest image.digest.',
      '  tileapp install <appId> [opts]            Record an app grant for a workspace (POST /v1/tileapps/:appId/install).',
      '    --workspace <workspaceId>               Target workspace (required).',
      '    [--accept-optional <perm>]              Accept an optional permission (repeatable).',
      '  tileapp add-tile <appId> [opts]           Place an app tile in a workspace (POST /v1/workspaces/:id/tiles).',
      '    --workspace <workspaceId>               Target workspace (required).',
      '    [--name <name>]                         Tile display name (default: the app manifest displayName).',
      '    [--version <v>]                         App version to pin (default: the app\'s current version).',
      '  mcp scopes [opts]                         Show mintable vs not-mintable MCP scopes for this session (pure read).',
      '    [--agent <agentId>]                     Agent identity to inspect (default: substrate-cli).',
      '    [--json]                                Emit {agentId, allowed, denied} as JSON.',
      '  serve <dir> [opts]                        Static file server (decision-preview / Gap 2a).',
      '    [--port <n>]                            Port (default: $PORT, else 3000).',
      '    [--host <h>]                            Bind host (default: 0.0.0.0).',
      '    [--spa]                                 Serve index.html for unmatched routes (SPA mode).',
      '  deploy [opts]                             Ship the cwd project (detect → build → bundle → upload).',
      '    [--env <staging|prod>]                  Target env (default staging; prod needs operator approval).',
      '    [--dry-run]                             Stop after bundling; print the manifest summary (offline).',
      '    [--json]                                Progress to stderr; final JSON result on stdout.',
      '  deploy init [--slug <s>] [--type <t>]     Create/link a hosting project; writes .yolo/deploy.json.',
      '  deploy status [--json]                    Project + release status (incl. pending approvals).',
      '  deploy logs [--tail] [--since <dur>]      Recent logs; --tail streams NDJSON.',
      '  deploy rollback [releaseId] [--json]      Repoint the project to a previous release.',
      '  --version                                 Print substrate CLI version.',
      '  --help                                    Print this help.',
      '',
      'Distinct from:',
      '  yolo-code   — the YOLO Studio coding-agent CLI.',
      '  yolo-router — the LLM gateway client (LLM API forwarder).',
      '',
    ].join('\n'),
  );
}

function runPlanValidate(args: string[]): number {
  const file = args[0];
  if (!file) {
    process.stderr.write('yolo: plan validate requires a file path\n');
    process.stderr.write('Usage: yolo plan validate <file>\n');
    return 64; // EX_USAGE
  }
  let result;
  try {
    result = validatePlanFile(file);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    process.stderr.write(`yolo: cannot read plan file '${file}': ${msg}\n`);
    return 64;
  }
  if (result.ok) {
    process.stdout.write(`OK: ${file} is canonical and schema-valid (planId=${result.planId}, ${result.bytes} bytes)\n`);
    return 0;
  }
  process.stderr.write(`FAIL: ${file}\n`);
  process.stderr.write(`${formatErrors(result.errors)}\n`);
  return 1;
}

interface ParsedImportArgs {
  ok: true;
  filePath: string;
  workspaceFlag?: string;
  lockfileFlag?: string;
  force: boolean;
  jsonOutput: boolean;
}

interface ParseError {
  ok: false;
  message: string;
}

function parseImportArgs(args: string[]): ParsedImportArgs | ParseError {
  let filePath: string | undefined;
  let workspaceFlag: string | undefined;
  let lockfileFlag: string | undefined;
  let force = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--lockfile') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--lockfile requires a value' };
      lockfileFlag = v;
    } else if (a.startsWith('--lockfile=')) {
      lockfileFlag = a.slice('--lockfile='.length);
    } else if (a === '--force') {
      force = true;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!filePath) {
      filePath = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!filePath) return { ok: false, message: 'plan import requires a file path' };
  return { ok: true, filePath, workspaceFlag, lockfileFlag, force, jsonOutput };
}

async function runPlanImportCmd(args: string[]): Promise<number> {
  const parsed = parseImportArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan import <file> [--workspace <wsId>] [--lockfile <name>] [--force] [--json]\n');
    return 64;
  }
  const result = await runPlanImport({
    filePath: parsed.filePath,
    workspaceFlag: parsed.workspaceFlag,
    lockfileFlag: parsed.lockfileFlag,
    force: parsed.force,
  });
  if (result.ok) {
    process.stdout.write(`${parsed.jsonOutput ? formatJsonResult(result) : formatImportSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(parsed.jsonOutput ? `${formatJsonResult(result)}\n` : `FAIL [${result.kind}]: ${result.message}\n`);
  return importExitCode(result.kind);
}

interface ParsedExportArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  lockfileFlag?: string;
  outputFlag?: string;
  jsonOutput: boolean;
}

function parseExportArgs(args: string[]): ParsedExportArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let lockfileFlag: string | undefined;
  let outputFlag: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--lockfile') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--lockfile requires a value' };
      lockfileFlag = v;
    } else if (a.startsWith('--lockfile=')) {
      lockfileFlag = a.slice('--lockfile='.length);
    } else if (a === '-o' || a === '--output') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '-o requires a value' };
      outputFlag = v;
    } else if (a.startsWith('--output=')) {
      outputFlag = a.slice('--output='.length);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'plan export requires a planId' };
  return { ok: true, planId, workspaceFlag, lockfileFlag, outputFlag, jsonOutput };
}

async function runPlanExportCmd(args: string[]): Promise<number> {
  const parsed = parseExportArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan export <planId> [--workspace <wsId>] [--lockfile <name>] [-o <file>] [--json]\n');
    return 64;
  }
  const result = await runPlanExport({
    planId: parsed.planId,
    workspaceFlag: parsed.workspaceFlag,
    lockfileFlag: parsed.lockfileFlag,
    outputFlag: parsed.outputFlag,
  });
  if (result.ok) {
    process.stdout.write(`${parsed.jsonOutput ? formatJsonResult(result) : formatExportSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(parsed.jsonOutput ? `${formatJsonResult(result)}\n` : `FAIL [${result.kind}]: ${result.message}\n`);
  return exportExitCode(result.kind);
}

interface ParsedStateArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  lockfileFlag?: string;
  jsonOutput: boolean;
}

function parseStateArgs(args: string[]): ParsedStateArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let lockfileFlag: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--lockfile') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--lockfile requires a value' };
      lockfileFlag = v;
    } else if (a.startsWith('--lockfile=')) {
      lockfileFlag = a.slice('--lockfile='.length);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'requires a planId' };
  return { ok: true, planId, workspaceFlag, lockfileFlag, jsonOutput };
}

async function runPlanStateCmd(verb: 'activate' | 'archive', args: string[]): Promise<number> {
  const parsed = parseStateArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: plan ${verb}: ${parsed.message}\n`);
    process.stderr.write(`Usage: yolo plan ${verb} <planId> [--workspace <wsId>] [--lockfile <name>] [--json]\n`);
    return 64;
  }
  const targetState: OperatorTargetState = verb === 'activate' ? 'active' : 'archived';
  const result = await runPlanStateTransition({
    planId: parsed.planId,
    targetState,
    workspaceFlag: parsed.workspaceFlag,
    lockfileFlag: parsed.lockfileFlag,
  });
  if (result.ok) {
    process.stdout.write(`${parsed.jsonOutput ? formatJsonResult(result) : formatStateSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(parsed.jsonOutput ? `${formatJsonResult(result)}\n` : `FAIL [${result.kind}]: ${result.message}\n`);
  return stateExitCode(result.kind);
}

interface ParsedGetArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  jsonOutput: boolean;
  wavesOutput: boolean;
}

function parseGetArgs(args: string[]): ParsedGetArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let jsonOutput = false;
  let wavesOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a === '--waves') {
      wavesOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'plan get requires a planId' };
  if (jsonOutput && wavesOutput) {
    return { ok: false, message: '--json and --waves are mutually exclusive' };
  }
  return { ok: true, planId, workspaceFlag, jsonOutput, wavesOutput };
}

async function runPlanGetCmd(args: string[]): Promise<number> {
  const parsed = parseGetArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan get <planId> [--workspace <wsId>] [--waves | --json]\n');
    return 64;
  }
  const outputFormat = parsed.jsonOutput ? 'json' : parsed.wavesOutput ? 'waves' : 'summary';
  const result = await runPlanGet({
    planId: parsed.planId,
    workspaceFlag: parsed.workspaceFlag,
    outputFormat,
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return getExitCode(result.kind);
}

interface ParsedListArgs {
  ok: true;
  workspaceFlag?: string;
  stateFilter?: PlanState;
  jsonOutput: boolean;
}

function parseListArgs(args: string[]): ParsedListArgs | ParseError {
  let workspaceFlag: string | undefined;
  let stateFilter: PlanState | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--state') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--state requires a value' };
      stateFilter = v as PlanState;
    } else if (a.startsWith('--state=')) {
      stateFilter = a.slice('--state='.length) as PlanState;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  return { ok: true, workspaceFlag, stateFilter, jsonOutput };
}

async function runPlanListCmd(args: string[]): Promise<number> {
  const parsed = parseListArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: plan list: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan list [--workspace <wsId>] [--state <draft|active|archived>] [--json]\n');
    return 64;
  }
  const result = await runPlanList({
    workspaceFlag: parsed.workspaceFlag,
    stateFilter: parsed.stateFilter,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return listExitCode(result.kind);
}

interface ParsedOpenArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  jsonOutput: boolean;
}

function parseOpenArgs(args: string[]): ParsedOpenArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'plan open requires a planId' };
  return { ok: true, planId, workspaceFlag, jsonOutput };
}

async function runPlanOpenCmd(args: string[]): Promise<number> {
  const parsed = parseOpenArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: plan open: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan open <planId> [--workspace <wsId>] [--json]\n');
    return 64;
  }
  const result = await runPlanOpen({
    planId: parsed.planId,
    workspaceFlag: parsed.workspaceFlag,
    outputFormat: parsed.jsonOutput ? 'json' : 'text',
  });
  if (result.ok) {
    if (parsed.jsonOutput) {
      process.stdout.write(`${formatJsonResult(result)}\n`);
    } else {
      process.stdout.write(`${result.output}\n`);
    }
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return openExitCode(result.kind);
}

interface ParsedRunStartArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  inputs?: Record<string, unknown>;
  jsonOutput: boolean;
}

function parseRunStartArgs(args: string[]): ParsedRunStartArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let inputs: Record<string, unknown> | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--inputs') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--inputs requires a JSON object value' };
      const parsed = parseInputsJson(v);
      if (!parsed.ok) return parsed;
      inputs = parsed.value;
    } else if (a.startsWith('--inputs=')) {
      const parsed = parseInputsJson(a.slice('--inputs='.length));
      if (!parsed.ok) return parsed;
      inputs = parsed.value;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'run start requires a planId' };
  return { ok: true, planId, workspaceFlag, inputs, jsonOutput };
}

function parseInputsJson(raw: string): { ok: true; value: Record<string, unknown> } | ParseError {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    return { ok: false, message: `--inputs is not valid JSON: ${err instanceof Error ? err.message : String(err)}` };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, message: '--inputs must be a JSON object (e.g. \'{"env":"prod"}\')' };
  }
  return { ok: true, value: parsed as Record<string, unknown> };
}

async function runRunStartCmd(args: string[]): Promise<number> {
  const parsed = parseRunStartArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: run start: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo run start <planId> [--workspace <wsId>] [--inputs <json>] [--json]\n');
    return 64;
  }
  const result = await runRunStart({
    planId: parsed.planId,
    workspaceFlag: parsed.workspaceFlag,
    inputs: parsed.inputs,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return runStartExitCode(result.kind);
}

interface ParsedRunLifecycleArgs {
  ok: true;
  planRunId: string;
  workspaceFlag?: string;
  reason?: string;
  jsonOutput: boolean;
}

function parseRunLifecycleArgs(args: string[]): ParsedRunLifecycleArgs | ParseError {
  let planRunId: string | undefined;
  let workspaceFlag: string | undefined;
  let reason: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--reason') {
      const v = args[++i];
      if (v === undefined || v.startsWith('--')) {
        return { ok: false, message: '--reason requires a value' };
      }
      reason = v;
    } else if (a.startsWith('--reason=')) {
      reason = a.slice('--reason='.length);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planRunId) {
      planRunId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planRunId) return { ok: false, message: 'run <verb> requires a planRunId' };
  return { ok: true, planRunId, workspaceFlag, reason, jsonOutput };
}

async function runRunLifecycleCmd(verb: RunLifecycleVerb, args: string[]): Promise<number> {
  const parsed = parseRunLifecycleArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: run ${verb}: ${parsed.message}\n`);
    const reasonHint = verb === 'resume' ? '' : ' [--reason <text>]';
    process.stderr.write(`Usage: yolo run ${verb} <planRunId> [--workspace <wsId>]${reasonHint} [--json]\n`);
    return 64;
  }
  const result = await runRunLifecycle({
    verb,
    planRunId: parsed.planRunId,
    workspaceFlag: parsed.workspaceFlag,
    reason: parsed.reason,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return runLifecycleExitCode(result.kind);
}

interface ParsedRunGetArgs {
  ok: true;
  planRunId: string;
  workspaceFlag?: string;
  jsonOutput: boolean;
}

function parseRunGetArgs(args: string[]): ParsedRunGetArgs | ParseError {
  let planRunId: string | undefined;
  let workspaceFlag: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planRunId) {
      planRunId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planRunId) return { ok: false, message: 'run get requires a planRunId' };
  return { ok: true, planRunId, workspaceFlag, jsonOutput };
}

function tileAppUsage(sub: 'sign' | 'publish' | 'validate' | 'dev' | 'init' | 'install' | 'add-tile' | 'media', message: string): number {
  process.stderr.write(`yolo tileapp ${sub}: ${message}\n`);
  const usage: Record<string, string> = {
    init: 'Usage: yolo tileapp init <name>   (scaffolds ./<name>/tileapp.json + index.html)\n',
    sign: 'Usage: yolo tileapp sign <manifest.json> --publisher <id> [--key <keyId>] [--stdout]\n',
    publish: 'Usage: yolo tileapp publish <manifest.json> --personal [--bundle-dir <dir>] [--context <dir>] [--dockerfile <f>] [--builder auto|podman|skopeo]   (personal app)\n'
      + '   or: yolo tileapp publish <manifest.json> [--channel beta|stable] [--image-digest <d>]   (marketplace)\n',
    validate: 'Usage: yolo tileapp validate <manifest.json> [--bundle-dir <dir>] [--personal]\n',
    dev: 'Usage: yolo tileapp dev <manifest.json> [--port N] [--host H] [--bundle-dir <dir>] [--deny]\n',
    install: 'Usage: yolo tileapp install <appId> --workspace <workspaceId> [--accept-optional <perm>]...\n',
    'add-tile': 'Usage: yolo tileapp add-tile <appId> --workspace <workspaceId> [--name <name>] [--version <v>]\n',
    media: 'Usage: yolo tileapp media push <manifest.json> [--dir <dir>]   (uploads store screenshots; additive, never touches the rest of the bundle)\n',
  };
  process.stderr.write(usage[sub]);
  return 64;
}

async function runTileAppInstallCmd(args: string[]): Promise<number> {
  let appId: string | undefined;
  let workspaceId: string | undefined;
  const acceptOptional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // A following flag must never be consumed as a value (`--workspace
    // --accept-optional=x`), so reject empty values and `--`-leading values —
    // same pattern as the run/plan parsers (codex gpt-5.6-sol P3, 2026-07-18).
    if (a === '--workspace') { const v = args[++i]; if (!v || v.startsWith('--')) return tileAppUsage('install', '--workspace requires a value'); workspaceId = v; }
    else if (a.startsWith('--workspace=')) { const v = a.slice('--workspace='.length); if (!v) return tileAppUsage('install', '--workspace requires a value'); workspaceId = v; }
    else if (a === '--accept-optional') { const v = args[++i]; if (!v || v.startsWith('--')) return tileAppUsage('install', '--accept-optional requires a value'); acceptOptional.push(v); }
    else if (a.startsWith('--accept-optional=')) { const v = a.slice('--accept-optional='.length); if (!v) return tileAppUsage('install', '--accept-optional requires a value'); acceptOptional.push(v); }
    else if (!a.startsWith('-') && !appId) appId = a;
    else return tileAppUsage('install', `unexpected argument '${a}'`);
  }
  if (!appId || !workspaceId) return tileAppUsage('install', 'an appId and --workspace <workspaceId> are required');
  const { runTileAppInstall, exitCodeForFailure } = await import('./tileapp-workspace.js');
  const result = await runTileAppInstall({ appId, workspaceId, acceptOptional });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

async function runTileAppAddTileCmd(args: string[]): Promise<number> {
  let appId: string | undefined;
  let workspaceId: string | undefined;
  let name: string | undefined;
  let version: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // Reject empty/`--`-leading values so a following flag is never consumed
    // as a value (codex gpt-5.6-sol P3, 2026-07-18).
    if (a === '--workspace') { const v = args[++i]; if (!v || v.startsWith('--')) return tileAppUsage('add-tile', '--workspace requires a value'); workspaceId = v; }
    else if (a.startsWith('--workspace=')) { const v = a.slice('--workspace='.length); if (!v) return tileAppUsage('add-tile', '--workspace requires a value'); workspaceId = v; }
    else if (a === '--name') { const v = args[++i]; if (!v || v.startsWith('--')) return tileAppUsage('add-tile', '--name requires a value'); name = v; }
    else if (a.startsWith('--name=')) { const v = a.slice('--name='.length); if (!v) return tileAppUsage('add-tile', '--name requires a value'); name = v; }
    else if (a === '--version') { const v = args[++i]; if (!v || v.startsWith('--')) return tileAppUsage('add-tile', '--version requires a value'); version = v; }
    else if (a.startsWith('--version=')) { const v = a.slice('--version='.length); if (!v) return tileAppUsage('add-tile', '--version requires a value'); version = v; }
    else if (!a.startsWith('-') && !appId) appId = a;
    else return tileAppUsage('add-tile', `unexpected argument '${a}'`);
  }
  if (!appId || !workspaceId) return tileAppUsage('add-tile', 'an appId and --workspace <workspaceId> are required');
  const { runTileAppAddTile, exitCodeForFailure } = await import('./tileapp-workspace.js');
  const result = await runTileAppAddTile({ appId, workspaceId, name, version });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

async function runMcpScopesCmd(args: string[]): Promise<number> {
  let agentId: string | undefined;
  let jsonOutput = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    // Reject empty/`--`-leading values so a following flag is never consumed
    // as a value (codex gpt-5.6-sol P3, 2026-07-18).
    if (a === '--agent') { const v = args[++i]; if (!v || v.startsWith('--')) { process.stderr.write('yolo mcp scopes: --agent requires a value\n'); return 64; } agentId = v; }
    else if (a.startsWith('--agent=')) { const v = a.slice('--agent='.length); if (!v) { process.stderr.write('yolo mcp scopes: --agent requires a value\n'); return 64; } agentId = v; }
    else if (a === '--json') jsonOutput = true;
    else { process.stderr.write(`yolo mcp scopes: unexpected argument '${a}'\nUsage: yolo mcp scopes [--agent <agentId>] [--json]\n`); return 64; }
  }
  const { runMcpScopes, exitCodeForFailure } = await import('./mcp-scopes.js');
  const result = await runMcpScopes({ agentId, outputFormat: jsonOutput ? 'json' : 'summary' });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

async function runTileAppSignCmd(args: string[]): Promise<number> {
  let manifestPath: string | undefined;
  let publisherId: string | undefined;
  let keyId: string | undefined;
  let toStdout = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--publisher' || a === '-p') { publisherId = args[++i]; if (publisherId === undefined) return tileAppUsage('sign', "--publisher requires a value"); }
    else if (a === '--key') { keyId = args[++i]; if (keyId === undefined) return tileAppUsage('sign', '--key requires a value'); }
    else if (a === '--stdout') toStdout = true;
    else if (!a.startsWith('-') && !manifestPath) manifestPath = a;
    else return tileAppUsage('sign', `unexpected argument '${a}'`);
  }
  if (!manifestPath || !publisherId) return tileAppUsage('sign', 'a manifest path and --publisher <id> are required');
  const result = await runTileAppSign({ manifestPath, publisherId, keyId, toStdout });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return tileAppExitCode(result.kind);
}

async function runTileAppPublishCmd(args: string[]): Promise<number> {
  let manifestPath: string | undefined;
  let channel: 'beta' | 'stable' | undefined;
  let imageDigest: string | undefined;
  let bundleDir: string | undefined;
  let context: string | undefined;
  let dockerfile: string | undefined;
  let builder: 'auto' | 'podman' | 'skopeo' | undefined;
  let personal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--personal' || a === '--private') { personal = true; }
    else if (a === '--bundle-dir') { bundleDir = args[++i]; if (bundleDir === undefined) return tileAppUsage('publish', '--bundle-dir requires a value'); }
    else if (a === '--context') { context = args[++i]; if (context === undefined) return tileAppUsage('publish', '--context requires a value'); }
    else if (a === '--dockerfile') { dockerfile = args[++i]; if (dockerfile === undefined) return tileAppUsage('publish', '--dockerfile requires a value'); }
    else if (a === '--builder') {
      const v = args[++i];
      if (v !== 'auto' && v !== 'podman' && v !== 'skopeo') return tileAppUsage('publish', `invalid --builder '${v ?? ''}' (expected auto|podman|skopeo)`);
      builder = v;
    }
    else if (a === '--channel') {
      const v = args[++i];
      if (v !== 'beta' && v !== 'stable') return tileAppUsage('publish', `invalid --channel '${v ?? ''}' (expected beta|stable)`);
      channel = v;
    } else if (a === '--image-digest') { imageDigest = args[++i]; if (imageDigest === undefined) return tileAppUsage('publish', '--image-digest requires a value'); }
    else if (!a.startsWith('-') && !manifestPath) manifestPath = a;
    else return tileAppUsage('publish', `unexpected argument '${a}'`);
  }
  if (!manifestPath) return tileAppUsage('publish', 'a manifest path is required');

  // Personal path: register under the caller's own namespace + upload the
  // bundle (no signing/review). Distinct from the marketplace publish below.
  if (personal) {
    const { runTileAppPublishPersonal, exitCodeForFailure } = await import('./tileapp-personal.js');
    const result = await runTileAppPublishPersonal({ manifestPath, bundleDir, context, dockerfile, builder });
    if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
    process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
    return exitCodeForFailure(result.kind);
  }
  if (bundleDir || context || dockerfile || builder) return tileAppUsage('publish', '--bundle-dir/--context/--dockerfile/--builder are only valid with --personal');

  const result = await runTileAppPublish({ manifestPath, channel, imageDigest });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return tileAppExitCode(result.kind);
}

async function runTileAppInitCmd(args: string[]): Promise<number> {
  let name: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (!a.startsWith('-') && !name) name = a;
    else return tileAppUsage('init', `unexpected argument '${a}'`);
  }
  if (!name) return tileAppUsage('init', 'an app name (slug) is required');
  const { runTileAppInit, exitCodeForFailure } = await import('./tileapp-personal.js');
  const result = runTileAppInit({ name });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

async function runTileAppMediaCmd(args: string[]): Promise<number> {
  // `exitCodeForFailure` (not devExitCode) — this command can fail with
  // auth/http kinds that the offline dev helper's narrower union doesn't cover.
  const { runTileAppMediaPush, exitCodeForFailure } = await import('./tileapp-personal.js');
  const action = args[0];
  if (action !== 'push') {
    return tileAppUsage('media', action ? `unknown action '${action}' (expected: push)` : 'an action is required (push)');
  }
  let manifestPath: string | undefined;
  let dir: string | undefined;
  for (let i = 1; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--dir') { dir = args[++i]; if (dir === undefined) return tileAppUsage('media', '--dir requires a value'); }
    else if (!a.startsWith('-') && !manifestPath) manifestPath = a;
    else return tileAppUsage('media', `unexpected argument '${a}'`);
  }
  if (!manifestPath) return tileAppUsage('media', 'a manifest path is required');
  const result = await runTileAppMediaPush({ manifestPath, dir });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

async function runTileAppValidateCmd(args: string[]): Promise<number> {
  const { runTileAppValidate, devExitCode } = await import('./tileapp-developer.js');
  let manifestPath: string | undefined;
  let bundleDir: string | undefined;
  let personal = false;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--bundle-dir') { bundleDir = args[++i]; if (bundleDir === undefined) return tileAppUsage('validate', '--bundle-dir requires a value'); }
    else if (a === '--personal') { personal = true; }
    else if (!a.startsWith('-') && !manifestPath) manifestPath = a;
    else return tileAppUsage('validate', `unexpected argument '${a}'`);
  }
  if (!manifestPath) return tileAppUsage('validate', 'a manifest path is required');
  const result = runTileAppValidate({ manifestPath, bundleDir, personal });
  if (result.ok) { process.stdout.write(`${result.output}\n`); return 0; }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return devExitCode(result.kind);
}

async function runTileAppDevCmd(args: string[]): Promise<number> {
  const { runTileAppDev } = await import('./tileapp-developer.js');
  let manifestPath: string | undefined;
  let bundleDir: string | undefined;
  let host = '127.0.0.1';
  let port: number | undefined;
  let allow = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--bundle-dir') { bundleDir = args[++i]; if (bundleDir === undefined) return tileAppUsage('dev', '--bundle-dir requires a value'); }
    else if (a === '--port' || a === '-p') { const v = args[++i]; const n = Number(v); if (!Number.isInteger(n) || n < 1 || n > 65535) return tileAppUsage('dev', `invalid --port '${v ?? ''}'`); port = n; }
    else if (a === '--host') { host = args[++i] ?? host; }
    else if (a === '--deny') allow = false;
    else if (!a.startsWith('-') && !manifestPath) manifestPath = a;
    else return tileAppUsage('dev', `unexpected argument '${a}'`);
  }
  if (!manifestPath) return tileAppUsage('dev', 'a manifest path is required');
  if (port === undefined) { const envPort = Number(process.env.PORT); port = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 3000; }
  return runTileAppDev({ manifestPath, port, host, bundleDir, allow });
}

async function runRunGetCmd(args: string[]): Promise<number> {
  const parsed = parseRunGetArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: run get: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo run get <planRunId> [--workspace <wsId>] [--json]\n');
    return 64;
  }
  const result = await runRunGet({
    planRunId: parsed.planRunId,
    workspaceFlag: parsed.workspaceFlag,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return runGetExitCode(result.kind);
}

interface ParsedRunListArgs {
  ok: true;
  workspaceFlag?: string;
  stateFilter?: RunExecutionState;
  jsonOutput: boolean;
}

function parseRunListArgs(args: string[]): ParsedRunListArgs | ParseError {
  let workspaceFlag: string | undefined;
  let stateFilter: RunExecutionState | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--state') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--state requires a value' };
      stateFilter = v as RunExecutionState;
    } else if (a.startsWith('--state=')) {
      stateFilter = a.slice('--state='.length) as RunExecutionState;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  return { ok: true, workspaceFlag, stateFilter, jsonOutput };
}

async function runRunListCmd(args: string[]): Promise<number> {
  const parsed = parseRunListArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: run list: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo run list [--workspace <wsId>] [--state <pending|running|paused|succeeded|failed|cancelled|superseded>] [--json]\n');
    return 64;
  }
  const result = await runRunList({
    workspaceFlag: parsed.workspaceFlag,
    stateFilter: parsed.stateFilter,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return runListExitCode(result.kind);
}

interface ParsedRunTransferArgs {
  ok: true;
  planRunId: string;
  /** Resolved target. Either a non-empty agentId or null (user-driven). */
  newOperatorAgentId: string | null;
  workspaceFlag?: string;
  jsonOutput: boolean;
}

function parseRunTransferArgs(args: string[]): ParsedRunTransferArgs | ParseError {
  let planRunId: string | undefined;
  let workspaceFlag: string | undefined;
  let toFlag: string | undefined;
  let userDriven = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--to') {
      const v = args[++i];
      if (!v || v.startsWith('--')) {
        // Without the `--` guard, `--to --user-driven` and `--to --json`
        // silently consume the next flag as the agentId, bypassing the
        // mutex / boolean check and triggering a network round-trip with
        // a bogus target. Use the `--to=<value>` form for values that
        // legitimately start with `--`.
        return { ok: false, message: '--to requires an agentId value' };
      }
      toFlag = v;
    } else if (a.startsWith('--to=')) {
      toFlag = a.slice('--to='.length);
    } else if (a === '--user-driven') {
      userDriven = true;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planRunId) {
      planRunId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planRunId) return { ok: false, message: 'run transfer requires a planRunId' };
  if (toFlag !== undefined && userDriven) {
    return { ok: false, message: '--to and --user-driven are mutually exclusive' };
  }
  if (toFlag === undefined && !userDriven) {
    return { ok: false, message: 'one of --to <agentId> or --user-driven is required' };
  }
  return {
    ok: true,
    planRunId,
    newOperatorAgentId: userDriven ? null : (toFlag as string),
    workspaceFlag,
    jsonOutput,
  };
}

async function runRunTransferCmd(args: string[]): Promise<number> {
  const parsed = parseRunTransferArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: run transfer: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo run transfer <planRunId> (--to <agentId> | --user-driven) [--workspace <wsId>] [--json]\n');
    return 64;
  }
  const result = await runRunTransfer({
    planRunId: parsed.planRunId,
    newOperatorAgentId: parsed.newOperatorAgentId,
    workspaceFlag: parsed.workspaceFlag,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return runTransferExitCode(result.kind);
}

interface ParsedArtifactGetArgs {
  ok: true;
  key: string;
  version?: number;
  workspaceFlag?: string;
  contentOutput: boolean;
  jsonOutput: boolean;
}

function parseArtifactGetArgs(args: string[]): ParsedArtifactGetArgs | ParseError {
  let key: string | undefined;
  let version: number | undefined;
  let workspaceFlag: string | undefined;
  let contentOutput = false;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--version') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--version requires an integer value' };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, message: `--version must be a positive integer (got '${v}')` };
      }
      version = n;
    } else if (a.startsWith('--version=')) {
      const raw = a.slice('--version='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1) {
        return { ok: false, message: `--version must be a positive integer (got '${raw}')` };
      }
      version = n;
    } else if (a === '--content') {
      contentOutput = true;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!key) {
      key = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!key) return { ok: false, message: 'artifact get requires a key' };
  if (contentOutput && jsonOutput) {
    return { ok: false, message: '--content and --json are mutually exclusive' };
  }
  return { ok: true, key, version, workspaceFlag, contentOutput, jsonOutput };
}

async function runArtifactGetCmd(args: string[]): Promise<number> {
  const parsed = parseArtifactGetArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: artifact get: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo artifact get <key> [--version <n>] [--workspace <wsId>] [--content | --json]\n');
    return 64;
  }
  const outputFormat = parsed.jsonOutput ? 'json' : parsed.contentOutput ? 'content' : 'summary';
  const result = await runArtifactGet({
    key: parsed.key,
    version: parsed.version,
    workspaceFlag: parsed.workspaceFlag,
    outputFormat,
  });
  if (result.ok) {
    // For --content, the body might be binary-ish text we don't want a trailing newline on.
    // Stdout the content verbatim; the user can pipe it to a file.
    if (outputFormat === 'content') {
      process.stdout.write(result.output);
    } else {
      process.stdout.write(`${result.output}\n`);
    }
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return artifactGetExitCode(result.kind);
}

interface ParsedArtifactListArgs {
  ok: true;
  workspaceFlag?: string;
  prefix?: string;
  limit?: number;
  jsonOutput: boolean;
}

function parseArtifactListArgs(args: string[]): ParsedArtifactListArgs | ParseError {
  let workspaceFlag: string | undefined;
  let prefix: string | undefined;
  let limit: number | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--prefix') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--prefix requires a value' };
      prefix = v;
    } else if (a.startsWith('--prefix=')) {
      prefix = a.slice('--prefix='.length);
    } else if (a === '--limit') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--limit requires an integer value' };
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return { ok: false, message: `--limit must be an integer between 1 and 500 (got '${v}')` };
      }
      limit = n;
    } else if (a.startsWith('--limit=')) {
      const raw = a.slice('--limit='.length);
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 1 || n > 500) {
        return { ok: false, message: `--limit must be an integer between 1 and 500 (got '${raw}')` };
      }
      limit = n;
    } else if (a === '--json') {
      jsonOutput = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  return { ok: true, workspaceFlag, prefix, limit, jsonOutput };
}

async function runArtifactListCmd(args: string[]): Promise<number> {
  const parsed = parseArtifactListArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: artifact list: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo artifact list [--prefix <prefix>] [--limit <n>] [--workspace <wsId>] [--json]\n');
    return 64;
  }
  const result = await runArtifactList({
    workspaceFlag: parsed.workspaceFlag,
    prefix: parsed.prefix,
    limit: parsed.limit,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
  });
  if (result.ok) {
    process.stdout.write(`${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return artifactListExitCode(result.kind);
}

async function main(argv: string[]): Promise<number> {
  const [, , ...args] = argv;
  const cmd = args[0];

  if (!cmd || cmd === '--help' || cmd === '-h') {
    printHelp();
    return 0;
  }

  if (cmd === '--version' || cmd === '-v') {
    process.stdout.write(`${PKG_VERSION}\n`);
    return 0;
  }

  if (cmd === 'context' || cmd === 'env' || cmd === 'env-doctor') {
    try {
      const ctx = readSessionContext();
      process.stdout.write(formatContext(ctx));
      return 0;
    } catch (err) {
      if (err instanceof ContextResolutionError) {
        process.stderr.write(`yolo: ${err.message}\n`);
        return err.exitCode;
      }
      throw err;
    }
  }

  if (cmd === 'plan') {
    const sub = args[1];
    if (sub === 'validate') {
      return runPlanValidate(args.slice(2));
    }
    if (sub === 'import') {
      return runPlanImportCmd(args.slice(2));
    }
    if (sub === 'export') {
      return runPlanExportCmd(args.slice(2));
    }
    if (sub === 'activate') {
      return runPlanStateCmd('activate', args.slice(2));
    }
    if (sub === 'archive') {
      return runPlanStateCmd('archive', args.slice(2));
    }
    if (sub === 'get') {
      return runPlanGetCmd(args.slice(2));
    }
    if (sub === 'list') {
      return runPlanListCmd(args.slice(2));
    }
    if (sub === 'open') {
      return runPlanOpenCmd(args.slice(2));
    }
    if (!sub) {
      process.stderr.write('yolo: plan requires a subcommand (validate, import, export, activate, archive, get, list, open)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown plan subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: validate, import, export, activate, archive, get, list, open\n');
    return 64;
  }

  if (cmd === 'run') {
    const sub = args[1];
    if (sub === 'start') {
      return runRunStartCmd(args.slice(2));
    }
    if (sub === 'get') {
      return runRunGetCmd(args.slice(2));
    }
    if (sub === 'list') {
      return runRunListCmd(args.slice(2));
    }
    if (sub === 'pause' || sub === 'resume' || sub === 'cancel') {
      return runRunLifecycleCmd(sub, args.slice(2));
    }
    if (sub === 'transfer') {
      return runRunTransferCmd(args.slice(2));
    }
    if (!sub) {
      process.stderr.write('yolo: run requires a subcommand (start, get, list, pause, resume, cancel, transfer)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown run subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: start, get, list, pause, resume, cancel, transfer\n');
    return 64;
  }

  if (cmd === 'artifact') {
    const sub = args[1];
    if (sub === 'get') {
      return runArtifactGetCmd(args.slice(2));
    }
    if (sub === 'list') {
      return runArtifactListCmd(args.slice(2));
    }
    if (!sub) {
      process.stderr.write('yolo: artifact requires a subcommand (get, list)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown artifact subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: get, list\n');
    return 64;
  }

  if (cmd === 'tileapp') {
    const sub = args[1];
    if (sub === 'init') return runTileAppInitCmd(args.slice(2));
    if (sub === 'sign') return runTileAppSignCmd(args.slice(2));
    if (sub === 'publish') return runTileAppPublishCmd(args.slice(2));
    if (sub === 'validate') return runTileAppValidateCmd(args.slice(2));
    if (sub === 'dev') return runTileAppDevCmd(args.slice(2));
    if (sub === 'install') return runTileAppInstallCmd(args.slice(2));
    if (sub === 'add-tile') return runTileAppAddTileCmd(args.slice(2));
    if (sub === 'media') return runTileAppMediaCmd(args.slice(2));
    if (!sub) {
      process.stderr.write('yolo: tileapp requires a subcommand (init, validate, dev, sign, publish, media, install, add-tile)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown tileapp subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: init, validate, dev, sign, publish, media, install, add-tile\n');
    return 64;
  }

  if (cmd === 'mcp') {
    const sub = args[1];
    if (sub === 'scopes') return runMcpScopesCmd(args.slice(2));
    if (!sub) {
      process.stderr.write('yolo: mcp requires a subcommand (scopes)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown mcp subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: scopes\n');
    return 64;
  }

  if (cmd === 'serve') {
    const { runServeCmd } = await import('./serve.js');
    return runServeCmd(args.slice(1));
  }

  if (cmd === 'deploy') {
    // Lazy-load (serve precedent) so the deploy stack — incl. esbuild via
    // deploy-bundle — never taxes `yolo plan` startup.
    const { runDeployCmd } = await import('./deploy-cli.js');
    return runDeployCmd(args.slice(1));
  }

  process.stderr.write(`yolo: unknown command '${cmd}'\n`);
  printHelp();
  return 64; // EX_USAGE
}

main(process.argv).then(
  (code) => process.exit(code),
  (err) => {
    process.stderr.write(`yolo: unexpected error: ${err?.message ?? err}\n`);
    process.exit(1);
  },
);
