/**
 * Tile-app manifest + bundle validator for the LOCAL dev harness (M1 slice 6).
 *
 * This is a faithful, dependency-free MIRROR of the server's authoritative
 * validator at `common-api/src/types/tileapp.ts` (`validateManifest` /
 * `parsePermission`) — the yolo-cli is a standalone package and cannot import
 * common-api. Keep the two in lockstep: the structural rules + error strings
 * here intentionally match the server so `yolo tileapp validate` reports the
 * SAME taxonomy a partner will hit at `POST /v1/publisher/publish`.
 *
 * One deliberate difference: this offline validator checks permission SHAPE
 * (namespace + segments) but NOT membership in the server's `VALID_MCP_SCOPES`
 * / `SECRET_PRESET_KEYS` enums (those live server-side). An `mcp:<scope>` or
 * `secret:<KEY>` with a well-formed but unknown arg passes the lint and is
 * confirmed authoritatively at publish — `validate` says so in its output.
 */

export interface ManifestValidation {
  ok: boolean;
  errors: string[];
}

interface ParsedPermission {
  raw: string;
  namespace: 'fs' | 'net' | 'mcp' | 'llm' | 'media' | 'secret' | 'device';
  action?: string;
  arg?: string;
}

const ID_RE = /^[a-z0-9][a-z0-9-]{1,63}$/;
const SEMVER_RE = /^\d+\.\d+\.\d+(?:[-+].+)?$/;

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}
function isStr(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0;
}

/**
 * Decompose a permission string by SHAPE. Returns null for an unrecognized
 * shape. Mirrors the server's `parsePermission` minus the enum-membership
 * checks (mcp scope / secret key) which are server-authoritative.
 */
export function parsePermissionShape(raw: string): ParsedPermission | null {
  if (typeof raw !== 'string' || raw.length === 0) return null;
  const [head, ...argParts] = raw.split(':');
  const arg = argParts.length > 0 ? argParts.join(':') : undefined;
  const [ns, action] = head.split('.');
  switch (ns) {
    case 'fs':
      if (action !== 'read' && action !== 'readwrite') return null;
      if (!arg) return null;
      return { raw, namespace: 'fs', action, arg };
    case 'net':
      if (action || !arg) return null;
      return { raw, namespace: 'net', arg };
    case 'mcp':
      if (action || !arg) return null; // arg = McpScope (membership checked server-side)
      return { raw, namespace: 'mcp', arg };
    case 'llm':
      // llm.invoke — provider-agnostic (the router picks the model). A legacy
      // `llm.invoke:<provider>` still parses; the provider is advisory only. Head
      // must be EXACTLY `llm.invoke`: bare is valid, but `llm.invoke:` and extra
      // segments `llm.invoke.foo` are rejected.
      if (head !== 'llm.invoke' || arg === '') return null;
      return { raw, namespace: 'llm', action, arg };
    case 'media':
      if (action !== 'upload' && action !== 'download') return null;
      if (!arg) return null;
      return { raw, namespace: 'media', action, arg };
    case 'secret':
      if (action || !arg) return null; // arg = KEY_NAME (preset membership checked server-side)
      return { raw, namespace: 'secret', action: arg };
    case 'device':
      if (!action) return null;
      return { raw, namespace: 'device', action, arg };
    default:
      return null;
  }
}

/**
 * Validate a parsed-JSON value as a tile-app manifest. Collects EVERY error
 * (not fail-fast) so the author sees all problems at once — matching the
 * server. Returns `{ ok, errors }`.
 */
export function validateManifest(raw: unknown): ManifestValidation {
  const errors: string[] = [];
  if (!isObj(raw)) return { ok: false, errors: ['manifest is not an object'] };

  if (!isStr(raw.id) || !ID_RE.test(raw.id)) errors.push('id must be a lowercase kebab-case slug (2-64 chars)');
  if (!isStr(raw.version) || !SEMVER_RE.test(raw.version)) errors.push('version must be semver (e.g. 1.0.0)');
  if (!isStr(raw.displayName)) errors.push('displayName is required');
  if (!isStr(raw.publisher)) errors.push('publisher is required');
  if (!isStr(raw.description)) errors.push('description is required');

  if (!isObj(raw.ui) || !isStr(raw.ui.icon) || !isStr(raw.ui.color) || !isStr(raw.ui.label)) {
    errors.push('ui must have string icon, color, label');
  }

  if (!isObj(raw.surface)) {
    errors.push('surface is required');
  } else {
    if (raw.surface.kind !== 'iframe') errors.push("surface.kind must be 'iframe' (v1)");
    if (!isStr(raw.surface.entry)) errors.push('surface.entry is required');
    if (raw.surface.tilePrefersSize !== undefined) {
      const s = raw.surface.tilePrefersSize as Record<string, unknown>;
      if (!isObj(s) || typeof s.rowSpan !== 'number' || typeof s.colSpan !== 'number') {
        errors.push('surface.tilePrefersSize must be { rowSpan, colSpan }');
      }
    }
  }

  if (raw.runtime !== undefined) {
    if (!isObj(raw.runtime)) {
      errors.push('runtime must be an object when present');
    } else {
      if (typeof raw.runtime.port !== 'number' || raw.runtime.port <= 0) errors.push('runtime.port must be a positive number');
      if (raw.runtime.exec !== undefined && !isStr(raw.runtime.exec)) errors.push('runtime.exec must be a non-empty string when present');
    }
  }

  if (raw.image !== undefined) {
    if (!isObj(raw.image)) {
      errors.push('image must be an object when present');
    } else {
      if (!isStr(raw.image.ref)) errors.push('image.ref is required (registry path without tag)');
      if (!isStr(raw.image.tag)) errors.push('image.tag is required');
      if (raw.image.digest !== undefined && !isStr(raw.image.digest)) errors.push('image.digest must be a string when present');
      if (raw.image.sizeBytes !== undefined && (typeof raw.image.sizeBytes !== 'number' || raw.image.sizeBytes < 0)) {
        errors.push('image.sizeBytes must be a non-negative number when present');
      }
    }
  }
  if (isObj(raw.runtime) && raw.image === undefined && !isStr((raw.runtime as Record<string, unknown>).exec)) {
    errors.push('runtime requires either `image` (OCI image, recommended) or `runtime.exec` (bare-process override)');
  }

  const allPerms: unknown[] = [];
  if (!isObj(raw.permissions)) {
    errors.push('permissions is required');
  } else {
    const { required, optional } = raw.permissions as Record<string, unknown>;
    if (!Array.isArray(required)) errors.push('permissions.required must be an array');
    else allPerms.push(...required);
    if (optional !== undefined) {
      if (!Array.isArray(optional)) errors.push('permissions.optional must be an array when present');
      else allPerms.push(...optional);
    }
  }
  for (const p of allPerms) {
    if (typeof p !== 'string') { errors.push(`permission must be a string: ${JSON.stringify(p)}`); continue; }
    const parsed = parsePermissionShape(p);
    if (!parsed) { errors.push(`unrecognized permission: '${p}'`); continue; }
    if (parsed.namespace === 'net' && (parsed.arg === '*' || parsed.arg?.includes('*'))) {
      errors.push(`net permission must name a specific host (no wildcards): '${p}'`);
    }
  }

  if (raw.category !== undefined && !isStr(raw.category)) errors.push('category must be a string when present');
  if (raw.screenshots !== undefined && (!Array.isArray(raw.screenshots) || !raw.screenshots.every(isStr))) {
    errors.push('screenshots must be an array of strings when present');
  }
  if (raw.changelog !== undefined && !isStr(raw.changelog)) errors.push('changelog must be a string when present');
  if (raw.featured !== undefined && typeof raw.featured !== 'boolean') errors.push('featured must be a boolean when present');

  if (raw.pricing !== undefined) {
    const p = raw.pricing as Record<string, unknown>;
    if (!isObj(p)) {
      errors.push('pricing must be an object when present');
    } else {
      if (!['free', 'purchase', 'subscription'].includes(p.model as string)) errors.push("pricing.model must be 'free' | 'purchase' | 'subscription'");
      if (!['byo', 'platform-metered', 'hybrid'].includes(p.costMode as string)) errors.push("pricing.costMode must be 'byo' | 'platform-metered' | 'hybrid'");
      for (const k of ['priceUsdMonthly', 'priceUsdOnce', 'trialDays'] as const) {
        if (p[k] !== undefined && (typeof p[k] !== 'number' || (p[k] as number) < 0)) errors.push(`pricing.${k} must be a non-negative number when present`);
      }
      if (p.model === 'subscription' && !(typeof p.priceUsdMonthly === 'number' && (p.priceUsdMonthly as number) > 0)) errors.push('pricing.priceUsdMonthly is required (> 0) for a subscription');
      if (p.model === 'purchase' && !(typeof p.priceUsdOnce === 'number' && (p.priceUsdOnce as number) > 0)) errors.push('pricing.priceUsdOnce is required (> 0) for a purchase');
    }
  }

  return { ok: errors.length === 0, errors };
}

/** A real OCI content digest — `sha256:<64 hex>` or `sha512:<128 hex>`. Mirrors
 *  the publish endpoint's `isValidOciDigest` (a tag / `latest` / short hash is
 *  NOT immutable content addressing). */
export function isValidOciDigest(d: string): boolean {
  return /^sha256:[a-f0-9]{64}$/.test(d) || /^sha512:[a-f0-9]{128}$/.test(d);
}

/**
 * PUBLISH-gate checks that go beyond the schema `validateManifest` — the extra
 * rules `POST /v1/publisher/publish` enforces, surfaced offline so a clean
 * `validate` predicts a clean publish. Currently: a runtime app (anything with
 * `runtime` OR `image`, matching the endpoint's `hasRuntime`) MUST pin
 * `image.digest` to a valid content digest (`DIGEST_REQUIRED`).
 */
export function publishGateErrors(manifest: unknown): string[] {
  const errors: string[] = [];
  if (!isObj(manifest)) return errors; // a non-object is reported by validateManifest; don't deref
  const hasRuntime = isObj(manifest.runtime) || isObj(manifest.image);
  if (hasRuntime) {
    const digest = isObj(manifest.image) ? manifest.image.digest : undefined;
    if (!(typeof digest === 'string' && isValidOciDigest(digest))) {
      errors.push('a runtime app must ship a signed image pinned to a valid content digest (image.digest = sha256:<64 hex>)');
    }
  }
  return errors;
}

/**
 * True if the manifest declares a server-side runtime. Keyed on `runtime` ONLY
 * — matching the launcher, which serves a static surface bundle for any manifest
 * WITHOUT `runtime` (`common-api/src/services/tileapp/launcher.ts`: `if
 * (!manifest.runtime) → staticSurfaceUrl`). An `image`-only manifest (no
 * `runtime`) is therefore pure-UI in production and STILL needs `surface.entry`
 * on disk — so it must NOT be classified runtime here (else `validate` would
 * skip the bundle check on an app that fails to render in prod).
 */
export function isRuntimeManifest(manifest: unknown): boolean {
  return isObj(manifest) && isObj(manifest.runtime);
}
