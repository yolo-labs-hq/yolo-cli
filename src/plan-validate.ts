/**
 * `yolo plan validate` core (Phase 8c.1).
 *
 * Pure offline validation of a `.yolo/plans/<slug>.md` plan file. No
 * network I/O. Three checks, in order:
 *
 *   1. **Parse** — file must split cleanly into YAML frontmatter +
 *      markdown body via the standard `---` delimiters.
 *   2. **Schema** — frontmatter must satisfy the Draft-07 JSON Schema
 *      shipped at `src/plan-frontmatter.schema.json` (a copy of the
 *      repo's `.yolo/plans/.schema.json`; a drift-check test enforces
 *      they stay byte-equal).
 *   3. **Canonical** — running the file through `canonicalizePlanFile`
 *      must return the same bytes. This is the parity that
 *      `yolo plan import` will rely on, and that 8c.5's CI check
 *      enforces across all `.yolo/plans/*.md` files in the repo.
 *
 * The first failing check short-circuits subsequent ones (a parse
 * failure makes "schema" / "canonical" meaningless). Successful checks
 * still run all three and report all errors when the `collectAll`
 * flag is true (used by tests; the CLI prints the first one).
 *
 * Exit codes (used by cli.ts):
 *   - 0 = valid
 *   - 1 = validation failure (parse / schema / canonical)
 *   - 64 = usage error (missing file argument, file not found at path)
 *
 * Out of scope (lands in 8c.3 import):
 *   - planId-vs-filename equality (semantic check; the import command
 *     enforces it because the file path is the source of truth there).
 *   - Stricter `name` regex (semantic, Unicode-aware — was deliberately
 *     dropped from the schema in Phase 8b Round 1 because Draft-07
 *     pattern doesn't support `\\p{L}`/`\\p{N}` consistently across
 *     validators).
 *   - Cross-step / cross-gate semantic checks (gate.requires resolves
 *     to a sibling step, declaredOutput names unique within a step,
 *     etc.) — these belong in plan-validators.ts on the server side
 *     and run at import-time anyway.
 */

import { readFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import yaml from 'js-yaml';
import Ajv from 'ajv';

import { canonicalizePlanFile } from './canonicalizer.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const SCHEMA_PATH = path.join(__dirname, 'plan-frontmatter.schema.json');

// Lazy-load + cache: keeps test parallelism cheap. The schema is
// small (<10 KB), so synchronous read + JSON.parse on first use is
// fine.
let cachedSchema: unknown;
function getSchema(): unknown {
  if (!cachedSchema) {
    cachedSchema = JSON.parse(readFileSync(SCHEMA_PATH, 'utf8'));
  }
  return cachedSchema;
}

let cachedValidator: ((data: unknown) => boolean) & { errors?: AjvError[] | null } | null = null;
function getValidator(): (data: unknown) => boolean {
  if (!cachedValidator) {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const ajv = new (Ajv as any)({ allErrors: true });
    cachedValidator = ajv.compile(getSchema());
  }
  return cachedValidator!;
}

interface AjvError {
  keyword: string;
  dataPath?: string;
  message?: string;
  params?: Record<string, unknown>;
}

export type ValidationErrorKind = 'parse' | 'schema' | 'canonical';

export interface ValidationError {
  kind: ValidationErrorKind;
  message: string;
  /** JSON-pointer-ish path into the frontmatter, when available. */
  path?: string;
}

export interface ValidationOk {
  ok: true;
  planId: string;
  /** Bytes of the file as read; useful for sanity logging. */
  bytes: number;
}

export interface ValidationFail {
  ok: false;
  errors: ValidationError[];
}

export type ValidationResult = ValidationOk | ValidationFail;

const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n([\s\S]*)$/;

/**
 * Validate the contents of a plan file (already read into memory).
 * Pure — no fs access; the caller owns reading the file. Used by both
 * the CLI (`validatePlanFile` wraps a `readFileSync`) and tests
 * (which feed in synthesized strings).
 */
export function validatePlanText(text: string): ValidationResult {
  const errors: ValidationError[] = [];

  // 1) Parse
  const match = text.match(FRONTMATTER_RE);
  if (!match) {
    return {
      ok: false,
      errors: [
        {
          kind: 'parse',
          message:
            'plan file must start with `---` frontmatter delimiter, contain a closing `---`, and have a body — no match',
        },
      ],
    };
  }
  const [, fmText, body] = match;
  let frontmatter: Record<string, unknown>;
  try {
    const loaded = yaml.load(fmText!);
    if (loaded === null || typeof loaded !== 'object' || Array.isArray(loaded)) {
      return {
        ok: false,
        errors: [
          {
            kind: 'parse',
            message: 'frontmatter must be a YAML mapping (object), not a list or scalar',
          },
        ],
      };
    }
    frontmatter = loaded as Record<string, unknown>;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return {
      ok: false,
      errors: [{ kind: 'parse', message: `YAML parse failed: ${msg}` }],
    };
  }

  // 2) Schema
  const validate = getValidator();
  const ok = validate(frontmatter);
  if (!ok) {
    const ajvErrors = (validate as { errors?: AjvError[] | null }).errors ?? [];
    for (const err of ajvErrors) {
      errors.push({
        kind: 'schema',
        message: err.message ?? 'schema validation failed',
        path: err.dataPath || '',
      });
    }
  }

  // 3) Canonical
  // Only meaningful when the parse step succeeded — schema fails
  // don't preclude canonicalization, so we always run this check too
  // and the caller gets a complete report.
  const canonical = canonicalizePlanFile(frontmatter, body!);
  if (canonical !== text) {
    errors.push({
      kind: 'canonical',
      message:
        'file is not in canonical form (frontmatter field order / lex-sort / body normalization). Run `yolo plan import` to rewrite, or canonicalize manually.',
    });
  }

  if (errors.length > 0) {
    return { ok: false, errors };
  }

  const planId = typeof frontmatter.planId === 'string' ? frontmatter.planId : '';
  return { ok: true, planId, bytes: text.length };
}

/**
 * Read a plan file from disk and validate it.
 *
 * Throws `ENOENT`-style errors through the caller (cli.ts maps them
 * to exit code 64 + a friendly message).
 */
export function validatePlanFile(filePath: string): ValidationResult {
  const text = readFileSync(filePath, 'utf8');
  return validatePlanText(text);
}

/**
 * Render a `ValidationFail` result as human-readable text for the
 * CLI. One line per error, with kind tag + optional path. Caller
 * appends a trailing newline if needed.
 */
export function formatErrors(errors: ValidationError[]): string {
  return errors
    .map((e) => {
      const tag = `[${e.kind}]`;
      const loc = e.path ? ` (at ${e.path})` : '';
      return `${tag}${loc} ${e.message}`;
    })
    .join('\n');
}
