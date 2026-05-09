/**
 * Plan diff → mutations (Phase 8c.3 helper).
 *
 * Given the DB's current Plan and the parsed-from-file Plan,
 * compute the mutation list that `work.update_plan` needs to bring
 * the DB into the file's state. Pure — no I/O, no Mongo, no fetch.
 *
 * Mutation shapes match `common-api/src/services/work/plan-mutations.ts`:
 *
 *   { op: 'set-plan-fields', fields: { name?, description?, inputs?,
 *     failurePolicy?, autoRetryCap?, autoRetryFallback?, integrationPolicy? } }
 *   { op: 'add-step', step: StepDefinition }
 *   { op: 'update-step', stepId: string, fields: <full new step shape, used as patch> }
 *   { op: 'remove-step', stepId: string }
 *   { op: 'set-state', state: 'draft' | 'active' | 'archived' }
 *
 * Re-import strategy notes:
 *   - Top-level fields: emit `set-plan-fields` with only the fields
 *     that differ. Compared via canonical JSON for inputs /
 *     integrationPolicy (free-form objects); primitive equality for
 *     scalars. The substrate validator at the Worker tier ignores any
 *     field absent from the patch, so this is safe to send selectively.
 *   - Steps: emit add/remove/update by stepId. `update-step.fields` is
 *     the FULL new step shape used as a patch — the substrate's
 *     `applyAndValidateStepPatch` re-validates after applying, so
 *     sending the whole shape is equivalent to a per-step replace.
 *   - Step ORDER inside the file is NOT enforced as a diff target in
 *     v1: the substrate's executor reads `gate.config.requires`, not
 *     array order, so reordering is semantically a no-op. New steps
 *     from `add-step` land at the end of the array. (A later phase
 *     can add `reorder-steps` if a UI reason emerges.)
 *   - Description: the design says body IS Plan.description (no
 *     frontmatter description field). The caller passes the body as
 *     `filePlan.description`; the diff treats it as a regular
 *     top-level string field.
 *   - state: emit `set-state` only if the file's state differs from
 *     the DB. Substrate-side validates the transition; this layer
 *     just produces the request. (Renamed from `authoringState` /
 *     `set-authoring-state` 2026-05-09 — item 17.)
 *
 * Input shape:
 *   - `dbPlan` = the response from `work.get_plan` (already validated
 *     by common-api).
 *   - `filePlan` = the validated frontmatter object plus the body
 *     string used as `description`.
 */

export type Mutation =
  | { op: 'set-plan-fields'; fields: Record<string, unknown> }
  | { op: 'add-step'; step: Record<string, unknown> }
  | { op: 'update-step'; stepId: string; fields: Record<string, unknown> }
  | { op: 'remove-step'; stepId: string }
  | { op: 'set-state'; state: 'draft' | 'active' | 'archived' };

export interface DbPlanSnapshot {
  planId: string;
  name: string;
  description?: string | null;
  state: 'draft' | 'active' | 'archived';
  failurePolicy?: string;
  autoRetryCap?: number;
  autoRetryFallback?: string;
  inputs?: unknown[];
  integrationPolicy?: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
  version: number;
}

export interface FilePlanShape {
  planId: string;
  name: string;
  description: string;
  state: 'draft' | 'active' | 'archived';
  failurePolicy?: string;
  autoRetryCap?: number;
  autoRetryFallback?: string;
  inputs?: unknown[];
  integrationPolicy?: Record<string, unknown>;
  steps: Array<Record<string, unknown>>;
}

/**
 * Top-level fields that round-trip through `set-plan-fields`. Order
 * matters for nothing here — we compare by name and emit only deltas.
 */
const TOP_LEVEL_DIFF_FIELDS: ReadonlyArray<keyof FilePlanShape> = [
  'name',
  'description',
  'failurePolicy',
  'autoRetryCap',
  'autoRetryFallback',
  'inputs',
  'integrationPolicy',
];

/**
 * Compute the mutation list required to bring `dbPlan` to match
 * `filePlan`. Empty array means "nothing to do". The caller is
 * responsible for guarding on `filePlan.planId === dbPlan.planId`
 * before calling this — diff doesn't cross identity.
 */
export function computeMutations(dbPlan: DbPlanSnapshot, filePlan: FilePlanShape): Mutation[] {
  const mutations: Mutation[] = [];

  // 1) Top-level fields (set-plan-fields)
  const fieldDelta: Record<string, unknown> = {};
  for (const field of TOP_LEVEL_DIFF_FIELDS) {
    const fileValue = filePlan[field];
    const dbValue = (dbPlan as unknown as Record<string, unknown>)[field];
    if (!equalDeep(fileValue, dbValue)) {
      // Server validator coerces null → undefined for description; we
      // mirror that here so the produced mutation is what the route
      // already accepts.
      fieldDelta[field] = fileValue ?? undefined;
    }
  }
  if (Object.keys(fieldDelta).length > 0) {
    mutations.push({ op: 'set-plan-fields', fields: fieldDelta });
  }

  // 2) Steps diff (add / update / remove)
  const dbStepIndex = new Map<string, Record<string, unknown>>();
  for (const step of dbPlan.steps) {
    const id = step.stepId;
    if (typeof id === 'string') dbStepIndex.set(id, step);
  }
  const fileStepIds = new Set<string>();

  for (const step of filePlan.steps) {
    const id = step.stepId;
    if (typeof id !== 'string') continue;
    fileStepIds.add(id);
    const dbStep = dbStepIndex.get(id);
    if (!dbStep) {
      mutations.push({ op: 'add-step', step });
    } else if (!equalDeep(step, dbStep)) {
      mutations.push({ op: 'update-step', stepId: id, fields: step });
    }
  }

  for (const id of dbStepIndex.keys()) {
    if (!fileStepIds.has(id)) {
      mutations.push({ op: 'remove-step', stepId: id });
    }
  }

  // 3) Plan state (set-state)
  if (filePlan.state !== dbPlan.state) {
    mutations.push({ op: 'set-state', state: filePlan.state });
  }

  return mutations;
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Structural equality for the value shapes that show up in plan
 * frontmatter: strings / numbers / booleans / null / undefined / arrays
 * of same / plain objects of same. NOT a general-purpose deep equality;
 * doesn't handle Date, RegExp, Map, Set, class instances. None of those
 * appear in the file → DB diff path because we're comparing JSON-shaped
 * data on both sides.
 *
 * Treats `undefined` and missing keys identically, so a file that omits
 * `autoRetryCap` matches a DB where `autoRetryCap: undefined`. Treats
 * `null` and `undefined` as equal too — the substrate validator
 * normalizes both ways.
 */
function equalDeep(a: unknown, b: unknown): boolean {
  if (a === b) return true;
  if (a == null && b == null) return true; // null/undefined normalize
  if (a == null || b == null) return false;
  if (typeof a !== typeof b) return false;
  if (typeof a !== 'object') return false;
  if (Array.isArray(a) !== Array.isArray(b)) return false;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (!equalDeep(a[i], b[i])) return false;
    return true;
  }
  const ao = a as Record<string, unknown>;
  const bo = b as Record<string, unknown>;
  // Ignore keys whose values are undefined — they're equivalent to absent.
  const aKeys = Object.keys(ao).filter((k) => ao[k] !== undefined);
  const bKeys = Object.keys(bo).filter((k) => bo[k] !== undefined);
  if (aKeys.length !== bKeys.length) return false;
  for (const k of aKeys) {
    if (!equalDeep(ao[k], bo[k])) return false;
  }
  return true;
}
