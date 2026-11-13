/**
 * Cross-environment safety: the sandbox's own credential is never sent to a
 * non-production API by default (api-env.ts).
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { isProductionApiUrl, missingUserTokenMessage, podProvisionedApiUrl, targetApiUrl } from './api-env.js';
import { resolveSubstrateContext, resolveUserToken } from './auth-context.js';
import { getProjectStatus, resolveDeployContext, type DeployFetchLike } from './deploy-client.js';

const STAGING = 'https://api-staging.yolo.studio';
const HOME = '/home/yolo';
const TOKEN_FILE = `${HOME}/.config/yolo/token`;
const POD_ENV_FILE = '/run/yolo/env';

function files(map: Record<string, string>) {
  return (p: string) => map[p];
}

/** A production pod: rotated prod token on disk, prod token in env, env file says prod. */
const PROD_POD_FILES = {
  [TOKEN_FILE]: 'prod-file-token\n',
  [POD_ENV_FILE]: "# generated\nexport SESSION_ID='s'\nexport YOLO_API_URL='https://api.yolo.studio'\n",
};

describe('isProductionApiUrl / targetApiUrl', () => {
  it('recognises the production origin only', () => {
    assert.equal(isProductionApiUrl('https://api.yolo.studio'), true);
    assert.equal(isProductionApiUrl('https://API.yolo.studio/'), true);
    assert.equal(isProductionApiUrl('https://api.yolo.studio/v1'), true);
    assert.equal(isProductionApiUrl(STAGING), false);
    assert.equal(isProductionApiUrl('http://api.yolo.studio'), false);
    assert.equal(isProductionApiUrl('http://localhost:3000'), false);
    assert.equal(isProductionApiUrl('not a url'), false);
  });

  it('YOLO_COMMON_API_URL, then YOLO_API_URL, then production', () => {
    assert.equal(targetApiUrl({}), 'https://api.yolo.studio');
    assert.equal(targetApiUrl({ YOLO_API_URL: STAGING }), STAGING);
    assert.equal(targetApiUrl({ YOLO_COMMON_API_URL: 'https://a.example', YOLO_API_URL: STAGING }), 'https://a.example');
  });

  it('reads the pod-provisioned URL from the env file', () => {
    assert.equal(podProvisionedApiUrl({}, files(PROD_POD_FILES)), 'https://api.yolo.studio');
    assert.equal(podProvisionedApiUrl({ YOLO_ENV_FILE: '/x' }, files({ '/x': `YOLO_API_URL="${STAGING}"\n` })), STAGING);
    assert.equal(podProvisionedApiUrl({}, files({})), undefined);
  });
});

describe('resolveUserToken — production API (unchanged)', () => {
  it('uses the rotated file, then YOLO_API_TOKEN, and ignores the non-prod variables', () => {
    const env = { HOME, YOLO_API_URL: 'https://api.yolo.studio', YOLO_API_TOKEN: 'prod-env', YOLO_API_TOKEN_NONPROD: 'np' };
    assert.equal(resolveUserToken(env, files(PROD_POD_FILES)), 'prod-file-token');
    assert.equal(resolveUserToken(env, files({})), 'prod-env');
  });

  it('treats an unset URL as production', () => {
    assert.equal(resolveUserToken({ HOME, YOLO_API_TOKEN: 'prod-env' }, files({})), 'prod-env');
  });
});

describe('resolveUserToken — non-production API', () => {
  it('never falls back to YOLO_API_TOKEN', () => {
    assert.equal(resolveUserToken({ HOME, YOLO_API_URL: STAGING, YOLO_API_TOKEN: 'prod-env' }, files({})), undefined);
  });

  it('does not use the rotated token file of a production pod pointed at another API', () => {
    const env = { HOME, YOLO_API_URL: STAGING, YOLO_API_TOKEN: 'prod-env' };
    assert.equal(resolveUserToken(env, files(PROD_POD_FILES)), undefined);
  });

  it('does not use the rotated token file outside a pod (no env file)', () => {
    assert.equal(resolveUserToken({ HOME, YOLO_API_URL: STAGING }, files({ [TOKEN_FILE]: 'tok' })), undefined);
  });

  it('uses YOLO_API_TOKEN_NONPROD first', () => {
    const env = { HOME, YOLO_API_URL: STAGING, YOLO_API_TOKEN: 'prod-env', YOLO_API_TOKEN_NONPROD: ' staging-tok \n' };
    assert.equal(resolveUserToken(env, files(PROD_POD_FILES)), 'staging-tok');
  });

  it('uses the file named by YOLO_API_TOKEN_FILE, and does not fall through when it is empty', () => {
    const env = { HOME, YOLO_API_URL: STAGING, YOLO_API_TOKEN: 'prod-env', YOLO_API_TOKEN_FILE: '/secrets/staging' };
    assert.equal(resolveUserToken(env, files({ ...PROD_POD_FILES, '/secrets/staging': 'staging-file-tok\n' })), 'staging-file-tok');
    assert.equal(resolveUserToken(env, files({ ...PROD_POD_FILES, '/secrets/staging': '  ' })), undefined);
  });

  it('a pod provisioned for that same API uses its own rotated file (a staging sandbox), never YOLO_API_TOKEN', () => {
    const stagingPod = { [POD_ENV_FILE]: `export YOLO_API_URL='${STAGING}'\n` };
    const env = { HOME, YOLO_API_URL: `${STAGING}/`, YOLO_API_TOKEN: 'staging-env' };
    assert.equal(resolveUserToken(env, files({ ...stagingPod, [TOKEN_FILE]: 'staging-file\n' })), 'staging-file');
    assert.equal(resolveUserToken(env, files(stagingPod)), undefined);
  });
});

describe('every client fails clearly instead of sending the sandbox token to a non-production API', () => {
  it('substrate context', () => {
    const res = resolveSubstrateContext({ SESSION_ID: 's', HOME, YOLO_API_URL: STAGING, YOLO_API_TOKEN: 'prod-env' }, files(PROD_POD_FILES));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.match(res.message, /non-production API https:\/\/api-staging\.yolo\.studio/);
      assert.match(res.message, /YOLO_API_TOKEN_NONPROD/);
      assert.match(res.message, /YOLO_API_TOKEN_FILE/);
    }
  });

  it('deploy context', () => {
    const res = resolveDeployContext({ HOME, YOLO_API_URL: STAGING, YOLO_API_TOKEN: 'prod-env' }, files(PROD_POD_FILES));
    assert.equal(res.ok, false);
    if (!res.ok) {
      assert.equal(res.kind, 'auth');
      assert.match(res.message, /YOLO_API_TOKEN_NONPROD/);
    }
  });

  it('a deploy leg against a staging context never calls fetch with the env token', async () => {
    const calls: unknown[] = [];
    const fetchImpl: DeployFetchLike = async (url, init) => {
      calls.push({ url, init });
      return { ok: true, status: 200, json: async () => ({}), text: async () => '{}', body: null };
    };
    // The context's URL decides, even when its env carries no URL at all.
    const result = await getProjectStatus(
      { commonApiUrl: STAGING, env: { HOME, YOLO_API_TOKEN: 'prod-env' }, readFileImpl: files(PROD_POD_FILES), fetchImpl },
      'hp_1',
    );
    assert.equal(result.ok, false);
    if (!result.ok) assert.equal(result.kind, 'auth');
    assert.equal(calls.length, 0);
  });

  it('the production message is unchanged', () => {
    assert.match(missingUserTokenMessage({}), /no user token available/);
    assert.match(missingUserTokenMessage({ YOLO_API_URL: STAGING }), /YOLO_API_TOKEN_NONPROD/);
  });
});
