/**
 * yolo tileapp sign|publish tests.
 *   - sign writes signature+publisherKeyId back into the manifest (and --stdout)
 *   - publish requires a signed manifest, returns the releaseId
 *   - auth resolution does NOT require SESSION_ID (off-pod partner use)
 *   - usage / http failures + exit-code mapping
 * Uses an injected fetch + a temp manifest file; never touches the network.
 */

import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { runTileAppSign, runTileAppPublish, exitCodeForFailure } from './tileapp-publisher.js';
import type { FetchLike } from './tileapp-publisher.js';

// No SESSION_ID — the publisher CLI is off-pod.
const ENV = { YOLO_API_TOKEN: 'user-jwt', YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/nonexistent-home' };
const MANIFEST = { id: 'acme-app', version: '1.0.0', displayName: 'Acme', publisher: 'acme', description: 'x', ui: { icon: 'a', color: '#fff', label: 'A' }, surface: { kind: 'iframe', entry: 'index.html' }, permissions: { required: [] } };

function tmpManifest(obj: unknown): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'yolo-tileapp-'));
  const p = path.join(dir, 'manifest.json');
  fs.writeFileSync(p, JSON.stringify(obj, null, 2));
  return p;
}
function stubFetch(handler: (url: string, init: RequestInit | undefined) => { status: number; body: unknown }): FetchLike {
  return (async (url: string | URL | Request, init?: RequestInit) => {
    const { status, body } = handler(String(url), init);
    return {
      ok: status >= 200 && status < 300,
      status,
      json: async () => body,
      text: async () => (typeof body === 'string' ? body : JSON.stringify(body)),
    } as unknown as Response;
  }) as unknown as FetchLike;
}

describe('yolo tileapp sign', () => {
  it('writes signature + publisherKeyId back into the manifest file', async () => {
    const p = tmpManifest(MANIFEST);
    let captured: { url?: string; body?: any } = {};
    const fetchImpl = stubFetch((url, init) => {
      captured = { url, body: JSON.parse(String(init?.body)) };
      return { status: 200, body: { ok: true, signature: 'SIG==', publisherKeyId: 'acme-k1' } };
    });
    const r = await runTileAppSign({ manifestPath: p, publisherId: 'acme', env: ENV, fetchImpl });
    assert.equal(r.ok, true);
    assert.match(captured.url!, /\/v1\/publisher\/sign$/);
    assert.equal(captured.body.publisherId, 'acme');
    const written = JSON.parse(fs.readFileSync(p, 'utf-8'));
    assert.equal(written.signature, 'SIG==');
    assert.equal(written.publisherKeyId, 'acme-k1');
  });

  it('--stdout prints the signed manifest and does NOT rewrite the file', async () => {
    const p = tmpManifest(MANIFEST);
    const before = fs.readFileSync(p, 'utf-8');
    const fetchImpl = stubFetch(() => ({ status: 200, body: { signature: 'S', publisherKeyId: 'k' } }));
    const r = await runTileAppSign({ manifestPath: p, publisherId: 'acme', toStdout: true, env: ENV, fetchImpl });
    assert.equal(r.ok, true);
    if (r.ok) assert.match(r.output, /"signature": "S"/);
    assert.equal(fs.readFileSync(p, 'utf-8'), before); // file untouched
  });

  it('fails (usage) without --publisher', async () => {
    const r = await runTileAppSign({ manifestPath: tmpManifest(MANIFEST), publisherId: '', env: ENV, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, 'usage');
  });

  it('fails (auth) when no user token is available', async () => {
    const r = await runTileAppSign({ manifestPath: tmpManifest(MANIFEST), publisherId: 'acme', env: { YOLO_COMMON_API_URL: 'https://api.example.com', HOME: '/nonexistent-home' }, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    if (!r.ok) assert.equal(r.kind, 'auth');
  });

  it('maps a non-2xx response to an http failure', async () => {
    const r = await runTileAppSign({ manifestPath: tmpManifest(MANIFEST), publisherId: 'acme', env: ENV, fetchImpl: stubFetch(() => ({ status: 403, body: { error: 'MFA required' } })) });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.kind, 'http'); assert.match(r.message, /403/); }
  });
});

describe('yolo tileapp publish', () => {
  it('rejects an UNSIGNED manifest (usage)', async () => {
    const r = await runTileAppPublish({ manifestPath: tmpManifest(MANIFEST), env: ENV, fetchImpl: stubFetch(() => ({ status: 200, body: {} })) });
    assert.equal(r.ok, false);
    if (!r.ok) { assert.equal(r.kind, 'usage'); assert.match(r.message, /sign/); }
  });

  it('submits a signed manifest and prints the releaseId; OMITS channel by default (server defaults to stable)', async () => {
    const signed = { ...MANIFEST, signature: 'SIG==', publisherKeyId: 'acme-k1' };
    let captured: any = {};
    const fetchImpl = stubFetch((url, init) => { captured = { url, body: JSON.parse(String(init?.body)) }; return { status: 200, body: { ok: true, releaseId: 'acme-app@1.0.0#stable', status: 'submitted' } }; });
    const r = await runTileAppPublish({ manifestPath: tmpManifest(signed), env: ENV, fetchImpl });
    assert.equal(r.ok, true);
    assert.match(captured.url, /\/v1\/publisher\/publish$/);
    assert.equal('channel' in captured.body, false); // not forced — server applies its stable default
    if (r.ok) assert.match(r.output, /acme-app@1\.0\.0#stable/);
  });

  it('sends channel only when --channel is explicitly passed', async () => {
    const signed = { ...MANIFEST, signature: 'SIG==', publisherKeyId: 'acme-k1' };
    let captured: any = {};
    const fetchImpl = stubFetch((url, init) => { captured = { url, body: JSON.parse(String(init?.body)) }; return { status: 200, body: { ok: true, releaseId: 'acme-app@1.0.0#beta', status: 'submitted' } }; });
    const r = await runTileAppPublish({ manifestPath: tmpManifest(signed), env: ENV, fetchImpl, channel: 'beta' });
    assert.equal(r.ok, true);
    assert.equal(captured.body.channel, 'beta');
  });
});

describe('exitCodeForFailure', () => {
  it('maps http→1, everything else→64', () => {
    assert.equal(exitCodeForFailure('http'), 1);
    assert.equal(exitCodeForFailure('usage'), 64);
    assert.equal(exitCodeForFailure('auth'), 64);
    assert.equal(exitCodeForFailure('io'), 64);
  });
});
