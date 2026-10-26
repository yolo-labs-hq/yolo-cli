import { it, mock } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { runKanbanCmd } from './kanban-cli.js';

it('the retired delegation command neither reads a credential file nor posts it', async () => {
  let read = false, sent = false, output = '';
  const stderr = mock.method(process.stderr, 'write', (value: string | Uint8Array) => { output += value.toString(); return true; });
  const reader = mock.method(fs, 'readFileSync', () => { read = true; throw new Error('must not read'); });
  try {
    const code = await runKanbanCmd(['focused-delegation', 'card', 'private.json'], {
      fetchImpl: async () => { sent = true; throw new Error('must not send'); },
    });
    assert.equal(code, 64); assert.equal(read, false); assert.equal(sent, false); assert.equal(output.includes('fake-retired-canary'), false);
  } finally { stderr.mock.restore(); reader.mock.restore(); }
});
