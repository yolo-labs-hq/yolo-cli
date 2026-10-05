import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runPreviewCmd } from './preview.js';
import type { FetchLike } from './work-client.js';
const env = { SESSION_ID: 'session', WORKSPACE_ID: 'untrusted-hint', YOLO_COMMON_API_URL: 'https://api.test', YOLO_API_TOKEN: 'user-token', HOME: '/nonexistent-preview-test-home' };
function fixture(response: unknown = {}, status = 200) {
  const calls: { url: string; init: any }[] = [];
  let out = '', err = '';
  const fetchImpl: FetchLike = async (url, init) => {
    calls.push({ url, init });
    const mint = url.endsWith('/tokens');
    const value = mint ? { token: 'delegated-token', expiresAt: 'later', jti: 'jti', claims: { workspaceId: 'authoritative-workspace', userId: 'user' } } : response;
    return { ok: mint || status < 400, status: mint ? 200 : status, json: async () => value, text: async () => JSON.stringify(value) };
  };
  return { calls, deps: { env, fetchImpl, stdout: (s: string) => { out += s; }, stderr: (s: string) => { err += s; } }, output: () => ({ out, err }) };
}
test('create uses minted workspace and preserves literal runtime variables', async () => {
  const f = fixture({ tile: { id: 'pv-1' }, preview: { port: 3150 } });
  assert.equal(await runPreviewCmd(['create', '--name', 'App', '--branch', 'main', '--command', 'python3 -m http.server "$PORT" --bind "$HOST"', '--setup', 'pip install -r requirements.txt', '--json'], f.deps), 0);
  assert.deepEqual(JSON.parse(f.calls[0]!.init.body).scopes, ['studio.create_preview']);
  assert.equal(f.calls[1]!.url, 'https://api.test/internal/mcp/workspaces/authoritative-workspace/tiles/preview');
  assert.equal(f.calls[1]!.init.headers.Authorization, 'Bearer delegated-token');
  const body = JSON.parse(f.calls[1]!.init.body);
  assert.equal(body.port, 'auto'); assert.match(body.command, /\$PORT/); assert.equal(body.followBranch.setup, 'pip install -r requirements.txt');
  assert.equal(JSON.parse(f.output().out).tile.id, 'pv-1');
});
test('--wait-for forwards followBranch.waitFor', async () => {
  const f = fixture({ tile: { id: 'pv-1' }, preview: { port: 3150 } });
  assert.equal(await runPreviewCmd(['create', '--name', 'Viz', '--branch', 'main', '--command', 'npm start', '--cwd', 'vizviz', '--wait-for', 'vizviz/package.json', '--json'], f.deps), 0);
  assert.equal(JSON.parse(f.calls[1]!.init.body).followBranch.waitFor, 'vizviz/package.json');
  const g = fixture({ tile: { id: 'pv-2' }, preview: { port: 3150 } });
  assert.equal(await runPreviewCmd(['create', '--name', 'App', '--branch', 'main', '--command', 'node x', '--json'], g.deps), 0);
  assert.equal('waitFor' in JSON.parse(g.calls[1]!.init.body).followBranch, false);
});
test('status, logs and stop use scoped routes and least-privilege capabilities', async () => {
  for (const [action, suffix, scope] of [['status', '/pv-1', 'studio.read_preview'], ['logs', '/pv-1/logs?tail=50', 'studio.read_preview'], ['stop', '/pv-1/stop', 'studio.stop_preview']]) {
    const f = fixture({ preview: { tileId: 'pv-1', branch: 'main', port: 3150, status: 'ready' }, lines: [{ text: 'hello\n' }] });
    assert.equal(await runPreviewCmd([action!, 'pv-1'], f.deps), 0);
    assert.deepEqual(JSON.parse(f.calls[0]!.init.body).scopes, [scope]);
    assert.ok(f.calls[1]!.url.endsWith('/previews' + suffix));
    assert.equal(f.calls[1]!.init.method, action === 'stop' ? 'POST' : 'GET');
  }
});
test('update rewrites env and health settings of an existing preview with create capability', async () => {
  const f = fixture({ updated: true, tileId: 'pv-1', port: 3101 });
  assert.equal(await runPreviewCmd(['update', 'pv-1', '--env', 'OCTOCOVE_MOCKS=1', '--env=EMPTY=', '--unset-env', 'OLD', '--health-path', '/health', '--ready-seconds', '120'], f.deps), 0);
  assert.deepEqual(JSON.parse(f.calls[0]!.init.body).scopes, ['studio.create_preview']);
  assert.equal(f.calls[1]!.url, 'https://api.test/internal/mcp/workspaces/authoritative-workspace/previews/pv-1/update');
  assert.equal(f.calls[1]!.init.method, 'POST');
  assert.deepEqual(JSON.parse(f.calls[1]!.init.body), { env: { OCTOCOVE_MOCKS: '1', EMPTY: '' }, unsetEnv: ['OLD'], healthPath: '/health', readySeconds: 120 });
  assert.match(f.output().out, /Updated preview pv-1 on port 3101/);
});
test('--mode production forwards the mode and requires --build; update can switch it', async () => {
  const f = fixture({ tile: { id: 'pv-1' }, preview: { port: 3150 } });
  assert.equal(await runPreviewCmd(['create', '--name', 'App', '--branch', 'main', '--mode', 'production', '--setup', 'npm ci', '--build', 'npx vinext build',
    '--command', 'npx vinext start --port "$PORT" --hostname "$HOST"', '--json'], f.deps), 0);
  assert.equal(JSON.parse(f.calls[1]!.init.body).followBranch.mode, 'production');
  const g = fixture({ tile: { id: 'pv-1' }, preview: { port: 3150 } });
  assert.equal(await runPreviewCmd(['create', '--name', 'App', '--branch', 'main', '--command', 'node x', '--json'], g.deps), 0);
  assert.equal('mode' in JSON.parse(g.calls[1]!.init.body).followBranch, false);
  for (const args of [['create', '--name', 'App', '--branch', 'main', '--command', 'x', '--mode', 'production'], ['create', '--name', 'App', '--branch', 'main', '--command', 'x', '--build', 'b', '--mode', 'fast']]) {
    const h = fixture();
    assert.equal(await runPreviewCmd(args, h.deps), 64);
    assert.equal(h.calls.length, 0);
  }
  const u = fixture({ updated: true, tileId: 'pv-1', port: 3104 });
  assert.equal(await runPreviewCmd(['update', 'pv-1', '--mode', 'production', '--build', 'npx vinext build', '--command', 'npx vinext start --port "$PORT" --hostname "$HOST"'], u.deps), 0);
  assert.deepEqual(JSON.parse(u.calls[1]!.init.body), { mode: 'production', build: 'npx vinext build', command: 'npx vinext start --port "$PORT" --hostname "$HOST"' });
});
test('status shows the serving mode and last build duration', async () => {
  const f = fixture({ previews: [{ tileId: 'pv-1', name: 'App', status: 'ready', branch: 'main', port: 3104,
    branchStatus: { phase: 'current', servedCommit: 'a'.repeat(40), mode: 'production', lastBuild: { commit: 'a'.repeat(40), durationMs: 41200, finishedAt: 'now' } } }] });
  assert.equal(await runPreviewCmd(['status'], f.deps), 0);
  assert.match(f.output().out, /\n {2}production mode, last build 41\.2s \(aaaaaaaaaaaa\)/);
});
test('status shows the failure reason and where to read logs', async () => {
  const f = fixture({ previews: [{ tileId: 'pv-1', name: 'App', status: 'ready', branch: 'main', port: 3101,
    branchStatus: { phase: 'error', error: 'Candidate never became healthy: GET / returned 500 ×410 in 120s' } }] });
  assert.equal(await runPreviewCmd(['status'], f.deps), 0);
  assert.match(f.output().out, /returned 500 ×410 in 120s\n {2}See: yolo preview logs pv-1/);
});
test('invalid arguments make no authenticated requests', async () => {
  for (const args of [[], ['create'], ['stop'], ['update', 'pv'], ['update', '--env', 'A=1'], ['update', 'pv', '--env', 'NOEQUALS'], ['update', 'pv', '--env', '1BAD=x'],
    ['update', 'pv', '--unset-env', 'A=B'], ['update', 'pv', '--health-path', 'health'], ['update', 'pv', '--branch', 'other'], ['update', 'pv', '--ready-seconds', '0'], ['logs', 'pv', '--tail', '0'], ['status', '--branch', 'main'], ['create', '--name', 'app', '--branch', 'main', '--command', 'node x', '--cwd', '../escape'], ['create', '--name', 'app', '--branch', 'main', '--command', 'node x', '--wait-for', '/abs'], ['create', '--name', 'app', '--branch', 'main', '--command', 'node x', '--wait-for', '../x']]) {
    const f = fixture(); assert.equal(await runPreviewCmd(args, f.deps), 64); assert.equal(f.calls.length, 0);
  }
});
test('help needs no session and HTTP failures remain failures', async () => {
  const f = fixture({ error: 'container upgrade required', code: 'CONTAINER_API_ERROR' }, 502);
  assert.equal(await runPreviewCmd(['--help'], { ...f.deps, env: {} }), 0);
  assert.equal(f.calls.length, 0);
  assert.equal(await runPreviewCmd(['status'], f.deps), 1);
  assert.match(f.output().err, /container upgrade required/);
});
test('empty status and stopped logs have useful output', async () => {
  const f = fixture({ previews: [] });
  assert.equal(await runPreviewCmd(['status'], f.deps), 0);
  assert.match(f.output().out, /No managed branch previews/);
});

test('compiled CLI creates, inspects, reads logs and stops over authenticated HTTP', async () => {
  const { createServer } = await import('node:http');
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const calls: string[] = [];
  const server = createServer(async (req, res) => {
    let raw = ''; for await (const chunk of req) raw += chunk;
    const body = raw ? JSON.parse(raw) : {};
    calls.push(`${req.method} ${req.url}`);
    res.setHeader('content-type', 'application/json');
    if (req.url === '/internal/mcp/tokens') {
      if (req.headers.authorization !== 'Bearer user-token' || body.sessionId !== 'session') { res.writeHead(401); res.end('{}'); return; }
      res.end(JSON.stringify({ token: 'delegated-token', expiresAt: 'later', jti: 'jti', claims: { workspaceId: 'authoritative-workspace', userId: 'user' } })); return;
    }
    if (req.headers.authorization !== 'Bearer delegated-token') { res.writeHead(401); res.end('{}'); return; }
    const preview = { tileId: 'pv-http', name: 'App', status: 'ready', branch: 'main', port: 3150, branchStatus: { phase: 'current', servedCommit: 'a'.repeat(40) } };
    if (req.url?.endsWith('/tiles/preview')) { res.end(JSON.stringify({ tile: { id: 'pv-http' }, preview })); return; }
    if (req.url?.endsWith('/previews')) { res.end(JSON.stringify({ previews: [preview] })); return; }
    if (req.url?.includes('/logs?tail=50')) { res.end(JSON.stringify({ lines: [{ text: 'server ready\n' }] })); return; }
    if (req.url?.endsWith('/stop')) { res.end(JSON.stringify({ stopped: true })); return; }
    res.writeHead(404); res.end('{}');
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as import('node:net').AddressInfo).port;
  const run = async (args: string[]) => new Promise<{ code: number | null; out: string; err: string }>((resolve, reject) => {
    const child = spawn(process.execPath, [fileURLToPath(new URL('./cli.js', import.meta.url)), 'preview', ...args], {
      env: { ...env, YOLO_COMMON_API_URL: `http://127.0.0.1:${port}` }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '', err = ''; child.stdout.on('data', data => { out += data; }); child.stderr.on('data', data => { err += data; });
    child.on('error', reject); child.on('exit', code => resolve({ code, out, err }));
  });
  try {
    for (const [args, expected] of [
      [['create', '--name', 'App', '--branch', 'main', '--command', 'node server.js'], /Preview pv-http follows main/],
      [['status'], /pv-http.*ready.*current.*main/],
      [['logs', 'pv-http'], /server ready/],
      [['stop', 'pv-http'], /Stopped preview pv-http/],
    ] as [string[], RegExp][]) {
      const result = await run(args); assert.equal(result.code, 0, result.err); assert.match(result.out, expected);
    }
    assert.equal(calls.filter(call => call.endsWith('/tokens')).length, 4);
    assert.ok(calls.includes('POST /internal/mcp/workspaces/authoritative-workspace/previews/pv-http/stop'));
  } finally { await new Promise<void>(resolve => server.close(() => resolve())); }
});
