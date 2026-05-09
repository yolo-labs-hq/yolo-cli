/**
 * Plan-file canonicalizer (Phase 8b).
 *
 * Pure function: a parsed plan-frontmatter object → canonical YAML
 * string. The canonical form is what `import` writes to the file
 * after parsing/normalizing user input AND what `export` emits when
 * snapshotting the live DB plan back to disk. Both paths share this
 * one engine so a round-trip through import → export produces a
 * byte-identical file.
 *
 * Round 5 stance #7 + Round 2 stance answers locked these rules:
 *   - Stable key order at the schema-defined level (planId, name,
 *     state, …, steps[]). Top-level field order is fixed.
 *   - Step-level + gate-level + input-level + declared-output-level +
 *     template-level orders are also schema-defined.
 *   - Nested arbitrary-keyed objects (gate.config,
 *     integrationPolicy, template.metadata) sort recursively
 *     lexicographically. The schema says nothing about their key
 *     order, so alphabetical is the only stable rule.
 *   - Unknown top-level keys (forward-compat) trail the known schema
 *     fields in lexicographic order.
 *   - Output uses `\n` line endings, single trailing newline, 2-space
 *     indent, plain scalars where unambiguous (double-quoted when a
 *     string would otherwise parse as a non-string YAML value), and
 *     no boolean/numeric coercion at parse time (caller's
 *     responsibility — js-yaml's default load is happy to coerce, so
 *     callers should run their own validator that doesn't).
 *
 * NOT enforced here (caller's job):
 *   - Schema validation (frontmatter shape).
 *   - Stripping DB-only fields (`_id`, `workspaceId`, `version`,
 *     `latestRunId`, `nextRunNumber`, `createdAt`, `updatedAt`).
 *   - Verifying `planId` matches the file stem.
 *   - Asserting stepId uniqueness, gate `requires` resolves to
 *     siblings, etc.
 */

import yaml from 'js-yaml';

// ─── Schema-defined field orders ──────────────────────────────────────────

// NB: no `description` at the plan level. Per the Phase 8 design
// (`docs/_ORCHESTRATION_PHASE8_PLAN_FILES_DESIGN.md` §"body is
// Plan.description"), the markdown body IS `Plan.description` —
// frontmatter has no description field, by design, to avoid dual
// sources. Step- and input-level `description` fields are unrelated
// and remain in their respective `*_FIELD_ORDER`s below.
const PLAN_FIELD_ORDER: ReadonlyArray<string> = [
  'planId',
  'name',
  'state',
  'failurePolicy',
  'autoRetryCap',
  'autoRetryFallback',
  'inputs',
  'integrationPolicy',
  'steps',
];

const STEP_FIELD_ORDER: ReadonlyArray<string> = [
  'stepId',
  'name',
  'description',
  'mode',
  'runner',
  'gates',
  'declaredOutputs',
  'failurePolicy',
  'autoRetryCap',
  'autoRetryFallback',
  'template',
];

const GATE_FIELD_ORDER: ReadonlyArray<string> = ['gateId', 'type', 'config'];

const INPUT_FIELD_ORDER: ReadonlyArray<string> = ['name', 'required', 'default', 'description'];

const DECLARED_OUTPUT_FIELD_ORDER: ReadonlyArray<string> = ['name', 'artifactType', 'required'];

const TEMPLATE_FIELD_ORDER: ReadonlyArray<string> = ['todoContent', 'todoFile', 'branch', 'metadata'];

// ─── Helpers ──────────────────────────────────────────────────────────────

/**
 * Reorder an object's keys: known schema keys first (in the given
 * order), then any unknown keys lexicographically. Missing schema
 * keys are skipped (we never emit `null` for unset optional fields).
 */
function reorderObject(
  obj: Record<string, unknown>,
  order: ReadonlyArray<string>,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of order) {
    if (key in obj && obj[key] !== undefined) {
      out[key] = obj[key];
    }
  }
  const known = new Set(order);
  const extras = Object.keys(obj)
    .filter((k) => !known.has(k) && obj[k] !== undefined)
    .sort();
  for (const k of extras) {
    out[k] = obj[k];
  }
  return out;
}

/**
 * Recursively sort the keys of arbitrary-keyed nested objects
 * lexicographically. Arrays preserve their declared order; primitives
 * pass through unchanged.
 *
 * Used for `gate.config`, `integrationPolicy`, `template.metadata`,
 * and any future free-form nested map. The schema doesn't dictate
 * key order for these, so alphabetical is the only deterministic
 * choice.
 */
function sortNestedKeys(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortNestedKeys);
  }
  if (value !== null && typeof value === 'object') {
    const obj = value as Record<string, unknown>;
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(obj).sort()) {
      out[key] = sortNestedKeys(obj[key]);
    }
    return out;
  }
  return value;
}

// ─── Reordering walk ──────────────────────────────────────────────────────

interface CanonicalizableObject {
  [key: string]: unknown;
}

/**
 * Reorder a parsed plan frontmatter to canonical shape. Pure — does
 * not mutate the input.
 */
export function canonicalizeFrontmatterObject(
  plan: CanonicalizableObject,
): CanonicalizableObject {
  const ordered = reorderObject(plan, PLAN_FIELD_ORDER);

  if (Array.isArray(ordered.inputs)) {
    ordered.inputs = (ordered.inputs as CanonicalizableObject[]).map((input) =>
      reorderObject(input, INPUT_FIELD_ORDER),
    );
  }

  if (ordered.integrationPolicy && typeof ordered.integrationPolicy === 'object') {
    ordered.integrationPolicy = sortNestedKeys(ordered.integrationPolicy);
  }

  if (Array.isArray(ordered.steps)) {
    ordered.steps = (ordered.steps as CanonicalizableObject[]).map((step) => {
      const orderedStep = reorderObject(step, STEP_FIELD_ORDER);

      if (Array.isArray(orderedStep.gates)) {
        orderedStep.gates = (orderedStep.gates as CanonicalizableObject[]).map((gate) => {
          const og = reorderObject(gate, GATE_FIELD_ORDER);
          if (og.config && typeof og.config === 'object') {
            og.config = sortNestedKeys(og.config);
          }
          return og;
        });
      }

      if (Array.isArray(orderedStep.declaredOutputs)) {
        orderedStep.declaredOutputs = (orderedStep.declaredOutputs as CanonicalizableObject[]).map(
          (d) => reorderObject(d, DECLARED_OUTPUT_FIELD_ORDER),
        );
      }

      if (orderedStep.template && typeof orderedStep.template === 'object') {
        const ot = reorderObject(orderedStep.template as CanonicalizableObject, TEMPLATE_FIELD_ORDER);
        if (ot.metadata && typeof ot.metadata === 'object') {
          ot.metadata = sortNestedKeys(ot.metadata);
        }
        orderedStep.template = ot;
      }

      return orderedStep;
    });
  }

  return ordered;
}

// ─── YAML emission ────────────────────────────────────────────────────────

/**
 * Emit a canonical YAML string for the given (already-reordered)
 * frontmatter object. Always ends with a single `\n`.
 */
export function emitCanonicalYaml(ordered: CanonicalizableObject): string {
  return yaml.dump(ordered, {
    noRefs: true,         // no anchors/aliases
    sortKeys: false,      // we control order ourselves; js-yaml leaves it alone
    lineWidth: -1,        // never wrap long scalars
    quotingType: '"',     // double-quotes when quoting is needed
    forceQuotes: false,   // only quote when ambiguous
    indent: 2,
    flowLevel: -1,        // always block style for objects/arrays (except where the YAML grammar requires flow)
  });
}

// ─── Public entry points ──────────────────────────────────────────────────

/**
 * Canonicalize a parsed plan frontmatter object to its YAML string.
 * Pure: same input → same byte-identical output.
 */
export function canonicalizeFrontmatter(plan: CanonicalizableObject): string {
  const ordered = canonicalizeFrontmatterObject(plan);
  return emitCanonicalYaml(ordered);
}

/**
 * Canonicalize a full plan file (frontmatter + body). Output shape:
 *
 *     ---
 *     <frontmatter>
 *     ---
 *
 *     <body>
 *
 * Body is normalized to LF-only, exactly one trailing newline, no
 * trailing whitespace beyond that. Frontmatter and body are
 * separated by `---` plus one blank line (markdown-friendly).
 */
export function canonicalizePlanFile(plan: CanonicalizableObject, body: string): string {
  const fm = canonicalizeFrontmatter(plan);
  // js-yaml's dump always ends with a single \n; collapse any
  // accidental trailing blanks just in case.
  const fmTrimmed = fm.replace(/\n+$/, '\n');
  // Body: LF-only, strip CR; strip any leading newlines (the
  // frontmatter-body separator is owned by this function, not the
  // caller's body string — a parsed file's body capture often starts
  // with the blank line after the closing `---`); trim trailing
  // whitespace; ensure exactly one trailing newline.
  const bodyTrimmed = body.replace(/\r\n/g, '\n').replace(/^\n+/, '').replace(/\s+$/, '');
  return `---\n${fmTrimmed}---\n\n${bodyTrimmed}\n`;
}
