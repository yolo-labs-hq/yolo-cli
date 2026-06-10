/**
 * Context resolver / formatter tests.
 *
 * Pure-string output, easy to lock against regression. The tested
 * change: `formatContext` used to render a misleading
 * `workspaceId hint   (unset; resolved from session at token mint)`
 * even when WORKSPACE_ID was set in the env. Now it surfaces
 * whatever's there as `workspaceId        <value>` and reserves
 * the `(unset — will resolve from session at mint time)` text for
 * the actually-unset case.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { formatContext, type SessionContext } from './context.js';

const BASE: SessionContext = {
  sessionId: 'sess-abc',
  commonApiUrl: 'https://api.example.com',
  userTokenPresent: true,
  workspaceIdHint: null,
};

describe('context — formatContext', () => {
  it('shows the workspaceId without "hint"-style hedging when WORKSPACE_ID is set', () => {
    const out = formatContext({ ...BASE, workspaceIdHint: 'ws-507f1f77' });
    assert.match(out, /workspaceId\s+ws-507f1f77\b/);
    assert.equal(out.includes('hint'), false);
    assert.equal(out.includes('(unset'), false);
  });

  it('shows a clear "(unset)" message when WORKSPACE_ID is missing', () => {
    const out = formatContext({ ...BASE, workspaceIdHint: null });
    assert.match(out, /workspaceId\s+\(unset/);
    assert.match(out, /resolve from session at mint time/);
  });

  it('reports userToken state honestly (set vs missing)', () => {
    assert.match(formatContext({ ...BASE, userTokenPresent: true }), /userToken\s+\(set\)/);
    assert.match(formatContext({ ...BASE, userTokenPresent: false }), /userToken\s+\(missing\)/);
  });

  it('renders sessionId + commonApiUrl directly (no hedging on either)', () => {
    const out = formatContext({ ...BASE, sessionId: 'my-session', commonApiUrl: 'https://prod.example.com' });
    assert.match(out, /sessionId\s+my-session/);
    assert.match(out, /commonApiUrl\s+https:\/\/prod\.example\.com/);
  });
});
