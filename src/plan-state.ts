/**
 * `yolo plan activate <planId>` / `yolo plan archive <planId>`.
 *
 * Out-of-band authoring-state transitions for plans already in the
 * DB. The file-driven flow can author a plan as `active` from the
 * start (Phase 8d.2 — substrate now accepts `authoringState` on
 * `work.create_plan`), but operators still need a way to:
 *   - flip an existing draft to active without rewriting the file
 *   - archive a plan that's done its job
 * neither of which has a clean file-level expression.
 *
 * Flow:
 *   1. Validate planId regex.
 *   2. Resolve env trio.
 *   3. Mint a session-bound delegated token
 *      (`work.get_plan` + `work.update_plan`, both already in
 *      `SUBSTRATE_CLI_PLAN_SCOPES`).
 *   4. Optional `--workspace` sanity-check against the minted
 *      workspaceId.
 *   5. GET the current plan to fetch (a) its current
 *      authoringState — for the "already in target state" no-op —
 *      and (b) its current `version` for the
 *      `update_plan(baseVersion, …)` CAS.
 *   6. PATCH with `{ baseVersion, mutations: [{ op:
 *      'set-authoring-state', state: <target> }] }`. The
 *      substrate's `applyMutations` enforces the transition
 *      matrix (draft→active|archived, active→archived; archived is
 *      terminal; same-state is allowed and bumps version).
 *   7. Refresh the lockfile entry's `lastImportedVersion` to the
 *      new DB version so a subsequent `yolo plan import` is a
 *      NO_CHANGE rather than a false-positive DIVERGED. Revision
 *      is unchanged because the file didn't change — same
 *      revision pointer, new version.
 *
 * Exit codes (used by the CLI wrapper):
 *   - 0  = success (transition applied OR no-op when already in target)
 *   - 1  = http (plan not found, version conflict, transition rejected)
 *   - 64 = usage (bad planId, missing env, --workspace mismatch)
 */

import path from 'node:path';

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

// ─── Public types ─────────────────────────────────────────────────────────

/**
 * Operator-facing target states. `'draft'` is intentionally not
 * exposed — once a plan has been activated/archived, the substrate
 * doesn't allow walking it back to draft, and there's no operational
 * use case for a CLI verb that does. (The substrate's transition
 * matrix would reject it; this prevents the user-facing footgun.)
 */
export type OperatorTargetState = 'active' | 'archived';

export interface PlanStateOptions {
  planId: string;
  targetState: OperatorTargetState;
  workspaceFlag?: string;
  envFlag?: string;
  /**
   * Lockfile directory. Defaults to `<cwd>/.yolo/plans/`. Tests
   * inject a tmp dir.
   */
  plansDir?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  now?: () => string;
}

export type PlanAuthoringState = 'draft' | 'active' | 'archived';

export interface PlanStateSuccess {
  ok: true;
  planId: string;
  workspaceId: string;
  fromState: PlanAuthoringState;
  toState: OperatorTargetState;
  /** Plan version after the operation (unchanged on no-op). */
  version: number;
  /** True when the plan was already in the target state (no DB write). */
  noop: boolean;
}

export interface PlanStateFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http' | 'lockfile';
  message: string;
  detail?: Record<string, unknown>;
}

export type PlanStateResult = PlanStateSuccess | PlanStateFailure;

interface GetPlanResponse {
  planId: string;
  authoringState: PlanAuthoringState;
  version: number;
}

const PLAN_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/;

// ─── Public entry ─────────────────────────────────────────────────────────

export async function runPlanStateTransition(options: PlanStateOptions): Promise<PlanStateResult> {
  const env = options.env ?? process.env;
  const now = options.now ?? (() => new Date().toISOString());

  // 1) planId regex
  if (!PLAN_ID_REGEX.test(options.planId)) {
    return fail(
      'usage',
      `invalid planId '${options.planId}': must match /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,127}$/`,
    );
  }

  // 2) env trio
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

  const ctx = {
    commonApiUrl,
    internalApiKey,
    delegatedToken: mint.token,
    fetchImpl: options.fetchImpl,
  };

  // 5) GET current plan (need version for CAS, state for no-op detection)
  const getResponse = await authenticatedRequest(
    ctx,
    `/workspaces/${mint.workspaceId}/plans/${options.planId}`,
    { method: 'GET' },
  );
  if (!getResponse.ok) {
    const text = await safeReadText(getResponse);
    return fail(
      'http',
      `work.get_plan failed: HTTP ${getResponse.status} — ${text}`,
      { status: getResponse.status },
    );
  }
  const getJson = (await getResponse.json()) as { plan?: GetPlanResponse };
  if (!getJson.plan) {
    return fail('http', 'work.get_plan response missing `plan` field');
  }
  const currentState = getJson.plan.authoringState;
  const baseVersion = getJson.plan.version;

  // 6) No-op short-circuit. The substrate accepts same-state
  //    transitions and bumps version — but we'd rather not churn
  //    the DB on idempotent calls. Caller still gets a success
  //    result so scripts can branch on `noop`.
  if (currentState === options.targetState) {
    return {
      ok: true,
      planId: options.planId,
      workspaceId: mint.workspaceId,
      fromState: currentState,
      toState: options.targetState,
      version: baseVersion,
      noop: true,
    };
  }

  // 7) PATCH with set-authoring-state mutation
  const patchResponse = await authenticatedRequest(
    ctx,
    `/workspaces/${mint.workspaceId}/plans/${options.planId}`,
    {
      method: 'PATCH',
      jsonBody: {
        baseVersion,
        mutations: [{ op: 'set-authoring-state', state: options.targetState }],
      },
    },
  );
  if (!patchResponse.ok) {
    const text = await safeReadText(patchResponse);
    return fail(
      'http',
      `work.update_plan failed: HTTP ${patchResponse.status} — ${text}`,
      { status: patchResponse.status },
    );
  }
  const patchJson = (await patchResponse.json()) as { version?: number };
  if (typeof patchJson.version !== 'number') {
    return fail('http', 'work.update_plan response missing version field');
  }

  // 8) Refresh the lockfile if an entry exists. The file revision
  //    didn't change (no file edit happened), so we keep the
  //    revision pointer and only bump `lastImportedVersion` to
  //    the post-update version. Without this, a subsequent
  //    `yolo plan import` of the unchanged file would see DB at
  //    version+1 vs. lockfile expecting baseVersion → DIVERGED.
  //    Best-effort: a missing lockfile entry is fine (e.g., the
  //    plan was created via curl, not import).
  const plansDir = options.plansDir ?? path.resolve('.yolo', 'plans');
  let lockfilePath: string;
  let lockfile: Lockfile;
  try {
    lockfilePath = resolveLockfilePath(plansDir, options.envFlag);
    lockfile = readLockfile(lockfilePath);
  } catch (err) {
    if (err instanceof LockfileError) {
      return fail('lockfile', err.message, { code: err.code });
    }
    return fail('lockfile', describeError(err));
  }
  const existing = getEntry(lockfile, mint.workspaceId, options.planId);
  if (existing) {
    const refreshed: LockfileEntry = {
      lastImportedRevision: existing.lastImportedRevision,
      lastImportedVersion: patchJson.version,
      lastImportedAt: now(),
    };
    setEntry(lockfile, mint.workspaceId, options.planId, refreshed);
    try {
      writeLockfile(lockfilePath, lockfile);
    } catch (err) {
      if (err instanceof LockfileError) {
        return fail('lockfile', err.message, { code: err.code });
      }
      return fail('lockfile', describeError(err));
    }
  }

  return {
    ok: true,
    planId: options.planId,
    workspaceId: mint.workspaceId,
    fromState: currentState,
    toState: options.targetState,
    version: patchJson.version,
    noop: false,
  };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(
  kind: PlanStateFailure['kind'],
  message: string,
  detail?: Record<string, unknown>,
): PlanStateFailure {
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

export function exitCodeForFailure(kind: PlanStateFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
    case 'lockfile':
      return 1;
  }
}

export function formatSuccess(result: PlanStateSuccess): string {
  if (result.noop) {
    return `OK: plan '${result.planId}' is already ${result.toState} (workspace ${result.workspaceId}, version ${result.version})`;
  }
  return `OK: plan '${result.planId}' transitioned ${result.fromState} → ${result.toState} (workspace ${result.workspaceId}, version ${result.version})`;
}
