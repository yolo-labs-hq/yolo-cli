/**
 * `yolo plan import <file>` orchestration (Phase 8c.3).
 *
 * Composes everything from earlier slices:
 *   - `plan-validate` (8c.1)  — parse + schema + canonical + no-coercion
 *   - `revision`     (8c.2)  — sha256 over canonical bytes
 *   - `lockfile`     (8c.2)  — `(workspaceId, planId) → entry` storage
 *   - `work-client`  (8c.2)  — `mintSubstrateToken` + `authenticatedRequest`
 *   - `plan-diff`    (8c.3)  — DB plan vs file plan → mutation list
 *
 * High-level flow:
 *
 *   1. Validate file (offline: parse + schema + canonical + no-coercion).
 *   2. Enforce planId equals the file stem (semantic check, design F8.1).
 *   3. Resolve substrate context (env trio); error otherwise.
 *   4. Mint a session-bound delegated token; the response carries the
 *      authoritative `workspaceId` (Phase 8 design: workspace binding
 *      is derived from session, not env/args).
 *   5. If `--workspace` was passed, assert it matches the minted
 *      workspaceId — otherwise the user's mental model and the
 *      session's binding diverge silently.
 *   6. Read the lockfile (gitignored default unless `--env` is set).
 *   7. Decide the action:
 *        - **NO_CHANGE**   — file revision == lockfile.lastImportedRevision.
 *                            Refresh the timestamp on the lockfile entry,
 *                            do not touch the DB.
 *        - **CREATE**      — no lockfile entry. Call `work.create_plan`.
 *                            On 409 (plan already exists in DB), refuse
 *                            unless `--force`.
 *        - **UPDATE**      — lockfile entry exists, file revision differs.
 *                            GET the DB plan, check `version` against
 *                            `lastImportedVersion` to detect drift, then
 *                            `work.update_plan` with computed mutations.
 *        - **DIVERGED**    — lockfile entry exists but DB version >
 *                            lastImportedVersion. Refuse unless `--force`.
 *   8. On success, write the new lockfile entry
 *      (`{ revision, version, importedAt }`).
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success (CREATE / UPDATE / NO_CHANGE all success)
 *   - 1  = validation failure / refused divergence / DB error
 *   - 64 = usage error (missing file, planId/stem mismatch, --workspace
 *          mismatch, missing env trio)
 *
 * Out of scope (deferred to a later slice if real demand emerges):
 *   - Step REORDER detection. Substrate executor reads
 *     `gate.config.requires`, not array order; reordering is a
 *     semantic no-op. New steps land at the end via `add-step`.
 *   - Outside-container login flow. v1 errors out without `SESSION_ID`
 *     (substrate CLI is container-only — design Round 5).
 *   - Concurrent import safety. The lockfile read-modify-write is not
 *     atomic across processes; multi-developer concurrent imports to
 *     the same workspace are rare enough to defer.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePlanFile } from './canonicalizer.js';
import { computeMutations, type Mutation, type DbPlanSnapshot, type FilePlanShape } from './plan-diff.js';
import { validatePlanText, formatErrors } from './plan-validate.js';
import { computeRevisionHash } from './revision.js';
import {
  type Lockfile,
  type LockfileEntry,
  LockfileError,
  getEntry,
  readLockfile,
  resolveLockfilePath,
  setEntry,
  writeLockfile,
} from './lockfile.js';
import {
  type FetchLike,
  SUBSTRATE_CLI_PLAN_SCOPES,
  WorkClientError,
  authenticatedRequest,
  mintSubstrateToken,
} from './work-client.js';
import yaml from 'js-yaml';

// ─── Public types ─────────────────────────────────────────────────────────

export interface ImportOptions {
  filePath: string;
  workspaceFlag?: string;
  lockfileFlag?: string;
  force?: boolean;
  /**
   * Absolute path to the directory containing the lockfile. v1 always
   * uses the file's parent (e.g., `.yolo/plans/`); the option exists
   * so tests can point at a tmp dir without disturbing the real repo.
   */
  plansDir?: string;
  /** Test-injectable fetch. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Test-injectable env reader. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Test-injectable timestamp source. Defaults to ISO `new Date()`. */
  now?: () => string;
}

export type ImportAction = 'created' | 'updated' | 'no-change';

export interface ImportSuccess {
  ok: true;
  action: ImportAction;
  planId: string;
  workspaceId: string;
  /** Plan version after the import (post-CREATE / post-UPDATE / unchanged on NO_CHANGE). */
  version: number;
  /** sha256:<hex> of the file's canonical bytes. */
  revision: string;
  /** ISO-8601 timestamp written to the lockfile. */
  importedAt: string;
  /** Path to the lockfile that was read+written. */
  lockfilePath: string;
}

export interface ImportFailure {
  ok: false;
  /** Stable kind used by the CLI wrapper to pick an exit code. */
  kind:
    | 'usage'
    | 'validation'
    | 'auth'
    | 'workspace_mismatch'
    | 'planid_stem_mismatch'
    | 'lockfile'
    | 'diverged'
    | 'conflict_no_force'
    | 'http';
  message: string;
  /** Optional structured detail for `--json` output (future). */
  detail?: Record<string, unknown>;
}

export type ImportResult = ImportSuccess | ImportFailure;

// ─── Public entry ─────────────────────────────────────────────────────────

export async function runPlanImport(options: ImportOptions): Promise<ImportResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());

  // 1) Validate file
  let fileText: string;
  try {
    fileText = readFileSync(options.filePath, 'utf8');
  } catch (err) {
    return fail('usage', `cannot read plan file '${options.filePath}': ${describeError(err)}`);
  }
  const validation = validatePlanText(fileText);
  if (!validation.ok) {
    return fail('validation', `plan-file validation failed:\n${formatErrors(validation.errors)}`);
  }

  // Parse the file once we know it's valid+canonical so we can hand
  // both the frontmatter and body to the diff.
  let frontmatter: Record<string, unknown>;
  let body: string;
  try {
    const parsed = parsePlanFile(fileText);
    frontmatter = parsed.frontmatter;
    body = parsed.body;
  } catch (err) {
    // validatePlanText already ruled this path out; defense-in-depth.
    return fail('validation', `plan-file parse failed: ${describeError(err)}`);
  }
  const filePlan = makeFilePlan(frontmatter, body);

  // 2) planId vs file stem (design F8.1)
  const stem = path.basename(options.filePath, path.extname(options.filePath));
  if (filePlan.planId !== stem) {
    return fail(
      'planid_stem_mismatch',
      `frontmatter planId '${filePlan.planId}' must equal the file stem '${stem}' (file '${options.filePath}')`,
    );
  }

  // 3) Substrate context
  const sessionId = env.SESSION_ID;
  const internalApiKey = env.INTERNAL_API_KEY;
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!sessionId) return fail('auth', 'SESSION_ID env var is required (substrate CLI is container-only in v1)');
  if (!internalApiKey) return fail('auth', 'INTERNAL_API_KEY env var is required');
  if (!commonApiUrl) return fail('auth', 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required');

  // 4) Mint token
  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      internalApiKey,
      sessionId,
      scopes: SUBSTRATE_CLI_PLAN_SCOPES,
      fetchImpl: options.fetchImpl,
    });
  } catch (err) {
    if (err instanceof WorkClientError) {
      return fail('auth', `failed to mint substrate token: ${err.message}`, { status: err.status, code: err.code });
    }
    return fail('auth', `failed to mint substrate token: ${describeError(err)}`);
  }

  // 5) --workspace assertion
  if (options.workspaceFlag && options.workspaceFlag !== mint.workspaceId) {
    return fail(
      'workspace_mismatch',
      `--workspace ${options.workspaceFlag} does not match the workspace bound to this session (${mint.workspaceId}). ` +
        `Either omit the flag (it's optional in containers) or open a session for the right workspace.`,
    );
  }

  // 6) Lockfile
  const plansDir = options.plansDir ?? path.dirname(options.filePath);
  let lockfilePath: string;
  let lockfile: Lockfile;
  try {
    lockfilePath = resolveLockfilePath(plansDir, options.lockfileFlag);
    lockfile = readLockfile(lockfilePath);
  } catch (err) {
    if (err instanceof LockfileError) {
      return fail('lockfile', err.message, { code: err.code });
    }
    return fail('lockfile', describeError(err));
  }

  // 7) Decide action
  const canonicalBytes = canonicalizePlanFile(frontmatter, body);
  const fileRevision = computeRevisionHash(canonicalBytes);
  const existingEntry = getEntry(lockfile, mint.workspaceId, filePlan.planId);

  const requestCtx = {
    commonApiUrl,
    internalApiKey,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };

  let resultAction: ImportAction;
  let resultVersion: number;

  if (!existingEntry) {
    // CREATE path
    const created = await tryCreate(requestCtx, mint.workspaceId, filePlan);
    if (created.ok) {
      resultAction = 'created';
      resultVersion = created.version;
    } else if (created.conflict409) {
      if (!options.force) {
        return fail(
          'conflict_no_force',
          `plan '${filePlan.planId}' already exists in workspace ${mint.workspaceId} but the lockfile has no entry. ` +
            `Run with --force to fast-forward import (will rewrite the DB plan with the file's contents), or ` +
            `run \`yolo plan export ${filePlan.planId}\` first to capture the DB shape.`,
        );
      }
      // --force on 409: pull the DB plan, run the UPDATE path with whatever's there as the base.
      const fetched = await tryGet(requestCtx, mint.workspaceId, filePlan.planId);
      if (!fetched.ok) return fetched.error;
      const updated = await tryUpdate(requestCtx, mint.workspaceId, filePlan, fetched.plan);
      if (!updated.ok) return updated.error;
      resultAction = 'updated';
      resultVersion = updated.version;
    } else {
      return created.error;
    }
  } else if (existingEntry.lastImportedRevision === fileRevision) {
    // NO_CHANGE path: refresh timestamp, write lockfile, exit.
    resultAction = 'no-change';
    resultVersion = existingEntry.lastImportedVersion;
  } else {
    // UPDATE path: GET DB, check drift, compute mutations, PATCH.
    const fetched = await tryGet(requestCtx, mint.workspaceId, filePlan.planId);
    if (!fetched.ok) return fetched.error;
    if (fetched.plan.version !== existingEntry.lastImportedVersion) {
      if (!options.force) {
        return fail(
          'diverged',
          `DB has plan '${filePlan.planId}' at version ${fetched.plan.version}, but lockfile expected version ${existingEntry.lastImportedVersion}. ` +
            `Run with --force to fast-forward (overwrites DB changes), or \`yolo plan export\` first to capture the DB shape.`,
          { dbVersion: fetched.plan.version, expectedVersion: existingEntry.lastImportedVersion },
        );
      }
    }
    const updated = await tryUpdate(requestCtx, mint.workspaceId, filePlan, fetched.plan);
    if (!updated.ok) return updated.error;
    resultAction = updated.action;
    resultVersion = updated.version;
  }

  // 8) Update lockfile (idempotent — same input → same bytes).
  const importedAt = now();
  const newEntry: LockfileEntry = {
    lastImportedRevision: fileRevision,
    lastImportedVersion: resultVersion,
    lastImportedAt: importedAt,
  };
  setEntry(lockfile, mint.workspaceId, filePlan.planId, newEntry);
  try {
    writeLockfile(lockfilePath, lockfile);
  } catch (err) {
    if (err instanceof LockfileError) {
      return fail('lockfile', err.message, { code: err.code });
    }
    return fail('lockfile', describeError(err));
  }

  return {
    ok: true,
    action: resultAction,
    planId: filePlan.planId,
    workspaceId: mint.workspaceId,
    version: resultVersion,
    revision: fileRevision,
    importedAt,
    lockfilePath,
  };
}

// ─── Per-action helpers ───────────────────────────────────────────────────

interface CreateOk { ok: true; version: number; conflict409?: false }
interface CreateConflict { ok: false; conflict409: true; error?: undefined }
interface CreateError { ok: false; conflict409?: false; error: ImportFailure }

type CreateResult = CreateOk | CreateConflict | CreateError;

async function tryCreate(
  ctx: { commonApiUrl: string; internalApiKey: string; delegatedToken: string; fetchImpl?: FetchLike },
  workspaceId: string,
  filePlan: FilePlanShape,
): Promise<CreateResult> {
  // `filePlan.description` is the SEPARATOR-NORMALIZED body
  // (`makeFilePlan` strips the leading `\n` that the regex captures
  // along with the body). Sending it raw was the Codex 8c.3 R1 bug —
  // canonical files emit `---\n\n<body>` so the captured `body`
  // starts with `\n`, which would make imported descriptions begin
  // with a phantom blank line and break round-trips.
  const body = {
    planId: filePlan.planId,
    name: filePlan.name,
    description: filePlan.description,
    inputs: filePlan.inputs ?? [],
    failurePolicy: filePlan.failurePolicy ?? 'pause-and-wait',
    autoRetryCap: filePlan.autoRetryCap,
    autoRetryFallback: filePlan.autoRetryFallback,
    integrationPolicy: filePlan.integrationPolicy,
    steps: filePlan.steps,
    // Send the file's authoringState so a Plan authored as 'active'
    // lands at 'active' instead of silently downgrading to 'draft'.
    // Surfaced in Phase 8d.2 verification: the substrate's
    // create_plan didn't accept authoringState until this slice
    // (validatePlanCreateFields now normalizes it via
    // PLAN_AUTHORING_STATES). Omitting the field keeps the
    // substrate's draft-first default for hand-authored callers
    // that don't supply one.
    authoringState: filePlan.authoringState,
  };
  const response = await authenticatedRequest(ctx, `/workspaces/${workspaceId}/plans`, {
    method: 'POST',
    jsonBody: body,
  });
  if (response.ok) {
    const json = (await response.json()) as { version?: number };
    if (typeof json.version !== 'number') {
      return { ok: false, error: fail('http', 'create_plan response missing version field') };
    }
    return { ok: true, version: json.version };
  }
  if (response.status === 409) {
    return { ok: false, conflict409: true };
  }
  const text = await safeReadText(response);
  return {
    ok: false,
    error: fail('http', `work.create_plan failed: HTTP ${response.status} — ${text}`, {
      status: response.status,
    }),
  };
}

interface FetchOk { ok: true; plan: DbPlanSnapshot }
interface FetchError { ok: false; error: ImportFailure }
type FetchResult = FetchOk | FetchError;

async function tryGet(
  ctx: { commonApiUrl: string; internalApiKey: string; delegatedToken: string; fetchImpl?: FetchLike },
  workspaceId: string,
  planId: string,
): Promise<FetchResult> {
  const response = await authenticatedRequest(ctx, `/workspaces/${workspaceId}/plans/${planId}`, {
    method: 'GET',
  });
  if (!response.ok) {
    const text = await safeReadText(response);
    return {
      ok: false,
      error: fail('http', `work.get_plan failed: HTTP ${response.status} — ${text}`, { status: response.status }),
    };
  }
  const json = (await response.json()) as { plan?: DbPlanSnapshot };
  if (!json.plan) {
    return { ok: false, error: fail('http', 'work.get_plan response missing `plan` field') };
  }
  return { ok: true, plan: json.plan };
}

interface UpdateOk { ok: true; action: ImportAction; version: number }
interface UpdateError { ok: false; error: ImportFailure }
type UpdateResult = UpdateOk | UpdateError;

async function tryUpdate(
  ctx: { commonApiUrl: string; internalApiKey: string; delegatedToken: string; fetchImpl?: FetchLike },
  workspaceId: string,
  filePlan: FilePlanShape,
  dbPlan: DbPlanSnapshot,
): Promise<UpdateResult> {
  const mutations = computeMutations(dbPlan, filePlan);
  if (mutations.length === 0) {
    // Lockfile knew the file was different (otherwise we'd be on the
    // NO_CHANGE path), but the diff says nothing to change. Likely:
    // the file's revision changed cosmetically (e.g., the
    // canonicalizer's output changed across versions). Treat as
    // no-change, and the caller will refresh the lockfile entry.
    return { ok: true, action: 'no-change', version: dbPlan.version };
  }
  const response = await authenticatedRequest(ctx, `/workspaces/${workspaceId}/plans/${filePlan.planId}`, {
    method: 'PATCH',
    jsonBody: { baseVersion: dbPlan.version, mutations: mutations as Mutation[] },
  });
  if (!response.ok) {
    const text = await safeReadText(response);
    return {
      ok: false,
      error: fail('http', `work.update_plan failed: HTTP ${response.status} — ${text}`, { status: response.status }),
    };
  }
  const json = (await response.json()) as { version?: number };
  if (typeof json.version !== 'number') {
    return { ok: false, error: fail('http', 'work.update_plan response missing version field') };
  }
  return { ok: true, action: 'updated', version: json.version };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Re-split the file into frontmatter object + body string. Mirrors
 * the regex used by validatePlanText so that a successful validate
 * implies a successful parse here. Throws on failure (defense-in-depth
 * against future drift between the two parsers).
 */
function parsePlanFile(text: string): { frontmatter: Record<string, unknown>; body: string } {
  const match = text.match(FRONTMATTER_RE);
  if (!match) throw new Error('frontmatter delimiters missing');
  const fm = yaml.load(match[1]!) as Record<string, unknown>;
  return { frontmatter: fm, body: match[2]! };
}

function makeFilePlan(frontmatter: Record<string, unknown>, body: string): FilePlanShape {
  // Body is Plan.description (Phase 8b design). The frontmatter→body
  // separator (the blank line after the closing `---`) is OWNED by
  // the canonicalizer (`canonicalizePlanFile` builds `---\n\n<body>`
  // and strips leading `\n+` from the captured body before re-emit).
  // Mirror that normalization here so `description` we send to
  // `work.create_plan` / `work.update_plan` is exactly what
  // round-tripping back through the canonicalizer would produce —
  // otherwise an imported description gets a phantom leading blank
  // line, and 8c.4 export round-trips churn (Codex 8c.3 R1 Medium).
  const description =
    body
      .replace(/\r\n/g, '\n')    // CRLF → LF (validate already rejects CRLF; defense in depth)
      .replace(/^\n+/, '')        // strip separator-owned leading newline(s)
      .replace(/\s+$/, '') +      // collapse trailing whitespace…
    '\n';                          // …and ensure exactly one trailing newline.
  return {
    planId: String(frontmatter.planId ?? ''),
    name: String(frontmatter.name ?? ''),
    description,
    authoringState: (frontmatter.authoringState as FilePlanShape['authoringState']) ?? 'draft',
    failurePolicy: frontmatter.failurePolicy as string | undefined,
    autoRetryCap: frontmatter.autoRetryCap as number | undefined,
    autoRetryFallback: frontmatter.autoRetryFallback as string | undefined,
    inputs: (frontmatter.inputs as unknown[]) ?? [],
    integrationPolicy: frontmatter.integrationPolicy as Record<string, unknown> | undefined,
    steps: ((frontmatter.steps as unknown[]) ?? []) as Array<Record<string, unknown>>,
  };
}

function fail(kind: ImportFailure['kind'], message: string, detail?: Record<string, unknown>): ImportFailure {
  return { ok: false, kind, message, detail };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try {
    return await response.text();
  } catch {
    return '<no body>';
  }
}

/**
 * Map an `ImportFailure.kind` to a CLI exit code. Used by cli.ts and
 * exported for tests.
 */
export function exitCodeForFailure(kind: ImportFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'planid_stem_mismatch':
    case 'workspace_mismatch':
      return 64; // EX_USAGE
    case 'validation':
    case 'lockfile':
    case 'diverged':
    case 'conflict_no_force':
    case 'http':
      return 1;
  }
}

/**
 * Render an `ImportSuccess` as a single-line CLI summary. Caller
 * appends `\n` if needed.
 */
export function formatSuccess(result: ImportSuccess): string {
  switch (result.action) {
    case 'created':
      return `OK: created plan '${result.planId}' in workspace ${result.workspaceId} at version ${result.version} (revision ${result.revision.slice(0, 14)}…)`;
    case 'updated':
      return `OK: updated plan '${result.planId}' in workspace ${result.workspaceId} to version ${result.version} (revision ${result.revision.slice(0, 14)}…)`;
    case 'no-change':
      return `OK: plan '${result.planId}' already at file revision (workspace ${result.workspaceId}, version ${result.version})`;
  }
}
