/**
 * AUTH_AND_ONBOARDING Slice 0 — substrate CLI auth-context resolution.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { resolveSubstrateContext, resolveUserToken } from './auth-context.js';

const BASE_ENV = {
  SESSION_ID: 'sess-1',
  YOLO_COMMON_API_URL: 'https://api.example.com',
};

// A readFile stub that returns content only for the rotated-token path.
function fileStub(map: Record<string, string>) {
  return (p: string) => map[p];
}

describe('resolveUserToken — precedence', () => {
  it('prefers ~/.config/yolo/token (rotated file) over YOLO_API_TOKEN', () => {
    const env = { HOME: '/home/yolo', YOLO_API_TOKEN: 'env-token' };
    const token = resolveUserToken(env, fileStub({ '/home/yolo/.config/yolo/token': 'file-token\n' }));
    assert.equal(token, 'file-token');
  });

  it('falls back to YOLO_API_TOKEN when the file is absent', () => {
    const env = { HOME: '/home/yolo', YOLO_API_TOKEN: 'env-token' };
    const token = resolveUserToken(env, fileStub({}));
    assert.equal(token, 'env-token');
  });

  it('returns undefined when neither file nor env token exists', () => {
    const env = { HOME: '/home/yolo' };
    assert.equal(resolveUserToken(env, fileStub({})), undefined);
  });

  it('ignores a blank/whitespace token file and falls through to env', () => {
    const env = { HOME: '/home/yolo', YOLO_API_TOKEN: 'env-token' };
    const token = resolveUserToken(env, fileStub({ '/home/yolo/.config/yolo/token': '   \n' }));
    assert.equal(token, 'env-token');
  });
});

describe('resolveSubstrateContext', () => {
  it('resolves with a user token (no internal key needed)', () => {
    const env = { ...BASE_ENV, HOME: '/home/yolo' };
    const res = resolveSubstrateContext(env, fileStub({ '/home/yolo/.config/yolo/token': 'file-token' }));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.context.userToken, 'file-token');
      assert.equal(res.context.internalApiKey, undefined);
      assert.equal(res.context.sessionId, 'sess-1');
      assert.equal(res.context.commonApiUrl, 'https://api.example.com');
    }
  });

  it('drops INTERNAL_API_KEY when a user token also exists (codex P2)', () => {
    // Both present → user token wins as the SOLE credential so the CLI
    // never forwards a (possibly stale) service key on work calls.
    const env = { ...BASE_ENV, HOME: '/home/yolo', INTERNAL_API_KEY: 'stale-svc-key' };
    const res = resolveSubstrateContext(env, fileStub({ '/home/yolo/.config/yolo/token': 'file-token' }));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.context.userToken, 'file-token');
      assert.equal(res.context.internalApiKey, undefined);
    }
  });

  it('resolves with only the internal key (service-caller fallback)', () => {
    const env = { ...BASE_ENV, INTERNAL_API_KEY: 'svc-key' };
    const res = resolveSubstrateContext(env, fileStub({}));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.context.userToken, undefined);
      assert.equal(res.context.internalApiKey, 'svc-key');
    }
  });

  it('fails when SESSION_ID is missing', () => {
    const res = resolveSubstrateContext({ YOLO_COMMON_API_URL: 'x', INTERNAL_API_KEY: 'k' }, fileStub({}));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /SESSION_ID/);
  });

  it('fails when the common-api URL is missing', () => {
    const res = resolveSubstrateContext({ SESSION_ID: 's', INTERNAL_API_KEY: 'k' }, fileStub({}));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /YOLO_COMMON_API_URL/);
  });

  it('fails when no credential is available', () => {
    const res = resolveSubstrateContext({ ...BASE_ENV, HOME: '/home/yolo' }, fileStub({}));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /no credential/);
  });
});
