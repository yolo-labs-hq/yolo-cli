/**
 * `yolo kanban export` / `yolo kanban import` — move a board seed document
 * between a workspace and a file, with no model in the loop. Plus
 * `yolo kanban models`, the pinnable model ids (`studio.kanban_list_models`
 * from a shell, on the same user-token surface).
 *
 * A board lives in Mongo, scoped to a workspace that can wedge. The seed
 * document (`common-api/src/services/kanban-board-seed.ts`) is the only copy
 * of a card graph that survives the workspace it was built in, and the card
 * descriptions it carries are verbatim dispatch contracts — thousands of
 * bytes of them. Re-emitting those by hand through a chat transcript is how a
 * recovery silently loses a paragraph. These two verbs make the path
 * mechanical: bytes off the wire onto disk, bytes off disk onto the wire.
 *
 * Two properties this module deliberately does NOT have:
 *
 *  - **It does not know the seed format.** The format has exactly one owner,
 *    server-side. `export` writes the response body unmodified; `import`
 *    sends the file unparsed apart from a `JSON.parse` that catches a
 *    truncated file before it becomes an HTTP 400. A serializer here and a
 *    parser there would drift, and the drift would only surface during a
 *    recovery — the worst possible moment.
 *  - **It has no MCP surface and needs no new scope.** These are the
 *    user-token REST routes in `common-api/src/routes/kanban.ts`, which is
 *    what makes them operator-only — the same policy board create/delete
 *    already follow (`vibe-mcp-client.ts`). So this goes through
 *    `userRouteRequest` (the USER-token helper), not `authenticatedRequest`,
 *    and never mints a delegated token.
 *
 * Exit codes (as `artifact-list.ts` documents them):
 *   - 0  = success
 *   - 1  = http (server error, including a 409 key collision)
 *   - 64 = usage (missing env, unreadable file, refusing to overwrite,
 *          `--workspace` mismatch)
 */

import * as fs from 'node:fs';

import { type FetchLike, userRouteRequest } from './work-client.js';
import { resolveSubstrateContext } from './auth-context.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface KanbanExportOptions {
  /** TILE id — the export route keys off the tile, like the board read. */
  tileId: string;
  workspaceFlag?: string;
  /**
   * Destination path. Omitted, `-`, `/dev/stdout` or `/dev/fd/1` → the
   * document goes to stdout for piping.
   */
  outFile?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  /** Injectable for tests. Must refuse to overwrite an existing path. */
  writeFileImpl?: WriteFileImpl;
}

export interface KanbanImportOptions {
  /** BOARD id — what `POST .../boards` hands back, not the tile id. */
  boardId: string;
  /** Path to the seed document. */
  file: string;
  workspaceFlag?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  readFileImpl?: ReadFileImpl;
}

export interface KanbanSuccess {
  ok: true;
  output: string;
  /**
   * True when `output` IS the seed document. The caller writes it byte for
   * byte with no trailing newline — `yolo kanban export <tile> | jq` has to
   * see exactly what the server sent.
   */
  raw: boolean;
  /**
   * True when `output` is a human status line ("Wrote N bytes to …", the
   * import summary) rather than the command's result. It goes to stderr so
   * stdout only ever carries machine output — `-o /dev/stdout | jq` included.
   */
  status?: boolean;
  workspaceId: string;
}

export interface KanbanFailure {
  ok: false;
  kind: 'usage' | 'auth' | 'workspace_mismatch' | 'http';
  message: string;
  detail?: Record<string, unknown>;
}

export type KanbanResult = KanbanSuccess | KanbanFailure;

/** Injectable FS seams so unit tests don't need a scratch directory. */
export type WriteFileImpl = (filePath: string, contents: string) => void;
export type ReadFileImpl = (filePath: string) => string;

// ─── export ───────────────────────────────────────────────────────────────

export async function runKanbanExport(options: KanbanExportOptions): Promise<KanbanResult> {
  const env = options.env ?? process.env;

  if (!options.tileId) return fail('usage', 'a tileId is required');

  const resolved = resolveKanbanContext(env, options.workspaceFlag);
  if (!resolved.ok) return resolved.failure;
  const { commonApiUrl, userToken, workspaceId } = resolved;

  // `-o -` and `-o /dev/stdout` mean stdout. Resolve them here rather than
  // writing to the path: the overwrite guard below would see /dev/stdout as an
  // existing file and refuse, and even if it didn't, the status line would
  // land in the same stream as the document.
  const outFile = options.outFile && !isStdoutTarget(options.outFile) ? options.outFile : undefined;

  // Refuse an occupied destination BEFORE the request, not after. An export
  // is reached for when a workspace is already in trouble; spending the round
  // trip only to discard the one readable copy of the board would be the
  // wrong half of the operation to get right.
  if (outFile && fs.existsSync(outFile)) {
    return fail('usage', `refusing to overwrite existing file '${outFile}'; pick another path or remove it first`);
  }

  const path = `/workspaces/${encodeURIComponent(workspaceId)}/kanban/boards/${encodeURIComponent(options.tileId)}/seed`;
  let response;
  try {
    response = await userRouteRequest({ commonApiUrl, userToken, fetchImpl: options.fetchImpl }, path, {
      method: 'GET',
    });
  } catch (err) {
    return fail('http', `kanban.board.seed.export failed: ${describeError(err)}`);
  }

  const body = await safeReadText(response);
  if (!response.ok) {
    return fail('http', `kanban.board.seed.export failed: HTTP ${response.status} — ${body}`, {
      status: response.status,
    });
  }

  if (!outFile) {
    return { ok: true, output: body, raw: true, workspaceId };
  }

  const write = options.writeFileImpl ?? defaultWriteFileExclusive;
  try {
    write(outFile, body);
  } catch (err) {
    if (isEexist(err)) {
      return fail('usage', `refusing to overwrite existing file '${outFile}'; pick another path or remove it first`);
    }
    return fail('usage', `could not write '${outFile}': ${describeError(err)}`);
  }

  return {
    ok: true,
    output: `Wrote ${Buffer.byteLength(body, 'utf-8')} bytes to ${outFile}`,
    raw: false,
    status: true,
    workspaceId,
  };
}

// ─── import ───────────────────────────────────────────────────────────────

export async function runKanbanImport(options: KanbanImportOptions): Promise<KanbanResult> {
  const env = options.env ?? process.env;

  if (!options.boardId) return fail('usage', 'a boardId is required');
  if (!options.file) return fail('usage', 'a seed document path is required');

  const resolved = resolveKanbanContext(env, options.workspaceFlag);
  if (!resolved.ok) return resolved.failure;
  const { commonApiUrl, userToken, workspaceId } = resolved;

  const read = options.readFileImpl ?? defaultReadFile;
  let contents: string;
  try {
    contents = read(options.file);
  } catch (err) {
    return fail('usage', `could not read '${options.file}': ${describeError(err)}`);
  }

  // The ONLY inspection of the document on this side. It catches a truncated
  // or half-pasted file locally, where the message can name the file. Every
  // other rule about what a seed means — keys, dependsOn, columns, cycles —
  // belongs to the server, which reports all of them at once.
  try {
    JSON.parse(contents);
  } catch (err) {
    return fail('usage', `'${options.file}' is not valid JSON: ${describeError(err)}`);
  }

  const path = `/workspaces/${encodeURIComponent(workspaceId)}/kanban/boards/${encodeURIComponent(options.boardId)}/seed`;
  let response;
  try {
    response = await userRouteRequest({ commonApiUrl, userToken, fetchImpl: options.fetchImpl }, path, {
      method: 'POST',
      // Verbatim: what the server validates is the file on disk, not a
      // re-serialization of it.
      rawBody: contents,
    });
  } catch (err) {
    return fail('http', `kanban.board.seed.import failed: ${describeError(err)}`);
  }

  const body = await safeReadText(response);
  if (!response.ok) {
    // A 409 names every colliding key. Pass the server's words through
    // unedited — an operator paraphrased at this point has to bisect the
    // document by hand to find out which card is already there.
    return fail('http', `kanban.board.seed.import failed: HTTP ${response.status} — ${body}`, {
      status: response.status,
    });
  }

  return {
    ok: true,
    output: formatImportSummary(body, options.boardId),
    raw: false,
    status: true,
    workspaceId,
  };
}

// ─── models ───────────────────────────────────────────────────────────────

export interface KanbanModelsOptions {
  workspaceFlag?: string;
  /** Print the response body as-is instead of the table. */
  json?: boolean;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

interface PinnableModel {
  id: string; agent: string; isDefault: boolean; available: boolean; unavailableReason?: string | null;
}

export async function runKanbanModels(options: KanbanModelsOptions = {}): Promise<KanbanResult> {
  const env = options.env ?? process.env;
  const resolved = resolveKanbanContext(env, options.workspaceFlag);
  if (!resolved.ok) return resolved.failure;
  const { commonApiUrl, userToken, workspaceId } = resolved;

  let response;
  try {
    response = await userRouteRequest({ commonApiUrl, userToken, fetchImpl: options.fetchImpl },
      `/workspaces/${encodeURIComponent(workspaceId)}/kanban/models`, { method: 'GET' });
  } catch (err) {
    return fail('http', `kanban.models.list failed: ${describeError(err)}`);
  }
  const body = await safeReadText(response);
  if (!response.ok) {
    return fail('http', `kanban.models.list failed: HTTP ${response.status} — ${body}`, { status: response.status });
  }
  if (options.json) return { ok: true, output: body, raw: true, workspaceId };
  return { ok: true, output: formatModels(body), raw: false, workspaceId };
}

/** One id per line — the value `model` takes — then whether it can run now and why not. */
export function formatModels(body: string): string {
  let models: PinnableModel[];
  try {
    models = (JSON.parse(body) as { models?: PinnableModel[] }).models ?? [];
  } catch {
    return body;
  }
  if (models.length === 0) return 'No models are discovered for this workspace right now.';
  const idCol = Math.max(...models.map((m) => m.id.length));
  return models.map((m) => {
    const state = m.available ? 'available' : `unavailable${m.unavailableReason ? ` — ${m.unavailableReason}` : ''}`;
    return `${m.id.padEnd(idCol)}  ${m.isDefault ? 'default  ' : '         '}${state}`;
  }).join('\n');
}

/**
 * `key → cardId`, one per line, under a count. That map is what a caller
 * needs to say anything at all about the board it just rebuilt, and it is
 * the only part of the response worth reading by eye.
 */
export function formatImportSummary(body: string, boardId: string): string {
  let parsed: { cards?: unknown[]; keyToCardId?: Record<string, string> } | undefined;
  try {
    parsed = JSON.parse(body) as { cards?: unknown[]; keyToCardId?: Record<string, string> };
  } catch {
    return `Imported seed into board ${boardId}`;
  }
  const keyToCardId = parsed?.keyToCardId ?? {};
  const keys = Object.keys(keyToCardId);
  const count = Array.isArray(parsed?.cards) ? parsed.cards.length : keys.length;
  const lines = [`Imported ${count} card${count === 1 ? '' : 's'} into board ${boardId}`];
  if (keys.length > 0) {
    const keyCol = Math.max(...keys.map((k) => k.length));
    for (const key of keys) lines.push(`  ${key.padEnd(keyCol)}  ${keyToCardId[key]}`);
  }
  return lines.join('\n');
}

// ─── Shared resolution ────────────────────────────────────────────────────

type ResolvedContext =
  | { ok: true; commonApiUrl: string; userToken: string; workspaceId: string }
  | { ok: false; failure: KanbanFailure };

/**
 * Auth first, so a missing token reports the message `resolveSubstrateContext`
 * already writes (which names both places a token can live) rather than a
 * workspace complaint that would send an operator looking in the wrong place.
 */
export function resolveKanbanContext(
  env: Record<string, string | undefined>,
  workspaceFlag?: string,
): ResolvedContext {
  const auth = resolveSubstrateContext(env);
  if (!auth.ok) return { ok: false, failure: fail('auth', auth.message) };
  const { commonApiUrl, userToken } = auth.context;

  const sessionWorkspace = env.WORKSPACE_ID?.trim() || undefined;
  if (workspaceFlag && sessionWorkspace && workspaceFlag !== sessionWorkspace) {
    return {
      ok: false,
      failure: fail(
        'workspace_mismatch',
        `--workspace ${workspaceFlag} does not match the workspace bound to this session (${sessionWorkspace}).`,
      ),
    };
  }
  const workspaceId = workspaceFlag ?? sessionWorkspace;
  if (!workspaceId) {
    return {
      ok: false,
      failure: fail('usage', 'no workspace: WORKSPACE_ID is unset in this session — pass --workspace <workspaceId>'),
    };
  }
  return { ok: true, commonApiUrl, userToken, workspaceId };
}

// ─── CLI surface ──────────────────────────────────────────────────────────

const EXPORT_USAGE = [
  'Usage: yolo kanban export <tileId> [-o <file>|-] [--workspace <wsId>]',
  '',
  '  -o <file>   Write the document to <file> (refuses to overwrite); the status line goes to stderr.',
  '  -o -        Write the document to stdout (the default). /dev/stdout works the same.',
  '',
].join('\n');
const IMPORT_USAGE = 'Usage: yolo kanban import <boardId> <file> [--workspace <wsId>]\n';
const MODELS_USAGE = 'Usage: yolo kanban models [--json] [--workspace <wsId>]\n';
const KANBAN_USAGE = [
  'Usage: yolo kanban <subcommand>',
  '',
  'Subcommands:',
  '  export <tileId> [-o <file>|-] Write a board\'s seed document to a file or stdout',
  '  import <boardId> <file>       Create cards on a board from a seed document',
  '  models [--json]               List the model ids a card can be pinned to',
  '',
  'Every subcommand takes --workspace <wsId> (defaults to this session\'s workspace).',
  '',
].join('\n');

const isHelp = (a: string | undefined) => a === '--help' || a === '-h' || a === 'help';

export interface ParsedExportArgs { ok: true; tileId: string; outFile?: string; workspaceFlag?: string }
export interface ParsedImportArgs { ok: true; boardId: string; file: string; workspaceFlag?: string }
export interface ParsedModelsArgs { ok: true; json: boolean; workspaceFlag?: string }
export interface ParseError { ok: false; message: string }

export function parseKanbanModelsArgs(args: string[]): ParsedModelsArgs | ParseError {
  let json = false;
  let workspaceFlag: string | undefined;
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--json') {
      json = true;
    } else if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      const v = a.slice('--workspace='.length);
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('-')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }
  return { ok: true, json, workspaceFlag };
}

export function parseKanbanExportArgs(args: string[]): ParsedExportArgs | ParseError {
  let tileId: string | undefined;
  let outFile: string | undefined;
  let workspaceFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace' || a === '-o' || a === '--out') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: `${a} requires a value` };
      if (a === '--workspace') workspaceFlag = v;
      else outFile = v;
    } else if (a.startsWith('--workspace=')) {
      const v = a.slice('--workspace='.length);
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--out=')) {
      const v = a.slice('--out='.length);
      if (!v) return { ok: false, message: '--out requires a value' };
      outFile = v;
    } else if (a.startsWith('-')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else if (tileId === undefined) {
      tileId = a;
    } else {
      return { ok: false, message: `unexpected positional argument: ${a}` };
    }
  }

  if (!tileId) return { ok: false, message: 'a <tileId> is required' };
  return { ok: true, tileId, outFile, workspaceFlag };
}

export function parseKanbanImportArgs(args: string[]): ParsedImportArgs | ParseError {
  const positional: string[] = [];
  let workspaceFlag: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a === '--workspace') {
      const v = args[++i];
      if (!v || v.startsWith('--')) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('--workspace=')) {
      const v = a.slice('--workspace='.length);
      if (!v) return { ok: false, message: '--workspace requires a value' };
      workspaceFlag = v;
    } else if (a.startsWith('-')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      positional.push(a);
    }
  }

  if (positional.length < 2) return { ok: false, message: 'a <boardId> and a <file> are required' };
  if (positional.length > 2) return { ok: false, message: `unexpected positional argument: ${positional[2]}` };
  return { ok: true, boardId: positional[0]!, file: positional[1]!, workspaceFlag };
}

/** Injectable for tests; production uses the real env and fetch. */
export interface KanbanCmdDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

/** `args` is everything after `kanban`. */
export async function runKanbanCmd(args: string[], deps: KanbanCmdDeps = {}): Promise<number> {
  const sub = args[0];

  if (isHelp(sub)) {
    process.stdout.write(KANBAN_USAGE);
    return 0;
  }
  // `yolo kanban <sub> --help` prints that subcommand's usage rather than failing its parse.
  const subUsage = sub === 'export' ? EXPORT_USAGE : sub === 'import' ? IMPORT_USAGE : sub === 'models' ? MODELS_USAGE : null;
  if (subUsage && args.slice(1).some((a) => a === '--help' || a === '-h')) {
    process.stdout.write(subUsage);
    return 0;
  }

  if (sub === 'models') {
    const parsed = parseKanbanModelsArgs(args.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`yolo: kanban models: ${parsed.message}\n`);
      process.stderr.write(MODELS_USAGE);
      return 64;
    }
    return report(await runKanbanModels({ json: parsed.json, workspaceFlag: parsed.workspaceFlag, ...deps }));
  }

  if (sub === 'export') {
    const parsed = parseKanbanExportArgs(args.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`yolo: kanban export: ${parsed.message}\n`);
      process.stderr.write(EXPORT_USAGE);
      return 64;
    }
    return report(await runKanbanExport({
      tileId: parsed.tileId,
      outFile: parsed.outFile,
      workspaceFlag: parsed.workspaceFlag,
      ...deps,
    }));
  }

  if (sub === 'import') {
    const parsed = parseKanbanImportArgs(args.slice(1));
    if (!parsed.ok) {
      process.stderr.write(`yolo: kanban import: ${parsed.message}\n`);
      process.stderr.write(IMPORT_USAGE);
      return 64;
    }
    return report(await runKanbanImport({
      boardId: parsed.boardId,
      file: parsed.file,
      workspaceFlag: parsed.workspaceFlag,
      ...deps,
    }));
  }

  process.stderr.write(sub ? `yolo: unknown kanban subcommand '${sub}'\n` : 'yolo: kanban requires a subcommand\n');
  process.stderr.write(KANBAN_USAGE);
  return 64;
}

function report(result: KanbanResult): number {
  if (result.ok) {
    // `raw` output is the document: no trailing newline, so a redirect or a
    // pipe gets the same bytes `-o` would have written. A status line is for
    // the human, so it stays out of stdout.
    if (result.status) process.stderr.write(`${result.output}\n`);
    else process.stdout.write(result.raw ? result.output : `${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function fail(kind: KanbanFailure['kind'], message: string, detail?: Record<string, unknown>): KanbanFailure {
  return { ok: false, kind, message, detail };
}

function describeError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

async function safeReadText(response: { text(): Promise<string> }): Promise<string> {
  try { return await response.text(); } catch { return '<no body>'; }
}

/** Destinations that mean "the document goes to stdout", not a file. */
function isStdoutTarget(filePath: string): boolean {
  return filePath === '-' || filePath === '/dev/stdout' || filePath === '/dev/fd/1';
}

function isEexist(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: unknown }).code === 'EEXIST';
}

/** `wx` so the refusal is the filesystem's, not a check racing the write. */
function defaultWriteFileExclusive(filePath: string, contents: string): void {
  fs.writeFileSync(filePath, contents, { encoding: 'utf-8', flag: 'wx' });
}

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}

export function exitCodeForFailure(kind: KanbanFailure['kind']): number {
  switch (kind) {
    case 'usage':
    case 'auth':
    case 'workspace_mismatch':
      return 64;
    case 'http':
      return 1;
  }
}
