/**
 * Project-shape detection for `yolo deploy` (spec
 * `docs/MANAGED_HOSTING_CLI_SPEC.md` §2, `deploy-detect`).
 *
 * Pure DETECTION — running the build command belongs to the ship
 * orchestration; this module only RETURNS `buildCommand` when one
 * applies. First hit wins, in spec order:
 *
 *   1. `.yolo/deploy.json` with `type` → authoritative.
 *   2. `wrangler.jsonc|toml` — read `main` + `assets.directory` via a
 *      minimal jsonc comment-strip / toml key-extract (NO new deps).
 *      `main` ⇒ worker; assets-only wrangler config ⇒ static.
 *   3. `package.json` with a `build` script (npm/pnpm/yarn/bun chosen
 *      via lockfile) → static, output dir resolved as
 *      `config build.outputDir` > first of dist/build/out/public/_site
 *      containing index.html. No resolvable output dir ⇒ fall through
 *      (a TS worker repo with a `build` script must still reach step 5).
 *   4. Plain static: `dist/` or `public/` containing index.html, or the
 *      cwd itself when it has a root index.html and no package.json.
 *   5. `src/index.ts|js` matching `export default` + `fetch(` → worker
 *      (esbuild handles TS at bundle time).
 *   6. `FAIL [detect-failed]` + the init hint.
 *
 * Everything is driven through the injectable `readFileImpl`
 * (auth-context convention) — existence checks are "can I read the
 * marker file", so unit tests can run against pure in-memory maps and
 * integration tests against tmp-dir fixtures.
 */

import { readFileSync } from 'node:fs';
import path from 'node:path';

import type { ReadFileImpl } from './auth-context.js';
import { readDeployConfig, type DeployConfig } from './deploy-config.js';

// ─── Public types ─────────────────────────────────────────────────────────

export type ProjectShape =
  | { type: 'static'; assetsDir: string; buildCommand?: string }
  // `prebuilt` is set ONLY when deploy.json explicitly points worker.entry at
  // a built .js/.mjs module (the vinext/OpenNext path) — those ship as-is.
  // Auto-detected (src/index.js) and wrangler `main` entries are SOURCE and
  // must go through esbuild so their imports are bundled (codex P2 r6).
  | { type: 'worker'; entry: string; assetsDir?: string; buildCommand?: string; prebuilt?: boolean };

/** Which detection step produced the shape (progress lines + tests). */
export type DetectSource =
  | 'deploy-json'
  | 'wrangler'
  | 'package-build'
  | 'plain-static'
  | 'worker-entry';

export type DetectResult =
  | { ok: true; shape: ProjectShape; source: DetectSource }
  | { ok: false; kind: 'detect-failed'; message: string };

export interface DetectOptions {
  cwd: string;
  /**
   * Pre-read deploy config. `undefined` ⇒ detect reads
   * `.yolo/deploy.json` itself; `null` ⇒ caller asserts there is none.
   */
  config?: DeployConfig | null;
  readFileImpl?: ReadFileImpl;
}

export const DETECT_INIT_HINT = "run 'yolo deploy init --type static|worker'";

const OUTPUT_DIR_CANDIDATES = ['dist', 'build', 'out', 'public', '_site'];
const WORKER_ENTRY_CANDIDATES = ['src/index.ts', 'src/index.js'];

// ─── Public entry ─────────────────────────────────────────────────────────

export function detectProjectShape(options: DetectOptions): DetectResult {
  const { cwd } = options;
  const read = options.readFileImpl ?? defaultReadFile;

  // Resolve the deploy config (step-1 input AND the outputDir/command
  // overrides steps 3 uses even when `type` is unset).
  let config: DeployConfig | null;
  if (options.config !== undefined) {
    config = options.config;
  } else {
    const result = readDeployConfig(cwd, read);
    if (!result.ok) {
      // A malformed/invalid deploy.json is an explicit user artifact —
      // heuristics must not silently override it.
      return fail(result.message);
    }
    config = result.config;
  }

  // Package build command — computed up front so the pinned-static branch can
  // fall back to it (codex P2 r11), same as the untyped package-build path.
  const pkg = readPackageJson(cwd, read);
  const pkgBuildCommand = pkg?.scripts?.build !== undefined ? buildCommandFor(cwd, read) : undefined;

  // ── 1. deploy.json `type` is authoritative ─────────────────────────────
  if (config?.type === 'static') {
    const buildCommand = config.build?.command ?? pkgBuildCommand;
    const assetsDir =
      config.build?.outputDir ??
      resolveOutputDir(cwd, read) ??
      (read(path.join(cwd, 'index.html')) !== undefined ? '.' : undefined) ??
      // A clean checkout whose build hasn't run yet: with a build command we
      // can default the output dir (build creates it, then bundle reads it) —
      // `yolo deploy init --type static` writes the pin but no build.command.
      (buildCommand !== undefined ? OUTPUT_DIR_CANDIDATES[0] : undefined);
    if (assetsDir === undefined) {
      return fail(
        ".yolo/deploy.json sets type 'static' but no output dir was found: set build.outputDir, add a package.json build script, or build the project so one of " +
          `${OUTPUT_DIR_CANDIDATES.join('/')} contains index.html`,
      );
    }
    return hit(
      {
        type: 'static',
        assetsDir,
        ...optional('buildCommand', buildCommand),
      },
      'deploy-json',
    );
  }
  if (config?.type === 'worker') {
    const explicitEntry = config.worker?.entry;
    const entry = explicitEntry ?? findWorkerEntry(cwd, read, /* requireSignature */ false);
    if (entry === undefined) {
      return fail(
        ".yolo/deploy.json sets type 'worker' but no entry was found: set worker.entry (source or a pre-built .js/.mjs module)",
      );
    }
    // Prebuilt skip is OPT-IN via deploy.json worker.prebuilt (codex P2 r9) —
    // the extension is not a reliable signal (a built bundle and a source
    // file can both be .js, and skipping esbuild on source drops its
    // imports). Only an explicitly-set entry can be prebuilt.
    const prebuilt = config.worker?.prebuilt === true && explicitEntry !== undefined;
    return hit(
      {
        type: 'worker',
        entry,
        ...(prebuilt && { prebuilt: true }),
        ...optional('assetsDir', config.worker?.assetsDir),
        // Symmetric with the static branch + the wrangler branch: fall back to
        // the package.json build script when deploy.json omits an explicit
        // build.command. Without this, an explicit-worker project would NOT
        // auto-build (the asymmetry users hit — static built, worker didn't),
        // and a `prebuilt` worker whose dist is produced by `npm run build`
        // (no explicit build.command) would ship a missing entry.
        ...optional('buildCommand', config.build?.command ?? pkgBuildCommand),
      },
      'deploy-json',
    );
  }

  // pkg / pkgBuildCommand are computed above (reused by steps 2–6).

  // ── 2. wrangler.jsonc / wrangler.toml ──────────────────────────────────
  const wrangler = readWranglerConfig(cwd, read);
  if (wrangler !== undefined) {
    const buildCommand = config?.build?.command ?? pkgBuildCommand;
    if (wrangler.main !== undefined) {
      return hit(
        {
          type: 'worker',
          entry: wrangler.main,
          ...optional('assetsDir', wrangler.assetsDirectory),
          ...optional('buildCommand', buildCommand),
        },
        'wrangler',
      );
    }
    if (wrangler.assetsDirectory !== undefined) {
      // Assets-only wrangler project (no `main`) — nothing to bundle as
      // a module; ship it static and let common-api attach the shim.
      return hit(
        {
          type: 'static',
          assetsDir: wrangler.assetsDirectory,
          ...optional('buildCommand', buildCommand),
        },
        'wrangler',
      );
    }
    // wrangler file present but carries neither key — fall through.
  }

  // ── 3. package.json `build` script → static ────────────────────────────
  if (pkgBuildCommand !== undefined) {
    const outputDir = config?.build?.outputDir ?? resolveOutputDir(cwd, read);
    if (outputDir !== undefined) {
      return hit(
        {
          type: 'static',
          assetsDir: outputDir,
          buildCommand: config?.build?.command ?? pkgBuildCommand,
        },
        'package-build',
      );
    }
    // Build script but no resolvable output dir — keep falling: this may
    // be a worker repo whose `build` is typecheck/compile (step 5).
  }

  // ── 4. plain static ─────────────────────────────────────────────────────
  for (const dir of ['dist', 'public']) {
    if (read(path.join(cwd, dir, 'index.html')) !== undefined) {
      return hit({ type: 'static', assetsDir: dir }, 'plain-static');
    }
  }
  if (read(path.join(cwd, 'index.html')) !== undefined && pkg === undefined) {
    return hit({ type: 'static', assetsDir: '.' }, 'plain-static');
  }

  // ── 5. worker entry signature ───────────────────────────────────────────
  const entry = findWorkerEntry(cwd, read, /* requireSignature */ true);
  if (entry !== undefined) {
    return hit({ type: 'worker', entry }, 'worker-entry');
  }

  // ── 6. build-script static with no output yet (clean checkout) ──────────
  // Detection is offline and runs BEFORE the build, so a fresh static app's
  // output dir doesn't exist yet (codex P2 r8). We've now ruled out a worker
  // entry, so a `build` script means static: default the assets dir to the
  // configured value or `dist`. The orchestrator runs the build, then bundle
  // reads it — a wrong guess fails later with a clear "assets dir not found"
  // pointing the user to set build.outputDir.
  if (pkgBuildCommand !== undefined) {
    return hit(
      {
        type: 'static',
        assetsDir: config?.build?.outputDir ?? OUTPUT_DIR_CANDIDATES[0]!,
        buildCommand: config?.build?.command ?? pkgBuildCommand,
      },
      'package-build',
    );
  }

  // ── 6. detect-failed ────────────────────────────────────────────────────
  return fail(
    `could not detect a deployable project in ${cwd}: no .yolo/deploy.json type, ` +
      'wrangler config, build script with an output dir, static dir with index.html, ' +
      'or src/index.ts|js worker entry',
  );
}

// ─── Detection internals ──────────────────────────────────────────────────

interface PackageJsonShape {
  scripts?: Record<string, unknown>;
}

function readPackageJson(cwd: string, read: ReadFileImpl): PackageJsonShape | undefined {
  const text = read(path.join(cwd, 'package.json'));
  if (text === undefined) return undefined;
  try {
    const parsed = JSON.parse(text) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as PackageJsonShape;
  } catch {
    return undefined;
  }
}

/** Package-manager-aware `run build`, chosen via lockfile presence. */
function buildCommandFor(cwd: string, read: ReadFileImpl): string {
  if (read(path.join(cwd, 'pnpm-lock.yaml')) !== undefined) return 'pnpm run build';
  if (read(path.join(cwd, 'yarn.lock')) !== undefined) return 'yarn run build';
  if (read(path.join(cwd, 'bun.lockb')) !== undefined || read(path.join(cwd, 'bun.lock')) !== undefined) {
    return 'bun run build';
  }
  return 'npm run build';
}

function resolveOutputDir(cwd: string, read: ReadFileImpl): string | undefined {
  for (const dir of OUTPUT_DIR_CANDIDATES) {
    if (read(path.join(cwd, dir, 'index.html')) !== undefined) return dir;
  }
  return undefined;
}

/**
 * Find a conventional worker entry. With `requireSignature` (step 5)
 * the file must contain both `export default` and `fetch(`; without it
 * (deploy.json says worker but omitted `entry`) existence is enough.
 */
function findWorkerEntry(cwd: string, read: ReadFileImpl, requireSignature: boolean): string | undefined {
  for (const candidate of WORKER_ENTRY_CANDIDATES) {
    const content = read(path.join(cwd, ...candidate.split('/')));
    if (content === undefined) continue;
    if (!requireSignature) return candidate;
    if (/export\s+default/.test(content) && content.includes('fetch(')) return candidate;
  }
  return undefined;
}

// ─── wrangler config extraction (minimal, no deps) ───────────────────────

// Wrangler binding stanzas we recognize. We only DETECT their presence (to
// warn) — we NEVER import them: wrangler bindings reference the user's OWN
// Cloudflare account resources, which don't exist in YOLO Host's tenancy.
// D1/KV/R2 are re-provisionable through our deploy.* tools; the rest are
// unsupported on the platform.
const PROVISIONABLE_BINDING_KEYS: Record<string, string> = {
  d1_databases: 'D1',
  kv_namespaces: 'KV',
  r2_buckets: 'R2',
};
const UNSUPPORTED_BINDING_KEYS = [
  'durable_objects',
  'queues',
  'services',
  'service', // defensive: the canonical key is `services`, but accept singular too
  'hyperdrive',
  'vectorize',
  'ai',
  'analytics_engine_datasets',
  'dispatch_namespaces',
  'mtls_certificates',
  'send_email',
  'browser',
  'workflows',
  'pipelines',
  'version_metadata',
  'unsafe',
  'wasm_modules',
  'text_blobs',
  'data_blobs',
];
const ALL_BINDING_KEYS = [...Object.keys(PROVISIONABLE_BINDING_KEYS), ...UNSUPPORTED_BINDING_KEYS];

/**
 * Binding stanzas present-and-non-empty in a parsed JSON wrangler config —
 * including per-environment overrides under `env.<name>` (codex P2), since
 * wrangler lets bindings live there with no top-level equivalent.
 */
function detectJsonBindingKinds(parsed: Record<string, unknown>): string[] {
  const nonEmpty = (v: unknown) =>
    Array.isArray(v) ? v.length > 0 : v !== null && typeof v === 'object' ? Object.keys(v).length > 0 : Boolean(v);
  const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === 'object' && !Array.isArray(v);
  const found = new Set<string>();
  const scan = (obj: Record<string, unknown>) => {
    for (const k of ALL_BINDING_KEYS) if (nonEmpty(obj[k])) found.add(k);
  };
  scan(parsed);
  if (isObj(parsed.env)) for (const envCfg of Object.values(parsed.env)) if (isObj(envCfg)) scan(envCfg);
  return [...found];
}

/**
 * Binding stanzas present in a toml wrangler config — detected by SECTION
 * HEADER (`[[d1_databases]]`, `[queues.producers]`, `[ai]`), not parsed, and
 * including env-scoped sections (`[[env.production.kv_namespaces]]`). The
 * minimal toml reader can't read the values, but it can notice the keys exist:
 * any segment of the dotted section name that is a known binding key counts.
 */
function detectTomlBindingKinds(text: string): string[] {
  const found = new Set<string>();
  for (const raw of text.split('\n')) {
    // Capture the full dotted section name incl. hyphenated env names
    // (`[[env.prod-us.kv_namespaces]]`) before splitting on '.' (codex P3).
    const m = /^\[+([A-Za-z0-9_.-]+)/.exec(raw.trim());
    if (!m) continue;
    const segs = m[1]!.split('.');
    // The binding key is POSITIONAL, not "any segment": top-level `[[key]]` →
    // segs[0]; env-scoped `[[env.<name>.key]]` → segs[2]. Scanning every
    // segment would mis-read an env NAMED after a binding (`[env.ai.vars]`,
    // `[env.queues.vars]`) as a binding (codex P3).
    const key = segs[0] === 'env' ? segs[2] : segs[0];
    if (key && ALL_BINDING_KEYS.includes(key)) found.add(key);
  }
  return [...found];
}

interface WranglerKeys {
  main?: string;
  assetsDirectory?: string;
  /** Only resolved from the JSON forms (toml array parsing is out of scope). */
  compatibilityFlags?: string[];
  /** Binding stanza keys present (detected, never imported). */
  bindingKinds?: string[];
  /** Which wrangler file the keys came from (for adapter messaging). */
  sourceFile?: string;
}

function readWranglerConfig(cwd: string, read: ReadFileImpl): WranglerKeys | undefined {
  const jsoncName = read(path.join(cwd, 'wrangler.jsonc')) !== undefined ? 'wrangler.jsonc' : 'wrangler.json';
  const jsoncText = read(path.join(cwd, 'wrangler.jsonc')) ?? read(path.join(cwd, 'wrangler.json'));
  if (jsoncText !== undefined) {
    const parsed = parseJsonc(jsoncText);
    if (parsed !== undefined) {
      const main = typeof parsed.main === 'string' ? parsed.main : undefined;
      const assets = parsed.assets;
      const assetsDirectory =
        assets !== null && typeof assets === 'object' && !Array.isArray(assets) &&
        typeof (assets as Record<string, unknown>).directory === 'string'
          ? ((assets as Record<string, unknown>).directory as string)
          : undefined;
      const compatibilityFlags = Array.isArray(parsed.compatibility_flags)
        ? (parsed.compatibility_flags.filter((f) => typeof f === 'string') as string[])
        : undefined;
      const bindingKinds = detectJsonBindingKinds(parsed);
      return {
        main,
        assetsDirectory,
        ...(compatibilityFlags && compatibilityFlags.length > 0 ? { compatibilityFlags } : {}),
        ...(bindingKinds.length > 0 ? { bindingKinds } : {}),
        sourceFile: jsoncName,
      };
    }
    // Unparseable wrangler file: treat as absent (fall through to toml).
  }
  const tomlText = read(path.join(cwd, 'wrangler.toml'));
  if (tomlText !== undefined) {
    const bindingKinds = detectTomlBindingKinds(tomlText);
    return {
      ...extractTomlKeys(tomlText),
      ...(bindingKinds.length > 0 ? { bindingKinds } : {}),
      sourceFile: 'wrangler.toml',
    };
  }
  return undefined;
}

/**
 * Adapt an existing wrangler config into the canonical `.yolo/deploy.json`
 * shape — the migration `yolo deploy init` performs once when a project has a
 * wrangler config but no deploy.json. Returns the deploy.json fields to merge,
 * the source filename, what was migrated, and any honesty warnings (e.g. toml
 * compatibility_flags aren't parsed by our minimal reader). Returns undefined
 * when no wrangler config is present or it carries nothing adaptable.
 */
export function adaptWrangler(
  cwd: string,
  readFileImpl?: ReadFileImpl,
): { config: Partial<DeployConfig>; sourceFile: string; migrated: string[]; warnings: string[] } | undefined {
  const read = readFileImpl ?? defaultReadFile;
  const w = readWranglerConfig(cwd, read);
  if (w === undefined || w.sourceFile === undefined) return undefined;

  const config: Partial<DeployConfig> = {};
  const migrated: string[] = [];
  const warnings: string[] = [];

  if (w.main !== undefined) {
    config.type = 'worker';
    config.worker = { entry: w.main, ...(w.assetsDirectory !== undefined ? { assetsDir: w.assetsDirectory } : {}) };
    migrated.push(`type=worker`, `worker.entry=${w.main}`);
    if (w.assetsDirectory !== undefined) migrated.push(`worker.assetsDir=${w.assetsDirectory}`);
  } else if (w.assetsDirectory !== undefined) {
    config.type = 'static';
    config.build = { outputDir: w.assetsDirectory };
    migrated.push(`type=static`, `build.outputDir=${w.assetsDirectory}`);
  }

  if (w.compatibilityFlags && w.compatibilityFlags.length > 0) {
    config.compatibilityFlags = w.compatibilityFlags;
    migrated.push(`compatibilityFlags=[${w.compatibilityFlags.join(', ')}]`);
  } else if (w.sourceFile === 'wrangler.toml') {
    // The minimal toml reader extracts only top-level main/[assets].directory,
    // not the compatibility_flags array — be honest rather than silently drop.
    warnings.push(
      'compatibility_flags (if any) were NOT read from wrangler.toml — add them to .yolo/deploy.json `compatibilityFlags` manually if your Worker needs them (e.g. nodejs_compat)',
    );
  }

  // Binding stanzas are NEVER imported (they reference the user's own CF
  // account). Warn so a declared D1/KV/R2 doesn't silently leave env.<NAME>
  // undefined at runtime, and so unsupported bindings aren't assumed to work.
  if (w.bindingKinds && w.bindingKinds.length > 0) {
    const provisionable = w.bindingKinds
      .filter((k) => k in PROVISIONABLE_BINDING_KEYS)
      .map((k) => PROVISIONABLE_BINDING_KEYS[k]);
    const unsupported = w.bindingKinds.filter((k) => !(k in PROVISIONABLE_BINDING_KEYS));
    if (provisionable.length > 0) {
      warnings.push(
        `wrangler config declares ${provisionable.join(', ')} binding(s) — NOT imported (they reference your own Cloudflare account); ` +
          'provision them on YOLO Host with deploy.db_provision / deploy.kv_create / deploy.bucket_create so env.<NAME> exists at runtime',
      );
    }
    if (unsupported.length > 0) {
      warnings.push(`wrangler config declares ${unsupported.join(', ')} which YOLO Host does not support — dropped`);
    }
  }

  if (migrated.length === 0) return undefined;
  return { config, sourceFile: w.sourceFile, migrated, warnings };
}

/**
 * Minimal jsonc: strip line and block comments outside string
 * literals, drop trailing commas, then JSON.parse. NOT a general jsonc
 * parser — exactly enough for wrangler configs, by spec.
 */
function parseJsonc(text: string): Record<string, unknown> | undefined {
  let out = '';
  let i = 0;
  let inString = false;
  while (i < text.length) {
    const c = text[i]!;
    if (inString) {
      out += c;
      if (c === '\\') {
        out += text[i + 1] ?? '';
        i += 2;
        continue;
      }
      if (c === '"') inString = false;
      i++;
      continue;
    }
    if (c === '"') {
      inString = true;
      out += c;
      i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (c === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += c;
    i++;
  }
  out = out.replace(/,\s*([}\]])/g, '$1');
  try {
    const parsed = JSON.parse(out) as unknown;
    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) return undefined;
    return parsed as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/**
 * Minimal toml: line-based extraction of top-level `main = "…"` and
 * `[assets] directory = "…"`. NOT a toml parser — exactly the two keys
 * the spec names, by spec.
 */
function extractTomlKeys(text: string): WranglerKeys {
  let section = '';
  let main: string | undefined;
  let assetsDirectory: string | undefined;
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const sectionMatch = /^\[([^\]]+)\]/.exec(line);
    if (sectionMatch) {
      section = sectionMatch[1]!.trim();
      continue;
    }
    const kv =
      /^([A-Za-z0-9_-]+)\s*=\s*"([^"]*)"/.exec(line) ?? /^([A-Za-z0-9_-]+)\s*=\s*'([^']*)'/.exec(line);
    if (!kv) continue;
    if (section === '' && kv[1] === 'main' && main === undefined) main = kv[2];
    if (section === 'assets' && kv[1] === 'directory' && assetsDirectory === undefined) {
      assetsDirectory = kv[2];
    }
  }
  return { main, assetsDirectory };
}

// ─── Helpers ──────────────────────────────────────────────────────────────

function hit(shape: ProjectShape, source: DetectSource): DetectResult {
  return { ok: true, shape, source };
}

function fail(message: string): DetectResult {
  return { ok: false, kind: 'detect-failed', message: `${message} | hint: ${DETECT_INIT_HINT}` };
}

/** Conditional-spread helper so absent optionals are OMITTED, not `undefined`. */
function optional<K extends string, V>(key: K, value: V | undefined): Partial<Record<K, V>> {
  return value === undefined ? {} : ({ [key]: value } as Record<K, V>);
}

function defaultReadFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
