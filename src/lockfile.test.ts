/**
 * Lockfile tests (Phase 8c.2).
 *
 * Pin the read/write/path-resolution behaviour the import flow
 * (8c.3) will rely on. Each test uses an isolated tmpdir so disk
 * state never leaks across tests.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, rmSync, mkdirSync } from 'node:fs';
import path from 'node:path';
import os from 'node:os';

import {
  resolveLockfilePath,
  readLockfile,
  writeLockfile,
  getEntry,
  setEntry,
  LockfileError,
  type Lockfile,
} from './lockfile.js';

function makeTmpDir(): string {
  return mkdtempSync(path.join(os.tmpdir(), 'yolo-cli-lockfile-test-'));
}

const SAMPLE_REVISION = 'sha256:e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const SAMPLE_REVISION_2 = 'sha256:abe3a05acc7a9ed7c1e451d76012ca6d7d29c8d2e7e2bbef0a73c52d2af09d49';
const SAMPLE_AT = '2026-04-30T12:00:00.000Z';

const SAMPLE_ENTRY = {
  lastImportedRevision: SAMPLE_REVISION,
  lastImportedVersion: 7,
  lastImportedAt: SAMPLE_AT,
};

// ─── resolveLockfilePath ─────────────────────────────────────────────────
describe('lockfile — resolveLockfilePath', () => {
  it('returns .imports.json when env is unset', () => {
    assert.equal(resolveLockfilePath('/repo/.yolo/plans'), '/repo/.yolo/plans/.imports.json');
  });

  it('returns .imports.<env>.json when env is set', () => {
    assert.equal(
      resolveLockfilePath('/repo/.yolo/plans', 'staging'),
      '/repo/.yolo/plans/.imports.staging.json',
    );
  });

  it('rejects an env name with a slash (path-traversal guard)', () => {
    assert.throws(
      () => resolveLockfilePath('/repo', '../etc'),
      (err: unknown) => err instanceof LockfileError && err.code === 'malformed',
    );
  });

  it('rejects an empty env name', () => {
    assert.throws(
      () => resolveLockfilePath('/repo', ''),
      (err: unknown) => err instanceof LockfileError,
    );
  });

  it('accepts allowed env characters [A-Za-z0-9_-]', () => {
    assert.equal(
      resolveLockfilePath('/repo', 'prod-east_1'),
      '/repo/.imports.prod-east_1.json',
    );
  });
});

// ─── readLockfile ────────────────────────────────────────────────────────
describe('lockfile — readLockfile', () => {
  it('returns {} when the file does not exist (first import)', () => {
    const dir = makeTmpDir();
    try {
      const result = readLockfile(path.join(dir, '.imports.json'));
      assert.deepEqual(result, {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns {} when the file exists but is empty / whitespace', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(fp, '   \n  \n');
      assert.deepEqual(readLockfile(fp), {});
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('parses a valid lockfile', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(
        fp,
        JSON.stringify(
          { ws1: { 'plan-a': SAMPLE_ENTRY } },
          null,
          2,
        ),
      );
      const result = readLockfile(fp);
      assert.deepEqual(result, { ws1: { 'plan-a': SAMPLE_ENTRY } });
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws LockfileError(code=malformed) on invalid JSON', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(fp, '{ this is not json');
      assert.throws(
        () => readLockfile(fp),
        (err: unknown) => err instanceof LockfileError && err.code === 'malformed',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws LockfileError(code=malformed) on top-level array', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(fp, '[]');
      assert.throws(
        () => readLockfile(fp),
        (err: unknown) => err instanceof LockfileError && err.code === 'malformed',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws LockfileError(code=malformed_entry) on missing required field', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(
        fp,
        JSON.stringify({
          ws1: {
            'plan-a': {
              lastImportedRevision: SAMPLE_REVISION,
              // lastImportedVersion missing
              lastImportedAt: SAMPLE_AT,
            },
          },
        }),
      );
      assert.throws(
        () => readLockfile(fp),
        (err: unknown) =>
          err instanceof LockfileError &&
          err.code === 'malformed_entry' &&
          /lastImportedVersion/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws LockfileError(code=malformed_entry) on bad revision shape', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(
        fp,
        JSON.stringify({
          ws1: {
            'plan-a': {
              lastImportedRevision: 'md5:abc',
              lastImportedVersion: 1,
              lastImportedAt: SAMPLE_AT,
            },
          },
        }),
      );
      assert.throws(
        () => readLockfile(fp),
        (err: unknown) =>
          err instanceof LockfileError &&
          err.code === 'malformed_entry' &&
          /sha256/.test(err.message),
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on non-integer version', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(
        fp,
        JSON.stringify({
          ws1: {
            'plan-a': {
              lastImportedRevision: SAMPLE_REVISION,
              lastImportedVersion: 1.5,
              lastImportedAt: SAMPLE_AT,
            },
          },
        }),
      );
      assert.throws(
        () => readLockfile(fp),
        (err: unknown) => err instanceof LockfileError && err.code === 'malformed_entry',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('throws on non-ISO timestamp', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeFileSync(
        fp,
        JSON.stringify({
          ws1: {
            'plan-a': {
              lastImportedRevision: SAMPLE_REVISION,
              lastImportedVersion: 1,
              lastImportedAt: 'not-a-date',
            },
          },
        }),
      );
      assert.throws(
        () => readLockfile(fp),
        (err: unknown) => err instanceof LockfileError && err.code === 'malformed_entry',
      );
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── writeLockfile ───────────────────────────────────────────────────────
describe('lockfile — writeLockfile', () => {
  it('creates the parent dir if missing', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, 'nested', 'deeper', '.imports.json');
      writeLockfile(fp, { ws1: { 'plan-a': SAMPLE_ENTRY } });
      assert.equal(existsSync(fp), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('emits canonical JSON: 2-space indent + single trailing newline', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeLockfile(fp, { ws1: { 'plan-a': SAMPLE_ENTRY } });
      const text = readFileSync(fp, 'utf8');
      assert.ok(text.endsWith('\n'), 'should end with single trailing newline');
      assert.equal(text.endsWith('\n\n'), false, 'should not end with two newlines');
      assert.match(text, /^{\n  "ws1":/, 'should use 2-space indent');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('sorts workspace IDs and planIds lex; entry fields in alphabetical order', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      // Insert in deliberately non-canonical order.
      const lockfile: Lockfile = {
        zebra: { 'plan-z': SAMPLE_ENTRY, 'plan-a': SAMPLE_ENTRY },
        alpha: { 'plan-b': SAMPLE_ENTRY },
      };
      writeLockfile(fp, lockfile);
      const text = readFileSync(fp, 'utf8');
      // alpha workspace should appear before zebra
      assert.ok(text.indexOf('"alpha"') < text.indexOf('"zebra"'));
      // plan-a should appear before plan-z within zebra
      const zebraStart = text.indexOf('"zebra"');
      const aIdx = text.indexOf('"plan-a"', zebraStart);
      const zIdx = text.indexOf('"plan-z"', zebraStart);
      assert.ok(aIdx > 0 && zIdx > 0 && aIdx < zIdx, 'plan-a should precede plan-z in zebra workspace');
      // entry field order: at, revision, version
      const atIdx = text.indexOf('"lastImportedAt"');
      const revIdx = text.indexOf('"lastImportedRevision"');
      const verIdx = text.indexOf('"lastImportedVersion"');
      assert.ok(atIdx < revIdx && revIdx < verIdx, 'entry fields must be in lex order: at, revision, version');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('round-trips byte-identically (idempotent re-write)', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      const lockfile: Lockfile = {
        wsB: { 'plan-2': SAMPLE_ENTRY, 'plan-1': { ...SAMPLE_ENTRY, lastImportedRevision: SAMPLE_REVISION_2 } },
        wsA: { 'plan-1': SAMPLE_ENTRY },
      };
      writeLockfile(fp, lockfile);
      const text1 = readFileSync(fp, 'utf8');
      const reparsed = readLockfile(fp);
      writeLockfile(fp, reparsed);
      const text2 = readFileSync(fp, 'utf8');
      assert.equal(text1, text2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('writes an empty lockfile as `{}` + newline', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      writeLockfile(fp, {});
      assert.equal(readFileSync(fp, 'utf8'), '{}\n');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ─── getEntry / setEntry ─────────────────────────────────────────────────
describe('lockfile — getEntry / setEntry', () => {
  it('getEntry returns null when workspace or planId is missing', () => {
    const lf: Lockfile = { ws1: { 'plan-a': SAMPLE_ENTRY } };
    assert.equal(getEntry(lf, 'ws1', 'plan-missing'), null);
    assert.equal(getEntry(lf, 'ws-missing', 'plan-a'), null);
  });

  it('getEntry returns the entry when present', () => {
    const lf: Lockfile = { ws1: { 'plan-a': SAMPLE_ENTRY } };
    assert.deepEqual(getEntry(lf, 'ws1', 'plan-a'), SAMPLE_ENTRY);
  });

  it('setEntry inserts a new workspace + planId pair', () => {
    const lf: Lockfile = {};
    setEntry(lf, 'ws1', 'plan-a', SAMPLE_ENTRY);
    assert.deepEqual(lf, { ws1: { 'plan-a': SAMPLE_ENTRY } });
  });

  it('setEntry replaces an existing entry without disturbing siblings', () => {
    const lf: Lockfile = {
      ws1: { 'plan-a': SAMPLE_ENTRY, 'plan-b': SAMPLE_ENTRY },
    };
    const updated = { ...SAMPLE_ENTRY, lastImportedVersion: 99 };
    setEntry(lf, 'ws1', 'plan-a', updated);
    assert.deepEqual(lf.ws1!['plan-a'], updated);
    // Sibling unchanged
    assert.deepEqual(lf.ws1!['plan-b'], SAMPLE_ENTRY);
  });

  it('setEntry returns the same lockfile (chaining ergonomics)', () => {
    const lf: Lockfile = {};
    const result = setEntry(lf, 'ws1', 'plan-a', SAMPLE_ENTRY);
    assert.equal(result, lf);
  });
});

// ─── End-to-end disk round-trip ──────────────────────────────────────────
describe('lockfile — end-to-end disk round-trip', () => {
  it('write → read → mutate → write produces a stable second-write byte-identical to itself', () => {
    const dir = makeTmpDir();
    try {
      const fp = path.join(dir, '.imports.json');
      // Initial write
      const lf1: Lockfile = {};
      setEntry(lf1, 'wsA', 'plan-foo', SAMPLE_ENTRY);
      writeLockfile(fp, lf1);

      // Read back, mutate (different plan), write again
      const lf2 = readLockfile(fp);
      setEntry(lf2, 'wsA', 'plan-bar', { ...SAMPLE_ENTRY, lastImportedRevision: SAMPLE_REVISION_2 });
      writeLockfile(fp, lf2);
      const text2 = readFileSync(fp, 'utf8');

      // Read + write again (no further mutation) — must be byte-identical
      const lf3 = readLockfile(fp);
      writeLockfile(fp, lf3);
      const text3 = readFileSync(fp, 'utf8');

      assert.equal(text2, text3, 'second re-write must be byte-identical (canonical idempotency)');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it('mkdirSync does not throw if dir already exists', () => {
    const dir = makeTmpDir();
    try {
      const subdir = path.join(dir, 'plans');
      mkdirSync(subdir);
      const fp = path.join(subdir, '.imports.json');
      writeLockfile(fp, { ws1: { 'plan-a': SAMPLE_ENTRY } });
      assert.equal(existsSync(fp), true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
