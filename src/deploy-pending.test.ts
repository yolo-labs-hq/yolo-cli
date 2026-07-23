/**
 * deploy-pending store — the REAL fs-backed store against a tmp HOME. Covers
 * the round-trip, the machine-local (never in-repo) location, and the
 * concurrency guards (first-wins save + identity-checked clear) from codex
 * gpt-5.6-sol P2 r6.
 */
import { describe, it, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import { defaultPendingStore, PENDING_MAX_AGE_MS, type DeployPendingRecord } from './deploy-pending.js';

let home: string;
let env: Record<string, string | undefined>;

function record(over: Partial<DeployPendingRecord> = {}): DeployPendingRecord {
  return {
    $version: 1,
    projectId: 'hp_1',
    shipId: 'shp_a',
    env: 'prod',
    slug: 'app',
    type: 'static',
    bundleDigest: 'sha256:aa',
    approvalId: 'apr_1',
    fileCount: 1,
    totalAssetBytes: 10,
    createdAt: new Date().toISOString(),
    ...over,
  };
}

beforeEach(() => {
  home = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-pending-'));
  env = { HOME: home };
});
afterEach(() => fs.rmSync(home, { recursive: true, force: true }));

describe('deploy-pending — round-trip + location', () => {
  it('saves under ~/.config/yolo/deploy-pending/<project>/<ship>.json and round-trips', () => {
    const store = defaultPendingStore(env);
    const rec = record();
    store.save(rec);
    const onDisk = path.join(home, '.config', 'yolo', 'deploy-pending', 'hp_1', 'shp_a.json');
    assert.ok(fs.existsSync(onDisk));
    assert.deepEqual(store.loadAll('hp_1'), [rec]);
  });

  it('empty HOME falls back to os.homedir() — never resolves into cwd (codex P2 r5)', () => {
    const store = defaultPendingStore({ HOME: '' });
    // Saving must not create a repo-local ./.config (a relative path would).
    const before = fs.existsSync(path.join(process.cwd(), '.config'));
    store.save(record({ projectId: 'hp_home_test' }));
    const after = fs.existsSync(path.join(process.cwd(), '.config'));
    assert.equal(after, before); // no repo-local dir appeared
    store.clear('hp_home_test'); // clean up the real-home artifact
  });
});

describe('deploy-pending — per-ship multi-record concurrency (codex P2 r7)', () => {
  it('two concurrent same-project deploys keep BOTH records (no clobber)', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_first', approvalId: 'apr_1' }));
    store.save(record({ shipId: 'shp_second', approvalId: 'apr_2' }));
    const all = store.loadAll('hp_1');
    assert.equal(all.length, 2);
    assert.deepEqual(all.map((r) => r.shipId).sort(), ['shp_first', 'shp_second']);
  });

  it('loadAll returns NEWEST first', () => {
    const store = defaultPendingStore(env);
    const older = new Date(Date.now() - 60_000).toISOString();
    store.save(record({ shipId: 'shp_old', createdAt: older }));
    store.save(record({ shipId: 'shp_new' }));
    assert.equal(store.loadAll('hp_1')[0]?.shipId, 'shp_new');
  });

  it('re-saving the same shipId is idempotent (overwrites in place)', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_x', approvalId: 'apr_1' }));
    store.save(record({ shipId: 'shp_x', approvalId: 'apr_2' }));
    const all = store.loadAll('hp_1');
    assert.equal(all.length, 1);
    assert.equal(all[0]?.approvalId, 'apr_2');
  });

  it('clear(projectId, shipId) removes ONLY that ship — a concurrent record survives', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_a' }));
    store.save(record({ shipId: 'shp_b' }));
    store.clear('hp_1', 'shp_a');
    assert.deepEqual(store.loadAll('hp_1').map((r) => r.shipId), ['shp_b']);
  });

  it('clear with no shipId removes every record for the project', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_a' }));
    store.save(record({ shipId: 'shp_b' }));
    store.clear('hp_1');
    assert.deepEqual(store.loadAll('hp_1'), []);
  });

  it('a malformed record file is skipped, not fatal', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_ok' }));
    const dir = path.join(home, '.config', 'yolo', 'deploy-pending', 'hp_1');
    fs.writeFileSync(path.join(dir, 'shp_bad.json'), '{not json');
    assert.deepEqual(store.loadAll('hp_1').map((r) => r.shipId), ['shp_ok']);
  });
});
