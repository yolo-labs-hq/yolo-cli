/**
 * `yolo kanban focused-delegation` — the CLI twin of the human-only delegation intake route.
 * Every token here is a fake string. What is asserted is mostly an absence: the bearer never reaches stdout or stderr.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { parseKanbanFocusedDelegationArgs, runKanbanFocusedDelegation } from './kanban-cli.js';
import type { FetchLike } from './work-client.js';

const WS = '507f1f77bcf86cd799439011';
const CARD = '507f1f77bcf86cd799439022';
const FAKE = 'fake-delegation-token-for-cli-tests-only';
const ENV = { SESSION_ID: 'sess-abc', HOME: '/nonexistent-yolo-cli-test-home', YOLO_API_TOKEN: 'user-jwt',
  YOLO_COMMON_API_URL: 'https://api.example.com', WORKSPACE_ID: WS };
const DOCUMENT = JSON.stringify({
  authorization: { taskId: 't-1', projectId: 'p-1', claimAttemptId: 'ca-1', delegationId: 'd-1',
    verbs: ['tasks:claim', 'submissions:create', 'candidates:read', 'receipts:read'] },
  delegation: { delegationId: 'd-1', accessToken: FAKE, tokenType: 'Bearer', expiresAt: '2026-10-24T00:00:00Z', revocationId: 'rv-1' },
}, null, 2);

interface Captured { url?: string; method?: string; body?: string; headers?: Record<string, string> }
function fetchStub(status: number, text: string, captured: Captured = {}): FetchLike {
  return async (url, init = {}) => {
    Object.assign(captured, { url, method: init.method, body: init.body, headers: init.headers });
    return { ok: status < 300, status, json: async () => JSON.parse(text), text: async () => text };
  };
}

describe('kanban focused-delegation', () => {
  it('posts the document unmodified with the USER token to the card route and prints a summary without the token', async () => {
    const captured: Captured = {};
    const result = await runKanbanFocusedDelegation({ cardId: CARD, file: 'claim.json', env: ENV, readFileImpl: () => DOCUMENT,
      fetchImpl: fetchStub(201, JSON.stringify({ state: 'stored', taskId: 't-1', delegationId: 'd-1', expiresAt: '2026-10-24T00:00:00.000Z',
        verbs: ['candidates:read', 'receipts:read'] }), captured) });
    assert.equal(result.ok, true);
    assert.equal(captured.method, 'POST');
    assert.ok(captured.url?.endsWith(`/workspaces/${WS}/kanban/cards/${CARD}/focused-delegation`), captured.url);
    assert.equal(captured.headers?.Authorization, 'Bearer user-jwt');
    assert.equal(captured.body, DOCUMENT);
    if (result.ok) {
      assert.match(result.output, /Stored delegation d-1 for Octocove task t-1/);
      assert.ok(!result.output.includes(FAKE));
    }
  });

  it('redacts the token from any server answer it prints, and never quotes a malformed document', async () => {
    const refused = await runKanbanFocusedDelegation({ cardId: CARD, file: 'claim.json', env: ENV, readFileImpl: () => DOCUMENT,
      fetchImpl: fetchStub(400, JSON.stringify({ error: `bad ${FAKE}`, code: 'INVALID_ARGUMENT' })) });
    assert.equal(refused.ok, false);
    if (!refused.ok) assert.ok(!refused.message.includes(FAKE) && refused.message.includes('[redacted]'), refused.message);
    const malformed = await runKanbanFocusedDelegation({ cardId: CARD, file: 'claim.json', env: ENV,
      readFileImpl: () => `{"delegation": {"accessToken": "${FAKE}"`, fetchImpl: fetchStub(201, '{}') });
    assert.equal(malformed.ok, false);
    if (!malformed.ok) assert.ok(!malformed.message.includes(FAKE));
  });

  it('takes the token only from the document: no option carries it', () => {
    assert.deepEqual(parseKanbanFocusedDelegationArgs([CARD, '-']), { ok: true, cardId: CARD, file: '-', workspaceFlag: undefined });
    assert.equal(parseKanbanFocusedDelegationArgs([CARD, 'f', '--token', FAKE]).ok, false);
    assert.equal(parseKanbanFocusedDelegationArgs([CARD]).ok, false);
    assert.deepEqual(parseKanbanFocusedDelegationArgs([CARD, 'f', '--workspace', WS]), { ok: true, cardId: CARD, file: 'f', workspaceFlag: WS });
  });
});
