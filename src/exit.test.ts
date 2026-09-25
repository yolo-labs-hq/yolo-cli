/**
 * Output written to a PIPE must survive exit. `process.exit()` right after a
 * large `stdout.write` cut a piped `yolo kanban export` at the 64 KiB pipe
 * buffer, so `yolo kanban export <tile> | jq` failed on any board over 64 KiB.
 * spawnSync reads the child's stdout through a pipe, which is the failing case.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const exitModule = pathToFileURL(resolve(here, 'exit.js')).href;
const BYTES = 300_000;

const run = (body: string) => spawnSync(process.execPath, ['--input-type=module', '-e', body], { encoding: 'utf-8', maxBuffer: 4 * BYTES });

describe('exitAfterFlush', () => {
  it('delivers all of a large piped write and keeps the exit code', () => {
    const r = run(`import { exitAfterFlush } from ${JSON.stringify(exitModule)};
      process.stdout.write('x'.repeat(${BYTES}));
      process.stderr.write('done');
      exitAfterFlush(3);`);
    assert.equal(r.stdout.length, BYTES);
    assert.equal(r.stderr, 'done');
    assert.equal(r.status, 3);
  });

  it('still exits when a handle would otherwise keep the process alive', () => {
    const r = run(`import { exitAfterFlush } from ${JSON.stringify(exitModule)};
      setInterval(() => {}, 1000);
      process.stdout.write('y'.repeat(${BYTES}));
      exitAfterFlush(0);`);
    assert.equal(r.stdout.length, BYTES);
    assert.equal(r.status, 0);
  });

  it('exits without writing when there are no streams to flush', () => {
    let exited: number | undefined;
    // Imported lazily so the test file itself does not depend on build order.
    return import(exitModule).then(({ exitAfterFlush }) => {
      exitAfterFlush(5, [], (code: number) => { exited = code; });
      assert.equal(exited, 5);
      process.exitCode = 0;
    });
  });

  it('shows the failure it fixes: process.exit() alone truncates a piped write', () => {
    const r = run(`process.stdout.write('z'.repeat(${BYTES})); process.exit(0);`);
    assert.ok(r.stdout.length < BYTES, `expected truncation, got ${r.stdout.length} bytes`);
  });
});
