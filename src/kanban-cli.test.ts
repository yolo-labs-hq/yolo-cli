/**
 * kanban-cli tests.
 *
 * The point of these two verbs is that the bytes are not touched, so most of
 * what is asserted here is an absence: the exported document lands on disk
 * character-for-character, and the imported document leaves as the exact
 * string that was read.
 *
 * Coverage:
 *   - export writes the body unmodified to -o (and reports byte count)
 *   - export with no -o returns the document raw, for piping
 *   - stdout carries only the document (no -o, -o -, -o /dev/stdout); status lines go to stderr
 *   - export to an existing path exits 64 and leaves the file untouched
 *   - export sends the USER token to the /v1 tile-scoped seed route
 *   - export HTTP 404 → http/1
 *   - import posts the exact bytes read from disk
 *   - import summarises the key → cardId map
 *   - import 409 reports the conflicting keys verbatim and exits 1
 *   - import refuses a file that is not JSON, and an unreadable path
 *   - missing YOLO_API_TOKEN → auth/64 with resolveSubstrateContext's message
 *   - --workspace mismatch → 64; --workspace supplies the id when env has none
 *   - arg parsing for both subcommands
 *   - exitCodeForFailure mapping
 */

import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';

import {
  runKanbanExport,
  runKanbanImport,
  parseKanbanExportArgs,
  parseKanbanImportArgs,
  formatImportSummary,
  exitCodeForFailure,
  runKanbanModels,
  parseKanbanModelsArgs,
  formatModels,
  runKanbanCmd,
} from './kanban-cli.js';
import { resolveSubstrateContext } from './auth-context.js';
import type { FetchLike } from './work-client.js';

const STUB_WS = '507f1f77bcf86cd799439011';
const STUB_TILE = 'tile-board-1';
const STUB_BOARD = '507f1f77bcf86cd799439099';

const STUB_ENV = {
  SESSION_ID: 'sess-abc',
  HOME: '/nonexistent-yolo-cli-test-home',
  YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com',
  WORKSPACE_ID: STUB_WS,
};

/**
 * Deliberately awkward on purpose: key order that is not alphabetical, two
 * spaces of indent, a trailing newline, a non-ASCII character. A round trip
 * through JSON.parse/stringify would quietly normalise every one of them.
 */
const SEED_DOCUMENT = [
  '{',
  '  "title": "Kanban orchestration gaps",',
  '  "createdAt": "2026-09-01T00:00:00.000Z",',
  '  "summary": "re-seed — thirteen cards",',
  '  "cards": [',
  '    { "key": "seed-format", "title": "Seed format", "columnId": "ready", "dependsOn": [], "description": "…" }',
  '  ]',
  '}',
  '',
].join('\n');

interface Captured {
  url?: string;
  method?: string;
  body?: string;
  headers?: Record<string, string>;
}

function makeFetchStub(
  respond: (url: string, method: string) => { ok: boolean; status: number; text: string },
  captured: Captured = {},
): FetchLike {
  return async (url, init = {}) => {
    const method = init.method ?? 'GET';
    captured.url = url;
    captured.method = method;
    captured.body = init.body;
    captured.headers = init.headers;
    const r = respond(url, method);
    return {
      ok: r.ok,
      status: r.status,
      json: async () => JSON.parse(r.text),
      text: async () => r.text,
    };
  };
}

function okWith(text: string, status = 200): (url: string, method: string) => { ok: boolean; status: number; text: string } {
  return () => ({ ok: true, status, text });
}

function errorWith(status: number, text: string) {
  return () => ({ ok: false, status, text });
}

// ─── Scratch directory ────────────────────────────────────────────────────

let scratch: string;
before(() => {
  scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-kanban-cli-'));
});
after(() => {
  fs.rmSync(scratch, { recursive: true, force: true });
});

// ─── export ───────────────────────────────────────────────────────────────

describe('kanban export', () => {
  it('writes the response body to -o byte-for-byte', async () => {
    const dest = path.join(scratch, 'export-verbatim.json');
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      outFile: dest,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(fs.readFileSync(dest, 'utf-8'), SEED_DOCUMENT);
    assert.match(result.output, new RegExp(`Wrote ${Buffer.byteLength(SEED_DOCUMENT, 'utf-8')} bytes`));
    assert.equal(result.raw, false);
  });

  it('returns the document raw when no -o is given, so it can be piped', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.equal(result.output, SEED_DOCUMENT);
    assert.equal(result.raw, true);
  });

  it('GETs the tile-scoped seed route on /v1 with the user JWT', async () => {
    const captured: Captured = {};
    await runKanbanExport({
      tileId: STUB_TILE,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT), captured),
    });
    assert.equal(captured.method, 'GET');
    assert.equal(
      captured.url,
      `https://api.example.com/v1/workspaces/${STUB_WS}/kanban/boards/${STUB_TILE}/seed`,
    );
    assert.equal(captured.headers?.Authorization, 'Bearer user-jwt');
    // The USER-token surface: no delegated-token impersonation headers.
    assert.equal(captured.headers?.['X-Internal-Auth'], undefined);
  });

  it('refuses an existing path, leaves the file untouched, and exits 64', async () => {
    const dest = path.join(scratch, 'occupied.json');
    const original = '{"do":"not clobber me"}';
    fs.writeFileSync(dest, original, 'utf-8');

    const result = await runKanbanExport({
      tileId: STUB_TILE,
      outFile: dest,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
    assert.match(result.message, /refusing to overwrite/);
    assert.equal(fs.readFileSync(dest, 'utf-8'), original);
  });

  it('surfaces a write refusal raised by the write itself (wx race) as usage', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      outFile: path.join(scratch, 'raced.json'),
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
      writeFileImpl: () => {
        throw Object.assign(new Error('EEXIST: file already exists'), { code: 'EEXIST' });
      },
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.match(result.message, /refusing to overwrite/);
  });

  it('reports an HTTP failure and maps it to exit 1', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(errorWith(404, '{"error":"Board not found","code":"NOT_FOUND"}')),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.equal(exitCodeForFailure(result.kind), 1);
    assert.match(result.message, /HTTP 404/);
    assert.match(result.message, /Board not found/);
  });

  it('does not write anything when the export fails', async () => {
    const dest = path.join(scratch, 'never-written.json');
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      outFile: dest,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(errorWith(500, '{"error":"Internal server error"}')),
    });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(dest), false);
  });
});

// ─── import ───────────────────────────────────────────────────────────────

describe('kanban import', () => {
  const importOk = JSON.stringify({
    cards: [{ id: 'c1' }],
    keyToCardId: { 'seed-format': '507f1f77bcf86cd7994390aa' },
  });

  it('posts the exact bytes read from disk', async () => {
    const src = path.join(scratch, 'import-verbatim.json');
    fs.writeFileSync(src, SEED_DOCUMENT, 'utf-8');

    const captured: Captured = {};
    const result = await runKanbanImport({
      boardId: STUB_BOARD,
      file: src,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(importOk, 201), captured),
    });
    assert.equal(result.ok, true);
    assert.equal(captured.method, 'POST');
    assert.equal(captured.body, SEED_DOCUMENT);
    assert.equal(
      captured.url,
      `https://api.example.com/v1/workspaces/${STUB_WS}/kanban/boards/${STUB_BOARD}/seed`,
    );
    assert.equal(captured.headers?.['Content-Type'], 'application/json');
    assert.equal(captured.headers?.Authorization, 'Bearer user-jwt');
  });

  it('summarises the created cards and their key → cardId map', async () => {
    const src = path.join(scratch, 'import-summary.json');
    fs.writeFileSync(src, SEED_DOCUMENT, 'utf-8');
    const result = await runKanbanImport({
      boardId: STUB_BOARD,
      file: src,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(importOk, 201)),
    });
    assert.equal(result.ok, true);
    if (!result.ok) return;
    assert.match(result.output, /Imported 1 card into board/);
    assert.match(result.output, /seed-format\s+507f1f77bcf86cd7994390aa/);
  });

  it('reports a 409 with the conflicting keys verbatim and exits 1', async () => {
    const src = path.join(scratch, 'import-conflict.json');
    fs.writeFileSync(src, SEED_DOCUMENT, 'utf-8');
    const conflict = JSON.stringify({
      error:
        'Card key(s) already on this board: seed-format, yolo-cli-verbs. Import is additive and never ' +
        'overwrites — seed into a fresh board. Nothing was created.',
      code: 'CONFLICT',
    });

    const result = await runKanbanImport({
      boardId: STUB_BOARD,
      file: src,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(errorWith(409, conflict)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
    assert.equal(exitCodeForFailure(result.kind), 1);
    assert.match(result.message, /HTTP 409/);
    assert.ok(result.message.includes(conflict), 'the 409 body is passed through unedited');
    assert.match(result.message, /seed-format, yolo-cli-verbs/);
    assert.equal(result.detail?.status, 409);
  });

  it('refuses a file that is not JSON, before the network', async () => {
    const src = path.join(scratch, 'truncated.json');
    fs.writeFileSync(src, '{"title": "half a fil', 'utf-8');
    const result = await runKanbanImport({
      boardId: STUB_BOARD,
      file: src,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(() => {
        throw new Error('the network must not be reached');
      }),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.equal(exitCodeForFailure(result.kind), 64);
    assert.match(result.message, /is not valid JSON/);
  });

  it('reports an unreadable path as usage', async () => {
    const result = await runKanbanImport({
      boardId: STUB_BOARD,
      file: path.join(scratch, 'does-not-exist.json'),
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(importOk, 201)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.match(result.message, /could not read/);
  });

  it('leaves seed-document validation entirely to the server', async () => {
    // A document with a dependsOn naming nothing: the CLI must still send it,
    // because the format has exactly one owner and it is not this module.
    const src = path.join(scratch, 'bad-graph.json');
    const bad = '{"title":"b","createdAt":"x","cards":[{"key":"a","title":"t","columnId":"ready","dependsOn":["nope"],"description":""}]}';
    fs.writeFileSync(src, bad, 'utf-8');
    const captured: Captured = {};
    const result = await runKanbanImport({
      boardId: STUB_BOARD,
      file: src,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(errorWith(400, '{"code":"INVALID_SEED","errors":[]}'), captured),
    });
    assert.equal(captured.body, bad);
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'http');
  });
});

// ─── Auth and workspace resolution ────────────────────────────────────────

describe('kanban-cli — auth and workspace', () => {
  const noToken = { ...STUB_ENV, YOLO_API_TOKEN: undefined };

  it('exits 64 with resolveSubstrateContext\'s own message when the token is missing', async () => {
    const expected = resolveSubstrateContext(noToken);
    assert.equal(expected.ok, false);
    if (expected.ok) return;

    for (const result of [
      await runKanbanExport({ tileId: STUB_TILE, env: noToken, fetchImpl: makeFetchStub(okWith('{}')) }),
      await runKanbanImport({ boardId: STUB_BOARD, file: 'unused.json', env: noToken, fetchImpl: makeFetchStub(okWith('{}')) }),
    ]) {
      assert.equal(result.ok, false);
      if (result.ok) return;
      assert.equal(result.kind, 'auth');
      assert.equal(exitCodeForFailure(result.kind), 64);
      assert.equal(result.message, expected.message);
      assert.match(result.message, /YOLO_API_TOKEN/);
    }
  });

  it('exits 64 when SESSION_ID is missing', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      env: { ...STUB_ENV, SESSION_ID: undefined },
      fetchImpl: makeFetchStub(okWith('{}')),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('rejects a --workspace that disagrees with the session workspace', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      workspaceFlag: 'some-other-workspace',
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'workspace_mismatch');
    assert.equal(exitCodeForFailure(result.kind), 64);
  });

  it('accepts a --workspace that agrees with the session workspace', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      workspaceFlag: STUB_WS,
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
    });
    assert.equal(result.ok, true);
  });

  it('uses --workspace as the id when the session has no WORKSPACE_ID', async () => {
    const captured: Captured = {};
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      workspaceFlag: STUB_WS,
      env: { ...STUB_ENV, WORKSPACE_ID: undefined },
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT), captured),
    });
    assert.equal(result.ok, true);
    assert.match(captured.url ?? '', new RegExp(`/workspaces/${STUB_WS}/kanban/`));
  });

  it('exits 64 when neither WORKSPACE_ID nor --workspace is available', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      env: { ...STUB_ENV, WORKSPACE_ID: undefined },
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
    });
    assert.equal(result.ok, false);
    if (result.ok) return;
    assert.equal(result.kind, 'usage');
    assert.match(result.message, /--workspace/);
  });
});

// ─── Arg parsing ──────────────────────────────────────────────────────────

describe('kanban-cli — arg parsing', () => {
  it('parses export positional + -o + --workspace', () => {
    const parsed = parseKanbanExportArgs([STUB_TILE, '-o', 'board.json', '--workspace', STUB_WS]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.tileId, STUB_TILE);
    assert.equal(parsed.outFile, 'board.json');
    assert.equal(parsed.workspaceFlag, STUB_WS);
  });

  it('parses --out= and --workspace= forms', () => {
    const parsed = parseKanbanExportArgs([STUB_TILE, '--out=board.json', `--workspace=${STUB_WS}`]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.outFile, 'board.json');
    assert.equal(parsed.workspaceFlag, STUB_WS);
  });

  it('requires a tileId for export', () => {
    const parsed = parseKanbanExportArgs(['-o', 'board.json']);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.message, /<tileId> is required/);
  });

  it('rejects an unknown export option and a stray positional', () => {
    assert.equal(parseKanbanExportArgs([STUB_TILE, '--nope']).ok, false);
    assert.equal(parseKanbanExportArgs([STUB_TILE, 'extra']).ok, false);
  });

  it('parses import boardId + file', () => {
    const parsed = parseKanbanImportArgs([STUB_BOARD, 'board.json', '--workspace', STUB_WS]);
    assert.equal(parsed.ok, true);
    if (!parsed.ok) return;
    assert.equal(parsed.boardId, STUB_BOARD);
    assert.equal(parsed.file, 'board.json');
    assert.equal(parsed.workspaceFlag, STUB_WS);
  });

  it('requires both import positionals', () => {
    const parsed = parseKanbanImportArgs([STUB_BOARD]);
    assert.equal(parsed.ok, false);
    if (parsed.ok) return;
    assert.match(parsed.message, /<boardId> and a <file> are required/);
  });
});

// ─── formatImportSummary ──────────────────────────────────────────────────

describe('kanban-cli — formatImportSummary', () => {
  it('pluralises and pads the key column', () => {
    const out = formatImportSummary(
      JSON.stringify({ cards: [1, 2], keyToCardId: { a: 'id-a', 'a-much-longer-key': 'id-b' } }),
      STUB_BOARD,
    );
    assert.match(out, /Imported 2 cards into board/);
    const short = out.split('\n').find((l) => l.includes('id-a')) ?? '';
    const long = out.split('\n').find((l) => l.includes('id-b')) ?? '';
    assert.equal(short.indexOf('id-a'), long.indexOf('id-b'));
  });

  it('degrades to a bare line when the body is not the expected shape', () => {
    assert.match(formatImportSummary('not json', STUB_BOARD), /Imported seed into board/);
  });
});

// ─── exitCodeForFailure ───────────────────────────────────────────────────

describe('kanban-cli — exitCodeForFailure', () => {
  it('maps usage-class to 64 and runtime-class to 1', () => {
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('workspace_mismatch'), 64);
    assert.equal(exitCodeForFailure('http'), 1);
  });
});

// ─── models ───────────────────────────────────────────────────────────────

const MODELS_BODY = JSON.stringify({ models: [
  { id: 'claude:sonnet:high', label: 'sonnet (high)', agent: 'claude', isDefault: false, available: true, readiness: 'unknown', unavailableReason: null },
  { id: 'codex:gpt-6.1-sol:high', label: 'gpt-6.1-sol (high)', agent: 'codex', isDefault: true, available: false, readiness: 'setup-required', unavailableReason: 'No compatible credential' },
] });

describe('kanban models', () => {
  it('GETs the workspace models route on /v1 with the user JWT', async () => {
    const captured: Captured = {};
    const result = await runKanbanModels({ env: STUB_ENV, fetchImpl: makeFetchStub(okWith(MODELS_BODY), captured) });
    assert.equal(result.ok, true);
    assert.equal(captured.method, 'GET');
    assert.equal(captured.url, `https://api.example.com/v1/workspaces/${STUB_WS}/kanban/models`);
    assert.equal(captured.headers?.Authorization, 'Bearer user-jwt');
  });

  it('prints one id per line with its default marker and why it cannot run', () => {
    const lines = formatModels(MODELS_BODY).split('\n');
    assert.equal(lines.length, 2);
    assert.match(lines[0]!, /^claude:sonnet:high\s+available$/);
    assert.match(lines[1]!, /^codex:gpt-6\.1-sol:high\s+default\s+unavailable — No compatible credential$/);
  });

  it('--json returns the body raw', async () => {
    const result = await runKanbanModels({ json: true, env: STUB_ENV, fetchImpl: makeFetchStub(okWith(MODELS_BODY)) });
    assert.equal(result.ok && result.raw && result.output, MODELS_BODY);
  });

  it('surfaces an HTTP failure as kind http', async () => {
    const result = await runKanbanModels({ env: STUB_ENV, fetchImpl: makeFetchStub(errorWith(403, '{"code":"FORBIDDEN"}')) });
    assert.equal(!result.ok && result.kind, 'http');
  });

  it('parses --json and --workspace, and refuses positionals', () => {
    assert.deepEqual(parseKanbanModelsArgs(['--json', '--workspace', 'w1']), { ok: true, json: true, workspaceFlag: 'w1' });
    assert.equal(parseKanbanModelsArgs(['extra']).ok, false);
  });
});

// ─── help ─────────────────────────────────────────────────────────────────

async function captureStreams(fn: () => Promise<number>): Promise<{ code: number; stdout: string; stderr: string }> {
  const out: string[] = [];
  const err: string[] = [];
  const origOut = process.stdout.write.bind(process.stdout);
  const origErr = process.stderr.write.bind(process.stderr);
  process.stdout.write = ((chunk: string) => { out.push(String(chunk)); return true; }) as typeof process.stdout.write;
  process.stderr.write = ((chunk: string) => { err.push(String(chunk)); return true; }) as typeof process.stderr.write;
  try {
    return { code: await fn(), stdout: out.join(''), stderr: err.join('') };
  } finally {
    process.stdout.write = origOut;
    process.stderr.write = origErr;
  }
}

describe('kanban help', () => {
  for (const flag of ['--help', '-h', 'help']) {
    it(`yolo kanban ${flag} prints usage to stdout and exits 0`, async () => {
      const { code, stdout } = await captureStreams(() => runKanbanCmd([flag]));
      assert.equal(code, 0);
      assert.match(stdout, /Usage: yolo kanban <subcommand>/);
      assert.match(stdout, /models/);
    });
  }

  it('yolo kanban export --help prints that subcommand\'s usage and exits 0', async () => {
    const { code, stdout } = await captureStreams(() => runKanbanCmd(['export', '--help']));
    assert.equal(code, 0);
    assert.match(stdout, /Usage: yolo kanban export/);
  });

  it('an unknown subcommand still fails with usage on stderr', async () => {
    const { code, stderr } = await captureStreams(() => runKanbanCmd(['frobnicate']));
    assert.equal(code, 64);
    assert.match(stderr, /unknown kanban subcommand 'frobnicate'/);
    assert.match(stderr, /Usage: yolo kanban <subcommand>/);
  });
});

// ─── stdout stays pure ────────────────────────────────────────────────────

describe('kanban export — stdout carries only the document', () => {
  const deps = () => ({ env: STUB_ENV, fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)) });

  for (const extra of [[], ['-o', '-'], ['--out=-'], ['-o', '/dev/stdout'], ['-o', '/dev/fd/1']]) {
    it(`export ${extra.join(' ') || '(no -o)'} puts exactly the document bytes on stdout`, async () => {
      const { code, stdout, stderr } = await captureStreams(() => runKanbanCmd(['export', STUB_TILE, ...extra], deps()));
      assert.equal(code, 0);
      assert.equal(stdout, SEED_DOCUMENT);
      assert.equal(stderr, '');
    });
  }

  it('export -o <file> writes the file, puts the status line on stderr, and leaves stdout empty', async () => {
    const dest = path.join(scratch, 'export-status-stderr.json');
    const { code, stdout, stderr } = await captureStreams(() => runKanbanCmd(['export', STUB_TILE, '-o', dest], deps()));
    assert.equal(code, 0);
    assert.equal(fs.readFileSync(dest, 'utf-8'), SEED_DOCUMENT);
    assert.equal(stdout, '');
    assert.equal(stderr, `Wrote ${Buffer.byteLength(SEED_DOCUMENT, 'utf-8')} bytes to ${dest}\n`);
  });

  it('runKanbanExport treats -o /dev/stdout as stdout instead of refusing an existing path', async () => {
    const result = await runKanbanExport({
      tileId: STUB_TILE,
      outFile: '/dev/stdout',
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(SEED_DOCUMENT)),
      writeFileImpl: () => { throw new Error('must not write to a path'); },
    });
    assert.equal(result.ok && result.raw && result.output, SEED_DOCUMENT);
  });

  it('import puts its summary on stderr, not stdout', async () => {
    const seedPath = path.join(scratch, 'import-status-stderr.json');
    fs.writeFileSync(seedPath, SEED_DOCUMENT);
    const { code, stdout, stderr } = await captureStreams(() => runKanbanCmd(['import', STUB_BOARD, seedPath], {
      env: STUB_ENV,
      fetchImpl: makeFetchStub(okWith(JSON.stringify({ cards: [{}], keyToCardId: { 'seed-format': 'card-1' } }), 201)),
    }));
    assert.equal(code, 0);
    assert.equal(stdout, '');
    assert.match(stderr, /seed-format/);
  });
});
