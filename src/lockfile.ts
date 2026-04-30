/**
 * Plan-import lockfile (Phase 8c.2).
 *
 * Tracks `(workspaceId, planId) → { lastImportedRevision,
 * lastImportedVersion, lastImportedAt }` so `yolo plan import` (8c.3)
 * can detect drift between the file and the DB. The lockfile is NOT
 * an identity remap — `planId` IS the workspace-scoped DB identifier
 * (substrate enforces `(workspaceId, planId)` uniqueness directly).
 *
 * Two locations, per design F8.2:
 *   - **Default** (`.yolo/plans/.imports.json`) — gitignored. Per-developer
 *     state. Each engineer's local Plan Run / staging workspace lands here.
 *   - **Env-named** (`.yolo/plans/.imports.<env>.json`) — opt-in checked-in.
 *     Use for shared stable workspaces (e.g., the team's prod workspace)
 *     so reproducible imports work across machines. Selected via
 *     `--env <name>` on the CLI.
 *
 * Canonical write shape:
 *   - JSON, 2-space indent, single trailing `\n`.
 *   - Workspace IDs sorted lexicographically; planIds within each
 *     workspace also sorted; entry keys in fixed order
 *     (lastImportedAt, lastImportedRevision, lastImportedVersion —
 *     alphabetical, mirroring how the plan-file canonicalizer treats
 *     free-form maps).
 *   - Same input → byte-identical output (idempotent re-write).
 *
 * Out of scope here (lands in 8c.3 import):
 *   - The actual import flow (mint token → call work.create_plan /
 *     work.update_plan → update lockfile).
 *   - Divergence-policy decisions (`--force` to override DB version
 *     drift, etc.) — `lockfile.ts` is just storage.
 *
 * Out of scope (8c.5 / future):
 *   - Lockfile schema evolution. v1 has no version field; if the shape
 *     ever changes, add a `$version` top-level field then.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { isWellFormedRevision } from './revision.js';

export interface LockfileEntry {
  /** `sha256:<hex>` of the canonical plan-file bytes at last import. */
  lastImportedRevision: string;
  /** DB-side `WorkPlan.version` returned at last import. */
  lastImportedVersion: number;
  /** ISO-8601 UTC timestamp of the import. */
  lastImportedAt: string;
}

/**
 * The lockfile is `{ [workspaceId]: { [planId]: LockfileEntry } }`.
 * Workspace IDs and planIds are workspace-local strings (not ObjectIds
 * or URLs); the JSON file is the source of truth, no schema header.
 */
export interface Lockfile {
  [workspaceId: string]: {
    [planId: string]: LockfileEntry;
  };
}

const LOCKFILE_DEFAULT_BASENAME = '.imports.json';

export class LockfileError extends Error {
  readonly code: 'malformed' | 'unreadable' | 'unwritable' | 'malformed_entry';
  constructor(message: string, code: LockfileError['code']) {
    super(message);
    this.name = 'LockfileError';
    this.code = code;
  }
}

/**
 * Resolve the lockfile path for a given plans directory and optional
 * env name.
 *
 * @param plansDir - the absolute or relative path to `.yolo/plans/`.
 * @param env - if set, picks `.imports.<env>.json` (the opt-in
 *   checked-in variant). If unset, picks the gitignored default.
 */
export function resolveLockfilePath(plansDir: string, env?: string): string {
  if (env !== undefined) {
    if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/.test(env)) {
      throw new LockfileError(
        `--env name must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,63}$/, got '${env}'`,
        'malformed',
      );
    }
    return path.join(plansDir, `.imports.${env}.json`);
  }
  return path.join(plansDir, LOCKFILE_DEFAULT_BASENAME);
}

/**
 * Read a lockfile from disk. Returns an empty object if the file
 * doesn't exist (first-import case). Throws `LockfileError` if the
 * file is unreadable or malformed.
 */
export function readLockfile(filePath: string): Lockfile {
  if (!existsSync(filePath)) return {};
  let text: string;
  try {
    text = readFileSync(filePath, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LockfileError(`could not read lockfile at ${filePath}: ${msg}`, 'unreadable');
  }
  if (text.trim() === '') return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LockfileError(`malformed JSON in lockfile at ${filePath}: ${msg}`, 'malformed');
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new LockfileError(
      `malformed lockfile at ${filePath}: top-level must be a JSON object, got ${describe(parsed)}`,
      'malformed',
    );
  }
  return validateShape(parsed as Record<string, unknown>, filePath);
}

/**
 * Write a lockfile to disk in canonical form. Creates the parent
 * directory if missing. Idempotent: same lockfile contents always
 * produce byte-identical output.
 */
export function writeLockfile(filePath: string, lockfile: Lockfile): void {
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LockfileError(`could not create lockfile dir ${dir}: ${msg}`, 'unwritable');
  }
  const sorted = canonicalize(lockfile);
  const text = JSON.stringify(sorted, null, 2) + '\n';
  try {
    writeFileSync(filePath, text, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new LockfileError(`could not write lockfile at ${filePath}: ${msg}`, 'unwritable');
  }
}

/**
 * Lookup helper. Returns the entry for a `(workspaceId, planId)` pair,
 * or `null` if either key is missing. Pure read — does not mutate the
 * lockfile.
 */
export function getEntry(
  lockfile: Lockfile,
  workspaceId: string,
  planId: string,
): LockfileEntry | null {
  return lockfile[workspaceId]?.[planId] ?? null;
}

/**
 * Mutator. Inserts or replaces the entry for a `(workspaceId, planId)`
 * pair. Mutates `lockfile` in place AND returns it (for chaining /
 * test ergonomics).
 */
export function setEntry(
  lockfile: Lockfile,
  workspaceId: string,
  planId: string,
  entry: LockfileEntry,
): Lockfile {
  if (!lockfile[workspaceId]) lockfile[workspaceId] = {};
  lockfile[workspaceId]![planId] = entry;
  return lockfile;
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Reorder the lockfile to canonical shape: workspace IDs sorted,
 * planIds within each sorted, entry fields in fixed alphabetical
 * order. Same canonicalization rule as the plan-file canonicalizer's
 * `sortNestedKeys`: lex sort because the schema doesn't dictate
 * order. Pure — does not mutate input.
 */
function canonicalize(lockfile: Lockfile): Lockfile {
  const out: Lockfile = {};
  for (const ws of Object.keys(lockfile).sort()) {
    out[ws] = {};
    for (const planId of Object.keys(lockfile[ws]!).sort()) {
      const e = lockfile[ws]![planId]!;
      // Fixed alphabetical entry-field order (matches a future
      // round-trip test: read → write → read produces same object).
      out[ws]![planId] = {
        lastImportedAt: e.lastImportedAt,
        lastImportedRevision: e.lastImportedRevision,
        lastImportedVersion: e.lastImportedVersion,
      };
    }
  }
  return out;
}

/**
 * Validate the shape of a parsed lockfile. Throws `LockfileError`
 * with `code: 'malformed_entry'` if any entry is missing required
 * fields or has wrong types. Returns the validated object cast to
 * `Lockfile`.
 */
function validateShape(parsed: Record<string, unknown>, filePath: string): Lockfile {
  for (const [ws, plans] of Object.entries(parsed)) {
    if (plans === null || typeof plans !== 'object' || Array.isArray(plans)) {
      throw new LockfileError(
        `malformed lockfile at ${filePath}: entry for workspace '${ws}' must be an object, got ${describe(plans)}`,
        'malformed_entry',
      );
    }
    for (const [planId, entry] of Object.entries(plans as Record<string, unknown>)) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new LockfileError(
          `malformed lockfile at ${filePath}: entry for ${ws}/${planId} must be an object, got ${describe(entry)}`,
          'malformed_entry',
        );
      }
      const e = entry as Record<string, unknown>;
      if (typeof e.lastImportedRevision !== 'string') {
        throw new LockfileError(
          `malformed lockfile at ${filePath}: ${ws}/${planId}.lastImportedRevision must be a string, got ${describe(e.lastImportedRevision)}`,
          'malformed_entry',
        );
      }
      if (!isWellFormedRevision(e.lastImportedRevision)) {
        throw new LockfileError(
          `malformed lockfile at ${filePath}: ${ws}/${planId}.lastImportedRevision must match 'sha256:<64-hex>', got '${e.lastImportedRevision}'`,
          'malformed_entry',
        );
      }
      if (typeof e.lastImportedVersion !== 'number' || !Number.isInteger(e.lastImportedVersion) || e.lastImportedVersion < 1) {
        throw new LockfileError(
          `malformed lockfile at ${filePath}: ${ws}/${planId}.lastImportedVersion must be a positive integer, got ${describe(e.lastImportedVersion)}`,
          'malformed_entry',
        );
      }
      if (typeof e.lastImportedAt !== 'string' || Number.isNaN(Date.parse(e.lastImportedAt))) {
        throw new LockfileError(
          `malformed lockfile at ${filePath}: ${ws}/${planId}.lastImportedAt must be an ISO-8601 timestamp, got ${describe(e.lastImportedAt)}`,
          'malformed_entry',
        );
      }
    }
  }
  return parsed as Lockfile;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}
