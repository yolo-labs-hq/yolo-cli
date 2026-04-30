/**
 * Validator tests (Phase 8c.1).
 *
 * Pin the three checks `yolo plan validate` performs:
 *   - parse  (well-formed `---` frontmatter / YAML mapping)
 *   - schema (Draft-07 JSON Schema, via Ajv 6.12)
 *   - canonical (round-trip byte-equal through canonicalizer)
 *
 * Plus the schema-drift guard between the in-package
 * `src/plan-frontmatter.schema.json` and the repo's
 * `.yolo/plans/.schema.json` — these MUST stay byte-equal.
 *
 * Uses the gate-coverage fixture from 8b (canonical, schema-valid)
 * as the green-path anchor; corrupts copies of it for the failure
 * paths so each test has a focused single-issue input.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

import { validatePlanText, formatErrors } from './plan-validate.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE_COVERAGE_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'plans', 'gate-coverage.md');
const REPO_SCHEMA_PATH = path.join(REPO_ROOT, '.yolo', 'plans', '.schema.json');
const PACKAGE_SCHEMA_PATH = path.join(__dirname, 'plan-frontmatter.schema.json');

const FIXTURE_TEXT = readFileSync(GATE_COVERAGE_FIXTURE, 'utf8');

// ─── Schema-drift guard ──────────────────────────────────────────────────
// The substrate CLI ships an embedded copy of the schema (loaded at
// runtime by Ajv); the repo's `.yolo/plans/.schema.json` is the
// IDE/yaml-language-server copy. Keeping them byte-equal is the only
// sane policy — if a future schema edit only updates one, this test
// fails and forces a re-copy.
describe('plan-validate — embedded schema drift guard', () => {
  it('packaged schema is byte-identical to the repo schema', () => {
    const packaged = readFileSync(PACKAGE_SCHEMA_PATH, 'utf8');
    const repo = readFileSync(REPO_SCHEMA_PATH, 'utf8');
    assert.equal(
      packaged,
      repo,
      'packages/yolo-cli/src/plan-frontmatter.schema.json must match .yolo/plans/.schema.json byte-for-byte; sync via `cp .yolo/plans/.schema.json packages/yolo-cli/src/plan-frontmatter.schema.json`',
    );
  });
});

// ─── Green path ──────────────────────────────────────────────────────────
describe('plan-validate — green path', () => {
  it('accepts the canonical gate-coverage fixture', () => {
    const result = validatePlanText(FIXTURE_TEXT);
    assert.equal(result.ok, true);
    if (result.ok) {
      assert.equal(result.planId, 'gate-coverage');
      assert.equal(result.bytes, FIXTURE_TEXT.length);
    }
  });
});

// ─── Parse failures ──────────────────────────────────────────────────────
describe('plan-validate — parse failures', () => {
  it('rejects a file missing the opening `---` delimiter', () => {
    const bad = FIXTURE_TEXT.replace(/^---\n/, '');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]!.kind, 'parse');
      assert.match(result.errors[0]!.message, /---/);
    }
  });

  it('rejects a file missing the closing `---` delimiter', () => {
    const bad = FIXTURE_TEXT.replace(/\n---\n/, '\n');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]!.kind, 'parse');
    }
  });

  it('rejects a file whose frontmatter parses as a list rather than a mapping', () => {
    const bad = '---\n- a\n- b\n---\n\n# body\n';
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]!.kind, 'parse');
      assert.match(result.errors[0]!.message, /mapping/);
    }
  });

  it('rejects malformed YAML in the frontmatter', () => {
    // Tab indentation under a mapping is a YAML parse error in js-yaml.
    const bad = '---\nplanId: p1\n\tnested: bad\n---\n\n# body\n';
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.equal(result.errors[0]!.kind, 'parse');
      assert.match(result.errors[0]!.message, /YAML parse failed/);
    }
  });
});

// ─── Schema failures ─────────────────────────────────────────────────────
describe('plan-validate — schema failures', () => {
  it('rejects an unknown failurePolicy enum value', () => {
    const bad = FIXTURE_TEXT.replace(
      'failurePolicy: pause-and-wait',
      'failurePolicy: rage-quit',
    );
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const schemaErrs = result.errors.filter((e) => e.kind === 'schema');
      assert.ok(schemaErrs.length > 0, 'expected at least one schema error');
      assert.ok(
        schemaErrs.some((e) => e.path === '.failurePolicy' && /allowed values/i.test(e.message ?? '')),
        'expected an allowed-values rejection on .failurePolicy (Ajv 6.12 enum error)',
      );
    }
  });

  it('rejects DB-only top-level fields (additionalProperties: false)', () => {
    // Inject a `_id` field after the planId line to trip
    // additionalProperties at the top level.
    const bad = FIXTURE_TEXT.replace(
      'planId: gate-coverage\n',
      'planId: gate-coverage\n_id: 507f1f77bcf86cd799439011\n',
    );
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const schemaErrs = result.errors.filter((e) => e.kind === 'schema');
      assert.ok(
        schemaErrs.some((e) =>
          /additionalProperties|should NOT have additional/i.test(e.message ?? ''),
        ),
        'expected additionalProperties rejection',
      );
    }
  });

  it('rejects missing required top-level field', () => {
    const bad = FIXTURE_TEXT.replace(/^planId: gate-coverage\n/m, '');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const schemaErrs = result.errors.filter((e) => e.kind === 'schema');
      assert.ok(
        schemaErrs.some((e) => /required/i.test(e.message ?? '')),
        'expected a required-field rejection',
      );
    }
  });
});

// ─── Canonical-form failures ─────────────────────────────────────────────
describe('plan-validate — canonical-form failures', () => {
  it('rejects a file with non-canonical field order at the plan level', () => {
    // Swap planId and name — schema is happy (both still present), but
    // canonical order requires planId first.
    const bad = FIXTURE_TEXT
      .replace(
        /^planId: gate-coverage\nname: Gate-coverage canary\n/m,
        'name: Gate-coverage canary\nplanId: gate-coverage\n',
      );
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const canonicalErrs = result.errors.filter((e) => e.kind === 'canonical');
      assert.equal(canonicalErrs.length, 1);
    }
  });

  it('rejects a file whose merge-gate config keys are not lex-sorted', () => {
    const bad = FIXTURE_TEXT.replace(
      /allowedStrategies:\n            - squash\n            - merge\n          baseBranch: main\n          blockOnConflict: true\n          requireGreenCi: true/,
      'baseBranch: main\n          requireGreenCi: true\n          allowedStrategies:\n            - squash\n            - merge\n          blockOnConflict: true',
    );
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.kind === 'canonical'),
        'expected canonical-form error',
      );
    }
  });

  it('rejects CRLF line endings in the body', () => {
    const bad = FIXTURE_TEXT.replace(/\n/g, '\r\n');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(result.errors.some((e) => e.kind === 'canonical'));
    }
  });
});

// ─── formatErrors ───────────────────────────────────────────────────────
describe('plan-validate — formatErrors', () => {
  it('renders one line per error with kind tag', () => {
    const out = formatErrors([
      { kind: 'schema', message: 'should be string', path: '.name' },
      { kind: 'canonical', message: 'not canonical' },
    ]);
    const lines = out.split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^\[schema\]/);
    assert.match(lines[0]!, /\.name/);
    assert.match(lines[1]!, /^\[canonical\]/);
  });
});
