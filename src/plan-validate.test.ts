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
      /allowedStrategies:\n            - squash\n            - merge\n          baseBranch: main\n          blockOnConflict: "true"\n          requireGreenCi: "true"/,
      'baseBranch: main\n          requireGreenCi: "true"\n          allowedStrategies:\n            - squash\n            - merge\n          blockOnConflict: "true"',
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

// ─── No-coercion rule on free-form maps (Codex 8c.1 Round 1) ────────────
//
// js-yaml's default `load` coerces unquoted scalars to JS booleans /
// numbers. Phase 8 design says gate.config + integrationPolicy values
// must stay as strings (Round 4 Q6). The schema's
// `additionalProperties: true` for those maps can't catch the drift,
// so plan-validate's post-parse walker (`assertStringValuedFreeFormMap`)
// is the enforcement point.
describe('plan-validate — no-coercion rule on free-form maps', () => {
  it('rejects an unquoted boolean in gate.config (retryFlakes: true → bool)', () => {
    const bad = FIXTURE_TEXT.replace('retryFlakes: "true"', 'retryFlakes: true');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const coercionErr = result.errors.find(
        (e) => e.kind === 'schema' && e.path?.endsWith('retryFlakes'),
      );
      assert.ok(coercionErr, 'expected a coercion error on retryFlakes');
      assert.match(coercionErr!.message, /string/);
      assert.match(coercionErr!.message, /quote/);
      assert.match(coercionErr!.message, /boolean/);
    }
  });

  it('rejects an unquoted number in gate.config (minPassRate: 0.95 → number)', () => {
    const bad = FIXTURE_TEXT.replace('minPassRate: "0.95"', 'minPassRate: 0.95');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const coercionErr = result.errors.find(
        (e) => e.kind === 'schema' && e.path?.endsWith('minPassRate'),
      );
      assert.ok(coercionErr, 'expected a coercion error on minPassRate');
      assert.match(coercionErr!.message, /number/);
    }
  });

  it('rejects an unquoted boolean in integrationPolicy (squashMerge: true → bool)', () => {
    const bad = FIXTURE_TEXT.replace('squashMerge: "true"', 'squashMerge: true');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const coercionErr = result.errors.find(
        (e) => e.kind === 'schema' && e.path === '.integrationPolicy.squashMerge',
      );
      assert.ok(coercionErr, 'expected a coercion error on integrationPolicy.squashMerge');
    }
  });

  it('rejects a non-string item inside a string array in gate.config', () => {
    const bad = FIXTURE_TEXT.replace(
      'requiredSuites:\n            - unit\n            - integration\n',
      'requiredSuites:\n            - unit\n            - 42\n',
    );
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const coercionErr = result.errors.find(
        (e) => e.kind === 'schema' && e.path?.includes('requiredSuites[1]'),
      );
      assert.ok(coercionErr, 'expected a coercion error on requiredSuites[1]');
    }
  });

  it('rejects a TitleCase boolean coercion (True → bool)', () => {
    // js-yaml's CORE_SCHEMA (default for `load`) is case-insensitive
    // for true/false. The rule must catch case variants too, since
    // they're another silent-coercion vector for users who don't
    // realize YAML treats them as booleans.
    const bad = FIXTURE_TEXT.replace('retryFlakes: "true"', 'retryFlakes: True');
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      assert.ok(
        result.errors.some((e) => e.kind === 'schema' && e.path?.endsWith('retryFlakes')),
        'expected a coercion error on retryFlakes (True coerced to boolean)',
      );
    }
  });

  it('accepts the canonical fixture (all gate.config + integrationPolicy leaves are quoted strings or string arrays)', () => {
    const result = validatePlanText(FIXTURE_TEXT);
    assert.equal(result.ok, true);
  });

  it('accepts nested objects/arrays inside gate.config + integrationPolicy when leaves are strings (Codex Round 2 Medium)', () => {
    // Phase 8 + the 8b canonicalizer (`sortNestedKeys`) explicitly
    // support recursive free-form nested maps. Round 2 surfaced that
    // the Round 1 walker over-rejected these. Insert a `thresholds`
    // object inside the test-result gate's config and a `custom`
    // object inside integrationPolicy — all leaves still strings —
    // and verify validate accepts the file. (Skips the canonical
    // check because we're synthesizing a non-canonical test input;
    // the assertion is just that there are no SCHEMA errors flagged
    // by the no-coercion walker.)
    const withNested = FIXTURE_TEXT
      .replace(
        'integrationPolicy:\n  baseBranch: main\n  squashMerge: "true"',
        'integrationPolicy:\n  baseBranch: main\n  custom:\n    aNested: "alpha"\n    nested:\n      deeper: "beta"\n  squashMerge: "true"',
      )
      .replace(
        '          minPassRate: "0.95"\n          requiredSuites:',
        '          minPassRate: "0.95"\n          thresholds:\n            ratio: "0.8"\n            tags:\n              - smoke\n              - regression\n          requiredSuites:',
      );
    const result = validatePlanText(withNested);
    // The file isn't byte-canonical (we inserted unsorted keys), so
    // the canonical check fails. But the no-coercion walker must NOT
    // flag any schema errors on the nested maps.
    if (result.ok) return;
    const schemaErrs = result.errors.filter((e) => e.kind === 'schema');
    assert.deepEqual(
      schemaErrs,
      [],
      `expected no schema errors, got:\n${schemaErrs.map((e) => `[${e.kind}] ${e.path ?? ''} ${e.message}`).join('\n')}`,
    );
  });

  it('rejects a non-string leaf at depth ≥2 with the full path (nested coercion)', () => {
    // Same shape as the positive test above, but with the deepest
    // leaf as an unquoted number — must surface the full path.
    const bad = FIXTURE_TEXT.replace(
      '          minPassRate: "0.95"\n          requiredSuites:',
      '          minPassRate: "0.95"\n          thresholds:\n            ratio: 0.8\n          requiredSuites:',
    );
    const result = validatePlanText(bad);
    assert.equal(result.ok, false);
    if (!result.ok) {
      const coercionErr = result.errors.find(
        (e) =>
          e.kind === 'schema' &&
          e.path === '.steps[1].gates[2].config.thresholds.ratio',
      );
      assert.ok(
        coercionErr,
        `expected coercion error at .steps[1].gates[2].config.thresholds.ratio, got:\n${result.errors.map((e) => `[${e.kind}] ${e.path ?? ''} ${e.message}`).join('\n')}`,
      );
      assert.match(coercionErr!.message, /number/);
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
