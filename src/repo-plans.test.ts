/**
 * Repo-wide plan-file sweep (Phase 8c.5).
 *
 * Walks every `.md` file under `.yolo/plans/` and `tests/fixtures/plans/`
 * in the repository and runs the offline `validatePlanText` (parse +
 * schema + canonical + no-coercion) on each. Catches:
 *
 *   - Non-canonical files (wrong field order, missing lex sort, body
 *     normalization drift).
 *   - Schema regressions (e.g., a future PR introduces a value the
 *     Draft-07 schema rejects).
 *   - Silent YAML coercion in free-form maps (`gate.config`,
 *     `integrationPolicy`).
 *
 * Pairs with `.github/workflows/yolo-cli-tests.yml`, which runs
 * `npm test` in this package on every PR touching `packages/yolo-cli/`,
 * `.yolo/plans/`, or `tests/fixtures/plans/`. Together they're the
 * Phase 8c.5 round-trip CI check the design called for: a committed
 * plan file MUST be in canonical, schema-valid, no-coercion form.
 *
 * (`yolo plan import`/`export` — the network round-trip this check
 * originally stood in for — were removed as dead CLI surface in the Plan
 * Run substrate tear-down; they had no backing common-api route. `yolo
 * plan validate` is the only surviving `plan` subcommand, and this sweep
 * is now the only thing enforcing canonical form on committed plan files.)
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { validatePlanText, formatErrors } from './plan-validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');

/**
 * Directories to sweep. Order is stable for deterministic test output.
 * Each entry is a path relative to the repo root.
 */
const PLAN_DIRECTORIES: ReadonlyArray<string> = [
  '.yolo/plans',
  'tests/fixtures/plans',
];

/**
 * Files we explicitly skip inside swept directories. These are not
 * plan files — they're the schema, lockfiles, or supporting material.
 */
const SKIP_BASENAMES: ReadonlySet<string> = new Set([
  '.schema.json',
  '.imports.json',
]);

/**
 * Discover all candidate plan files: `*.md` directly inside one of
 * `PLAN_DIRECTORIES`, with `SKIP_BASENAMES` filtered out and dotfiles
 * (`.imports.<env>.json` and friends) skipped. Returns repo-relative
 * paths so failure messages stay readable.
 */
function discoverPlanFiles(): string[] {
  const found: string[] = [];
  for (const dir of PLAN_DIRECTORIES) {
    const abs = path.join(REPO_ROOT, dir);
    let entries: string[];
    try {
      entries = readdirSync(abs);
    } catch {
      // Directory doesn't exist yet (e.g., `.yolo/plans/` before 8d's
      // first migration). Treat as empty — not an error.
      continue;
    }
    for (const entry of entries) {
      if (SKIP_BASENAMES.has(entry)) continue;
      if (entry.startsWith('.imports.') && entry.endsWith('.json')) continue;
      const full = path.join(abs, entry);
      let stat;
      try {
        stat = statSync(full);
      } catch {
        continue;
      }
      if (!stat.isFile()) continue;
      if (path.extname(entry) !== '.md') continue;
      found.push(path.relative(REPO_ROOT, full));
    }
  }
  return found.sort();
}

describe('repo-plans — every committed plan file is canonical, schema-valid, no-coercion', () => {
  const files = discoverPlanFiles();

  it('discovery sweep finds at least the gate-coverage fixture', () => {
    // Belt-and-suspenders against a future refactor that breaks the
    // sweep (e.g., wrong REPO_ROOT). The gate-coverage fixture is
    // committed and stable; if the sweep can't even find it, this
    // test catches the misconfiguration before it produces silent
    // false-passes on the per-file checks below.
    assert.ok(
      files.some((f) => f.endsWith('tests/fixtures/plans/gate-coverage.md')),
      `discovery sweep failed to find tests/fixtures/plans/gate-coverage.md; found: [${files.join(', ')}]`,
    );
  });

  // One test per discovered file — gives clean per-file output in the
  // spec reporter, isolates failures, and lets Codex point at one
  // specific file when something drifts.
  for (const file of files) {
    it(`${file} validates clean (parse + schema + canonical + no-coercion)`, () => {
      const text = readFileSync(path.join(REPO_ROOT, file), 'utf8');
      const result = validatePlanText(text);
      if (!result.ok) {
        assert.fail(
          `${file} failed validation:\n${formatErrors(result.errors)}\n\n` +
            `Run \`yolo plan validate ${file}\` locally to reproduce. To fix, edit the file by ` +
            `hand. Canonical = schema-defined field order at every level, lex-sorted keys in ` +
            `free-form maps (gate.config, integrationPolicy, template.metadata), strings (not ` +
            `booleans/numbers) at every leaf of those maps, LF endings, single trailing newline.`,
        );
      }
    });
  }
});
