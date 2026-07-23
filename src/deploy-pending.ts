/**
 * deploy-pending.ts — machine-local staged-ship state for the T3 approval
 * round-trip (codex gpt-5.6-sol P1, round 3).
 *
 * Problem: a prod finalize that parks on `awaiting-approval` leaves the ship
 * session OPEN server-side (assets staged, approval bound to the exact
 * bundleDigest) — but a plain `yolo deploy` rerun REBUILDS first. Any
 * nondeterminism in the build (timestamps, hash salts, ordering) changes the
 * digest, the grant never matches, and the retry loops on fresh approvals
 * forever. The approved BYTES must be what ships.
 *
 * Fix: on PENDING, persist a resume record — shipId, digest, approvalId, and
 * the exact worker module bytes (base64; pure-static ships have none — their
 * assets are already staged server-side). The next `yolo deploy` for the same
 * project+env resumes by re-FINALIZING that session (no build, no bundle, no
 * re-upload) and only falls back to a fresh build when the server says the
 * session/approval is gone.
 *
 * Location: `~/.config/yolo/deploy-pending/<projectId>.json` (0600) — the
 * same machine-local config root as the auth token, NOT the repo. In-repo
 * state would surface in `git status` of arbitrary user repos and could ride
 * a lane's `git add -A` WIP-rescue; here it also survives lane teardown, so a
 * later lane can resume a ship the operator approved after the original step
 * ended.
 */
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

export interface DeployPendingRecord {
  $version: 1;
  projectId: string;
  shipId: string;
  env: 'staging' | 'prod';
  slug?: string;
  type: 'static' | 'worker';
  bundleDigest: string;
  approvalId: string;
  fileCount: number;
  totalAssetBytes: number;
  createdAt: string; // ISO
  /** Exact module bytes the approval covers (worker ships only), base64. */
  workerModules?: Array<{ name: string; contentsBase64: string }>;
  sourceMap?: { name: string; content: string } | null;
}

export interface PendingStore {
  /**
   * All resumable records for a project, NEWEST first. One file per shipId
   * (see keying note below), so two concurrent same-project deploys each get
   * their OWN record — neither clobbers the other, and BOTH stay resumable
   * once approved (codex P2 r7). Malformed files are skipped.
   */
  loadAll(projectId: string): DeployPendingRecord[];
  /**
   * Persist a staged-ship record. Keyed by (projectId, shipId), so a
   * concurrent deploy with a different shipId writes a DIFFERENT file —
   * there is no shared-file race and no lost record (the write itself is a
   * single atomic file write). Re-saving the same shipId is idempotent.
   */
  save(record: DeployPendingRecord): void;
  /**
   * Remove a SPECIFIC (projectId, shipId) record, or — when shipId is
   * omitted — every record for the project. Per-ship keying means a clear can
   * never delete another concurrent deploy's record.
   */
  clear(projectId: string, shipId?: string): void;
}

/** Resume records older than this are stale — the ship session is long gone. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pendingRoot(env: Record<string, string | undefined>): string {
  // `||` (not `??`) + os.homedir() fallback (matching auth-context.ts): an
  // unset OR EMPTY HOME must not resolve the store into the CURRENT REPO,
  // where the persisted bundle would surface in `git status` and could ride
  // a `git add -A` (codex P2 r4+r5).
  const home = env.HOME || process.env.HOME || os.homedir();
  return path.join(home, '.config', 'yolo', 'deploy-pending');
}

// server-issued ids; sanitize anyway so a hostile value can't escape the dir.
const safe = (id: string): string => id.replace(/[^A-Za-z0-9_-]/g, '_');

function projectDir(env: Record<string, string | undefined>, projectId: string): string {
  return path.join(pendingRoot(env), safe(projectId));
}

function shipPath(env: Record<string, string | undefined>, projectId: string, shipId: string): string {
  return path.join(projectDir(env, projectId), `${safe(shipId)}.json`);
}

function parseRecord(raw: string): DeployPendingRecord | null {
  try {
    const parsed = JSON.parse(raw) as DeployPendingRecord;
    if (
      parsed?.$version !== 1 ||
      typeof parsed.shipId !== 'string' ||
      typeof parsed.bundleDigest !== 'string' ||
      typeof parsed.approvalId !== 'string'
    ) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export function defaultPendingStore(env: Record<string, string | undefined>): PendingStore {
  return {
    loadAll(projectId) {
      let names: string[];
      try {
        names = fs.readdirSync(projectDir(env, projectId));
      } catch {
        return []; // no dir → nothing staged
      }
      const records: DeployPendingRecord[] = [];
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const rec = parseRecord(fs.readFileSync(path.join(projectDir(env, projectId), name), 'utf8'));
          if (rec) records.push(rec);
        } catch {
          // unreadable — skip
        }
      }
      return records.sort((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    },
    save(record) {
      const dir = projectDir(env, record.projectId);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(shipPath(env, record.projectId, record.shipId), `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
    },
    clear(projectId, shipId) {
      if (shipId !== undefined) {
        try {
          fs.unlinkSync(shipPath(env, projectId, shipId));
        } catch {
          // absent — fine
        }
        return;
      }
      // Whole-project clear: remove the dir and everything under it.
      try {
        fs.rmSync(projectDir(env, projectId), { recursive: true, force: true });
      } catch {
        // absent — fine
      }
    },
  };
}
