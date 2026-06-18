/**
 * skopeo-based OCI image assembler — a container-engine-free builder for
 * RUN-less ("COPY-only") Dockerfiles (PERSONAL_TILE_APPS_PLAN §7.1 #2).
 *
 * Rootless `podman build` is non-functional in the session pod (Kata blocks
 * newuidmap uid_map writes; /dev/fuse is absent), so the normal runtime publish
 * path can't build. But the vast majority of personal runtime apps are just
 * `FROM <base>` + `COPY <app files>` + `CMD …` — which needs no build engine at
 * all: we can PULL the base with skopeo (pure blob copy — no namespaces, no
 * fuse), append ONE filesystem layer containing the COPY'd files, patch the
 * image config (Cmd/Entrypoint/WorkingDir/ExposedPorts/Env/User), and EXPORT an
 * oci-archive — byte-compatible with what `podman save --format oci-archive`
 * produces, so the rest of the publish path (mediated push) is unchanged.
 *
 * Supported Dockerfile subset: a single `FROM`, `COPY`/`ADD` (local files only),
 * `CMD`, `ENTRYPOINT`, `WORKDIR`, `EXPOSE`, `ENV`, `USER`. Anything that needs to
 * EXECUTE in the image — `RUN`, multi-stage (`FROM … AS` / `COPY --from=`),
 * `ADD <url>`, glob sources — is rejected as not-assemblable (the caller falls
 * back to podman for those).
 *
 * Layers are written UNCOMPRESSED (mediaType …layer.v1.tar) so the layer digest
 * and its diffID are identical — no gzip bookkeeping. All blob/config/manifest
 * digests are computed from the exact bytes written, so skopeo's copy-time
 * digest validation passes.
 *
 * KNOWN LIMITATIONS (inherent to assembling without the base image's filesystem;
 * the common personal-app case — base + COPY app files + CMD/ENV/EXPOSE — is
 * exact, and anything that needs a real build is rejected as not-assemblable so
 * it never silently produces a wrong image):
 *   - COPY of a SINGLE file to an existing base-image directory WITHOUT a
 *     trailing slash (e.g. `COPY index.html /usr/share/nginx/html`) lands the
 *     file AT that path rather than inside the dir — we can't see the base FS to
 *     know it's a directory. Workaround = the Docker best practice: write a
 *     trailing slash (`…/html/`) or a WORKDIR; both are honored.
 *   - Cosmetic config directives that don't affect the running surface — LABEL,
 *     VOLUME, HEALTHCHECK, STOPSIGNAL — are dropped (not applied to the config).
 *   - Symlinks INSIDE a copied directory are skipped (not preserved as links).
 */

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

export type ExecLike = (file: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;

/** Normalize a POSIX path (collapse `.`/`..`/`//`), preserving absoluteness. */
function posixNormalize(p: string): string {
  const isAbs = p.startsWith('/');
  const parts: string[] = [];
  for (const seg of p.split('/')) {
    if (seg === '' || seg === '.') continue;
    if (seg === '..') { if (parts.length && parts[parts.length - 1] !== '..') parts.pop(); else if (!isAbs) parts.push('..'); }
    else parts.push(seg);
  }
  return (isAbs ? '/' : '') + parts.join('/');
}

export interface ParsedDockerfile {
  from: string | null;
  /** `dest` is the ABSOLUTE in-image path (relative COPY dests are resolved
   *  against the WORKDIR active at that COPY); `destIsDir` records whether the
   *  author wrote it as a directory target (trailing slash, `.`, or `/`). */
  copies: { src: string; dest: string; destIsDir: boolean; mode?: number }[];
  cmd: string[] | null;
  entrypoint: string[] | null;
  workdir: string | null;
  user: string | null;
  /** Normalized `port/proto` tokens (e.g. `8080/tcp`, `8125/udp`). */
  exposes: string[];
  env: { k: string; v: string }[];
  /** True when this Dockerfile can be assembled without a container engine. */
  assemblable: boolean;
  /** Human-readable reasons it's NOT assemblable (empty when assemblable). */
  unsupported: string[];
}

/** Split a token list (ws-separated) honoring nothing fancy — Dockerfiles here are simple. */
function tokenize(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

/** Parse a CMD/ENTRYPOINT value: JSON-array (exec) form, else shell form. */
function parseExecOrShell(rest: string): string[] {
  const t = rest.trim();
  if (t.startsWith('[')) {
    try {
      const arr = JSON.parse(t);
      if (Array.isArray(arr) && arr.every((x) => typeof x === 'string')) return arr;
    } catch { /* fall through to shell form */ }
  }
  // Shell form → run via /bin/sh -c (matches Docker semantics).
  return ['/bin/sh', '-c', t];
}

export function parseDockerfile(text: string): ParsedDockerfile {
  const out: ParsedDockerfile = {
    from: null, copies: [], cmd: null, entrypoint: null, workdir: null,
    user: null, exposes: [], env: [], assemblable: false, unsupported: [],
  };

  // Join continuation lines (trailing backslash) into logical lines.
  const logical: string[] = [];
  let buf = '';
  for (const raw of text.split('\n')) {
    const line = raw.replace(/\r$/, '');
    const trimmedStart = line.trimStart();
    if (buf === '' && (trimmedStart === '' || trimmedStart.startsWith('#'))) continue; // blank / comment
    if (/\\\s*$/.test(line)) { buf += line.replace(/\\\s*$/, '') + ' '; continue; }
    buf += line;
    logical.push(buf.trim());
    buf = '';
  }
  if (buf.trim()) logical.push(buf.trim());

  let fromCount = 0;
  let currentWorkdir = '/'; // WORKDIR active at the current line (Docker default /)
  const workdirs = new Set<string>(); // declared WORKDIRs — they exist as dirs, so a COPY into one copies INTO it
  for (const line of logical) {
    const m = /^(\w+)\s+(.*)$/.exec(line);
    if (!m) continue;
    const instr = m[1].toUpperCase();
    const rest = m[2].trim();
    switch (instr) {
      case 'FROM': {
        fromCount += 1;
        if (fromCount > 1) { out.unsupported.push('multi-stage build (multiple FROM)'); break; }
        if (/\sAS\s/i.test(` ${rest} `)) { out.unsupported.push('multi-stage build (FROM … AS …)'); break; }
        // A pinned platform would need the right per-arch base; we pull the host
        // platform, so fall back rather than risk a wrong-arch image.
        if (/--platform[=\s]/.test(rest)) { out.unsupported.push('FROM --platform (cross-arch needs a full build)'); break; }
        const toks = tokenize(rest).filter((t) => !t.startsWith('--'));
        const base = toks[0] ?? null;
        // ARG-substituted base (`FROM ${BASE}`) can't be resolved here → fall back.
        if (base && base.includes('$')) { out.unsupported.push('FROM uses an ARG/variable base'); break; }
        out.from = base;
        break;
      }
      case 'RUN':
        out.unsupported.push('RUN steps require a full container build');
        break;
      case 'COPY':
      case 'ADD': {
        const toks = tokenize(rest);
        const flags = toks.filter((t) => t.startsWith('--'));
        const args = toks.filter((t) => !t.startsWith('--'));
        if (flags.some((f) => f.startsWith('--from'))) { out.unsupported.push(`${instr} --from= (multi-stage copy)`); break; }
        if (args.length < 2) { out.unsupported.push(`${instr} needs a source and a destination`); break; }
        // Only --chmod is implemented. Any other flag (--chown changes ownership,
        // --link changes layer semantics, …) would make the assembled image
        // differ from `podman build`, so treat it as not-assemblable → fall back.
        const unhandled = flags.filter((f) => !f.startsWith('--chmod='));
        if (unhandled.length) { out.unsupported.push(`${instr} ${unhandled.join(' ')} (unsupported flag — needs a full build)`); break; }
        const rawDest = args[args.length - 1];
        if (rawDest.includes('$')) { out.unsupported.push(`${instr} uses an ARG/variable destination '${rawDest}'`); break; }
        const srcs = args.slice(0, -1);
        let mode: number | undefined;
        const chmod = flags.find((f) => f.startsWith('--chmod='));
        if (chmod) { const v = parseInt(chmod.split('=')[1], 8); if (!Number.isNaN(v)) mode = v; }
        // Resolve a relative dest against the WORKDIR in effect here (Docker:
        // relative COPY destinations are relative to WORKDIR). Record whether the
        // author meant a directory target (trailing slash / `.` / `/`).
        const dest = rawDest.startsWith('/') ? posixNormalize(rawDest) : posixNormalize(`${currentWorkdir}/${rawDest}`);
        // A dir target when the author wrote a trailing slash / `.` / `/`, OR the
        // dest is a declared WORKDIR (which exists as a dir, so Docker copies INTO it).
        const destIsDir = /\/$/.test(rawDest) || rawDest === '.' || rawDest === '/' || workdirs.has(dest);
        for (const src of srcs) {
          if (src.includes('$')) { out.unsupported.push(`${instr} uses an ARG/variable path '${src}'`); continue; }
          if (/[*?[\]]/.test(src)) { out.unsupported.push(`${instr} glob source '${src}'`); continue; }
          if (instr === 'ADD' && /^https?:\/\//i.test(src)) { out.unsupported.push(`ADD <url> '${src}'`); continue; }
          // ADD auto-extracts local archives — we'd stage the tarball verbatim, so fall back.
          if (instr === 'ADD' && /\.(tar|tgz|tbz2?|txz|tar\.(gz|bz2|xz|zst))$/i.test(src)) { out.unsupported.push(`ADD archive '${src}' (auto-extract needs a full build)`); continue; }
          out.copies.push({ src, dest, destIsDir, mode });
        }
        break;
      }
      case 'CMD': out.cmd = parseExecOrShell(rest); break;
      case 'ENTRYPOINT': out.entrypoint = parseExecOrShell(rest); break;
      case 'WORKDIR': {
        const w = rest.trim();
        // ARG/ENV-expanded WORKDIR (`WORKDIR $APP_HOME`) can't be resolved here.
        if (w.includes('$')) { out.unsupported.push('WORKDIR uses an ARG/variable path'); break; }
        currentWorkdir = w.startsWith('/') ? posixNormalize(w) : posixNormalize(`${currentWorkdir}/${w}`);
        out.workdir = currentWorkdir;
        workdirs.add(currentWorkdir);
        break;
      }
      case 'USER': out.user = tokenize(rest)[0] ?? null; break;
      case 'EXPOSE':
        for (const t of tokenize(rest)) {
          const [pStr, protoRaw] = t.split('/');
          const n = parseInt(pStr, 10);
          const proto = (protoRaw || 'tcp').toLowerCase();
          const key = `${n}/${proto}`;
          if (Number.isInteger(n) && n > 0 && !out.exposes.includes(key)) out.exposes.push(key);
        }
        break;
      case 'ENV': {
        // `ENV K=V [K2=V2 …]` or legacy `ENV K rest-of-line`. A quoted value may
        // contain spaces (`ENV NODE_OPTIONS="--a --b"`), which the whitespace
        // tokenizer would split — so when quotes are present treat the line as a
        // SINGLE assignment and strip the surrounding quotes (the common form).
        const stripQuotes = (v: string) => v.replace(/^(['"])([\s\S]*)\1$/, '$2');
        if (/["']/.test(rest) && rest.includes('=')) {
          const m2 = /^(\S+?)=([\s\S]*)$/.exec(rest);
          if (m2) out.env.push({ k: m2[1], v: stripQuotes(m2[2].trim()) });
        } else if (rest.includes('=')) {
          for (const t of tokenize(rest)) {
            const i = t.indexOf('=');
            if (i > 0) out.env.push({ k: t.slice(0, i), v: t.slice(i + 1) });
          }
        } else {
          const t = tokenize(rest);
          if (t.length >= 2) out.env.push({ k: t[0], v: stripQuotes(t.slice(1).join(' ')) });
        }
        break;
      }
      case 'SHELL':
        // SHELL changes how shell-form CMD/ENTRYPOINT are wrapped; we hard-code
        // /bin/sh -c, so fall back rather than run a different command.
        out.unsupported.push('SHELL overrides the default shell (needs a full build)');
        break;
      default:
        // LABEL/VOLUME/HEALTHCHECK/STOPSIGNAL/ARG/… don't affect the running
        // surface (see the module header's known-limitations note) — dropped.
        break;
    }
  }

  if (!out.from) out.unsupported.push('no FROM instruction');
  out.assemblable = out.from !== null && out.unsupported.length === 0;
  return out;
}

// ── minimal ustar tar writer (dependency-free, deterministic) ────────────────

interface TarEntry { name: string; mode: number; type: '0' | '5'; content?: Buffer }

function tarHeader(name: string, size: number, mode: number, type: '0' | '5'): Buffer {
  const h = Buffer.alloc(512, 0);
  let nm = name;
  let prefix = '';
  if (Buffer.byteLength(name) > 100) {
    const cut = name.lastIndexOf('/', name.length - 1 - (name.length - 100));
    if (cut > 0 && Buffer.byteLength(name.slice(cut + 1)) <= 100 && Buffer.byteLength(name.slice(0, cut)) <= 155) {
      prefix = name.slice(0, cut);
      nm = name.slice(cut + 1);
    } else {
      throw new Error(`path too long for tar (>100 bytes, unsplittable): ${name}`);
    }
  }
  h.write(nm, 0, 100, 'utf8');
  h.write((mode & 0o7777).toString(8).padStart(7, '0') + '\0', 100, 8, 'ascii');
  h.write('0000000\0', 108, 8, 'ascii'); // uid
  h.write('0000000\0', 116, 8, 'ascii'); // gid
  h.write(size.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii');
  h.write('00000000000\0', 136, 12, 'ascii'); // mtime = 0 (deterministic)
  h.write('        ', 148, 8, 'ascii'); // checksum placeholder (8 spaces)
  h.write(type, 156, 1, 'ascii');
  h.write('ustar\0', 257, 6, 'ascii');
  h.write('00', 263, 2, 'ascii');
  if (prefix) h.write(prefix, 345, 155, 'utf8');
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += h[i];
  h.write(sum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return h;
}

function buildTar(entries: TarEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const e of entries) {
    const size = e.type === '0' ? (e.content?.length ?? 0) : 0;
    chunks.push(tarHeader(e.name, size, e.mode, e.type));
    if (e.type === '0' && e.content && e.content.length) {
      chunks.push(e.content);
      const pad = (512 - (e.content.length % 512)) % 512;
      if (pad) chunks.push(Buffer.alloc(pad, 0));
    }
  }
  chunks.push(Buffer.alloc(1024, 0)); // two trailing zero blocks
  return Buffer.concat(chunks);
}

function walkFiles(root: string, onFile: (abs: string) => void): void {
  for (const ent of fs.readdirSync(root, { withFileTypes: true })) {
    const abs = path.join(root, ent.name);
    if (ent.isDirectory()) walkFiles(abs, onFile);
    else if (ent.isFile()) onFile(abs);
  }
}

/**
 * Build a `.dockerignore` matcher (a subset: `#` comments, blank lines, `*`/`**`/
 * `?` globs, and `!` negation; last matching rule wins). Returns a predicate over
 * a context-relative POSIX path. Honoring this is load-bearing: `auto` routes
 * `COPY . /app` through the assembler, so without it an ignored `.env` /
 * `node_modules` would be packed into the published image.
 */
function loadDockerignore(contextDir: string): (rel: string) => boolean {
  let text: string;
  try { text = fs.readFileSync(path.join(contextDir, '.dockerignore'), 'utf-8'); } catch { return () => false; }
  const rules: { negate: boolean; test: (rel: string) => boolean }[] = [];
  for (const raw of text.split('\n')) {
    let line = raw.trim();
    if (!line || line.startsWith('#')) continue;
    let negate = false;
    if (line.startsWith('!')) { negate = true; line = line.slice(1).trim(); }
    line = line.replace(/^\/+/, '').replace(/\/+$/, '');
    if (!line) continue;
    const hasSlash = line.includes('/');
    if (/[*?]/.test(line)) {
      const re = new RegExp('^' + line.split('').map((ch) => {
        if (ch === '*') return ' STAR ';
        if (ch === '?') return '[^/]';
        return ch.replace(/[.+^${}()|[\]\\]/g, '\\$&');
      }).join('').replace(/ STAR  STAR /g, '.*').replace(/ STAR /g, '[^/]*') + '$');
      // Slash-less glob (`*.log`) matches by BASENAME at any depth; a glob with
      // `/` matches the full path.
      rules.push({ negate, test: (rel) => hasSlash ? re.test(rel) : re.test(rel.split('/').pop() ?? rel) });
    } else if (hasSlash) {
      rules.push({ negate, test: (rel) => rel === line || rel.startsWith(line + '/') });
    } else {
      // Slash-less literal (`node_modules`, `.env`) matches that name as ANY path
      // component at any depth — so `COPY . /app` can't leak a nested
      // `packages/x/node_modules` or `src/.env`.
      rules.push({ negate, test: (rel) => rel.split('/').includes(line) });
    }
  }
  if (!rules.length) return () => false;
  return (rel) => {
    let ignored = false;
    for (const r of rules) if (r.test(rel)) ignored = !r.negate;
    return ignored;
  };
}

/** Stage the Dockerfile's COPY instructions into a deterministic layer tar. */
export function buildCopyLayer(
  contextDir: string,
  copies: { src: string; dest: string; destIsDir?: boolean; mode?: number }[],
): { ok: true; tar: Buffer } | { ok: false; message: string } {
  const files: { name: string; content: Buffer; mode: number }[] = [];
  const ignored = loadDockerignore(contextDir);
  for (const c of copies) {
    const srcAbs = path.resolve(contextDir, c.src);
    const rel = path.relative(contextDir, srcAbs);
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, message: `COPY source escapes the build context: ${c.src}` };
    // A COPY source that is a symlink (to a file OR dir) escaping the context
    // would otherwise have its TARGET read/walked — leaking host files (~/.ssh,
    // /etc, a sibling .env) into the published image. statSync FOLLOWS links, so
    // check the link target's real path is still inside the context first. (The
    // dir-walk below skips symlinks entirely, so this covers the explicit-source
    // vector.)
    try {
      if (fs.lstatSync(srcAbs).isSymbolicLink()) {
        const realRel = path.relative(contextDir, fs.realpathSync(srcAbs));
        if (realRel.startsWith('..') || path.isAbsolute(realRel)) {
          return { ok: false, message: `COPY source symlink escapes the build context: ${c.src}` };
        }
      }
    } catch { return { ok: false, message: `COPY source not found: ${c.src}` }; }
    let st: fs.Stats;
    try { st = fs.statSync(srcAbs); } catch { return { ok: false, message: `COPY source not found: ${c.src}` }; }
    const destClean = c.dest.replace(/^\/+/, '').replace(/\/+$/, '');
    const destIsDir = c.destIsDir ?? (/\/$/.test(c.dest) || c.dest === '/' || c.dest === '.');
    if (st.isDirectory()) {
      // Docker: COPY <dir> <dest> copies the CONTENTS of <dir> into <dest>.
      walkFiles(srcAbs, (fileAbs) => {
        const relToCtx = path.relative(contextDir, fileAbs).split(path.sep).join('/');
        if (ignored(relToCtx)) return; // honor .dockerignore (don't leak ignored files)
        const relFromSrc = path.relative(srcAbs, fileAbs).split(path.sep).join('/');
        const name = (destClean ? destClean + '/' : '') + relFromSrc;
        // Preserve the source mode (Docker default) unless --chmod overrode it.
        files.push({ name, content: fs.readFileSync(fileAbs), mode: c.mode ?? (fs.statSync(fileAbs).mode & 0o777) });
      });
    } else {
      // Honor .dockerignore for an explicitly-named file too — an ignored `.env`
      // / key is NOT in the build context, so it must not be packaged even when
      // the Dockerfile names it directly (leak parity with the dir-walk above).
      if (ignored(rel.split(path.sep).join('/'))) continue;
      const name = destIsDir ? (destClean ? destClean + '/' : '') + path.basename(srcAbs) : (destClean || path.basename(srcAbs));
      files.push({ name, content: fs.readFileSync(srcAbs), mode: c.mode ?? (st.mode & 0o777) });
    }
  }
  if (files.length === 0) return { ok: false, message: 'the Dockerfile COPYs no files into the image' };

  // Synthesize directory entries for every ancestor path (deduped, sorted).
  const dirSet = new Set<string>();
  for (const f of files) {
    const parts = f.name.split('/');
    parts.pop();
    let acc = '';
    for (const p of parts) { acc += p + '/'; dirSet.add(acc); }
  }
  const entries: TarEntry[] = [
    ...[...dirSet].sort().map((d) => ({ name: d, mode: 0o755, type: '5' as const })),
    ...files.sort((a, b) => a.name.localeCompare(b.name)).map((f) => ({ name: f.name, mode: f.mode, type: '0' as const, content: f.content })),
  ];
  return { ok: true, tar: buildTar(entries) };
}

// ── OCI image config patching ────────────────────────────────────────────────

/** Apply the Dockerfile's runtime directives onto an OCI image config's `.config`. */
export function applyDockerfileToConfig(cfg: Record<string, unknown>, parsed: ParsedDockerfile): void {
  if (parsed.entrypoint) cfg.Entrypoint = parsed.entrypoint;
  if (parsed.cmd) cfg.Cmd = parsed.cmd;
  if (parsed.workdir) cfg.WorkingDir = parsed.workdir;
  if (parsed.user) cfg.User = parsed.user;
  if (parsed.exposes.length) {
    const ep: Record<string, unknown> = { ...(cfg.ExposedPorts as Record<string, unknown> | undefined) };
    for (const portProto of parsed.exposes) ep[portProto] = {}; // already `port/proto`
    cfg.ExposedPorts = ep;
  }
  if (parsed.env.length) {
    const envArr: string[] = Array.isArray(cfg.Env) ? [...(cfg.Env as string[])] : [];
    for (const { k, v } of parsed.env) {
      const i = envArr.findIndex((e) => e.startsWith(`${k}=`));
      if (i >= 0) envArr[i] = `${k}=${v}`;
      else envArr.push(`${k}=${v}`);
    }
    cfg.Env = envArr;
  }
}

// ── assembler ────────────────────────────────────────────────────────────────

function sha256hex(buf: Buffer): string { return createHash('sha256').update(buf).digest('hex'); }
function blobPath(layoutDir: string, digest: string): string { return path.join(layoutDir, 'blobs', 'sha256', digest.replace('sha256:', '')); }
function writeBlob(layoutDir: string, digest: string, buf: Buffer): void { fs.writeFileSync(blobPath(layoutDir, digest), buf); }

/** Materialize a minimal empty OCI layout (a `FROM scratch` base). */
function writeScratchBase(layoutDir: string, tag: string): void {
  fs.mkdirSync(path.join(layoutDir, 'blobs', 'sha256'), { recursive: true });
  fs.writeFileSync(path.join(layoutDir, 'oci-layout'), JSON.stringify({ imageLayoutVersion: '1.0.0' }));
  const config = { architecture: 'amd64', os: 'linux', config: {}, rootfs: { type: 'layers', diff_ids: [] as string[] }, history: [] as unknown[] };
  const cBuf = Buffer.from(JSON.stringify(config));
  const cDig = 'sha256:' + sha256hex(cBuf);
  writeBlob(layoutDir, cDig, cBuf);
  const manifest = { schemaVersion: 2, mediaType: 'application/vnd.oci.image.manifest.v1+json', config: { mediaType: 'application/vnd.oci.image.config.v1+json', digest: cDig, size: cBuf.length }, layers: [] as unknown[] };
  const mBuf = Buffer.from(JSON.stringify(manifest));
  const mDig = 'sha256:' + sha256hex(mBuf);
  writeBlob(layoutDir, mDig, mBuf);
  fs.writeFileSync(path.join(layoutDir, 'index.json'), JSON.stringify({ schemaVersion: 2, manifests: [{ mediaType: 'application/vnd.oci.image.manifest.v1+json', digest: mDig, size: mBuf.length, annotations: { 'org.opencontainers.image.ref.name': tag } }] }));
}

export interface AssembleOpts {
  baseRef: string;
  contextDir: string;
  parsed: ParsedDockerfile;
  ociLayoutDir: string;   // an empty temp dir skopeo pulls the base into
  outArchivePath: string; // the oci-archive tar to produce
  tag: string;            // ref name inside the archive
  exec: ExecLike;
  log: (msg: string) => void;
}

export type AssembleResult = { ok: true } | { ok: false; kind: 'io' | 'validation'; message: string };

/**
 * Assemble + export an oci-archive for a COPY-only Dockerfile, no container
 * engine. Caller passes an already-empty `ociLayoutDir` and is responsible for
 * reaping it + `outArchivePath`.
 */
export async function assembleOciArchive(opts: AssembleOpts): Promise<AssembleResult> {
  const { baseRef, contextDir, parsed, ociLayoutDir, outArchivePath, tag, exec, log } = opts;

  if (baseRef.toLowerCase() === 'scratch') {
    // `scratch` is a Dockerfile sentinel for an EMPTY base, not a pullable image
    // — synthesize a minimal OCI layout (no base layer) instead of skopeo-pulling.
    log('Base is `scratch` — starting from an empty image …');
    writeScratchBase(ociLayoutDir, tag);
  } else {
    log(`Pulling base image ${baseRef} (skopeo) …`);
    const pull = await exec('skopeo', ['copy', '--quiet', `docker://${baseRef}`, `oci:${ociLayoutDir}:${tag}`]);
    if (pull.code !== 0) {
      return { ok: false, kind: 'io', message: `skopeo pull of base '${baseRef}' failed (code ${pull.code}): ${(pull.stderr || '').trim().slice(-4000)}` };
    }
  }

  let index: any, manifest: any, config: any;
  try {
    index = JSON.parse(fs.readFileSync(path.join(ociLayoutDir, 'index.json'), 'utf-8'));
    const mdesc = index.manifests?.[0];
    if (!mdesc?.digest) throw new Error('base OCI layout has no manifest in index.json');
    manifest = JSON.parse(fs.readFileSync(blobPath(ociLayoutDir, mdesc.digest), 'utf-8'));
    config = JSON.parse(fs.readFileSync(blobPath(ociLayoutDir, manifest.config.digest), 'utf-8'));
  } catch (e) {
    return { ok: false, kind: 'io', message: `reading base OCI layout failed (the base may be a manifest list skopeo couldn't resolve to one platform): ${(e as Error).message}` };
  }

  // Append the COPY layer (skip when the Dockerfile COPYs nothing — base as-is).
  if (parsed.copies.length > 0) {
    const layer = buildCopyLayer(contextDir, parsed.copies);
    if (!layer.ok) return { ok: false, kind: 'validation', message: layer.message };
    const layerDigest = 'sha256:' + sha256hex(layer.tar);
    writeBlob(ociLayoutDir, layerDigest, layer.tar);
    manifest.layers = Array.isArray(manifest.layers) ? manifest.layers : [];
    manifest.layers.push({ mediaType: 'application/vnd.oci.image.layer.v1.tar', digest: layerDigest, size: layer.tar.length });
    config.rootfs = config.rootfs || { type: 'layers', diff_ids: [] };
    config.rootfs.diff_ids = Array.isArray(config.rootfs.diff_ids) ? config.rootfs.diff_ids : [];
    config.rootfs.diff_ids.push(layerDigest); // uncompressed tar → diffID == layer digest
    config.history = Array.isArray(config.history) ? config.history : [];
    config.history.push({ created_by: 'yolo tileapp (skopeo-assembler): COPY app bundle', empty_layer: false });
  }

  config.config = (config.config && typeof config.config === 'object') ? config.config : {};
  applyDockerfileToConfig(config.config, parsed);

  // Rewrite config → manifest.config → index, recomputing each digest from the
  // exact bytes (orphaned old blobs are harmless; the index points at the new ones).
  const configBuf = Buffer.from(JSON.stringify(config));
  const configDigest = 'sha256:' + sha256hex(configBuf);
  writeBlob(ociLayoutDir, configDigest, configBuf);
  manifest.config = { mediaType: 'application/vnd.oci.image.config.v1+json', digest: configDigest, size: configBuf.length };

  const manifestBuf = Buffer.from(JSON.stringify(manifest));
  const manifestDigest = 'sha256:' + sha256hex(manifestBuf);
  writeBlob(ociLayoutDir, manifestDigest, manifestBuf);
  index.manifests = [{
    mediaType: 'application/vnd.oci.image.manifest.v1+json',
    digest: manifestDigest,
    size: manifestBuf.length,
    annotations: { 'org.opencontainers.image.ref.name': tag },
  }];
  try {
    fs.writeFileSync(path.join(ociLayoutDir, 'index.json'), JSON.stringify(index));
  } catch (e) {
    return { ok: false, kind: 'io', message: `writing patched OCI index failed: ${(e as Error).message}` };
  }

  log('Exporting OCI archive (skopeo) …');
  const out = await exec('skopeo', ['copy', '--quiet', `oci:${ociLayoutDir}:${tag}`, `oci-archive:${outArchivePath}:${tag}`]);
  if (out.code !== 0) {
    return { ok: false, kind: 'io', message: `skopeo export to oci-archive failed (code ${out.code}): ${(out.stderr || '').trim().slice(-4000)}` };
  }
  return { ok: true };
}
