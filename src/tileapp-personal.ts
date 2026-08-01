/**
 * `yolo tileapp init` + `yolo tileapp publish --personal` — the PERSONAL
 * (owner-only) app path. Unlike the marketplace `sign`/`publish` flow, this
 * needs no signing, no review, no publisher entity: it registers the manifest
 * under the caller's own namespace and uploads the static bundle, both via the
 * user-authed `/v1/tileapps/personal*` routes. See docs/PERSONAL_TILE_APPS_PLAN.md.
 *
 *   yolo tileapp init <name>
 *     → scaffold ./<name>/tileapp.json + ./<name>/index.html (a renderable
 *       pure-UI starter). Offline, no auth.
 *
 *   yolo tileapp publish <manifest.json> --personal [--bundle-dir <dir>]
 *     → POST /v1/tileapps/personal (register the manifest, returns the namespaced
 *       appId) then PUT /v1/tileapps/personal/<appId>/bundle (upload the static
 *       files). Prints the appId. Auth: user JWT (no SESSION_ID needed).
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { resolveUserToken } from './auth-context.js';
import { validateManifest, isRuntimeManifest } from './tileapp-validator.js';
import { resolveBundleDir } from './tileapp-developer.js';
import { parseDockerfile, assembleOciArchive } from './tileapp-oci-assembler.js';

export type Builder = 'auto' | 'podman' | 'skopeo';

export type FetchLike = typeof fetch;

/** Run a command (podman build/save), streaming output. Injectable for tests. */
export type ExecLike = (file: string, args: string[]) => Promise<{ code: number | null; stderr: string }>;
function defaultExec(file: string, args: string[]): Promise<{ code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    let proc;
    try {
      proc = spawn(file, args, { stdio: ['ignore', 'inherit', 'pipe'] });
    } catch (err) {
      return resolve({ code: null, stderr: (err as Error).message });
    }
    let stderr = '';
    proc.stderr?.on('data', (d) => { stderr += d; process.stderr.write(d); });
    proc.on('error', (err) => resolve({ code: null, stderr: stderr + err.message }));
    proc.on('close', (code) => resolve({ code, stderr }));
  });
}

export type CmdResult =
  | { ok: true; output: string }
  | { ok: false; kind: 'usage' | 'auth' | 'io' | 'http' | 'validation'; message: string };

export function exitCodeForFailure(kind: 'usage' | 'auth' | 'io' | 'http' | 'validation'): number {
  if (kind === 'http') return 1;
  if (kind === 'validation') return 65; // EX_DATAERR
  return 64; // EX_USAGE / auth / io
}

const LOCAL_ID_RE = /^[a-z0-9][a-z0-9-]{1,31}$/;

// Extensions served as text (utf8); everything else is uploaded base64.
const TEXT_EXTS = new Set(['.html', '.htm', '.js', '.mjs', '.css', '.json', '.svg', '.txt', '.map', '.xml', '.webmanifest']);
const MAX_FILES = 100;
const MAX_TOTAL_BYTES = 3 * 1024 * 1024;

function apiBase(commonApiUrl: string): string {
  const base = commonApiUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

type Auth = { ok: true; commonApiUrl: string; userToken: string } | { ok: false; message: string };
function resolveAuth(env: Record<string, string | undefined>): Auth {
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!commonApiUrl) return { ok: false, message: 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required' };
  const userToken = resolveUserToken(env);
  if (!userToken) return { ok: false, message: 'no user token: set YOLO_API_TOKEN or sign in (~/.config/yolo/token)' };
  return { ok: true, commonApiUrl, userToken };
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try { return await res.text(); } catch { return '<no body>'; }
}

function readManifest(p: string): { ok: true; manifest: Record<string, unknown> } | { ok: false; message: string } {
  let raw: string;
  try { raw = fs.readFileSync(p, 'utf-8'); }
  catch (e) { return { ok: false, message: `cannot read manifest '${p}': ${(e as Error).message}` }; }
  try { return { ok: true, manifest: JSON.parse(raw) as Record<string, unknown> }; }
  catch (e) { return { ok: false, message: `manifest '${p}' is not valid JSON: ${(e as Error).message}` }; }
}

// ── init ───────────────────────────────────────────────────────────────────

export interface InitOptions { name: string; cwd?: string }

/** Scaffold a renderable pure-UI personal app under ./<name>/. */
export function runTileAppInit(opts: InitOptions): CmdResult {
  const name = opts.name;
  if (!LOCAL_ID_RE.test(name)) {
    return { ok: false, kind: 'usage', message: `name must be a lowercase kebab-case slug, 2-32 chars (got '${name}')` };
  }
  const dir = path.resolve(opts.cwd ?? process.cwd(), name);
  if (fs.existsSync(dir)) return { ok: false, kind: 'io', message: `directory already exists: ${dir}` };

  const title = name.split('-').map((w) => w.charAt(0).toUpperCase() + w.slice(1)).join(' ');
  const manifest = {
    id: name,
    version: '1.0.0',
    displayName: title,
    publisher: 'personal',
    description: `${title} — a personal tile-app.`,
    ui: { icon: '🧩', color: '#4f46e5', label: title },
    surface: { kind: 'iframe', entry: 'index.html', tilePrefersSize: { rowSpan: 2, colSpan: 2 } },
    permissions: { required: [] as string[] },
  };
  const indexHtml = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>${title}</title>
  <!--
    ⚠️ CONTENT-SECURITY-POLICY — read this before you build.
    Tile-app bundles are served with \`script-src 'self'\`. That means:
      • NO inline <script> — put ALL your JavaScript in app.js (loaded below).
      • NO eval() / new Function() — they are blocked. If your app needs to
        evaluate expressions (a calculator, grapher, template engine, …), write
        a real tokenizer/parser in app.js; you cannot shortcut with eval.
      • NO network — no CDN scripts, remote fonts, or fetch() to other origins.
        Keep the app fully self-contained (only the files in this folder).
    Inline <style> is fine; CSS may also live in a bundled .css file.
  -->
  <style>
    body { font: 15px/1.5 system-ui, sans-serif; margin: 0; display: grid; place-items: center;
           height: 100vh; color: #e5e7eb; background: #111827; }
  </style>
</head>
<body>
  <main>
    <h1>${title}</h1>
    <p id="status">Loading…</p>
    <p>Edit <code>index.html</code> + <code>app.js</code>, then re-run
       <code>yolo tileapp publish tileapp.json --personal</code>.</p>
  </main>
  <!-- All JS lives in app.js (the CSP forbids inline scripts). type="module" so
       you can \`import\` the app-sdk (a same-origin module is allowed under 'self'). -->
  <script src="app.js" type="module"></script>
</body>
</html>
`;
  const appJs = `// ${title} — personal tile-app logic.
//
// ⚠️ CSP: served under \`script-src 'self'\` → eval() and new Function() are
// BLOCKED, and there is no network. If you need to evaluate user input (e.g. a
// calculator/grapher), write a real parser here (tokenizer → shunting-yard →
// RPN eval) rather than reaching for eval. Keep everything self-contained.
//
// To call HOST capabilities (LLM, MCP tools, files), vendor @yololabs/app-sdk's
// browser build into ./vendor/app-sdk/ and request matching permissions in
// tileapp.json (permissions.required / optional):
//   import { createTileApp } from './vendor/app-sdk/index.js';
//   const app = createTileApp();
//   const res = await app.call('llm', 'complete', { prompt: '...' });

const status = document.getElementById('status');
if (status) status.textContent = 'Ready — edit app.js to build your app.';
`;
  // Store screenshots live in `media/`. Scaffolding the directory (with a
  // README, since an empty dir wouldn't survive and a dotfile is skipped by
  // both the collector and the server) is what makes the feature discoverable
  // — an author who never learns the folder exists ships a listing with no
  // preview and no idea one was possible.
  const mediaReadme = `# Store screenshots

Drop screenshots here, then reference them from tileapp.json:

    "screenshots": ["media/01-main.webp"]

\`yolo tileapp publish tileapp.json --personal\` walks this directory and
uploads whatever is in it; the platform serves each file at
/v1/tileapps/<appId>/media/<file>.

  format   1280x800 (16:10) webp, <= 400 KB each, 1-6 images, first is the hero
  capture  render at 2x and downscale — the store card crops to ~320px wide
  content  show the app doing its job on realistic data; an empty state or a
           permission prompt is a wasted slot
  budget   bundles cap at 100 files / 3 MB total

An absolute https:// URL works too, and is the ONLY option for a runtime app
(it publishes an image, not a bundle, so it has nowhere to put these).

Upload (additive — leaves the rest of your bundle alone):

    yolo tileapp media push tileapp.json

Check refs before publishing:  yolo tileapp validate tileapp.json --personal
`;
  try {
    fs.mkdirSync(dir, { recursive: false });
    fs.writeFileSync(path.join(dir, 'tileapp.json'), `${JSON.stringify(manifest, null, 2)}\n`);
    fs.writeFileSync(path.join(dir, 'index.html'), indexHtml);
    fs.writeFileSync(path.join(dir, 'app.js'), appJs);
    fs.mkdirSync(path.join(dir, 'media'), { recursive: false });
    fs.writeFileSync(path.join(dir, 'media', 'README.md'), mediaReadme);
  } catch (e) {
    return { ok: false, kind: 'io', message: `scaffold failed: ${(e as Error).message}` };
  }
  return {
    ok: true,
    output: `Created ${name}/ (tileapp.json + index.html + app.js + media/)\n  note: bundle CSP is \`script-src 'self'\` — keep JS in app.js (no inline <script>, no eval, no network)\n  note: drop a 1280x800 webp in media/ and add \`"screenshots": ["media/01-main.webp"]\` to get a store preview (see media/README.md)\n  next: cd ${name} && yolo tileapp publish tileapp.json --personal`,
  };
}

// ── media (store screenshots) ───────────────────────────────────────────────

const MEDIA_NAME_RE = /^[a-z0-9][a-z0-9._-]*$/;
const MEDIA_EXTS = new Set(['.webp', '.png']);

export interface MediaPushOptions {
  /** Manifest path — its `id` resolves the namespaced appId server-side. */
  manifestPath: string;
  /** Directory of images to upload. Defaults to `media/` beside the manifest. */
  dir?: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

/**
 * Upload store screenshots for an already-published personal app.
 *
 * ADDITIVE — it posts to `/tileapps/personal/:appId/media`, which writes one
 * file at a time and never reaps. This is deliberately NOT `publish`: the
 * bundle PUT is a full replace, so using it to add a screenshot would delete
 * the app's index.html. This command exists so adding a preview never requires
 * re-uploading (or still having) the whole bundle.
 */
export async function runTileAppMediaPush(opts: MediaPushOptions): Promise<CmdResult> {
  const auth = resolveAuth(opts.env ?? process.env);
  if (!auth.ok) return { ok: false, kind: 'usage', message: auth.message };

  const read = readManifest(opts.manifestPath);
  if (!read.ok) return { ok: false, kind: 'io', message: read.message };
  const localId = typeof read.manifest.id === 'string' ? read.manifest.id : '';
  if (!LOCAL_ID_RE.test(localId)) {
    return { ok: false, kind: 'validation', message: `manifest.id must be a lowercase kebab-case slug (got '${localId}')` };
  }

  const dir = path.resolve(opts.dir ?? path.join(path.dirname(path.resolve(opts.manifestPath)), 'media'));
  let entries: string[];
  try { entries = fs.readdirSync(dir); }
  catch { return { ok: false, kind: 'io', message: `no media directory at ${dir} — create it and add your screenshots (see media/README.md from \`yolo tileapp init\`)` }; }

  const files: Array<{ name: string; content: string }> = [];
  for (const name of entries.sort()) {
    const ext = path.extname(name).toLowerCase();
    if (!MEDIA_EXTS.has(ext)) continue; // README.md and friends are not screenshots
    if (!MEDIA_NAME_RE.test(name)) {
      return { ok: false, kind: 'validation', message: `invalid media filename '${name}' — lowercase, one segment, e.g. 01-main.webp` };
    }
    files.push({ name, content: fs.readFileSync(path.join(dir, name)).toString('base64') });
  }
  if (files.length === 0) {
    return { ok: false, kind: 'io', message: `no .webp/.png files in ${dir}` };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBase(auth.commonApiUrl);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.userToken}` };

  // Resolve the namespaced appId (pa-<ownerId>-<localId>) — the caller only
  // knows the local slug; the owner half is server-side.
  let appId: string;
  try {
    const res = await fetchImpl(`${base}/tileapps/personal`, { headers });
    if (!res.ok) return { ok: false, kind: 'http', message: `could not list personal apps: HTTP ${res.status} — ${await safeText(res)}` };
    const json = (await res.json()) as { apps?: Array<{ id?: string }> };
    const match = (json.apps ?? []).find((a) => typeof a.id === 'string' && a.id.endsWith(`-${localId}`));
    if (!match?.id) {
      return { ok: false, kind: 'validation', message: `no published personal app matching '${localId}' — publish it first: yolo tileapp publish ${opts.manifestPath} --personal` };
    }
    appId = match.id;
  } catch (e) {
    return { ok: false, kind: 'http', message: `list request failed: ${(e as Error).message}` };
  }

  try {
    const res = await fetchImpl(`${base}/tileapps/personal/${encodeURIComponent(appId)}/media`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ files }),
    });
    if (!res.ok) return { ok: false, kind: 'http', message: `media upload failed: HTTP ${res.status} — ${await safeText(res)}` };
    const json = (await res.json()) as { files?: Array<{ ref: string; width?: number; height?: number }> };
    const uploaded = json.files ?? [];
    const lines = uploaded.map((f) => `  ${f.ref}${f.width ? `  ${f.width}x${f.height}` : ''}`);
    const refs = JSON.stringify(uploaded.map((f) => f.ref));
    return {
      ok: true,
      output: `Uploaded ${uploaded.length} screenshot(s) to ${appId}:\n${lines.join('\n')}\n\nAdd them to ${opts.manifestPath}:\n  "screenshots": ${refs}\nthen re-register:  yolo tileapp publish ${opts.manifestPath} --personal`,
    };
  } catch (e) {
    return { ok: false, kind: 'http', message: `media upload request failed: ${(e as Error).message}` };
  }
}

// ── publish --personal ───────────────────────────────────────────────────────

export interface PublishPersonalOptions {
  manifestPath: string;
  bundleDir?: string;
  /** Runtime apps: build context + Dockerfile (default: the manifest's dir). */
  context?: string;
  dockerfile?: string;
  /** Runtime build engine: 'auto' (default) uses the skopeo assembler for
   *  RUN-less Dockerfiles + podman otherwise; 'skopeo'/'podman' force one. */
  builder?: Builder;
  fetchImpl?: FetchLike;
  execImpl?: ExecLike;
  env?: Record<string, string | undefined>;
}

/** Recursively collect a bundle dir's files as upload entries. Skips VCS/dep
 *  dirs and the manifest itself; classifies text vs binary by extension. */
function collectBundleFiles(
  rootDir: string,
  manifestPath: string,
): { ok: true; files: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }>; totalBytes: number } | { ok: false; message: string } {
  const out: Array<{ path: string; content: string; encoding: 'utf8' | 'base64' }> = [];
  const manifestAbs = path.resolve(manifestPath);
  const root = path.resolve(rootDir);
  let total = 0;
  const SKIP_DIRS = new Set(['node_modules', '.git', '.yolo']);

  const walk = (abs: string): string | null => {
    for (const entry of fs.readdirSync(abs, { withFileTypes: true })) {
      // Skip dotfiles/dotdirs entirely — the bundle is served PUBLICLY, so a
      // stray .env/.npmrc/.git from the project dir must never be uploaded (the
      // server's sanitizeBundlePath also rejects dot-leading paths). codex Round-3 P1.
      if (entry.name.startsWith('.')) continue;
      const childAbs = path.join(abs, entry.name);
      if (entry.isDirectory()) {
        if (SKIP_DIRS.has(entry.name)) continue;
        const err = walk(childAbs);
        if (err) return err;
        continue;
      }
      if (!entry.isFile()) continue;
      if (path.resolve(childAbs) === manifestAbs) continue; // never upload the manifest
      const rel = path.relative(root, childAbs).split(path.sep).join('/');
      const buf = fs.readFileSync(childAbs);
      total += buf.byteLength;
      if (out.length + 1 > MAX_FILES) return `too many files (max ${MAX_FILES})`;
      if (total > MAX_TOTAL_BYTES) return `bundle exceeds ${MAX_TOTAL_BYTES} bytes — use a smaller bundle`;
      const ext = path.extname(rel).toLowerCase();
      if (TEXT_EXTS.has(ext)) out.push({ path: rel, content: buf.toString('utf8'), encoding: 'utf8' });
      else out.push({ path: rel, content: buf.toString('base64'), encoding: 'base64' });
    }
    return null;
  };

  try {
    const err = walk(root);
    if (err) return { ok: false, message: err };
  } catch (e) {
    return { ok: false, message: `reading bundle failed: ${(e as Error).message}` };
  }
  if (out.length === 0) return { ok: false, message: `no files found in bundle dir: ${rootDir}` };
  return { ok: true, files: out, totalBytes: total };
}

export async function runTileAppPublishPersonal(opts: PublishPersonalOptions): Promise<CmdResult> {
  const env = opts.env ?? process.env;
  const auth = resolveAuth(env);
  if (!auth.ok) return { ok: false, kind: 'auth', message: auth.message };

  const read = readManifest(opts.manifestPath);
  if (!read.ok) return { ok: false, kind: 'io', message: read.message };

  // Guard non-object manifests (JSON `null`/array/scalar) BEFORE dereferencing —
  // the runtime branch + id read below assume an object (the strict validator
  // only runs on the pure-UI path).
  if (typeof read.manifest !== 'object' || read.manifest === null || Array.isArray(read.manifest)) {
    return { ok: false, kind: 'validation', message: 'manifest must be a JSON object' };
  }
  const localId = typeof read.manifest.id === 'string' ? read.manifest.id : '';
  if (!LOCAL_ID_RE.test(localId)) {
    return { ok: false, kind: 'validation', message: `manifest "id" must be a lowercase kebab-case slug, 2-32 chars (got '${localId}')` };
  }

  // Runtime app (has `runtime`/`image`): build the image in-pod + mediated push.
  // Branch BEFORE the strict pure-UI lint, since a runtime manifest legitimately
  // omits `image` (the server fills it from the actual pushed digest).
  if (isRuntimeManifest(read.manifest)) {
    return publishRuntime({
      manifest: read.manifest, localId, manifestPath: opts.manifestPath,
      context: opts.context, dockerfile: opts.dockerfile, builder: opts.builder,
      auth, env, fetchImpl: opts.fetchImpl ?? fetch, execImpl: opts.execImpl ?? defaultExec,
    });
  }

  // Pure-UI path: strict schema lint (the server re-validates authoritatively).
  // This IS the path that gets an R2 bundle, so the `media/<file>` screenshot
  // form is available to it — see ScreenshotRefOptions.
  const v = validateManifest(read.manifest, { allowPlatformHostedScreenshots: true });
  if (v.errors.length > 0) {
    return { ok: false, kind: 'validation', message: `manifest invalid:\n  - ${v.errors.join('\n  - ')}` };
  }

  // Resolve + collect the static bundle BEFORE registering, so a bad bundle
  // fails before we create a registry doc.
  const resolved = resolveBundleDir(opts.manifestPath, read.manifest, opts.bundleDir);
  if (!resolved.ok) return { ok: false, kind: 'io', message: `bundle: ${resolved.message}` };
  const collected = collectBundleFiles(resolved.dir, opts.manifestPath);
  if (!collected.ok) return { ok: false, kind: 'io', message: collected.message };

  const fetchImpl = opts.fetchImpl ?? fetch;
  const base = apiBase(auth.commonApiUrl);
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${auth.userToken}` };

  // 1) Register the manifest (id + publisher are stamped server-side).
  let appId: string;
  try {
    const res = await fetchImpl(`${base}/tileapps/personal`, {
      method: 'POST',
      headers,
      body: JSON.stringify({ id: localId, manifest: read.manifest }),
    });
    if (!res.ok) return { ok: false, kind: 'http', message: `register failed: HTTP ${res.status} — ${await safeText(res)}` };
    const json = (await res.json()) as { appId?: string };
    if (!json.appId) return { ok: false, kind: 'http', message: 'register response missing appId' };
    appId = json.appId;
  } catch (e) {
    return { ok: false, kind: 'http', message: `register request failed: ${(e as Error).message}` };
  }

  // 2) Upload the bundle.
  try {
    const res = await fetchImpl(`${base}/tileapps/personal/${encodeURIComponent(appId)}/bundle`, {
      method: 'PUT',
      headers,
      body: JSON.stringify({ files: collected.files }),
    });
    if (!res.ok) return { ok: false, kind: 'http', message: `bundle upload failed: HTTP ${res.status} — ${await safeText(res)}` };
  } catch (e) {
    return { ok: false, kind: 'http', message: `bundle upload request failed: ${(e as Error).message}` };
  }

  return {
    ok: true,
    output: `Published ${appId} (${collected.files.length} file${collected.files.length === 1 ? '' : 's'}, ${collected.totalBytes} bytes)\n  next: install it + add a tile from the workspace (or via the studio.install_app / studio.create_app_tile MCP tools).`,
  };
}

// ── publish (runtime / mediated push) ────────────────────────────────────────

interface RuntimePublishParams {
  manifest: Record<string, unknown>;
  localId: string;
  manifestPath: string;
  context?: string;
  dockerfile?: string;
  builder?: Builder;
  auth: { commonApiUrl: string; userToken: string };
  env: Record<string, string | undefined>;
  fetchImpl: FetchLike;
  execImpl: ExecLike;
}

/**
 * Build the app image in-pod with podman, `save` it to an OCI archive in the
 * workspace, and hand it to common-api's MEDIATED push endpoint — common-api
 * mints the registry token + chooses the destination and directs container-api
 * to push it. We never see a registry credential and never choose the dest.
 */
async function publishRuntime(p: RuntimePublishParams): Promise<CmdResult> {
  const { manifest, localId } = p;
  const version = typeof manifest.version === 'string' ? manifest.version : '';
  if (!version) return { ok: false, kind: 'validation', message: 'manifest.version is required for a runtime app' };

  // PRE-FLIGHT manifest validation BEFORE the (expensive) build + multi-MB
  // upload — so a trivial manifest error (a missing `ui` block, bad surface,
  // etc.) fails locally in milliseconds instead of after a full image build,
  // push, and a server 400 (dogfood feedback 2026-06-18). A runtime manifest
  // legitimately OMITS `image` (the server fills it from the pushed digest), so
  // we drop ONLY that one expected error; every other field is validated exactly
  // as the server will, surfacing all problems at once.
  // SCOPE: this mirrors the shared manifest SCHEMA validator (catches the common
  // dogfood errors — missing ui/surface/displayName — before the build). It does
  // NOT duplicate common-api's personal-specific gates (the runtime.exec ban,
  // per-permission tier/grantability rules) — those stay server-authoritative to
  // avoid CLI↔server validator drift, so a manifest that passes here can still be
  // rejected server-side. Acceptable: this strictly improves on the prior
  // no-preflight behavior and never false-rejects.
  // Validate with `image` STRIPPED: the publish-image path ignores any
  // author-supplied image and the server fills ref/tag/digest from the actual
  // pushed image, so a placeholder/partial `image` block (e.g. `image: {}`)
  // must NOT trip a local image.ref/tag failure. Stripping it also leaves the
  // "runtime requires either `image` or exec" error, which we filter (the push
  // supplies the image). Everything else (ui, surface, …) is validated as the
  // server will, surfacing all problems at once before the build.
  const { image: _serverFilledImage, ...rest } = manifest;
  const forValidation = {
    ...rest,
    // The server OVERWRITES publisher with `personal:<ownerId>` before validating
    // (the author's value is ignored entirely), so ALWAYS stamp a valid
    // placeholder here — an absent OR empty-string author publisher must not
    // cause a false local rejection that the server wouldn't.
    publisher: 'personal',
  };
  const v = validateManifest(forValidation);
  if (!v.ok) {
    const real = v.errors.filter((e) => !e.startsWith('runtime requires either `image`'));
    if (real.length > 0) {
      return { ok: false, kind: 'validation', message: `manifest invalid (fix before build):\n  - ${real.join('\n  - ')}` };
    }
  }

  const manifestDir = path.dirname(path.resolve(p.manifestPath));
  const context = p.context ? path.resolve(p.context) : manifestDir;
  const dockerfile = p.dockerfile ? path.resolve(p.dockerfile) : path.join(context, 'Dockerfile');
  try { if (!fs.statSync(dockerfile).isFile()) return { ok: false, kind: 'io', message: `Dockerfile not found: ${dockerfile}` }; }
  catch { return { ok: false, kind: 'io', message: `Dockerfile not found: ${dockerfile}` }; }

  const localTag = `localhost/tileapp-${localId}:${version}`;
  // Archive goes to a LOCAL temp file — common-api does the push, so it never
  // needs to be in the workspace / reachable by another in-pod process.
  const archiveTmp = path.join(os.tmpdir(), `tileapp-build-${localId}-${version}-${Date.now()}.tar`);

  const parsed = parseDockerfile(fs.readFileSync(dockerfile, 'utf-8'));
  const builder: Builder = p.builder ?? 'auto';
  let ociTmpDir: string | null = null;

  // archiveTmp (and the assembler's ociTmpDir, when used) may exist even on a
  // partial failure past this point, so the finally always reaps both.
  try {
    // Produce `archiveTmp` (an oci-archive) via the selected builder.
    if (builder === 'podman' || (builder === 'auto' && !parsed.assemblable)) {
      if (builder === 'auto') {
        process.stdout.write(`Dockerfile needs a full container build (${parsed.unsupported.join('; ')}) — using podman.\n`);
      }
      process.stdout.write(`Building ${localTag} …\n`);
      const build = await p.execImpl('podman', ['build', '-t', localTag, '-f', dockerfile, context]);
      if (build.code !== 0) return { ok: false, kind: 'io', message: `podman build failed (code ${build.code}): ${build.stderr.trim().slice(-4000)}` };
      process.stdout.write(`Exporting OCI archive …\n`);
      const save = await p.execImpl('podman', ['save', '--format', 'oci-archive', '-o', archiveTmp, localTag]);
      if (save.code !== 0) return { ok: false, kind: 'io', message: `podman save failed (code ${save.code}): ${save.stderr.trim().slice(-4000)}` };
    } else {
      // skopeo assembler — no container engine (works under the in-pod Kata
      // uid_map/fuse limits that break rootless podman, PERSONAL_TILE_APPS §7.1 #2).
      if (!parsed.assemblable) {
        return { ok: false, kind: 'validation', message: `--builder skopeo can't assemble this Dockerfile (it needs a full container build): ${parsed.unsupported.join('; ')}` };
      }
      ociTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), `tileapp-oci-${localId}-`));
      process.stdout.write(`Assembling ${localTag} via skopeo (no container engine) …\n`);
      const asm = await assembleOciArchive({
        baseRef: parsed.from!, contextDir: context, parsed,
        ociLayoutDir: ociTmpDir, outArchivePath: archiveTmp, tag: version,
        exec: p.execImpl, log: (m) => process.stdout.write(`${m}\n`),
      });
      if (!asm.ok) return { ok: false, kind: asm.kind, message: asm.message };
    }

    // Strip any `image` the author put in — common-api computes ref + the actual
    // pushed digest and fills it in. `runtime` is carried through. The manifest
    // travels in a header; the body is the raw archive (streamed, never buffered).
    const sentManifest = { ...manifest };
    delete (sentManifest as Record<string, unknown>).image;
    const manifestHeader = Buffer.from(JSON.stringify({ id: localId, manifest: sentManifest })).toString('base64');
    // The manifest rides in a header (the body is the archive). Keep it well
    // under HTTP header limits — a runtime manifest is small; if you've packed in
    // large store-listing metadata (screenshots/changelog), trim it.
    if (Buffer.byteLength(manifestHeader) > 7000) {
      return { ok: false, kind: 'validation', message: 'manifest is too large to publish as a runtime app — remove bulky fields (screenshots/changelog) or shorten description/permissions' };
    }


    let size = 0;
    try { size = fs.statSync(archiveTmp).size; } catch { /* server validates the upload */ }
    process.stdout.write(`Uploading + pushing (mediated, ${size} bytes) …\n`);
    const res = await p.fetchImpl(`${apiBase(p.auth.commonApiUrl)}/tileapps/personal/publish-image`, {
      method: 'POST',
      headers: {
        'content-type': 'application/octet-stream',
        authorization: `Bearer ${p.auth.userToken}`,
        'x-tileapp-manifest': manifestHeader,
      },
      body: fs.createReadStream(archiveTmp),
      // Node/undici requires duplex for a streaming request body.
      duplex: 'half',
    } as Parameters<FetchLike>[1]);
    if (!res.ok) return { ok: false, kind: 'http', message: `publish-image failed: HTTP ${res.status} — ${await safeText(res)}` };
    const json = (await res.json()) as { appId?: string; ref?: string; tag?: string; digest?: string };
    if (!json.appId) return { ok: false, kind: 'http', message: 'publish-image response missing appId' };
    return {
      ok: true,
      output: `Published runtime app ${json.appId}\n  image: ${json.ref}:${json.tag}@${json.digest}\n  next: install it + add a tile (studio.install_app / studio.create_app_tile).`,
    };
  } catch (e) {
    return { ok: false, kind: 'http', message: `publish-image request failed: ${(e as Error).message}` };
  } finally {
    try { fs.unlinkSync(archiveTmp); } catch { /* best effort */ }
    if (ociTmpDir) { try { fs.rmSync(ociTmpDir, { recursive: true, force: true }); } catch { /* best effort */ } }
  }
}
