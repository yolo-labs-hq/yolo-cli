/**
 * `yolo tileapp validate|dev` — the LOCAL developer harness (M1 slice 6).
 *
 *   yolo tileapp validate <manifest.json> [--bundle-dir <dir>]
 *     → Offline lint: manifest schema (mirrors the server's validateManifest)
 *       + bundle layout (a pure-UI app's `surface.entry` must exist on disk).
 *       Exit 0 clean, 65 on validation errors, 64 usage, 66 I/O. Prints every
 *       error at once — the same taxonomy `POST /v1/publisher/publish` enforces.
 *
 *   yolo tileapp dev <manifest.json> [--port N] [--host H] [--bundle-dir <dir>] [--deny]
 *     → Validate, then serve the bundle on a local HTTP server with a MOCK
 *       broker at `/__yolo/broker` (POST) so a partner can run + click through
 *       their app offline, without production review or a session pod. Allow-all
 *       by default; `--deny` makes the mock broker deny every request (to test
 *       the app's graceful-degradation path). Long-running until killed.
 *
 * Offline + auth-free by design (unlike sign/publish): a partner iterates here
 * with no token, no SESSION_ID, no network.
 */

import * as fs from 'node:fs';
import * as path from 'node:path';
import * as http from 'node:http';
import { createServeHandler } from './serve.js';
import { validateManifest, isRuntimeManifest, publishGateErrors } from './tileapp-validator.js';

/** The mock-broker + helper routes the dev server mounts (under a reserved
 *  prefix so they can't collide with a real bundle asset path). */
export const DEV_BROKER_PATH = '/__yolo/broker';
export const DEV_MANIFEST_PATH = '/__yolo/manifest';

export type DevResult =
  | { ok: true; output: string }
  | { ok: false; kind: 'usage' | 'io' | 'validation'; message: string };

/** Map a failure kind to a process exit code. */
export function devExitCode(kind: 'usage' | 'io' | 'validation'): number {
  if (kind === 'usage') return 64; // EX_USAGE
  if (kind === 'io') return 66; // EX_NOINPUT
  return 65; // EX_DATAERR (validation)
}

function readManifestFile(p: string): { ok: true; manifest: Record<string, unknown> } | { ok: false; message: string } {
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch (e) { return { ok: false, message: `cannot read manifest '${p}': ${(e as Error).message}` }; }
  try { return { ok: true, manifest: JSON.parse(raw) as Record<string, unknown> }; }
  catch (e) { return { ok: false, message: `manifest '${p}' is not valid JSON: ${(e as Error).message}` }; }
}

/**
 * Resolve the static-bundle directory for a pure-UI manifest. Tries, in order:
 * an explicit `--bundle-dir`, `<manifestDir>/bundles/<id>` (the registry layout),
 * then `<manifestDir>` (a flat project where index.html sits beside the
 * manifest). Returns the first that EXISTS and contains `surface.entry`.
 */
export function resolveBundleDir(
  manifestPath: string,
  manifest: Record<string, unknown>,
  override?: string,
): { ok: true; dir: string } | { ok: false; message: string; candidates: string[] } {
  const manifestDir = path.dirname(path.resolve(manifestPath));
  const id = typeof manifest.id === 'string' ? manifest.id : '';
  const entry = (manifest.surface as { entry?: string } | undefined)?.entry || 'index.html';
  // An EXPLICIT --bundle-dir is authoritative: it's the ONLY candidate, so a
  // missing entry there fails loudly rather than silently validating/serving a
  // stale fallback bundle. Only auto-discover when no override is given.
  const candidates = override
    ? [path.resolve(override)]
    : [
        id ? path.join(manifestDir, 'bundles', id) : null,
        manifestDir,
      ].filter((c): c is string => !!c);
  for (const dir of candidates) {
    try {
      const root = path.resolve(dir);
      if (!fs.statSync(root).isDirectory()) continue;
      // The entry must stay WITHIN the bundle root — production's bundle route
      // rejects `..`-escaping paths with 403, so an entry like `../index.html`
      // that resolves outside must not pass here.
      const entryAbs = path.resolve(root, entry);
      if (entryAbs !== root && !entryAbs.startsWith(root + path.sep)) continue;
      // …and it must be a FILE (production 404s a directory entry).
      if (fs.statSync(entryAbs).isFile()) return { ok: true, dir };
    } catch { /* try next */ }
  }
  return {
    ok: false,
    candidates,
    message: `could not find bundle entry '${entry}' in any of: ${candidates.join(', ')}`,
  };
}

/**
 * The mock broker's reply to a dev-time capability request. Returns the SAME
 * shape + HTTP status the production broker does (`BrokerResult`:
 * `{ ok: true, payload }` on allow; `{ ok: false, reason, message }` with a 4xx
 * on deny) so an app written against the mock behaves identically against the
 * real host bridge — including the deny/error path. Allow echoes the request as
 * the payload; deny uses `permission-not-granted` (→ 403), matching the real
 * broker's deny-reason → status mapping.
 */
export function mockBrokerResponse(
  body: unknown,
  opts: { allow: boolean },
): { httpStatus: number; result: { ok: true; payload: unknown } | { ok: false; reason: string; message: string } } {
  if (opts.allow) {
    return { httpStatus: 200, result: { ok: true, payload: { echo: body ?? null } } };
  }
  return { httpStatus: 403, result: { ok: false, reason: 'permission-not-granted', message: 'dev-mock: deny-all (--deny)' } };
}

// ── validate ─────────────────────────────────────────────────────────────────

export interface ValidateOptions { manifestPath: string; bundleDir?: string }

export function runTileAppValidate(opts: ValidateOptions): DevResult {
  const read = readManifestFile(opts.manifestPath);
  if (!read.ok) return { ok: false, kind: 'io', message: read.message };

  const v = validateManifest(read.manifest);
  const errors = [...v.errors, ...publishGateErrors(read.manifest)];

  // A non-object manifest is fully reported by validateManifest; bail before the
  // bundle/runtime checks (which deref manifest fields) so we never crash on it.
  const manifestIsObject = typeof read.manifest === 'object' && read.manifest !== null && !Array.isArray(read.manifest);
  if (!manifestIsObject) {
    return { ok: false, kind: 'validation', message: `manifest invalid:\n  - ${errors.join('\n  - ')}` };
  }

  // Bundle layout: a PURE-UI app must ship its `surface.entry` on disk. A
  // runtime/image app's surface comes from its container, so skip the disk check.
  let bundleNote = '';
  if (!isRuntimeManifest(read.manifest)) {
    const resolved = resolveBundleDir(opts.manifestPath, read.manifest, opts.bundleDir);
    if (!resolved.ok) errors.push(`bundle: ${resolved.message}`);
    else bundleNote = `\n  bundle: ${resolved.dir}`;
  } else {
    bundleNote = '\n  runtime app — surface served from its container image (no local bundle checked)';
  }

  if (errors.length > 0) {
    return { ok: false, kind: 'validation', message: `manifest invalid (${errors.length} issue${errors.length === 1 ? '' : 's'}):\n  - ${errors.join('\n  - ')}` };
  }
  const id = String(read.manifest.id);
  const version = String(read.manifest.version);
  return {
    ok: true,
    output: `OK: ${id}@${version} is valid.${bundleNote}\n  note: mcp-scope + secret-key NAMES are confirmed server-side at publish.`,
  };
}

// ── dev (local serve + mock broker) ───────────────────────────────────────────

export interface DevServeOptions {
  manifestPath: string;
  port: number;
  host: string;
  bundleDir?: string;
  allow: boolean; // mock broker: allow-all (default) vs deny-all
}

/**
 * Build the dev HTTP handler: the mock-broker + manifest helper routes, with
 * everything else delegated to the static bundle server. Exported for tests.
 */
export function createDevHandler(opts: { dir: string; manifest: Record<string, unknown>; allow: boolean }): http.RequestListener {
  const staticHandler = createServeHandler({ dir: opts.dir, port: 0, host: '', spa: false, noCache: true });
  return (req, res) => {
    const url = (req.url ?? '/').split('?')[0];
    if (url === DEV_MANIFEST_PATH) {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
      res.end(JSON.stringify(opts.manifest));
      return;
    }
    if (url === DEV_BROKER_PATH) {
      if (req.method !== 'POST') {
        res.writeHead(405, { 'Content-Type': 'application/json; charset=utf-8', Allow: 'POST' });
        res.end(JSON.stringify({ error: 'mock broker accepts POST only' }));
        return;
      }
      const chunks: Buffer[] = [];
      req.on('data', (c) => chunks.push(c as Buffer));
      req.on('end', () => {
        let parsed: unknown = null;
        try { parsed = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf-8')) : null; }
        catch { res.writeHead(400, { 'Content-Type': 'application/json; charset=utf-8' }); res.end(JSON.stringify({ ok: false, reason: 'invalid-args', message: 'invalid JSON body' })); return; }
        const { httpStatus, result } = mockBrokerResponse(parsed, { allow: opts.allow });
        res.writeHead(httpStatus, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
        res.end(JSON.stringify(result));
      });
      return;
    }
    staticHandler(req, res);
  };
}

export async function runTileAppDev(opts: DevServeOptions): Promise<number> {
  const read = readManifestFile(opts.manifestPath);
  if (!read.ok) { process.stderr.write(`FAIL [io]: ${read.message}\n`); return devExitCode('io'); }

  // Block on schema AND publish-gate errors before serving — `dev` claims to
  // validate before serving, so it must reject anything publish would (e.g. an
  // image-only manifest missing its pinned digest).
  const gateErrors = [...validateManifest(read.manifest).errors, ...publishGateErrors(read.manifest)];
  if (gateErrors.length) {
    process.stderr.write(`FAIL [validation]: manifest invalid:\n  - ${gateErrors.join('\n  - ')}\n`);
    return devExitCode('validation');
  }
  if (isRuntimeManifest(read.manifest)) {
    process.stderr.write('FAIL [validation]: `yolo tileapp dev` serves a static (pure-UI) bundle; this manifest declares a runtime/image app — run your container locally and preview it yourself.\n');
    return devExitCode('validation');
  }
  const resolved = resolveBundleDir(opts.manifestPath, read.manifest, opts.bundleDir);
  if (!resolved.ok) { process.stderr.write(`FAIL [io]: ${resolved.message}\n`); return devExitCode('io'); }

  const handler = createDevHandler({ dir: resolved.dir, manifest: read.manifest, allow: opts.allow });
  const server = http.createServer(handler);
  return new Promise<number>((resolve) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      process.stderr.write(`yolo tileapp dev: ${err.code === 'EADDRINUSE' ? `port ${opts.port} is already in use` : err.message}\n`);
      resolve(70); // EX_SOFTWARE
    });
    server.listen(opts.port, opts.host, () => {
      const entry = (read.manifest.surface as { entry?: string }).entry || 'index.html';
      process.stdout.write(`yolo tileapp dev: serving ${String(read.manifest.id)} from ${resolved.dir}\n`);
      process.stdout.write(`  open    http://${opts.host}:${opts.port}/${entry}\n`);
      process.stdout.write(`  broker  POST http://${opts.host}:${opts.port}${DEV_BROKER_PATH}  (mock: ${opts.allow ? 'allow-all' : 'deny-all'})\n`);
      // Long-running — never resolve; the process runs until killed.
    });
  });
}
