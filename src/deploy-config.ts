/**
 * `.yolo/deploy.json` — the durable project↔hosting link (spec
 * `docs/MANAGED_HOSTING_CLI_SPEC.md` §3).
 *
 * COMMITTED by design (the wrangler-config analog): gitignored `.yolo/`
 * entries are per-machine state; `deploy.json` is durable shared
 * identity so future sessions/teammates/CI ship to the SAME project
 * instead of forking a new slug. No secrets live in it — the credential
 * is the session JWT; `projectId` is non-secret and ownership-checked
 * server-side on every call.
 *
 * Canonical write shape (mirrors `lockfile.ts` write discipline):
 *   - JSON, 2-space indent, single trailing `\n`.
 *   - Fixed key order per the spec example: $version, projectId, slug,
 *     type, build{command,outputDir}, worker{entry,assetsDir},
 *     compatibilityFlags, bindings. Absent optional fields are omitted.
 *   - Same input → byte-identical output (idempotent re-write).
 *
 * Validation is lenient on PRESENCE (only `$version` is required —
 * `init` may write a partial link before detection fills the rest) but
 * strict on TYPES: a present field with the wrong shape is a structured
 * error, never silently coerced. Unknown keys are tolerated (forward
 * compat — a newer deploy.json must not be rejected by an older CLI) and
 * dropped by the canonical writer, but they are NO LONGER SILENT: each is
 * returned as a non-fatal `warning` so a misspelled or unsupported field
 * (e.g. `compatibilityDate`, which the platform fixes and does not read)
 * surfaces in `yolo deploy validate` instead of misleading the author.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';

import type { ReadFileImpl } from './auth-context.js';

// ─── Public types ─────────────────────────────────────────────────────────

export interface DeployBuildConfig {
  /** Build command run before bundling (e.g. `npm run build`). */
  command?: string;
  /** Static output dir relative to project root (e.g. `dist`). */
  outputDir?: string;
}

export interface DeployWorkerConfig {
  /**
   * Worker entry relative to project root. By default it's treated as SOURCE
   * and esbuild bundles it (so relative imports come along). Set
   * `prebuilt: true` to ship `entry` byte-for-byte without esbuild — for a
   * self-contained build output (vinext/OpenNext). Extension alone is NOT a
   * reliable signal: a built bundle and a source file can both be `.js`
   * (codex P2 r9).
   */
  entry?: string;
  /**
   * Ship `entry` as-is, skipping esbuild. Only for a self-contained built
   * module — a source file with relative imports would lose its deps.
   */
  prebuilt?: boolean;
  /** Static assets shipped alongside the worker (e.g. `.vinext/assets`). */
  assetsDir?: string;
}

export interface DeployBinding {
  /** Resource kind (`d1`, `r2`, `kv`, …). */
  kind: string;
  /** The binding name the worker code sees (e.g. `DB`). */
  binding: string;
  /** Extra provisioning hints are tolerated and preserved. */
  [key: string]: unknown;
}

export interface DeployConfig {
  $version: 1;
  /** The durable link (`hp_…`). Absent until `yolo deploy init` links. */
  projectId?: string;
  /** Informational; the server is the source of truth. */
  slug?: string;
  type?: 'static' | 'worker';
  build?: DeployBuildConfig;
  worker?: DeployWorkerConfig;
  /** Passed through ship/start → WfP upload metadata (Next.js needs `nodejs_compat`). */
  compatibilityFlags?: string[];
  /** Binding EXPECTATIONS; mismatch at ship is a warning, not a failure. */
  bindings?: DeployBinding[];
}

export interface DeployConfigValidationError {
  /** Dotted field path, e.g. `build.outputDir` or `bindings[1].binding`. */
  path: string;
  message: string;
}

export type ValidateDeployConfigResult =
  /** `warnings` carries non-fatal advisories (e.g. unknown/ignored fields); always present on success, may be empty. */
  | { ok: true; config: DeployConfig; warnings: DeployConfigValidationError[] }
  | { ok: false; errors: DeployConfigValidationError[] };

export type ReadDeployConfigResult =
  /** `config: null` ⇒ no `.yolo/deploy.json` exists (not an error — first-ship case). `warnings` ⇒ non-fatal advisories. */
  | { ok: true; config: DeployConfig | null; path: string; warnings: DeployConfigValidationError[] }
  | {
      ok: false;
      kind: 'malformed' | 'invalid';
      path: string;
      message: string;
      errors?: DeployConfigValidationError[];
    };

export class DeployConfigError extends Error {
  readonly code: 'invalid' | 'unwritable';
  readonly errors?: DeployConfigValidationError[];
  constructor(message: string, code: DeployConfigError['code'], errors?: DeployConfigValidationError[]) {
    super(message);
    this.name = 'DeployConfigError';
    this.code = code;
    this.errors = errors;
  }
}

// ─── Public API ───────────────────────────────────────────────────────────

/** Resolve the deploy.json path for a project root. */
export function deployConfigPath(cwd: string): string {
  return path.join(cwd, '.yolo', 'deploy.json');
}

/** An ancestor directory that is already linked to a hosting project. */
export interface AncestorDeployLink {
  projectId: string;
  slug?: string;
  /** The ancestor directory itself (not the `.yolo` path). */
  dir: string;
  /** Its `.yolo/deploy.json`, for the message that explains the inference. */
  path: string;
}

/** How far up to look before giving up. A backstop against a pathological tree. */
const ANCESTOR_WALK_MAX_DEPTH = 24;

/**
 * Walk UP from `cwd` looking for an ancestor already linked to a hosting project.
 *
 * WHY: `yolo deploy init` inside `apps/api` mints a fully independent project
 * named after the directory — which is exactly how `El Paso Ballroom API` came
 * to exist as an unrelated top-level card next to the site it serves. The
 * relationship already exists in the filesystem; nothing recorded it. This finds
 * it so `init` can offer it (nesting plan §10 S4).
 *
 * 🚨 THE STOP CONDITIONS ARE THE DESIGN. An unbounded walk is actively harmful:
 *
 *   - **Never `cwd` itself.** That is the already-linked case, which `init`
 *     handles separately; treating it as an ancestor would make every project
 *     its own parent.
 *   - **Stop at a `.git` directory.** That is the repo boundary and therefore
 *     the monorepo boundary. The repo root is CHECKED first and only then
 *     becomes a stopping point, so a deployed monorepo root is still found.
 *   - **Stop BEFORE `$HOME`, and never inspect it.** Someone who once ran
 *     `yolo deploy init` in their home directory would otherwise have every
 *     future project on the machine silently adopted by that one — a
 *     machine-wide capture from a single stray file.
 *   - **Depth cap** as a backstop, and the filesystem root always terminates.
 *
 * Pure and injectable so the walk is testable without touching a real tree.
 */
export function findAncestorDeployLink(
  cwd: string,
  readFileImpl: ReadFileImpl = defaultReadFile,
  opts: {
    /** Absolute path to the user's home. Omit to disable the home guard. */
    home?: string;
    existsImpl?: (p: string) => boolean;
    maxDepth?: number;
  } = {},
): AncestorDeployLink | null {
  const exists = opts.existsImpl ?? ((p: string) => existsSync(p));
  const maxDepth = opts.maxDepth ?? ANCESTOR_WALK_MAX_DEPTH;
  const home = opts.home ? path.resolve(opts.home) : undefined;

  const start = path.resolve(cwd);
  // The repo boundary applies to `cwd` ITSELF (codex P2). Running `init` at the
  // root of a nested repository would otherwise begin the walk one level ABOVE
  // it and adopt a parent from the enclosing tree — crossing exactly the
  // boundary the ancestor-level check below exists to hold.
  if (exists(path.join(start, '.git'))) return null;

  let dir = path.dirname(start);
  for (let depth = 0; depth < maxDepth; depth += 1) {
    // Home is a hard FLOOR: reaching it ends the walk, and it is never
    // inspected. Walking upward from anywhere inside home always arrives here
    // before `/`, so this one check covers the whole case — an earlier version
    // tried to test "is dir inside home" and had the sense inverted, which
    // refused every directory UNDER home and quietly disabled the feature for
    // every user whose repos live there (i.e. almost all of them).
    if (home && dir === home) return null;

    const filePath = deployConfigPath(dir);
    const text = readFileImpl(filePath);
    if (text !== undefined && text.trim() !== '') {
      try {
        const parsed = JSON.parse(text) as { projectId?: unknown; slug?: unknown };
        if (typeof parsed.projectId === 'string' && parsed.projectId.length > 0) {
          return {
            projectId: parsed.projectId,
            ...(typeof parsed.slug === 'string' && parsed.slug ? { slug: parsed.slug } : {}),
            dir,
            path: filePath,
          };
        }
      } catch {
        // A malformed ancestor link is not this command's problem to report —
        // it belongs to that directory, and failing `init` here would block a
        // child on a file the user may not even know exists. Keep walking.
      }
    }

    // Repo boundary. Checked AFTER the link above so a deployed monorepo root
    // still counts as an ancestor.
    if (exists(path.join(dir, '.git'))) return null;

    const parent = path.dirname(dir);
    if (parent === dir) return null; // filesystem root
    dir = parent;
  }
  return null;
}

/**
 * Read `.yolo/deploy.json` from a project root. Absent file is the
 * non-error `{ ok: true, config: null }` case (detection falls through
 * to heuristics); malformed JSON or schema violations are structured
 * failures so the CLI can print `FAIL [<reason>]` with field paths.
 */
export function readDeployConfig(
  cwd: string,
  readFileImpl: ReadFileImpl = defaultReadFile,
): ReadDeployConfigResult {
  const filePath = deployConfigPath(cwd);
  const text = readFileImpl(filePath);
  if (text === undefined) return { ok: true, config: null, path: filePath, warnings: [] };
  if (text.trim() === '') return { ok: true, config: null, path: filePath, warnings: [] };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      kind: 'malformed',
      path: filePath,
      message: `malformed JSON in ${filePath}: ${msg}`,
    };
  }

  const validated = validateDeployConfig(parsed);
  if (!validated.ok) {
    return {
      ok: false,
      kind: 'invalid',
      path: filePath,
      message:
        `invalid deploy config at ${filePath}: ` +
        validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      errors: validated.errors,
    };
  }
  return { ok: true, config: validated.config, path: filePath, warnings: validated.warnings };
}

/**
 * Write `.yolo/deploy.json` in canonical form (2-space JSON, fixed key
 * order, trailing newline). Creates `.yolo/` if missing. Validates
 * before touching disk and throws `DeployConfigError` on an invalid
 * config or fs failure — a half-written link file is worse than none.
 */
export function writeDeployConfig(cwd: string, config: DeployConfig): string {
  const validated = validateDeployConfig(config);
  if (!validated.ok) {
    throw new DeployConfigError(
      'refusing to write invalid deploy config: ' +
        validated.errors.map((e) => `${e.path}: ${e.message}`).join('; '),
      'invalid',
      validated.errors,
    );
  }
  const filePath = deployConfigPath(cwd);
  const dir = path.dirname(filePath);
  try {
    mkdirSync(dir, { recursive: true });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeployConfigError(`could not create ${dir}: ${msg}`, 'unwritable');
  }
  const text = JSON.stringify(canonicalize(validated.config), null, 2) + '\n';
  try {
    writeFileSync(filePath, text, 'utf8');
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new DeployConfigError(`could not write ${filePath}: ${msg}`, 'unwritable');
  }
  return filePath;
}

/**
 * Schema validation per spec §3. Returns the value typed as
 * `DeployConfig` on success or a full list of structured errors (all
 * violations, not just the first) on failure. Pure — no I/O.
 */
export function validateDeployConfig(value: unknown): ValidateDeployConfigResult {
  const errors: DeployConfigValidationError[] = [];
  if (value === null || typeof value !== 'object' || Array.isArray(value)) {
    return { ok: false, errors: [{ path: '$', message: `must be a JSON object, got ${describe(value)}` }] };
  }
  const obj = value as Record<string, unknown>;

  if (obj.$version !== 1) {
    errors.push({ path: '$version', message: `must be the number 1, got ${describe(obj.$version)}` });
  }
  checkOptionalString(obj, 'projectId', errors);
  checkOptionalString(obj, 'slug', errors);
  if (obj.type !== undefined && obj.type !== 'static' && obj.type !== 'worker') {
    errors.push({ path: 'type', message: `must be 'static' or 'worker', got ${describe(obj.type)}` });
  }

  if (obj.build !== undefined) {
    if (!isPlainObject(obj.build)) {
      errors.push({ path: 'build', message: `must be an object, got ${describe(obj.build)}` });
    } else {
      checkOptionalString(obj.build, 'command', errors, 'build.');
      checkOptionalString(obj.build, 'outputDir', errors, 'build.');
    }
  }

  if (obj.worker !== undefined) {
    if (!isPlainObject(obj.worker)) {
      errors.push({ path: 'worker', message: `must be an object, got ${describe(obj.worker)}` });
    } else {
      checkOptionalString(obj.worker, 'entry', errors, 'worker.');
      checkOptionalString(obj.worker, 'assetsDir', errors, 'worker.');
      if (obj.worker.prebuilt !== undefined && typeof obj.worker.prebuilt !== 'boolean') {
        errors.push({ path: 'worker.prebuilt', message: `must be a boolean, got ${describe(obj.worker.prebuilt)}` });
      }
    }
  }

  if (obj.compatibilityFlags !== undefined) {
    if (!Array.isArray(obj.compatibilityFlags)) {
      errors.push({
        path: 'compatibilityFlags',
        message: `must be an array of strings, got ${describe(obj.compatibilityFlags)}`,
      });
    } else {
      obj.compatibilityFlags.forEach((flag, i) => {
        if (typeof flag !== 'string' || flag.trim() === '') {
          errors.push({ path: `compatibilityFlags[${i}]`, message: `must be a non-empty string, got ${describe(flag)}` });
        }
      });
    }
  }

  if (obj.bindings !== undefined) {
    if (!Array.isArray(obj.bindings)) {
      errors.push({ path: 'bindings', message: `must be an array, got ${describe(obj.bindings)}` });
    } else {
      obj.bindings.forEach((b, i) => {
        if (!isPlainObject(b)) {
          errors.push({ path: `bindings[${i}]`, message: `must be an object, got ${describe(b)}` });
          return;
        }
        if (typeof b.kind !== 'string' || b.kind.trim() === '') {
          errors.push({ path: `bindings[${i}].kind`, message: `must be a non-empty string, got ${describe(b.kind)}` });
        }
        if (typeof b.binding !== 'string' || b.binding.trim() === '') {
          errors.push({ path: `bindings[${i}].binding`, message: `must be a non-empty string, got ${describe(b.binding)}` });
        }
      });
    }
  }

  if (errors.length > 0) return { ok: false, errors };
  return { ok: true, config: obj as unknown as DeployConfig, warnings: collectUnknownKeyWarnings(obj) };
}

// Known schema keys per level. Unknown keys are tolerated (forward compat) but
// surfaced as warnings so a silently-ignored field doesn't mislead the author.
// `bindings[]` entries intentionally allow extra keys (provisioning hints), so
// they're excluded here.
const KNOWN_TOP_KEYS = new Set(['$version', 'projectId', 'slug', 'type', 'build', 'worker', 'compatibilityFlags', 'bindings']);
const KNOWN_BUILD_KEYS = new Set(['command', 'outputDir']);
const KNOWN_WORKER_KEYS = new Set(['entry', 'prebuilt', 'assetsDir']);

function collectUnknownKeyWarnings(obj: Record<string, unknown>): DeployConfigValidationError[] {
  const warnings: DeployConfigValidationError[] = [];
  const note = (path: string, key: string) => {
    // A targeted hint for the field a field report saw silently swallowed: the
    // Worker compatibility DATE is platform-fixed and not read from deploy.json
    // (only compatibilityFlags is) — see release-service `COMPATIBILITY_DATE`.
    const message =
      key === 'compatibilityDate'
        ? "unknown field 'compatibilityDate' — ignored. The Worker compatibility date is fixed by the platform and is not configurable via deploy.json; use 'compatibilityFlags' for runtime flags (e.g. [\"nodejs_compat\"])."
        : `unknown field '${key}' — ignored (not part of the deploy.json schema; check for a typo)`;
    warnings.push({ path, message });
  };
  for (const k of Object.keys(obj)) if (!KNOWN_TOP_KEYS.has(k)) note(k, k);
  if (isPlainObject(obj.build)) for (const k of Object.keys(obj.build)) if (!KNOWN_BUILD_KEYS.has(k)) note(`build.${k}`, k);
  if (isPlainObject(obj.worker)) for (const k of Object.keys(obj.worker)) if (!KNOWN_WORKER_KEYS.has(k)) note(`worker.${k}`, k);
  return warnings;
}

// ─── Internals ────────────────────────────────────────────────────────────

/**
 * Reorder to the spec's fixed key order, omitting absent optionals.
 * Binding entries keep `kind`, `binding` first; extra hint keys follow
 * lex-sorted (same rule the plan-file canonicalizer applies to
 * free-form maps). Pure — does not mutate input.
 */
function canonicalize(config: DeployConfig): Record<string, unknown> {
  const out: Record<string, unknown> = { $version: 1 };
  if (config.projectId !== undefined) out.projectId = config.projectId;
  if (config.slug !== undefined) out.slug = config.slug;
  if (config.type !== undefined) out.type = config.type;
  if (config.build !== undefined) {
    const build: Record<string, unknown> = {};
    if (config.build.command !== undefined) build.command = config.build.command;
    if (config.build.outputDir !== undefined) build.outputDir = config.build.outputDir;
    out.build = build;
  }
  if (config.worker !== undefined) {
    const worker: Record<string, unknown> = {};
    if (config.worker.entry !== undefined) worker.entry = config.worker.entry;
    if (config.worker.prebuilt !== undefined) worker.prebuilt = config.worker.prebuilt;
    if (config.worker.assetsDir !== undefined) worker.assetsDir = config.worker.assetsDir;
    out.worker = worker;
  }
  if (config.compatibilityFlags !== undefined) out.compatibilityFlags = [...config.compatibilityFlags];
  if (config.bindings !== undefined) {
    out.bindings = config.bindings.map((b) => {
      const entry: Record<string, unknown> = { kind: b.kind, binding: b.binding };
      for (const key of Object.keys(b).sort()) {
        if (key !== 'kind' && key !== 'binding') entry[key] = b[key];
      }
      return entry;
    });
  }
  return out;
}

function checkOptionalString(
  obj: Record<string, unknown>,
  key: string,
  errors: DeployConfigValidationError[],
  prefix = '',
): void {
  const v = obj[key];
  if (v === undefined) return;
  if (typeof v !== 'string' || v.trim() === '') {
    errors.push({ path: `${prefix}${key}`, message: `must be a non-empty string, got ${describe(v)}` });
  }
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `'${value}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value;
}

function defaultReadFile(filePath: string): string | undefined {
  try {
    return readFileSync(filePath, 'utf8');
  } catch {
    return undefined;
  }
}
