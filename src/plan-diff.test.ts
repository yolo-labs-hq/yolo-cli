/**
 * plan-diff tests (Phase 8c.3).
 *
 * Pin the mutation-generation logic that drives `work.update_plan`
 * during re-import. Pure, no I/O — every test feeds in synthesized
 * DB + file shapes and asserts the mutation list shape.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { computeMutations, type DbPlanSnapshot, type FilePlanShape } from './plan-diff.js';

function makeDb(overrides: Partial<DbPlanSnapshot> = {}): DbPlanSnapshot {
  return {
    planId: 'p1',
    name: 'Plan One',
    description: 'old body\n',
    authoringState: 'active',
    failurePolicy: 'pause-and-wait',
    inputs: [],
    integrationPolicy: undefined,
    steps: [
      {
        stepId: 'build',
        name: 'Build',
        mode: 'workstream',
        gates: [],
      },
    ],
    version: 7,
    ...overrides,
  };
}

function makeFile(overrides: Partial<FilePlanShape> = {}): FilePlanShape {
  return {
    planId: 'p1',
    name: 'Plan One',
    description: 'old body\n',
    authoringState: 'active',
    failurePolicy: 'pause-and-wait',
    inputs: [],
    integrationPolicy: undefined,
    steps: [
      {
        stepId: 'build',
        name: 'Build',
        mode: 'workstream',
        gates: [],
      },
    ],
    ...overrides,
  };
}

// ─── No-op ───────────────────────────────────────────────────────────────
describe('plan-diff — no-op', () => {
  it('emits an empty mutation list when DB and file match', () => {
    const result = computeMutations(makeDb(), makeFile());
    assert.deepEqual(result, []);
  });

  it('treats missing-key vs undefined-value as equal', () => {
    // DB has integrationPolicy: undefined; file omits the key → equal.
    const db = makeDb({ integrationPolicy: undefined });
    const file = makeFile();
    delete (file as unknown as Record<string, unknown>).integrationPolicy;
    assert.deepEqual(computeMutations(db, file as FilePlanShape), []);
  });

  it('treats null and undefined as equal (description normalization)', () => {
    const db = makeDb({ description: null });
    const file = makeFile();
    delete (file as unknown as Record<string, unknown>).description;
    file.description = undefined as unknown as string;
    assert.deepEqual(computeMutations(db, file), []);
  });
});

// ─── set-plan-fields ─────────────────────────────────────────────────────
describe('plan-diff — set-plan-fields', () => {
  it('emits one mutation listing only the changed fields', () => {
    const result = computeMutations(makeDb(), makeFile({ name: 'Plan One Renamed' }));
    assert.equal(result.length, 1);
    assert.equal(result[0]!.op, 'set-plan-fields');
    assert.deepEqual((result[0] as { fields: Record<string, unknown> }).fields, {
      name: 'Plan One Renamed',
    });
  });

  it('coalesces multiple top-level changes into a single set-plan-fields', () => {
    const result = computeMutations(
      makeDb(),
      makeFile({ name: 'X', failurePolicy: 'abort-run', autoRetryCap: 3 }),
    );
    const setOp = result.find((m) => m.op === 'set-plan-fields') as { fields: Record<string, unknown> };
    assert.ok(setOp);
    assert.deepEqual(setOp.fields, {
      name: 'X',
      failurePolicy: 'abort-run',
      autoRetryCap: 3,
    });
  });

  it('description (body) is treated as a top-level field', () => {
    const result = computeMutations(makeDb({ description: 'old\n' }), makeFile({ description: 'new\n' }));
    assert.equal(result.length, 1);
    const fields = (result[0] as { fields: Record<string, unknown> }).fields;
    assert.equal(fields.description, 'new\n');
  });

  it('inputs array changes emit a set-plan-fields with the new array', () => {
    const result = computeMutations(
      makeDb({ inputs: [] }),
      makeFile({ inputs: [{ name: 'env', required: true }] }),
    );
    const fields = (result[0] as { fields: Record<string, unknown> }).fields;
    assert.deepEqual(fields.inputs, [{ name: 'env', required: true }]);
  });

  it('integrationPolicy changes emit set-plan-fields with the new object', () => {
    const result = computeMutations(
      makeDb({ integrationPolicy: { baseBranch: 'main' } }),
      makeFile({ integrationPolicy: { baseBranch: 'release' } }),
    );
    const fields = (result[0] as { fields: Record<string, unknown> }).fields;
    assert.deepEqual(fields.integrationPolicy, { baseBranch: 'release' });
  });
});

// ─── Steps: add / update / remove ────────────────────────────────────────
describe('plan-diff — steps add/update/remove', () => {
  it('emits add-step for a step in file but not DB', () => {
    const file = makeFile({
      steps: [
        { stepId: 'build', name: 'Build', mode: 'workstream', gates: [] },
        { stepId: 'test', name: 'Test', mode: 'test', gates: [] },
      ],
    });
    const result = computeMutations(makeDb(), file);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.op, 'add-step');
    assert.deepEqual(
      (result[0] as { step: Record<string, unknown> }).step,
      { stepId: 'test', name: 'Test', mode: 'test', gates: [] },
    );
  });

  it('emits remove-step for a step in DB but not file', () => {
    const db = makeDb({
      steps: [
        { stepId: 'build', name: 'Build', mode: 'workstream', gates: [] },
        { stepId: 'old', name: 'Old', mode: 'workstream', gates: [] },
      ],
    });
    const result = computeMutations(db, makeFile());
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { op: 'remove-step', stepId: 'old' });
  });

  it('emits update-step (full new shape as fields) when a step changed', () => {
    const file = makeFile({
      steps: [{ stepId: 'build', name: 'Build (renamed)', mode: 'workstream', gates: [] }],
    });
    const result = computeMutations(makeDb(), file);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.op, 'update-step');
    const u = result[0] as { stepId: string; fields: Record<string, unknown> };
    assert.equal(u.stepId, 'build');
    assert.deepEqual(u.fields, { stepId: 'build', name: 'Build (renamed)', mode: 'workstream', gates: [] });
  });

  it('emits add + update + remove together when needed', () => {
    const db = makeDb({
      steps: [
        { stepId: 'build', name: 'Build', mode: 'workstream', gates: [] },
        { stepId: 'old', name: 'Old', mode: 'workstream', gates: [] },
      ],
    });
    const file = makeFile({
      steps: [
        { stepId: 'build', name: 'Build (renamed)', mode: 'workstream', gates: [] },
        { stepId: 'test', name: 'Test', mode: 'test', gates: [] },
      ],
    });
    const ops = computeMutations(db, file).map((m) => m.op);
    assert.deepEqual(ops.sort(), ['add-step', 'remove-step', 'update-step']);
  });

  it('detects deep changes inside a step (gate config updated)', () => {
    const db = makeDb({
      steps: [
        {
          stepId: 'test',
          name: 'Test',
          mode: 'test',
          gates: [{ gateId: 'g1', type: 'test-result', config: { minPassRate: '0.9' } }],
        },
      ],
    });
    const file = makeFile({
      steps: [
        {
          stepId: 'test',
          name: 'Test',
          mode: 'test',
          gates: [{ gateId: 'g1', type: 'test-result', config: { minPassRate: '0.95' } }],
        },
      ],
    });
    const result = computeMutations(db, file);
    assert.equal(result.length, 1);
    assert.equal(result[0]!.op, 'update-step');
  });

  it('does NOT emit reorder mutations when steps are present in both but in different order', () => {
    // v1 design: step ORDER isn't a diff target — substrate executor
    // reads gate.config.requires, not array order.
    const db = makeDb({
      steps: [
        { stepId: 'build', name: 'Build', mode: 'workstream', gates: [] },
        { stepId: 'test', name: 'Test', mode: 'test', gates: [] },
      ],
    });
    const file = makeFile({
      steps: [
        { stepId: 'test', name: 'Test', mode: 'test', gates: [] },
        { stepId: 'build', name: 'Build', mode: 'workstream', gates: [] },
      ],
    });
    assert.deepEqual(computeMutations(db, file), []);
  });
});

// ─── set-authoring-state ─────────────────────────────────────────────────
describe('plan-diff — set-authoring-state', () => {
  it('emits set-authoring-state when state differs', () => {
    const result = computeMutations(makeDb({ authoringState: 'draft' }), makeFile({ authoringState: 'active' }));
    assert.equal(result.length, 1);
    assert.deepEqual(result[0], { op: 'set-authoring-state', state: 'active' });
  });

  it('does not emit set-authoring-state when state matches', () => {
    const result = computeMutations(
      makeDb({ authoringState: 'active' }),
      makeFile({ authoringState: 'active' }),
    );
    assert.equal(result.length, 0);
  });
});

// ─── Multi-mutation emit order ───────────────────────────────────────────
describe('plan-diff — emit order', () => {
  it('orders mutations: set-plan-fields → step ops → set-authoring-state', () => {
    const db = makeDb({ name: 'Old', authoringState: 'draft' });
    const file = makeFile({
      name: 'New',
      authoringState: 'active',
      steps: [
        { stepId: 'build', name: 'Build', mode: 'workstream', gates: [] },
        { stepId: 'new-step', name: 'NewStep', mode: 'test', gates: [] },
      ],
    });
    const ops = computeMutations(db, file).map((m) => m.op);
    assert.deepEqual(ops, ['set-plan-fields', 'add-step', 'set-authoring-state']);
  });
});
