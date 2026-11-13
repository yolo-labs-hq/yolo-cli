/**
 * The CLI's API origin: explicit env first, production when unset.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DEFAULT_YOLO_API_URL, resolveCommonApiUrl } from './api-url.js';

describe('resolveCommonApiUrl', () => {
  it('defaults to the production API when neither URL env var is set', () => {
    assert.equal(DEFAULT_YOLO_API_URL, 'https://api.yolo.studio');
    assert.equal(resolveCommonApiUrl({}), 'https://api.yolo.studio');
    assert.equal(resolveCommonApiUrl({ YOLO_COMMON_API_URL: '', YOLO_API_URL: '' }), 'https://api.yolo.studio');
  });

  it('YOLO_COMMON_API_URL wins, then YOLO_API_URL', () => {
    assert.equal(
      resolveCommonApiUrl({ YOLO_COMMON_API_URL: 'https://a.example', YOLO_API_URL: 'https://b.example' }),
      'https://a.example',
    );
    assert.equal(resolveCommonApiUrl({ YOLO_API_URL: 'https://api-staging.yolo.studio' }), 'https://api-staging.yolo.studio');
  });
});
