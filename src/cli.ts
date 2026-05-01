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
 * Auth contract (Round 5 trio): `SESSION_ID`, `YOLO_COMMON_API_URL`,
 * `INTERNAL_API_KEY`. The CLI exits with `session-required` if
 * `SESSION_ID` is missing — outside-container invocation is out of
 * scope for v1 (future external-login flow). Workspace binding is
 * derived from the session record, not from env or args.
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
  runPlanList,
  exitCodeForFailure as listExitCode,
  type PlanAuthoringState,
} from './plan-list.js';

const PKG_VERSION = '0.1.0';

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
      '    [--env <name>]                          Use .imports.<env>.json instead of the gitignored default.',
      '    [--force]                               Override divergence (DB ahead of lockfile) or 409 on create.',
      '  plan export <planId> [opts]               Export DB → file (work.get_plan + canonicalize).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--env <name>]                          Refresh .imports.<env>.json instead of the default.',
      '    [-o <file>]                             Output path. Default: <plansDir>/<planId>.md.',
      '  plan activate <planId> [opts]             Transition authoringState → active (work.update_plan).',
      '  plan archive <planId> [opts]              Transition authoringState → archived (work.update_plan).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--env <name>]                          Refresh .imports.<env>.json lockfile entry post-update.',
      '  plan get <planId> [opts]                  Read a Plan from the DB (work.get_plan, no file write).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--json]                                Pretty-print raw JSON instead of the summary.',
      '  plan list [opts]                          List Plans in the current workspace (work.list_plans).',
      '    [--workspace <wsId>]                    Sanity-check the workspace bound to this session.',
      '    [--state <draft|active|archived>]       Server-side authoringState filter.',
      '    [--json]                                Pretty-print raw JSON instead of the table.',
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
  envFlag?: string;
  force: boolean;
}

interface ParseError {
  ok: false;
  message: string;
}

function parseImportArgs(args: string[]): ParsedImportArgs | ParseError {
  let filePath: string | undefined;
  let workspaceFlag: string | undefined;
  let envFlag: string | undefined;
  let force = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--env') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--env requires a value' };
      envFlag = v;
    } else if (a.startsWith('--env=')) {
      envFlag = a.slice('--env='.length);
    } else if (a === '--force') {
      force = true;
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!filePath) {
      filePath = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!filePath) return { ok: false, message: 'plan import requires a file path' };
  return { ok: true, filePath, workspaceFlag, envFlag, force };
}

async function runPlanImportCmd(args: string[]): Promise<number> {
  const parsed = parseImportArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan import <file> [--workspace <wsId>] [--env <name>] [--force]\n');
    return 64;
  }
  const result = await runPlanImport({
    filePath: parsed.filePath,
    workspaceFlag: parsed.workspaceFlag,
    envFlag: parsed.envFlag,
    force: parsed.force,
  });
  if (result.ok) {
    process.stdout.write(`${formatImportSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return importExitCode(result.kind);
}

interface ParsedExportArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  envFlag?: string;
  outputFlag?: string;
}

function parseExportArgs(args: string[]): ParsedExportArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let envFlag: string | undefined;
  let outputFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--env') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--env requires a value' };
      envFlag = v;
    } else if (a.startsWith('--env=')) {
      envFlag = a.slice('--env='.length);
    } else if (a === '-o' || a === '--output') {
      const v = args[++i];
      if (!v) return { ok: false, message: '-o requires a value' };
      outputFlag = v;
    } else if (a.startsWith('--output=')) {
      outputFlag = a.slice('--output='.length);
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'plan export requires a planId' };
  return { ok: true, planId, workspaceFlag, envFlag, outputFlag };
}

async function runPlanExportCmd(args: string[]): Promise<number> {
  const parsed = parseExportArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan export <planId> [--workspace <wsId>] [--env <name>] [-o <file>]\n');
    return 64;
  }
  const result = await runPlanExport({
    planId: parsed.planId,
    workspaceFlag: parsed.workspaceFlag,
    envFlag: parsed.envFlag,
    outputFlag: parsed.outputFlag,
  });
  if (result.ok) {
    process.stdout.write(`${formatExportSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exportExitCode(result.kind);
}

interface ParsedStateArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  envFlag?: string;
}

function parseStateArgs(args: string[]): ParsedStateArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let envFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--env') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--env requires a value' };
      envFlag = v;
    } else if (a.startsWith('--env=')) {
      envFlag = a.slice('--env='.length);
    } else if (a.startsWith('--')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (!planId) {
      planId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!planId) return { ok: false, message: 'requires a planId' };
  return { ok: true, planId, workspaceFlag, envFlag };
}

async function runPlanStateCmd(verb: 'activate' | 'archive', args: string[]): Promise<number> {
  const parsed = parseStateArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: plan ${verb}: ${parsed.message}\n`);
    process.stderr.write(`Usage: yolo plan ${verb} <planId> [--workspace <wsId>] [--env <name>]\n`);
    return 64;
  }
  const targetState: OperatorTargetState = verb === 'activate' ? 'active' : 'archived';
  const result = await runPlanStateTransition({
    planId: parsed.planId,
    targetState,
    workspaceFlag: parsed.workspaceFlag,
    envFlag: parsed.envFlag,
  });
  if (result.ok) {
    process.stdout.write(`${formatStateSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return stateExitCode(result.kind);
}

interface ParsedGetArgs {
  ok: true;
  planId: string;
  workspaceFlag?: string;
  jsonOutput: boolean;
}

function parseGetArgs(args: string[]): ParsedGetArgs | ParseError {
  let planId: string | undefined;
  let workspaceFlag: string | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--workspace requires a value' };
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

  if (!planId) return { ok: false, message: 'plan get requires a planId' };
  return { ok: true, planId, workspaceFlag, jsonOutput };
}

async function runPlanGetCmd(args: string[]): Promise<number> {
  const parsed = parseGetArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: ${parsed.message}\n`);
    process.stderr.write('Usage: yolo plan get <planId> [--workspace <wsId>] [--json]\n');
    return 64;
  }
  const result = await runPlanGet({
    planId: parsed.planId,
    workspaceFlag: parsed.workspaceFlag,
    outputFormat: parsed.jsonOutput ? 'json' : 'summary',
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
  stateFilter?: PlanAuthoringState;
  jsonOutput: boolean;
}

function parseListArgs(args: string[]): ParsedListArgs | ParseError {
  let workspaceFlag: string | undefined;
  let stateFilter: PlanAuthoringState | undefined;
  let jsonOutput = false;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      workspaceFlag = a.slice('--workspace='.length);
    } else if (a === '--state') {
      const v = args[++i];
      if (!v) return { ok: false, message: '--state requires a value' };
      stateFilter = v as PlanAuthoringState;
    } else if (a.startsWith('--state=')) {
      stateFilter = a.slice('--state='.length) as PlanAuthoringState;
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
    if (!sub) {
      process.stderr.write('yolo: plan requires a subcommand (validate, import, export, activate, archive, get, list)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown plan subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: validate, import, export, activate, archive, get, list\n');
    return 64;
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
