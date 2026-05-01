/**
 * `yolo plan export <planId>` orchestration (Phase 8c.4).
 *
 * Inverse of `yolo plan import`: DB → file. Composes everything from
 * earlier slices:
 *   - `work-client`     (8c.2) — mint + authenticatedRequest for
 *                                `work.get_plan`.
 *   - `canonicalizer`   (8b)   — pure object → canonical YAML+body.
 *   - `revision`        (8c.2) — sha256 of the bytes we just wrote.
 *   - `lockfile`        (8c.2) — refresh `(workspaceId, planId)`
 *                                entry so a follow-up `import` is
 *                                NO_CHANGE.
 *
 * High-level flow:
 *
 *   1. Resolve substrate context (env trio); error if missing.
 *   2. Mint a session-bound delegated token; the response is the
 *      authoritative `workspaceId`.
 *   3. If `--workspace` was passed, assert it matches the minted
 *      workspaceId (same ergonomics as import).
 *   4. Call `work.get_plan(workspaceId, planId)`; serialize to the
 *      canonical file form.
 *   5. Write the canonical bytes to `-o <file>` (default
 *      `<plansDir>/<planId>.md`). Errors out if the destination
 *      directory doesn't exist UNLESS `--force` is set, in which
 *      case it `mkdir -p`s.
 *   6. Refresh the lockfile entry so `import` of the freshly
 *      written file is detected as NO_CHANGE on the next run.
 *
 * Out of scope (deferred):
 *   - `--diff` / dry-run output. Add when there's real demand.
 *   - File-watch / auto-export daemon. Manual export only per the
 *     Phase 8 design ("Bidirectional file ↔ DB sync... out of scope").
 *   - Outside-container login. v1 errors out without `SESSION_ID`
 *     (substrate CLI is container-only — design Round 5).
 *
 * Errors map to exit codes via the CLI wrapper:
 *   - 0  = success
 *   - 1  = HTTP / file-write / lockfile failure
 *   - 64 = usage error (missing planId, workspace mismatch, missing env trio)
 */

import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import { canonicalizePlanFile } from './canonicalizer.js';
import { computeRevisionHash } from './revision.js';
import {
  type Lockfile,
  type LockfileEntry,
  LockfileError,
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

// ─── Public types ─────────────────────────────────────────────────────────

export interface ExportOptions {
  planId: string;
  workspaceFlag?: string;
  lockfileFlag?: string;
  /** Output path. Default: `<plansDir>/<planId>.md`. */
  outputFlag?: string;
  /**
   * Absolute path to the directory containing the lockfile (and
   * the default output target). v1 always uses
   * `<cwd>/.yolo/plans/`; tests inject a tmp dir.
   */
  plansDir?: string;
  /** Test-injectable fetch. Defaults to globalThis.fetch. */
  fetchImpl?: FetchLike;
  /** Test-injectable env reader. Defaults to `process.env`. */
  env?: Record<string, string | undefined>;
  /** Test-injectable timestamp source. Defaults to ISO `new Date()`. */
  now?: () => string;
}

export interface ExportSuccess {
  ok: true;
  planId: string;
  workspaceId: string;
  /** Plan version exported. */
  version: number;
  /** sha256:<hex> of the canonical bytes written. */
  revision: string;
  /** Absolute path to the file written. */
  outputPath: string;
  /** ISO-8601 written to the lockfile. */
  exportedAt: string;
  /** Path to the lockfile that was refreshed. */
  lockfilePath: string;
}

export interface ExportFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http' | 'write' | 'lockfile';
  message: string;
  detail?: Record<string, unknown>;
}

export type ExportResult = ExportSuccess | ExportFailure;

// ─── Public entry ─────────────────────────────────────────────────────────

const PLAN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

export async function runPlanExport(options: ExportOptions): Promise<ExportResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());

  // 1) planId shape (matches substrate's PLAN_ID_REGEX)
  if (!PLAN_ID_REGEX.test(options.planId)) {
    return fail(
      'usage',
      `invalid planId '${options.planId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`,
    );
  }

  // 1b) -o basename stem must equal planId so the exported file
  //     round-trips through `yolo plan import`, which enforces
  //     `frontmatter.planId === file-stem` (plan-import.ts:172).
  //     Otherwise `yolo plan export foo -o custom-name.md` produces
  //     a file the import command refuses (Codex 8c.4 R1 Medium).
  //     -o is for changing the DIRECTORY, not the filename.
  if (options.outputFlag !== undefined) {
    const outStem = path.basename(options.outputFlag, path.extname(options.outputFlag));
    if (outStem !== options.planId) {
      return fail(
        'usage',
        `-o basename stem '${outStem}' must equal planId '${options.planId}' so the exported file round-trips through \`yolo plan import\`. ` +
          `Either rename the output to '${options.planId}.md' (with any directory you like) or drop -o to use the default <plansDir>/${options.planId}.md.`,
      );
    }
  }

  // 2) Substrate context
  const sessionId = env.SESSION_ID;
  const internalApiKey = env.INTERNAL_API_KEY;
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!sessionId) return fail('auth', 'SESSION_ID env var is required (substrate CLI is container-only in v1)');
  if (!internalApiKey) return fail('auth', 'INTERNAL_API_KEY env var is required');
  if (!commonApiUrl) return fail('auth', 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required');

  // 3) Mint token
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

  // 4) --workspace assertion
  if (options.workspaceFlag && options.workspaceFlag !== mint.workspaceId) {
    return fail(
      'workspace_mismatch',
      `--workspace ${options.workspaceFlag} does not match the workspace bound to this session (${mint.workspaceId}).`,
    );
  }

  // 5) work.get_plan
  const plansDir = options.plansDir ?? path.resolve('.yolo', 'plans');
  const requestCtx = {
    commonApiUrl,
    internalApiKey,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };
  const fetched = await tryGet(requestCtx, mint.workspaceId, options.planId);
  if (!fetched.ok) return fetched.error;

  // 6) Convert to canonical file bytes
  const dbPlan = fetched.plan;
  const { frontmatter, body } = dbPlanToFile(dbPlan);
  const canonicalBytes = canonicalizePlanFile(frontmatter, body);

  // 7) Resolve output path + ensure dir
  const outputPath = options.outputFlag
    ? path.resolve(options.outputFlag)
    : path.join(plansDir, `${dbPlan.planId}.md`);
  try {
    mkdirSync(path.dirname(outputPath), { recursive: true });
    writeFileSync(outputPath, canonicalBytes, 'utf8');
  } catch (err) {
    return fail('write', `could not write '${outputPath}': ${describeError(err)}`);
  }

  // 8) Refresh lockfile so a subsequent `yolo plan import` of this
  //    file is a NO_CHANGE (file revision == lockfile entry).
  const revision = computeRevisionHash(canonicalBytes);
  const exportedAt = now();
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
  const newEntry: LockfileEntry = {
    lastImportedRevision: revision,
    lastImportedVersion: dbPlan.version,
    lastImportedAt: exportedAt,
  };
  setEntry(lockfile, mint.workspaceId, dbPlan.planId, newEntry);
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
    planId: dbPlan.planId,
    workspaceId: mint.workspaceId,
    version: dbPlan.version,
    revision,
    outputPath,
    exportedAt,
    lockfilePath,
  };
}

// ─── Pure DB→file conversion ──────────────────────────────────────────────

interface GetPlanResponse {
  planId: string;
  name: string;
  description?: string | null;
  authoringState: 'draft' | 'active' | 'archived';
  version: number;
  inputs?: unknown[];
  failurePolicy?: string;
  autoRetryCap?: number | null;
  autoRetryFallback?: string | null;
  integrationPolicy?: Record<string, unknown> | null;
  steps: Array<Record<string, unknown>>;
  latestRunId?: string | null;
  createdAt?: string;
  updatedAt?: string;
}

/**
 * Convert a `work.get_plan` response (the `serializePlan` shape from
 * `common-api/src/routes/work.ts`) to the canonical file form
 * (frontmatter object + body string). Pure, no I/O.
 *
 * Strips DB-only fields (`version`, `latestRunId`, `createdAt`,
 * `updatedAt`) per the Phase 8 design — those don't round-trip.
 * Converts nulls back to `undefined` so the canonicalizer drops them
 * via `reorderObject`'s "skip undefined" rule.
 *
 * Empty `inputs: []` is preserved in the frontmatter so a follow-up
 * `import` produces a stable diff (round-trip equivalence). Empty
 * `integrationPolicy: {}` is dropped since the substrate validator
 * normalizes it to `undefined` anyway.
 */
export function dbPlanToFile(dbPlan: GetPlanResponse): { frontmatter: Record<string, unknown>; body: string } {
  const frontmatter: Record<string, unknown> = {
    planId: dbPlan.planId,
    name: dbPlan.name,
    authoringState: dbPlan.authoringState,
    failurePolicy: dbPlan.failurePolicy ?? 'pause-and-wait',
    steps: dbPlan.steps,
  };
  if (dbPlan.autoRetryCap !== undefined && dbPlan.autoRetryCap !== null) {
    frontmatter.autoRetryCap = dbPlan.autoRetryCap;
  }
  if (dbPlan.autoRetryFallback !== undefined && dbPlan.autoRetryFallback !== null) {
    frontmatter.autoRetryFallback = dbPlan.autoRetryFallback;
  }
  if (Array.isArray(dbPlan.inputs)) {
    frontmatter.inputs = dbPlan.inputs;
  }
  if (
    dbPlan.integrationPolicy !== undefined &&
    dbPlan.integrationPolicy !== null &&
    Object.keys(dbPlan.integrationPolicy).length > 0
  ) {
    frontmatter.integrationPolicy = dbPlan.integrationPolicy;
  }

  // Body = description. canonicalizePlanFile's body-side normalization
  // (CRLF→LF, strip leading `\n+`, exactly one trailing newline)
  // handles whatever comes out of the DB. Treat `null`/`undefined` as
  // empty string — canonical form will be `---\n…\n---\n\n\n`, which
  // is an empty body plus the mandatory trailing newline.
  const body = typeof dbPlan.description === 'string' ? dbPlan.description : '';
  return { frontmatter, body };
}

// ─── HTTP helpers ─────────────────────────────────────────────────────────

interface FetchOk { ok: true; plan: GetPlanResponse }
interface FetchFail { ok: false; error: ExportFailure }
type FetchResult = FetchOk | FetchFail;

async function tryGet(
  ctx: { commonApiUrl: string; internalApiKey: string; delegatedToken: string; fetchImpl?: FetchLike },
  workspaceId: string,
  planId: string,
): Promise<FetchResult> {
  const response = await authenticatedRequest(
    ctx,
    `/workspaces/${workspaceId}/plans/${planId}`,
    { method: 'GET' },
  );
  if (!response.ok) {
    const text = await safeReadText(response);
    return {
      ok: false,
      error: fail('http', `work.get_plan failed: HTTP ${response.status} — ${text}`, { status: response.status }),
    };
  }
  const json = (await response.json()) as { plan?: GetPlanResponse };
  if (!json.plan) {
    return { ok: false, error: fail('http', 'work.get_plan response missing `plan` field') };
  }
  return { ok: true, plan: json.plan };
}

// ─── Helpers + CLI surface ────────────────────────────────────────────────

function fail(kind: ExportFailure['kind'], message: string, detail?: Record<string, unknown>): ExportFailure {
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
 * Map an `ExportFailure.kind` to a CLI exit code. Used by cli.ts and
 * exported for tests.
 */
export function exitCodeForFailure(kind: ExportFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64; // EX_USAGE
    case 'http':
    case 'write':
    case 'lockfile':
      return 1;
  }
}

/**
 * Render an `ExportSuccess` as a single-line CLI summary. Caller
 * appends `\n` if needed.
 */
export function formatSuccess(result: ExportSuccess): string {
  return `OK: exported plan '${result.planId}' (workspace ${result.workspaceId}, version ${result.version}) to ${result.outputPath} (revision ${result.revision.slice(0, 14)}…)`;
}
