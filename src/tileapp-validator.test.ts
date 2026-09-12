/**
 * tileapp-validator tests — the CLI-side publishing gate.
 *
 * This module decides what a partner can publish, and its own comment states
 * why being lenient is the wrong failure: a relative screenshot ref "would pass
 * this lint and then be rejected server-side ... a CLI that green-lights it is
 * worse than one that is strict". It had no tests.
 *
 * The cases below are the rules where lenient and strict are one character
 * apart — a default flag, an exactness check, a subdirectory. Not an exhaustive
 * transcription of the file.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parsePermissionShape, validateManifest, isValidOciDigest } from './tileapp-validator.js';

/** The minimum manifest `validateManifest` accepts, so each case below tests one rule. */
const base = {
  id: 'my-app',
  version: '1.0.0',
  displayName: 'My App',
  publisher: 'someone',
  description: 'x',
  ui: { icon: 'i', color: '#fff', label: 'My App' },
  surface: { kind: 'iframe', entry: 'index.html' },
  permissions: { required: [] },
};

const errorsFor = (m: Record<string, unknown>, opts = {}) => validateManifest(m, opts).errors;

describe('marketplace visibility', () => {
  it('accepts legacy manifests and boolean visibility, rejects string booleans', () => {
    for (const manifest of [base, { ...base, marketplaceListed: true }, { ...base, marketplaceListed: false }]) {
      assert.deepEqual(errorsFor(manifest), []);
    }
    assert.deepEqual(errorsFor({ ...base, marketplaceListed: 'false' }), ['marketplaceListed must be a boolean when present']);
  });
});

describe('screenshot refs — the partner-safe default', () => {
  it('REJECTS the media/<file> form unless the caller opts in', () => {
    // The default is false on purpose: partner ingest uploads no media, so this
    // form lints clean and then fails server-side.
    const errs = errorsFor({ ...base, screenshots: ['media/shot.png'] });
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /requires platform-hosted storage/);
  });

  it('accepts media/<file> when the publishing path actually has a store', () => {
    assert.deepEqual(
      errorsFor({ ...base, screenshots: ['media/shot.png'] }, { allowPlatformHostedScreenshots: true }),
      [],
    );
  });

  it('accepts an absolute https URL either way', () => {
    for (const opts of [{}, { allowPlatformHostedScreenshots: true }]) {
      assert.deepEqual(errorsFor({ ...base, screenshots: ['https://cdn.example.test/a.png'] }, opts), []);
    }
  });

  it('rejects a subdirectory in the relative form, even when opted in', () => {
    const errs = errorsFor({ ...base, screenshots: ['media/sub/shot.png'] }, { allowPlatformHostedScreenshots: true });
    assert.equal(errs.length, 1);
    assert.match(errs[0]!, /no subdirectories/);
  });

  it('rejects a non-image extension in both forms', () => {
    assert.equal(errorsFor({ ...base, screenshots: ['https://cdn.example.test/a.exe'] }).length, 1);
    assert.equal(
      errorsFor({ ...base, screenshots: ['media/a.exe'] }, { allowPlatformHostedScreenshots: true }).length,
      1,
    );
  });

  it('rejects http:// — the rule is https, not "a URL"', () => {
    assert.equal(errorsFor({ ...base, screenshots: ['http://cdn.example.test/a.png'] }).length, 1);
  });
});

describe('permission shapes — exactness is the rule', () => {
  it('accepts bare llm.invoke', () => {
    assert.equal(parsePermissionShape('llm.invoke')?.namespace, 'llm');
  });

  it('accepts the legacy provider-suffixed form, which is advisory only', () => {
    assert.equal(parsePermissionShape('llm.invoke:openai')?.namespace, 'llm');
  });

  it('rejects a trailing colon with no provider', () => {
    // `llm.invoke:` parses to an empty arg, which is not the bare form.
    assert.equal(parsePermissionShape('llm.invoke:'), null);
  });

  it('rejects extra segments — the head must be EXACTLY llm.invoke', () => {
    assert.equal(parsePermissionShape('llm.invoke.foo'), null);
    assert.equal(parsePermissionShape('llm'), null);
  });

  it('rejects an unknown namespace outright', () => {
    assert.equal(parsePermissionShape('filesystem.read:/etc'), null);
  });

  it('media requires both an action and an argument', () => {
    assert.equal(parsePermissionShape('media.upload:img')?.namespace, 'media');
    assert.equal(parsePermissionShape('media.upload'), null, 'no argument');
    assert.equal(parsePermissionShape('media:img'), null, 'no action');
    assert.equal(parsePermissionShape('media.delete:img'), null, 'action not in the allowlist');
  });
});

describe('identity', () => {
  it('requires a lowercase kebab-case slug', () => {
    for (const id of ['My-App', 'a', 'app_name', 'App', '-lead', 'x'.repeat(65)]) {
      assert.ok(errorsFor({ ...base, id }).some((e) => /kebab-case/.test(e)), `expected ${id} to be rejected`);
    }
    assert.deepEqual(errorsFor({ ...base, id: 'my-app-2' }), []);
  });
});

describe('OCI digests', () => {
  it('accepts a well-formed sha256 digest and rejects near-misses', () => {
    const ok = `sha256:${'a'.repeat(64)}`;
    assert.equal(isValidOciDigest(ok), true);
    assert.equal(isValidOciDigest(`sha256:${'a'.repeat(63)}`), false, 'too short');
    assert.equal(isValidOciDigest(`sha256:${'a'.repeat(65)}`), false, 'too long');
    assert.equal(isValidOciDigest(`sha512:${'a'.repeat(64)}`), false, 'wrong algorithm');
    assert.equal(isValidOciDigest(`sha256:${'A'.repeat(64)}`), false, 'uppercase hex');
    assert.equal(isValidOciDigest('a'.repeat(64)), false, 'no algorithm prefix');
  });
});

describe('notification permissions', () => {
  it('accepts explicit surfaces and rejects wildcard/both grant shortcuts', () => {
    for (const scope of ['global', 'workspace']) {
      assert.equal(parsePermissionShape(`notifications.send:${scope}`)?.namespace, 'notifications');
    }
    for (const permission of ['notifications.send', 'notifications.send:both', 'notifications.send:*', 'notifications.send.extra:global']) {
      assert.equal(parsePermissionShape(permission), null);
    }
  });
});
