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

const PKG_VERSION = '0.1.0';

function printHelp(): void {
  process.stdout.write(
    [
      'Usage: yolo <command> [options]',
      '',
      'Commands:',
      '  context           Print resolved session/workspace/API context.',
      '  --version         Print substrate CLI version.',
      '  --help            Print this help.',
      '',
      'Future commands (Phase 8c+): plan validate / import / export.',
      '',
      'Distinct from:',
      '  yolo-code   — the YOLO Studio coding-agent CLI.',
      '  yolo-router — the LLM gateway client (LLM API forwarder).',
      '',
    ].join('\n'),
  );
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
