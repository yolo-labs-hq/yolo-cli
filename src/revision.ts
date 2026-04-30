/**
 * Plan-file revision hash (Phase 8c.2).
 *
 * The lockfile records a `lastImportedRevision` for each
 * `(workspaceId, planId)` so re-import can detect divergence: if the
 * file's current canonical bytes hash to the same revision as the
 * lockfile entry's `lastImportedRevision`, the file hasn't changed
 * since the last import (no-op or version bump only). If the hash
 * differs, the user actually edited the file — and `import` then
 * compares the lockfile's `lastImportedVersion` against the DB's
 * current `version` to decide whether to fast-forward
 * (`work.update_plan`) or refuse (without `--force`).
 *
 * Hash domain: the **canonical** bytes of the plan file
 * (frontmatter + body, post-`canonicalizePlanFile`). Hashing the raw
 * input bytes would mean cosmetic re-formatting (whitespace, key
 * order) shows up as drift; using the canonical form means only
 * semantic edits register.
 *
 * Format: `sha256:<hex>` per the design doc strawman
 * (`docs/_ORCHESTRATION_PHASE8_PLAN_FILES_DESIGN.md` §"Plan ID
 * identity"). The `sha256:` prefix is intentional: it leaves room for
 * a future algorithm bump (e.g., `blake3:…`) without re-keying old
 * entries.
 */

import { createHash } from 'node:crypto';

export const REVISION_PREFIX = 'sha256:';

/**
 * Compute the lockfile revision hash for a canonical plan-file string.
 * Pure: same input → same output.
 */
export function computeRevisionHash(canonicalText: string): string {
  const digest = createHash('sha256').update(canonicalText, 'utf8').digest('hex');
  return `${REVISION_PREFIX}${digest}`;
}

/**
 * True if `revision` is well-formed (matches the `sha256:<64-hex>`
 * shape this version emits). Used by lockfile-read code to flag
 * malformed entries up front rather than letting them propagate.
 */
export function isWellFormedRevision(revision: string): boolean {
  return /^sha256:[0-9a-f]{64}$/.test(revision);
}
