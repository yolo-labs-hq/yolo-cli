/**
 * Option-parser hardening regression tests (codex gpt-5.6-sol P3, 2026-07-18):
 * a value-taking flag must never consume a following flag as its value
 * (`--workspace --accept-optional=net:x` used to swallow the second flag as
 * the workspace id), and `--flag=` empty values are rejected too.
 *
 * Spawns the compiled CLI (the shipped surface) — every case must fail with
 * exit 64 + a "requires a value" usage message BEFORE any auth/network work,
 * which the empty env guarantees would otherwise fail differently.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const cliPath = resolve(here, '..', 'dist', 'cli.js');

function run(args: string[]): { status: number | null; stderr: string } {
  const r = spawnSync(process.execPath, [cliPath, ...args], {
    encoding: 'utf-8',
    env: { PATH: process.env.PATH, HOME: '/nonexistent-yolo-cli-test-home' },
  });
  return { status: r.status, stderr: r.stderr };
}

describe('flag-value parsing — a following flag is never consumed as a value', () => {
  it('tileapp install: --workspace followed by another flag', () => {
    const r = run(['tileapp', 'install', 'notes', '--workspace', '--accept-optional=net:x']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--workspace requires a value/);
  });

  it('tileapp install: --accept-optional followed by another flag', () => {
    const r = run(['tileapp', 'install', 'notes', '--workspace', 'ws1', '--accept-optional', '--json']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--accept-optional requires a value/);
  });

  it('tileapp install: empty --workspace= value', () => {
    const r = run(['tileapp', 'install', 'notes', '--workspace=']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--workspace requires a value/);
  });

  it('tileapp add-tile: --name followed by another flag', () => {
    const r = run(['tileapp', 'add-tile', 'notes', '--workspace', 'ws1', '--name', '--version', '1.0.0']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--name requires a value/);
  });

  it('tileapp add-tile: --version followed by another flag', () => {
    const r = run(['tileapp', 'add-tile', 'notes', '--workspace', 'ws1', '--version', '--name=x']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--version requires a value/);
  });

  it('tileapp add-tile: empty --version= value', () => {
    const r = run(['tileapp', 'add-tile', 'notes', '--workspace', 'ws1', '--version=']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--version requires a value/);
  });

  it('mcp scopes: --agent followed by another flag', () => {
    const r = run(['mcp', 'scopes', '--agent', '--json']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--agent requires a value/);
  });

  it('mcp scopes: empty --agent= value', () => {
    const r = run(['mcp', 'scopes', '--agent=']);
    assert.equal(r.status, 64);
    assert.match(r.stderr, /--agent requires a value/);
  });
});
