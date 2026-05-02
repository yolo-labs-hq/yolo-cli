/**
 * `yolo --version` regression test. The shipped binary prints the
 * package's own version string; this used to be a hardcoded constant
 * that drifted from package.json (commit 88cf6468 → 0.2.0 in
 * package.json but the dist still printed 0.1.0). We now resolve via
 * createRequire so the two can't drift, and this test locks that in.
 *
 * Spawns the compiled CLI as a subprocess (the same path the
 * /usr/local/bin/yolo launcher uses in production containers) rather
 * than importing the module — because the runtime binary is what
 * ships, and that's what we have to verify.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const pkgPath = resolve(here, '..', 'package.json');
const cliPath = resolve(here, '..', 'dist', 'cli.js');

const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as { version: string };

describe('yolo --version', () => {
  it('prints the version from package.json (no drift)', () => {
    const r = spawnSync(process.execPath, [cliPath, '--version'], { encoding: 'utf-8' });
    assert.equal(r.status, 0, `unexpected exit ${r.status}: ${r.stderr}`);
    assert.equal(r.stdout.trim(), pkg.version);
  });

  it('also accepts -v as the short flag', () => {
    const r = spawnSync(process.execPath, [cliPath, '-v'], { encoding: 'utf-8' });
    assert.equal(r.status, 0);
    assert.equal(r.stdout.trim(), pkg.version);
  });
});
