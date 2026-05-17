/**
 * webapp-url tests — make sure the CLI link-print produces something
 * usable across the deployment shapes we ship to (prod, staging, custom
 * override) and falls back cleanly on unrecognized shapes rather than
 * printing a bogus URL.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deriveWebappUrl, planDagUrl } from './webapp-url.js';

describe('deriveWebappUrl', () => {
  it('strips `api.` from the prod-shape host', () => {
    const out = deriveWebappUrl({ commonApiUrl: 'https://api.yolo.studio' });
    assert.equal(out, 'https://yolo.studio');
  });

  it('rewrites `api-<env>.` to `<env>.` for env-suffixed hosts', () => {
    const out = deriveWebappUrl({ commonApiUrl: 'https://api-staging.yolo.studio' });
    assert.equal(out, 'https://staging.yolo.studio');
  });

  it('returns null for unrecognized hosts (raw localhost, IPs, custom)', () => {
    assert.equal(deriveWebappUrl({ commonApiUrl: 'http://localhost:8080' }), null);
    assert.equal(deriveWebappUrl({ commonApiUrl: 'http://192.168.0.10' }), null);
    assert.equal(deriveWebappUrl({ commonApiUrl: 'https://example.com' }), null);
  });

  it('returns null for malformed URLs', () => {
    assert.equal(deriveWebappUrl({ commonApiUrl: 'not a url' }), null);
  });

  it('honors the override and strips its trailing slash', () => {
    const out = deriveWebappUrl({
      commonApiUrl: 'http://localhost:8080',
      webappUrlOverride: 'https://my-studio.local/',
    });
    assert.equal(out, 'https://my-studio.local');
  });

  it('preserves http vs https from the source', () => {
    const out = deriveWebappUrl({ commonApiUrl: 'http://api.yolo.studio' });
    assert.equal(out, 'http://yolo.studio');
  });
});

describe('planDagUrl', () => {
  it('builds the /workspaces/<id>/plans/<planId> path from env', () => {
    const out = planDagUrl(
      { YOLO_COMMON_API_URL: 'https://api.yolo.studio' },
      '507f1f77bcf86cd799439011',
      'auth-and-onboarding',
    );
    assert.equal(out, 'https://yolo.studio/workspaces/507f1f77bcf86cd799439011/plans/auth-and-onboarding');
  });

  it('falls back to YOLO_API_URL when YOLO_COMMON_API_URL is absent', () => {
    const out = planDagUrl(
      { YOLO_API_URL: 'https://api-staging.yolo.studio' },
      'ws1',
      'p1',
    );
    assert.equal(out, 'https://staging.yolo.studio/workspaces/ws1/plans/p1');
  });

  it('returns null when no API URL is set', () => {
    assert.equal(planDagUrl({}, 'ws1', 'p1'), null);
  });

  it('returns null when the API URL is an unrecognized shape', () => {
    assert.equal(
      planDagUrl({ YOLO_COMMON_API_URL: 'http://localhost:8080' }, 'ws1', 'p1'),
      null,
    );
  });

  it('honors YOLO_WEBAPP_URL override over API-URL derivation', () => {
    const out = planDagUrl(
      {
        YOLO_COMMON_API_URL: 'https://api.yolo.studio',
        YOLO_WEBAPP_URL: 'http://localhost:3000',
      },
      'ws1',
      'p1',
    );
    assert.equal(out, 'http://localhost:3000/workspaces/ws1/plans/p1');
  });
});
