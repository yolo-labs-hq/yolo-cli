/**
 * `run_worker_first` for a Worker + static-assets ship (deploy.json
 * `assets.runWorkerFirst`, wrangler `assets.run_worker_first`).
 *
 * Cloudflare's Workers static assets serve a request that matches an asset
 * WITHOUT invoking the Worker by default. `run_worker_first` changes that:
 *
 *   - `true`  → every request reaches the Worker first (it can still fall back
 *               to `env.ASSETS.fetch(request)`).
 *   - `false` → the default (assets first). Sent explicitly when declared.
 *   - `string[]` → route globs. A request whose PATH matches a positive rule
 *               (`/api/*`) runs the Worker first; a negative rule (`!/api/docs/*`)
 *               carves an exception out of the positives and always wins.
 *               `*` is the only wildcard and matches any run of characters,
 *               `/` included.
 *
 * LOCKSTEP COPY of `common-api/src/services/hosting/run-worker-first.ts`. The
 * server copy is the authority (a direct REST client skips the CLI); this one
 * exists so the same mistake fails in `yolo deploy validate` before anything is
 * built. Change both together.
 */

export type RunWorkerFirst = boolean | string[];

/** Upper bound on rules. Generous for real route tables; bounds the metadata size. */
export const RUN_WORKER_FIRST_MAX_RULES = 100;
/** Per-rule length cap (a path glob, not a URL). */
export const RUN_WORKER_FIRST_MAX_RULE_LENGTH = 256;

export type RunWorkerFirstValidation =
  | { ok: true; value: RunWorkerFirst }
  | { ok: false; errors: string[] };

/**
 * Validate a declared `runWorkerFirst`. Reports EVERY problem (one refusal the
 * author can fix in one pass), each naming the offending rule by index.
 */
export function validateRunWorkerFirst(value: unknown): RunWorkerFirstValidation {
  if (typeof value === 'boolean') return { ok: true, value };
  if (!Array.isArray(value)) {
    return {
      ok: false,
      errors: [`must be true, false, or an array of route globs like ["/api/*", "!/api/docs/*"], got ${describe(value)}`],
    };
  }
  const errors: string[] = [];
  if (value.length === 0) {
    errors.push('an empty array matches nothing — use false (or remove the field) for the default, assets first');
  }
  if (value.length > RUN_WORKER_FIRST_MAX_RULES) {
    errors.push(`at most ${RUN_WORKER_FIRST_MAX_RULES} rules, got ${value.length}`);
  }
  const seen = new Set<string>();
  let positives = 0;
  value.forEach((rule, i) => {
    const at = `[${i}]`;
    if (typeof rule !== 'string') {
      errors.push(`${at} must be a string route glob, got ${describe(rule)}`);
      return;
    }
    const problem = ruleProblem(rule);
    if (problem) {
      errors.push(`${at} '${truncate(rule)}' ${problem}`);
      return;
    }
    if (seen.has(rule)) {
      errors.push(`${at} '${truncate(rule)}' is a duplicate`);
      return;
    }
    seen.add(rule);
    if (!rule.startsWith('!')) positives += 1;
  });
  if (errors.length === 0 && positives === 0) {
    errors.push(
      'only negative (!) rules — a negative rule only carves exceptions out of positive ones, so this matches nothing. Add a positive rule like "/api/*"',
    );
  }
  return errors.length > 0 ? { ok: false, errors } : { ok: true, value: value as string[] };
}

function ruleProblem(rule: string): string | null {
  if (rule.length === 0) return 'is empty';
  if (rule.length > RUN_WORKER_FIRST_MAX_RULE_LENGTH) return `is longer than ${RUN_WORKER_FIRST_MAX_RULE_LENGTH} characters`;
  const body = rule.startsWith('!') ? rule.slice(1) : rule;
  if (!body.startsWith('/')) {
    return /^[a-z][a-z0-9+.-]*:\/\//i.test(body)
      ? 'is a URL — rules match the request PATH only; write it as "/path/*"'
      : 'must start with "/" (or "!/" for an exception), e.g. "/api/*"';
  }
  // eslint-disable-next-line no-control-regex
  if (/[\s\u0000-\u001f\u007f]/.test(body)) return 'contains whitespace or a control character';
  if (body.includes('?') || body.includes('#')) {
    return 'contains "?" or "#" — rules match the path only (no query string or fragment), and "*" is the only wildcard';
  }
  if (/[[\]{}]/.test(body)) {
    return 'uses [ ] or { } — Cloudflare route globs support only "*" (list each alternative as its own rule)';
  }
  return null;
}

function truncate(s: string): string {
  return s.length > 60 ? `${s.slice(0, 57)}...` : s;
}

function describe(value: unknown): string {
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  if (typeof value === 'string') return `'${truncate(value)}'`;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return typeof value;
}
