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
  it('saves under ~/.config/yolo/deploy-pending and round-trips', () => {
    const store = defaultPendingStore(env);
    const rec = record();
    assert.equal(store.save(rec), true);
    const onDisk = path.join(home, '.config', 'yolo', 'deploy-pending', 'hp_1.json');
    assert.ok(fs.existsSync(onDisk));
    assert.deepEqual(store.load('hp_1'), rec);
  });

  it('empty HOME falls back to os.homedir() — never resolves into cwd (codex P2 r5)', () => {
    const store = defaultPendingStore({ HOME: '' });
    // The path must be absolute (under the OS home), not a relative ./.config.
    // We assert indirectly: saving must not create a ./.config in cwd.
    const before = fs.existsSync(path.join(process.cwd(), '.config'));
    store.save(record({ projectId: 'hp_home_test' }));
    const after = fs.existsSync(path.join(process.cwd(), '.config'));
    assert.equal(after, before); // no repo-local dir appeared
    // clean up the real-home artifact we just wrote
    store.clear('hp_home_test');
  });
});

describe('deploy-pending — concurrency guards', () => {
  it('save is FIRST-WINS: a non-stale record for a different shipId is not clobbered', () => {
    const store = defaultPendingStore(env);
    assert.equal(store.save(record({ shipId: 'shp_first' })), true);
    assert.equal(store.save(record({ shipId: 'shp_second' })), false);
    assert.equal(store.load('hp_1')?.shipId, 'shp_first');
  });

  it('save DOES replace the same shipId (idempotent re-save)', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_x' }));
    assert.equal(store.save(record({ shipId: 'shp_x', approvalId: 'apr_2' })), true);
    assert.equal(store.load('hp_1')?.approvalId, 'apr_2');
  });

  it('a fresh different shipId REPLACES a STALE (>24h) existing record', () => {
    const store = defaultPendingStore(env);
    const staleTime = new Date(Date.now() - PENDING_MAX_AGE_MS - 1000).toISOString();
    store.save(record({ shipId: 'shp_old', createdAt: staleTime }));
    assert.equal(store.load('hp_1')?.shipId, 'shp_old'); // present but stale
    assert.equal(store.save(record({ shipId: 'shp_new' })), true); // stale → replaceable
    assert.equal(store.load('hp_1')?.shipId, 'shp_new');
  });

  it('clear is IDENTITY-CHECKED: a mismatched shipId does not delete a newer record', () => {
    const store = defaultPendingStore(env);
    store.save(record({ shipId: 'shp_current' }));
    store.clear('hp_1', 'shp_stale'); // a racing deploy's stale id
    assert.ok(store.load('hp_1'), 'record must survive a mismatched clear');
    store.clear('hp_1', 'shp_current'); // the real owner clears
    assert.equal(store.load('hp_1'), null);
  });

  it('clear with no shipId forces removal', () => {
    const store = defaultPendingStore(env);
    store.save(record());
    store.clear('hp_1');
    assert.equal(store.load('hp_1'), null);
  });
});
