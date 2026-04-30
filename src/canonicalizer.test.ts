/**
 * Canonicalizer tests (Phase 8b).
 *
 * Pin the canonical-form invariants:
 *  - Schema-defined top-level + step-level + gate-level + input-level
 *    + declared-output-level + template-level field orders.
 *  - Lexicographic recursive sort on nested arbitrary-keyed objects
 *    (gate.config, integrationPolicy, template.metadata).
 *  - Round-trip stability: canonicalize → parse → canonicalize is a
 *    fixed point (idempotent).
 *  - Body-side normalization (LF endings, single trailing newline).
 *
 * Uses Node's built-in `node --test` runner — no extra runtime deps.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';

import {
  canonicalizeFrontmatter,
  canonicalizeFrontmatterObject,
  canonicalizePlanFile,
} from './canonicalizer.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = path.resolve(__dirname, '..', '..', '..');
const GATE_COVERAGE_FIXTURE = path.join(REPO_ROOT, 'tests', 'fixtures', 'plans', 'gate-coverage.md');

/**
 * Split a plan markdown file into (frontmatter object, body string).
 * Pure helper for the fixture round-trip tests; the real import
 * command in 8c will share this parsing logic.
 */
function parsePlanFile(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = text.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/);
  if (!match) throw new Error('plan file missing --- frontmatter delimiters');
  const [, fmText, bodyText] = match;
  const fm = yaml.load(fmText!) as Record<string, unknown>;
  return { frontmatter: fm, body: bodyText! };
}

// ─── Schema-order invariants ──────────────────────────────────────────────

describe('canonicalizer — top-level field order', () => {
  it('emits schema-defined fields in fixed order regardless of input order', () => {
    const scrambled = {
      steps: [],
      authoringState: 'active',
      planId: 'p1',
      inputs: [],
      name: 'Plan One',
      failurePolicy: 'pause-and-wait',
    };
    const ordered = canonicalizeFrontmatterObject(scrambled);
    assert.deepEqual(Object.keys(ordered), [
      'planId',
      'name',
      'authoringState',
      'failurePolicy',
      'inputs',
      'steps',
    ]);
  });

  it('appends unknown fields lexicographically AFTER known schema fields', () => {
    const withUnknowns = {
      planId: 'p1',
      zUnknown: 'z',
      name: 'Plan',
      authoringState: 'active',
      aUnknown: 'a',
      failurePolicy: 'pause-and-wait',
      mUnknown: 'm',
    };
    const ordered = canonicalizeFrontmatterObject(withUnknowns);
    assert.deepEqual(Object.keys(ordered), [
      'planId',
      'name',
      'authoringState',
      'failurePolicy',
      'aUnknown',
      'mUnknown',
      'zUnknown',
    ]);
  });

  it('drops undefined optional fields rather than emitting null', () => {
    const withUndef = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      autoRetryCap: undefined,
      integrationPolicy: undefined,
      steps: [],
    };
    const ordered = canonicalizeFrontmatterObject(withUndef);
    assert.equal('autoRetryCap' in ordered, false);
    assert.equal('integrationPolicy' in ordered, false);
  });
});

describe('canonicalizer — step / gate / input / declaredOutput / template orders', () => {
  it('reorders step fields to schema order', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          gates: [],
          template: { branch: 'feature/x' },
          mode: 'workstream',
          name: 'Step One',
          stepId: 's1',
          description: 'A step',
        },
      ],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const step = (ordered.steps as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(Object.keys(step), [
      'stepId',
      'name',
      'description',
      'mode',
      'gates',
      'template',
    ]);
  });

  it('reorders gate fields to gateId, type, config', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          stepId: 's1',
          name: 'Step',
          mode: 'test',
          gates: [
            { config: { requires: ['build'] }, type: 'dependency', gateId: 'g1' },
          ],
        },
      ],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const gate = (
      (ordered.steps as Array<Record<string, unknown>>)[0]!.gates as Array<Record<string, unknown>>
    )[0]!;
    assert.deepEqual(Object.keys(gate), ['gateId', 'type', 'config']);
  });

  it('reorders input declarations to name, required, default, description', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      inputs: [{ description: 'x', default: '1', required: true, name: 'maxRetries' }],
      steps: [],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const input = (ordered.inputs as Array<Record<string, unknown>>)[0]!;
    assert.deepEqual(Object.keys(input), ['name', 'required', 'default', 'description']);
  });

  it('reorders declaredOutputs to name, artifactType, required', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          stepId: 's1',
          name: 'Step',
          mode: 'workstream',
          gates: [],
          declaredOutputs: [{ required: true, artifactType: 'branch', name: 'out' }],
        },
      ],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const decl = ((ordered.steps as Array<Record<string, unknown>>)[0]!.declaredOutputs as Array<
      Record<string, unknown>
    >)[0]!;
    assert.deepEqual(Object.keys(decl), ['name', 'artifactType', 'required']);
  });

  it('reorders template fields to todoContent, todoFile, branch, metadata', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          stepId: 's1',
          name: 'Step',
          mode: 'workstream',
          gates: [],
          template: { metadata: { x: 'y' }, branch: 'b', todoFile: 't.md' },
        },
      ],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const template = (ordered.steps as Array<Record<string, unknown>>)[0]!.template as Record<
      string,
      unknown
    >;
    assert.deepEqual(Object.keys(template), ['todoFile', 'branch', 'metadata']);
  });
});

// ─── Lexicographic-sort invariants on nested arbitrary-keyed maps ─────────

describe('canonicalizer — recursive lexicographic sort on free-form nested maps', () => {
  it('sorts gate.config keys lexicographically', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          stepId: 's1',
          name: 'Step',
          mode: 'test',
          gates: [
            {
              gateId: 'g1',
              type: 'merge',
              config: {
                zebra: true,
                alpha: 1,
                middle: 'm',
              },
            },
          ],
        },
      ],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const config = (
      ((ordered.steps as Array<Record<string, unknown>>)[0]!.gates as Array<Record<string, unknown>>)[0]!
        .config as Record<string, unknown>
    );
    assert.deepEqual(Object.keys(config), ['alpha', 'middle', 'zebra']);
  });

  it('sorts integrationPolicy keys lexicographically + recursively', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      integrationPolicy: {
        squashMerge: true,
        baseBranch: 'main',
        custom: { zNested: 1, aNested: 2 },
      },
      steps: [],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const ip = ordered.integrationPolicy as Record<string, unknown>;
    assert.deepEqual(Object.keys(ip), ['baseBranch', 'custom', 'squashMerge']);
    const custom = ip.custom as Record<string, unknown>;
    assert.deepEqual(Object.keys(custom), ['aNested', 'zNested']);
  });

  it('sorts template.metadata keys lexicographically', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          stepId: 's1',
          name: 'Step',
          mode: 'workstream',
          gates: [],
          template: { metadata: { z: '1', a: '2', m: '3' } },
        },
      ],
    };
    const ordered = canonicalizeFrontmatterObject(plan);
    const meta = (
      (ordered.steps as Array<Record<string, unknown>>)[0]!.template as Record<string, unknown>
    ).metadata as Record<string, unknown>;
    assert.deepEqual(Object.keys(meta), ['a', 'm', 'z']);
  });
});

// ─── YAML output invariants ───────────────────────────────────────────────

describe('canonicalizer — YAML output shape', () => {
  it('emits LF endings and a single trailing newline', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [],
    };
    const out = canonicalizeFrontmatter(plan);
    assert.equal(out.includes('\r'), false);
    assert.match(out, /[^\n]\n$/, 'should end with exactly one trailing newline');
  });

  it('uses 2-space indent and no flow-style for objects/arrays', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        { stepId: 's1', name: 'S', mode: 'workstream', gates: [{ gateId: 'g1', type: 'dependency', config: { requires: ['x'] } }] },
      ],
    };
    const out = canonicalizeFrontmatter(plan);
    assert.match(out, /^steps:$/m);
    assert.match(out, /^ {2}- stepId:/m);
    assert.match(out, /^ {4}gates:$/m);
    // Gate dash sits at 6 spaces: 4 for step indent + 2 for array dash.
    assert.match(out, /^ {6}- gateId:/m);
    // Should not see flow style {} or [...] for object values
    assert.equal(out.includes('{'), false);
  });

  it('round-trips parse → canonicalize idempotently', () => {
    const original = {
      planId: 'p1',
      name: 'Plan One',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      inputs: [{ name: 'targetEnv', required: true, description: 'staging|prod' }],
      integrationPolicy: { baseBranch: 'main', squashMerge: true },
      steps: [
        {
          stepId: 'build',
          name: 'Build',
          mode: 'workstream',
          gates: [],
          declaredOutputs: [{ name: 'out', artifactType: 'branch', required: true }],
          template: { branch: 'feature/build', metadata: { owner: 'core' } },
        },
        {
          stepId: 'test',
          name: 'Test',
          mode: 'test',
          gates: [
            { gateId: 'dep', type: 'dependency', config: { requires: ['build'] } },
            {
              gateId: 'present',
              type: 'artifact-presence',
              config: { name: 'out', producerStepId: 'build' },
            },
          ],
        },
      ],
    };
    const yamlA = canonicalizeFrontmatter(original);
    const reparsed = yaml.load(yamlA) as Record<string, unknown>;
    const yamlB = canonicalizeFrontmatter(reparsed);
    assert.equal(yamlA, yamlB, 'second pass should equal first pass');
  });

  it('round-trips an empty steps array unchanged', () => {
    const plan = {
      planId: 'p1',
      name: 'Plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [],
    };
    const yamlA = canonicalizeFrontmatter(plan);
    const reparsed = yaml.load(yamlA) as Record<string, unknown>;
    const yamlB = canonicalizeFrontmatter(reparsed);
    assert.equal(yamlA, yamlB);
  });
});

// ─── Full plan-file canonicalization ──────────────────────────────────────

describe('canonicalizePlanFile — frontmatter + body assembly', () => {
  const plan = {
    planId: 'p1',
    name: 'Plan',
    authoringState: 'active',
    failurePolicy: 'pause-and-wait',
    steps: [],
  };

  it('wraps frontmatter in --- delimiters and appends body separated by blank line', () => {
    const out = canonicalizePlanFile(plan, '# Body header\n\nSome prose.');
    assert.match(out, /^---\n/);
    assert.match(out, /\n---\n\n# Body header\n\nSome prose\.\n$/);
  });

  it('normalizes CRLF endings in body to LF', () => {
    const out = canonicalizePlanFile(plan, '# Header\r\n\r\nSome prose.\r\n');
    assert.equal(out.includes('\r'), false);
  });

  it('collapses trailing whitespace in body to a single LF', () => {
    const out = canonicalizePlanFile(plan, '# Header\n\nProse.\n\n\n   \n');
    assert.match(out, /Prose\.\n$/);
    assert.equal(out.endsWith('\n\n'), false);
  });

  it('round-trips through canonicalize → parse-frontmatter → canonicalize idempotently', () => {
    const planRich = {
      planId: 'p1',
      name: 'Rich plan',
      authoringState: 'active',
      failurePolicy: 'pause-and-wait',
      steps: [
        {
          stepId: 's1',
          name: 'Step',
          mode: 'workstream',
          gates: [{ gateId: 'g1', type: 'critique', config: { rubric: 'r.md', minScore: '0.8' } }],
        },
      ],
    };
    const fileA = canonicalizePlanFile(planRich, '# Body\n\nProse.');
    // Extract frontmatter between the two --- delimiters
    const match = fileA.match(/^---\n([\s\S]*?)\n---\n\n([\s\S]*)$/);
    assert.ok(match, 'output should match the canonical frontmatter+body shape');
    const [, fmText, bodyText] = match;
    const reparsed = yaml.load(fmText!) as Record<string, unknown>;
    const fileB = canonicalizePlanFile(reparsed, bodyText!);
    assert.equal(fileA, fileB);
  });
});

// ─── Real fixture: tests/fixtures/plans/gate-coverage.md ──────────────────

describe('gate-coverage fixture — real-file round-trip + gate-coverage proof', () => {
  const text = readFileSync(GATE_COVERAGE_FIXTURE, 'utf8');
  const { frontmatter, body } = parsePlanFile(text);

  it('parses cleanly — frontmatter is an object, body is non-empty', () => {
    assert.equal(typeof frontmatter, 'object');
    assert.equal(frontmatter.planId, 'gate-coverage');
    assert.match(body, /^# Gate-coverage canary/m);
  });

  it('exercises all four target gate types (artifact-presence, test-result, critique, merge) plus dependency', () => {
    const seen = new Set<string>();
    for (const step of frontmatter.steps as Array<{ gates?: Array<{ type: string }> }>) {
      for (const gate of step.gates ?? []) {
        seen.add(gate.type);
      }
    }
    assert.ok(seen.has('artifact-presence'), 'fixture should contain an artifact-presence gate');
    assert.ok(seen.has('test-result'), 'fixture should contain a test-result gate');
    assert.ok(seen.has('critique'), 'fixture should contain a critique gate');
    assert.ok(seen.has('merge'), 'fixture should contain a merge gate');
    assert.ok(seen.has('dependency'), 'fixture should contain dependency gates linking the steps');
  });

  it('canonicalizes idempotently (canonical → parse → canonical = canonical)', () => {
    const fileA = canonicalizePlanFile(frontmatter, body);
    const reparsed = parsePlanFile(fileA);
    const fileB = canonicalizePlanFile(reparsed.frontmatter, reparsed.body);
    assert.equal(fileA, fileB, 'fixture must be a fixed point of the canonicalizer');
  });

  it('preserves nested gate.config keys after recursive lex sort (merge gate)', () => {
    const canonical = canonicalizeFrontmatter(frontmatter);
    // The merge gate's config should now have keys in alphabetical
    // order: allowedStrategies, baseBranch, blockOnConflict,
    // requireGreenCi.
    const reparsed = yaml.load(canonical) as Record<string, unknown>;
    const mergeStep = (reparsed.steps as Array<Record<string, unknown>>).find(
      (s) => s.stepId === 'merge',
    )!;
    const mergeGate = (mergeStep.gates as Array<Record<string, unknown>>).find(
      (g) => g.type === 'merge',
    )!;
    assert.deepEqual(Object.keys(mergeGate.config as Record<string, unknown>), [
      'allowedStrategies',
      'baseBranch',
      'blockOnConflict',
      'requireGreenCi',
    ]);
  });

  it('ends with single trailing newline, no CR characters', () => {
    const out = canonicalizePlanFile(frontmatter, body);
    assert.equal(out.includes('\r'), false);
    assert.match(out, /[^\n]\n$/);
  });
});
