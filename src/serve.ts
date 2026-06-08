/**
 * `yolo serve <dir>` — a minimal, dependency-free static file server.
 *
 * Purpose (BAKE_OFF / decision-preview Gap 2a): a `mode:workstream`
 * candidate that produces a STATIC site (index.html + assets, no dev
 * server) has nothing to preview. The substrate auto-spawns a preview tile
 * whose command is `yolo serve <lane-worktree> --port $PORT` so the operator
 * can SEE each bake-off variant before picking a winner — without the agent
 * having to ship a server or an operator hand-rolling `python3 -m http.server`.
 *
 * Deliberately built on Node's stdlib only (http/fs/path) so it has zero
 * install cost and starts instantly in any sandbox. Long-running: it binds
 * the port and runs until the process is killed (the preview-manager owns
 * the lifecycle), so the command never "completes".
 *
 * Usage:
 *   yolo serve <dir> [--port N] [--host H] [--spa] [--no-cache]
 *     <dir>        directory to serve (required)
 *     --port N     port (default: $PORT, else 3000)
 *     --host H     bind host (default: 0.0.0.0 — reachable by preview-manager)
 *     --spa        serve index.html for unmatched routes (single-page apps)
 *     --no-cache   send no-store (default; previews should always be fresh)
 */
import * as http from 'http';
import * as fs from 'fs';
import * as path from 'path';

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.map': 'application/json; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.wasm': 'application/wasm',
  '.mp4': 'video/mp4',
  '.webm': 'video/webm',
  '.mp3': 'audio/mpeg',
};

export interface ServeOptions {
  dir: string;
  port: number;
  host: string;
  spa: boolean;
  noCache: boolean;
}

/** Parse `yolo serve` args. Exported for tests. Returns the options or a
 *  usage error string. */
export function parseServeArgs(args: string[]): { ok: true; opts: ServeOptions } | { ok: false; error: string } {
  let dir: string | undefined;
  let port: number | undefined;
  let host = '0.0.0.0';
  let spa = false;
  let noCache = true;
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === '--port' || a === '-p') {
      const v = args[++i];
      const n = Number(v);
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: `invalid --port '${v}'` };
      port = n;
    } else if (a.startsWith('--port=')) {
      const n = Number(a.slice('--port='.length));
      if (!Number.isInteger(n) || n < 1 || n > 65535) return { ok: false, error: `invalid --port` };
      port = n;
    } else if (a === '--host') {
      host = args[++i] ?? host;
    } else if (a.startsWith('--host=')) {
      host = a.slice('--host='.length);
    } else if (a === '--spa') {
      spa = true;
    } else if (a === '--cache') {
      noCache = false;
    } else if (a === '--no-cache') {
      noCache = true;
    } else if (a.startsWith('-')) {
      return { ok: false, error: `unknown flag '${a}'` };
    } else if (dir === undefined) {
      dir = a;
    } else {
      return { ok: false, error: `unexpected argument '${a}'` };
    }
  }
  if (!dir) return { ok: false, error: 'serve requires a <dir> argument' };
  // $PORT (preview-manager injects it) is the fallback before the 3000 default.
  if (port === undefined) {
    const envPort = Number(process.env.PORT);
    port = Number.isInteger(envPort) && envPort >= 1 && envPort <= 65535 ? envPort : 3000;
  }
  return { ok: true, opts: { dir: path.resolve(dir), port, host, spa, noCache } };
}

/** Resolve a request URL path to an on-disk file path, GUARDING against
 *  traversal outside `root`. Returns null when the resolved path escapes
 *  root. Exported for tests. */
export function resolveRequestPath(root: string, urlPath: string): string | null {
  // Strip query/hash, decode, normalize.
  let p = urlPath.split('?')[0].split('#')[0];
  try {
    p = decodeURIComponent(p);
  } catch {
    return null; // malformed percent-encoding
  }
  // A decoded NUL byte (e.g. `/%00`) passes decodeURIComponent but makes the
  // downstream fs.* calls THROW SYNCHRONOUSLY (ERR_INVALID_ARG_VALUE),
  // crashing the server instead of returning a 4xx. Reject it here.
  if (p.includes('\0')) return null;
  // Join + normalize, then confirm the result is still within root.
  const resolved = path.resolve(root, '.' + (p.startsWith('/') ? p : '/' + p));
  if (resolved !== root && !resolved.startsWith(root + path.sep)) return null;
  return resolved;
}

export function createServeHandler(opts: ServeOptions): http.RequestListener {
  // The real (symlink-resolved) served root, computed once. Per-request
  // realpath checks confirm targets stay within THIS. Falls back to the
  // lexical dir if the root itself can't be realpath'd (shouldn't happen —
  // runServeCmd verified it's a directory first).
  let realRoot = opts.dir;
  try {
    realRoot = fs.realpathSync(opts.dir);
  } catch {
    /* keep lexical opts.dir */
  }
  return (req, res) => {
    const send = (status: number, body: string | Buffer, contentType: string) => {
      res.writeHead(status, {
        'Content-Type': contentType,
        ...(opts.noCache ? { 'Cache-Control': 'no-store, max-age=0' } : {}),
      });
      res.end(body);
    };

    const resolved = resolveRequestPath(opts.dir, req.url ?? '/');
    if (resolved === null) {
      send(400, 'Bad Request', 'text/plain; charset=utf-8');
      return;
    }

    const serveFile = (filePath: string) => {
      // Resolve symlinks and RE-CHECK containment: the lexical guard in
      // resolveRequestPath can't catch a symlink INSIDE root that points
      // outside it. realpath the target and confirm its real path is still
      // within realRoot before reading — blocks symlink escapes while still
      // allowing symlinks that stay inside the served tree.
      fs.realpath(filePath, (rpErr, realPath) => {
        if (rpErr) {
          // Missing / broken-symlink → SPA fallback to root index.html, else 404.
          if (opts.spa) {
            const indexPath = path.join(opts.dir, 'index.html');
            if (filePath !== indexPath) {
              serveFile(indexPath);
              return;
            }
          }
          send(404, 'Not Found', 'text/plain; charset=utf-8');
          return;
        }
        if (realPath !== realRoot && !realPath.startsWith(realRoot + path.sep)) {
          send(403, 'Forbidden', 'text/plain; charset=utf-8'); // symlink escaped root
          return;
        }
        fs.readFile(realPath, (err, data) => {
          if (err) {
            send(404, 'Not Found', 'text/plain; charset=utf-8');
            return;
          }
          send(200, data, MIME[path.extname(realPath).toLowerCase()] ?? 'application/octet-stream');
        });
      });
    };

    fs.stat(resolved, (err, stat) => {
      if (err) {
        serveFile(resolved); // delegate to serveFile's 404 / SPA handling
        return;
      }
      // Directory → its index.html.
      if (stat.isDirectory()) {
        serveFile(path.join(resolved, 'index.html'));
        return;
      }
      serveFile(resolved);
    });
  };
}

/** Start the static server. Resolves only on a fatal listen error;
 *  otherwise runs until the process is killed (long-running). */
export async function runServeCmd(args: string[]): Promise<number> {
  const parsed = parseServeArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo serve: ${parsed.error}\n`);
    process.stderr.write('Usage: yolo serve <dir> [--port N] [--host H] [--spa] [--no-cache]\n');
    return 64; // EX_USAGE
  }
  const { opts } = parsed;
  if (!fs.existsSync(opts.dir) || !fs.statSync(opts.dir).isDirectory()) {
    process.stderr.write(`yolo serve: not a directory: ${opts.dir}\n`);
    return 66; // EX_NOINPUT
  }
  const server = http.createServer(createServeHandler(opts));
  return new Promise<number>((resolve) => {
    server.on('error', (err: NodeJS.ErrnoException) => {
      process.stderr.write(`yolo serve: ${err.code === 'EADDRINUSE' ? `port ${opts.port} is already in use` : err.message}\n`);
      resolve(70); // EX_SOFTWARE
    });
    server.listen(opts.port, opts.host, () => {
      process.stdout.write(`yolo serve: serving ${opts.dir} on http://${opts.host}:${opts.port}\n`);
      // Intentionally never resolve — the server runs until killed.
    });
  });
}
