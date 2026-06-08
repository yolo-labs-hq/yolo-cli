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

import * as http from 'node:http';
import * as fs from 'node:fs';
import * as os from 'node:os';
import { createServeHandler } from './serve.js';

describe('createServeHandler — symlink escape guard (integration)', () => {
  function req(server: http.Server, urlPath: string): Promise<{ status: number; body: string }> {
    return new Promise((resolve, reject) => {
      const addr = server.address();
      const port = typeof addr === 'object' && addr ? addr.port : 0;
      http.get({ host: '127.0.0.1', port, path: urlPath }, (res) => {
        let body = '';
        res.on('data', (c) => (body += c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, body }));
      }).on('error', reject);
    });
  }

  it('serves in-root files but 403s a symlink escaping root', async () => {
    const base = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-serve-'));
    const root = path.join(base, 'root');
    const secretDir = path.join(base, 'secret');
    fs.mkdirSync(root);
    fs.mkdirSync(secretDir);
    fs.writeFileSync(path.join(root, 'index.html'), '<h1>ok</h1>');
    fs.writeFileSync(path.join(secretDir, 'passwd'), 'TOPSECRET');
    // Symlink INSIDE root pointing OUTSIDE it — the lexical guard can't catch this.
    try {
      fs.symlinkSync(path.join(secretDir, 'passwd'), path.join(root, 'leak'));
    } catch {
      return; // platform without symlink perms — skip
    }

    const server = http.createServer(
      createServeHandler({ dir: path.resolve(root), port: 0, host: '127.0.0.1', spa: false, noCache: true }),
    );
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    try {
      const ok = await req(server, '/index.html');
      assert.equal(ok.status, 200);
      assert.match(ok.body, /ok/);

      const leak = await req(server, '/leak');
      assert.equal(leak.status, 403); // symlink escape blocked
      assert.doesNotMatch(leak.body, /TOPSECRET/);
    } finally {
      server.close();
      fs.rmSync(base, { recursive: true, force: true });
    }
  });
});
