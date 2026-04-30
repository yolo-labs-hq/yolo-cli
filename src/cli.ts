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
import { runPlanImport, formatSuccess, exitCodeForFailure } from './plan-import.js';

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
      '  --version                                 Print substrate CLI version.',
      '  --help                                    Print this help.',
      '',
      'Future commands (Phase 8c.4+): plan export.',
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
    process.stdout.write(`${formatSuccess(result)}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
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
    if (!sub) {
      process.stderr.write('yolo: plan requires a subcommand (validate, import)\n');
      return 64;
    }
    process.stderr.write(`yolo: unknown plan subcommand '${sub}'\n`);
    process.stderr.write('Subcommands: validate, import\n');
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
