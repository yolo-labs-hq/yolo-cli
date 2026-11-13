/**
 * MOGUL-D040 P2 — the CLI surfaces a pod's staged owner approval (202
 * POD_OWNER_APPROVAL_REQUESTED) as PENDING / awaiting-approval (exit 3), never
 * as success and never as a resend; and says plainly that marketplace publishing
 * is refused from a pod.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { formatOwnerApprovalPending, ownerApprovalRequestedOf } from './pod-owner-approval.js';
import { setProjectWorkspace, type DeployFetchLike } from './deploy-client.js';
import { runTileAppInit, runTileAppPublishPersonal, exitCodeForFailure } from './tileapp-personal.js';
import { runTileAppPublish } from './tileapp-publisher.js';

const STAGED = {
  ok: false,
  reason: 'approval-required',
  code: 'POD_OWNER_APPROVAL_REQUESTED',
  message: 'Owner approval requested in Studio: Re-link a deploy project',
  approvalId: 'nonce-abc',
  statement: 'Re-link a deploy project to a different workspace, requested by a workspace agent: PUT /v1/deploy/projects/p1/workspace',
  expiresAt: '2026-11-06T23:10:00.000Z',
  pollPath: '/v1/deploy/approvals/nonce-abc',
  hint: 'Poll it with deploy.approval_status.',
};

describe('ownerApprovalRequestedOf', () => {
  it('recognises only the 202 staged-approval answer', () => {
    assert.deepEqual(ownerApprovalRequestedOf(202, STAGED), {
      approvalId: 'nonce-abc', statement: STAGED.statement, expiresAt: STAGED.expiresAt, message: STAGED.message, hint: STAGED.hint,
    });
    assert.equal(ownerApprovalRequestedOf(200, STAGED), null);
    assert.equal(ownerApprovalRequestedOf(202, { ...STAGED, code: 'OTHER' }), null);
    assert.equal(ownerApprovalRequestedOf(202, { ...STAGED, approvalId: '' }), null);
    assert.equal(ownerApprovalRequestedOf(202, null), null);
  });

  it('formats a PENDING block that says it runs as the owner and must not be resent', () => {
    const out = formatOwnerApprovalPending(ownerApprovalRequestedOf(202, STAGED)!, 'linking project p1');
    assert.match(out, /^PENDING \[awaiting-approval\]: linking project p1 needs the workspace owner's approval \(approval nonce-abc\)/);
    assert.match(out, /runs AS THE OWNER/);
    assert.match(out, /Do not rerun/);
  });
});

describe('deploy-client: a staged re-link is awaiting-approval, not success', () => {
  it('maps the 202 to kind awaiting-approval with the approval id', async () => {
    const fetchImpl: DeployFetchLike = async () => ({
      ok: true, status: 202, json: async () => STAGED, text: async () => JSON.stringify(STAGED), body: null,
    });
    const r = await setProjectWorkspace(
      { commonApiUrl: 'https://api.example.com', env: { HOME: '/home/test', YOLO_API_TOKEN_NONPROD: 'tok' }, readFileImpl: () => undefined, fetchImpl },
      'p1', { workspaceId: 'w2', expectedWorkspaceId: 'w1' },
    );
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, 'awaiting-approval');
    assert.equal(r.status, 202);
    assert.equal(r.detail?.approvalId, 'nonce-abc');
  });

  it('a plain 200 is still success', async () => {
    const fetchImpl: DeployFetchLike = async () => ({
      ok: true, status: 200, json: async () => ({ project: { workspaceId: 'w2' } }), text: async () => '', body: null,
    });
    const r = await setProjectWorkspace(
      { commonApiUrl: 'https://api.example.com', env: { HOME: '/home/test', YOLO_API_TOKEN_NONPROD: 'tok' }, readFileImpl: () => undefined, fetchImpl },
      'p1', { workspaceId: 'w2', expectedWorkspaceId: 'w1' },
    );
    assert.equal(r.ok, true);
  });
});

function stubFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown }, calls: string[] = []) {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    calls.push(`${init?.method ?? 'GET'} ${String(url)}`);
    const { status, body } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as typeof fetch;
}

const ENV = { YOLO_API_TOKEN_NONPROD: 'user-jwt', YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/nonexistent-home' };

describe('tileapp publish --personal from a pod', () => {
  function scaffold(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-pod-approval-'));
    runTileAppInit({ name: 'clock', cwd });
    return path.join(cwd, 'clock', 'tileapp.json');
  }

  it('stops at the staged register (no bundle upload against an app that does not exist yet), exit 3', async () => {
    const calls: string[] = [];
    const r = await runTileAppPublishPersonal({ manifestPath: scaffold(), env: ENV, fetchImpl: stubFetch(() => ({ status: 202, body: STAGED }), calls) });
    assert.equal(r.ok, false);
    if (r.ok) return;
    assert.equal(r.kind, 'awaiting-approval');
    assert.equal(exitCodeForFailure(r.kind), 3);
    assert.match(r.message, /registering personal app 'clock' needs the workspace owner's approval \(approval nonce-abc\)/);
    assert.equal(calls.length, 1, `only the register call: ${calls.join(', ')}`);
  });

  it('a staged bundle upload is awaiting-approval too', async () => {
    const r = await runTileAppPublishPersonal({
      manifestPath: scaffold(), env: ENV,
      fetchImpl: stubFetch((url) => (url.endsWith('/tileapps/personal') ? { status: 201, body: { appId: 'pa-x-clock' } } : { status: 202, body: STAGED })),
    });
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, 'awaiting-approval');
      assert.match(r.message, /uploading the bundle of pa-x-clock/);
    }
  });
});

describe('tileapp publish --personal inside a pod: ONE request, ONE approval (ruling 2026-11-07)', () => {
  const POD_ENV = { ...ENV, SESSION_ID: 'sess-1' };
  function scaffold(): string {
    const cwd = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-pod-batch-'));
    runTileAppInit({ name: 'clock', cwd });
    return path.join(cwd, 'clock', 'tileapp.json');
  }

  it('sends register + bundle as one publish-batch call and reports the staged approval (exit 3)', async () => {
    const calls: string[] = [];
    const r = await runTileAppPublishPersonal({ manifestPath: scaffold(), env: POD_ENV, fetchImpl: stubFetch(() => ({ status: 202, body: STAGED }), calls) });
    assert.deepEqual(calls.map((c) => c.replace('https://api.example.com', '')), ['POST /v1/tileapps/personal/publish-batch']);
    assert.equal(r.ok, false);
    if (!r.ok) {
      assert.equal(r.kind, 'awaiting-approval');
      assert.match(r.message, /publishing personal app 'clock' needs the workspace owner's approval/);
    }
  });

  it('a direct success (boundary not enforcing) publishes in one call', async () => {
    const calls: string[] = [];
    const r = await runTileAppPublishPersonal({
      manifestPath: scaffold(), env: POD_ENV,
      fetchImpl: stubFetch(() => ({ status: 201, body: { appId: 'pa-x-clock', created: true, bundle: { uploaded: 2 } } }), calls),
    });
    assert.equal(r.ok, true, r.ok ? '' : (r as { message: string }).message);
    assert.equal(calls.length, 1);
    if (r.ok) assert.match(r.output, /Published pa-x-clock/);
  });

  it('falls back to the two-step path on a server without the batch route', async () => {
    const calls: string[] = [];
    const r = await runTileAppPublishPersonal({
      manifestPath: scaffold(), env: POD_ENV,
      fetchImpl: stubFetch((url) => (url.endsWith('/publish-batch') ? { status: 404, body: { error: 'Not found' } }
        : url.endsWith('/tileapps/personal') ? { status: 201, body: { appId: 'pa-x-clock' } } : { status: 200, body: { uploaded: 2 } }), calls),
    });
    assert.equal(r.ok, true);
    assert.equal(calls.length, 3);
  });
});

describe('tileapp publish (marketplace) from a pod', () => {
  it('says plainly that it is refused from a workspace pod', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-pod-publisher-'));
    const manifestPath = path.join(dir, 'tileapp.json');
    fs.writeFileSync(manifestPath, JSON.stringify({
      id: 'acme-app', version: '1.0.0', displayName: 'Acme', publisher: 'acme', description: 'x',
      ui: { icon: 'a', color: '#fff', label: 'A' }, surface: { kind: 'iframe', entry: 'index.html' }, permissions: { required: [] },
      signature: 'SIG==', publisherKeyId: 'acme-k1',
    }));
    const r = await runTileAppPublish({
      manifestPath, env: ENV,
      fetchImpl: stubFetch(() => ({ status: 403, body: { error: 'This action is not available to a workspace pod credential', code: 'POD_TOKEN_FORBIDDEN' } })),
    });
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.message, /publish refused: marketplace publishing cannot be done from a workspace pod/);
  });
});
