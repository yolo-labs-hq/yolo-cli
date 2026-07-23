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
  load(projectId: string): DeployPendingRecord | null;
  save(record: DeployPendingRecord): void;
  clear(projectId: string): void;
}

/** Resume records older than this are stale — the ship session is long gone. */
export const PENDING_MAX_AGE_MS = 24 * 60 * 60 * 1000;

function pendingDir(env: Record<string, string | undefined>): string {
  // os.homedir() fallback (matching auth-context.ts): an empty HOME must not
  // resolve the store into the CURRENT REPO, where the persisted bundle would
  // surface in `git status` and could ride a `git add -A` (codex P2 r4).
  const home = env.HOME ?? process.env.HOME ?? os.homedir();
  return path.join(home, '.config', 'yolo', 'deploy-pending');
}

function pendingPath(env: Record<string, string | undefined>, projectId: string): string {
  // projectId is server-issued; sanitize anyway so a hostile value can't
  // escape the directory.
  return path.join(pendingDir(env), `${projectId.replace(/[^A-Za-z0-9_-]/g, '_')}.json`);
}

export function defaultPendingStore(env: Record<string, string | undefined>): PendingStore {
  return {
    load(projectId) {
      try {
        const raw = fs.readFileSync(pendingPath(env, projectId), 'utf8');
        const parsed = JSON.parse(raw) as DeployPendingRecord;
        if (
          parsed?.$version !== 1 ||
          typeof parsed.shipId !== 'string' ||
          typeof parsed.bundleDigest !== 'string' ||
          typeof parsed.approvalId !== 'string'
        ) {
          return null; // malformed → treat as absent (caller clears + fresh-ships)
        }
        return parsed;
      } catch {
        return null;
      }
    },
    save(record) {
      const dir = pendingDir(env);
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(pendingPath(env, record.projectId), `${JSON.stringify(record, null, 2)}\n`, {
        mode: 0o600,
      });
    },
    clear(projectId) {
      try {
        fs.unlinkSync(pendingPath(env, projectId));
      } catch {
        // absent — fine
      }
    },
  };
}
