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
  it('resolves with a user token', () => {
    const env = { ...BASE_ENV, HOME: '/home/yolo' };
    const res = resolveSubstrateContext(env, fileStub({ '/home/yolo/.config/yolo/token': 'file-token' }));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.context.userToken, 'file-token');
      assert.equal(res.context.sessionId, 'sess-1');
      assert.equal(res.context.commonApiUrl, 'https://api.example.com');
    }
  });

  it('ignores INTERNAL_API_KEY env entirely — a user token is the only credential', () => {
    // INTERNAL_API_KEY in the shell is irrelevant now: the fallback was
    // removed, so the user JWT is resolved and the env key is never read.
    const env = { ...BASE_ENV, HOME: '/home/yolo', INTERNAL_API_KEY: 'stale-svc-key' };
    const res = resolveSubstrateContext(env, fileStub({ '/home/yolo/.config/yolo/token': 'file-token' }));
    assert.equal(res.ok, true);
    if (res.ok) {
      assert.equal(res.context.userToken, 'file-token');
    }
  });

  it('fails when only INTERNAL_API_KEY is present (no user token) — fallback removed', () => {
    const env = { ...BASE_ENV, INTERNAL_API_KEY: 'svc-key' };
    const res = resolveSubstrateContext(env, fileStub({}));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /user-JWT-only|user token/i);
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

  it('fails when no user token is available', () => {
    const res = resolveSubstrateContext({ ...BASE_ENV, HOME: '/home/yolo' }, fileStub({}));
    assert.equal(res.ok, false);
    if (!res.ok) assert.match(res.message, /no user token|user-JWT-only/i);
  });
});
