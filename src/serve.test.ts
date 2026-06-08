/**
 * Unit tests for `yolo serve` pure helpers — arg parsing + the path
 * traversal guard (the security-load-bearing piece).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import * as path from 'path';
import { parseServeArgs, resolveRequestPath } from './serve.js';

describe('parseServeArgs', () => {
  it('requires a <dir>', () => {
    const r = parseServeArgs([]);
    assert.equal(r.ok, false);
  });

  it('resolves dir + defaults host/port (3000 when no --port / $PORT)', () => {
    const saved = process.env.PORT;
    delete process.env.PORT;
    try {
      const r = parseServeArgs(['./site']);
      assert.equal(r.ok, true);
      if (r.ok) {
        assert.equal(r.opts.dir, path.resolve('./site'));
        assert.equal(r.opts.port, 3000);
        assert.equal(r.opts.host, '0.0.0.0');
        assert.equal(r.opts.spa, false);
      }
    } finally {
      if (saved !== undefined) process.env.PORT = saved;
    }
  });

  it('honors $PORT as the fallback before the 3000 default', () => {
    const saved = process.env.PORT;
    process.env.PORT = '4321';
    try {
      const r = parseServeArgs(['./site']);
      assert.equal(r.ok, true);
      if (r.ok) assert.equal(r.opts.port, 4321);
    } finally {
      if (saved === undefined) delete process.env.PORT;
      else process.env.PORT = saved;
    }
  });

  it('--port overrides $PORT and accepts --port=N', () => {
    const a = parseServeArgs(['d', '--port', '8080']);
    assert.equal(a.ok && a.opts.port, 8080);
    const b = parseServeArgs(['d', '--port=8081']);
    assert.equal(b.ok && b.opts.port, 8081);
  });

  it('rejects an invalid port', () => {
    assert.equal(parseServeArgs(['d', '--port', '0']).ok, false);
    assert.equal(parseServeArgs(['d', '--port', '99999']).ok, false);
    assert.equal(parseServeArgs(['d', '--port', 'abc']).ok, false);
  });

  it('parses --spa and --host', () => {
    const r = parseServeArgs(['d', '--spa', '--host', '127.0.0.1']);
    assert.equal(r.ok && r.opts.spa, true);
    assert.equal(r.ok && r.opts.host, '127.0.0.1');
  });

  it('rejects unknown flags and extra args', () => {
    assert.equal(parseServeArgs(['d', '--bogus']).ok, false);
    assert.equal(parseServeArgs(['d', 'e']).ok, false);
  });
});

describe('resolveRequestPath (traversal guard)', () => {
  const root = path.resolve('/srv/site');

  it('resolves a normal path under root', () => {
    assert.equal(resolveRequestPath(root, '/index.html'), path.join(root, 'index.html'));
    assert.equal(resolveRequestPath(root, '/'), root);
    assert.equal(resolveRequestPath(root, '/assets/app.css'), path.join(root, 'assets', 'app.css'));
  });

  it('strips query + hash', () => {
    assert.equal(resolveRequestPath(root, '/index.html?v=2#x'), path.join(root, 'index.html'));
  });

  it('decodes percent-encoding', () => {
    assert.equal(resolveRequestPath(root, '/a%20b.html'), path.join(root, 'a b.html'));
  });

  it('BLOCKS traversal escaping root', () => {
    assert.equal(resolveRequestPath(root, '/../etc/passwd'), null);
    assert.equal(resolveRequestPath(root, '/../../secret'), null);
    assert.equal(resolveRequestPath(root, '/%2e%2e/%2e%2e/etc/passwd'), null);
  });

  it('rejects malformed percent-encoding', () => {
    assert.equal(resolveRequestPath(root, '/%zz'), null);
  });

  it('does not treat a sibling dir with the root prefix as inside root', () => {
    // /srv/site-secret must NOT be considered within /srv/site
    assert.equal(resolveRequestPath(root, '/../site-secret/x'), null);
  });
});
