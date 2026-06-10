/**
 * `yolo plan activate <planId>` / `yolo plan archive <planId>`.
 *
 * Out-of-band Plan-state transitions for plans already in the DB.
 * The file-driven flow can author a plan as `active` from the start
 * (Phase 8d.2 — substrate now accepts `state` on `work.create_plan`),
 * but operators still need a way to:
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
 *   5. GET the current plan to fetch (a) its current state — for the
 *      "already in target state" no-op — and (b) its current
 *      `version` for the `update_plan(baseVersion, …)` CAS.
 *   6. PATCH with `{ baseVersion, mutations: [{ op: 'set-state',
 *      state: <target> }] }`. The substrate's `applyMutations`
 *      enforces the transition matrix (draft→active|archived,
 *      active→archived; archived is terminal; same-state is allowed
 *      and bumps version).
 *   7. Refresh the lockfile entry's `lastImportedVersion` to the
 *      new DB version so a subsequent `yolo plan import` is a
 *      NO_CHANGE rather than a false-positive DIVERGED. Revision
 *      is unchanged because the file didn't change — same
 *      revision pointer, new version.
 *
 * Field rename note: the Plan-level state field was `authoringState`
 * before 2026-05-09 and `state` after (item 17 of
 * `docs/SUBSTRATE_IMPROVEMENTS.md`). The substrate accepts only `state`.
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
import { resolveSubstrateContext } from './auth-context.js';

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
  lockfileFlag?: string;
  /**
   * Lockfile directory. Defaults to `<cwd>/.yolo/plans/`. Tests
   * inject a tmp dir.
   */
  plansDir?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  now?: () => string;
}

export type PlanState = 'draft' | 'active' | 'archived';

export interface PlanStateSuccess {
  ok: true;
  planId: string;
  workspaceId: string;
  fromState: PlanState;
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
  state: PlanState;
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
  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return fail('auth', auth.message);
  const { sessionId, commonApiUrl, userToken } = auth.context;

  // 3) Mint token
  let mint;
  try {
    mint = await mintSubstrateToken({
      commonApiUrl,
      userToken,
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
  const currentState = getJson.plan.state;
  const baseVersion = getJson.plan.version;

  // 6) No-op short-circuit OR PATCH. Either way, we end up with
  //    a definitive (state, version) pair that the lockfile must
  //    reflect — the substrate's view of the plan is the source
  //    of truth for `lastImportedVersion`. Skipping the lockfile
  //    refresh on the no-op path was the Codex R1 finding:
  //    if the lockfile pointed at a stale version (e.g., the
  //    plan was activated outside this CLI between two
  //    `yolo plan activate` invocations), retry would return
  //    success but leave the divergence to fire on the next
  //    `yolo plan import`.
  let finalVersion: number;
  if (currentState === options.targetState) {
    // No-op: substrate would accept same-state and bump version,
    // but we'd rather not churn the DB on idempotent calls. The
    // GET-response version is what the lockfile must align to.
    finalVersion = baseVersion;
  } else {
    const patchResponse = await authenticatedRequest(
      ctx,
      `/workspaces/${mint.workspaceId}/plans/${options.planId}`,
      {
        method: 'PATCH',
        jsonBody: {
          baseVersion,
          mutations: [{ op: 'set-state', state: options.targetState }],
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
    finalVersion = patchJson.version;
  }

  // 7) Refresh the lockfile entry (if one exists for this
  //    workspace/plan). Same on both paths: revision pointer
  //    stays put (the file didn't change), version + timestamp
  //    realign to the substrate's current view. Best-effort skip
  //    when no entry exists (e.g., plan was created via curl,
  //    not import).
  const plansDir = options.plansDir ?? path.resolve('.yolo', 'plans');
  const lockfileResult = refreshLockfileEntry({
    plansDir,
    lockfileFlag: options.lockfileFlag,
    workspaceId: mint.workspaceId,
    planId: options.planId,
    newVersion: finalVersion,
    now,
  });
  if (!lockfileResult.ok) return lockfileResult.error;

  return {
    ok: true,
    planId: options.planId,
    workspaceId: mint.workspaceId,
    fromState: currentState,
    toState: options.targetState,
    version: finalVersion,
    noop: currentState === options.targetState,
  };
}

interface RefreshLockfileOptions {
  plansDir: string;
  lockfileFlag?: string;
  workspaceId: string;
  planId: string;
  newVersion: number;
  now: () => string;
}

interface RefreshLockfileOk { ok: true }
interface RefreshLockfileFail { ok: false; error: PlanStateFailure }

function refreshLockfileEntry(
  opts: RefreshLockfileOptions,
): RefreshLockfileOk | RefreshLockfileFail {
  let lockfilePath: string;
  let lockfile: Lockfile;
  try {
    lockfilePath = resolveLockfilePath(opts.plansDir, opts.lockfileFlag);
    lockfile = readLockfile(lockfilePath);
  } catch (err) {
    if (err instanceof LockfileError) {
      return { ok: false, error: fail('lockfile', err.message, { code: err.code }) };
    }
    return { ok: false, error: fail('lockfile', describeError(err)) };
  }
  const existing = getEntry(lockfile, opts.workspaceId, opts.planId);
  if (!existing) {
    // Best-effort: no entry, no write. The plan was likely
    // created via curl or a different operator's machine.
    return { ok: true };
  }
  const refreshed: LockfileEntry = {
    lastImportedRevision: existing.lastImportedRevision,
    lastImportedVersion: opts.newVersion,
    lastImportedAt: opts.now(),
  };
  setEntry(lockfile, opts.workspaceId, opts.planId, refreshed);
  try {
    writeLockfile(lockfilePath, lockfile);
  } catch (err) {
    if (err instanceof LockfileError) {
      return { ok: false, error: fail('lockfile', err.message, { code: err.code }) };
    }
    return { ok: false, error: fail('lockfile', describeError(err)) };
  }
  return { ok: true };
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
