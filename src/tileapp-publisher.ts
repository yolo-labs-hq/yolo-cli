/**
 * `yolo tileapp sign|publish` — the publisher submission flow (M1).
 *
 *   yolo tileapp sign    <manifest.json> --publisher <id> [--key <keyId>] [--stdout]
 *     → POST /v1/publisher/sign — the platform KMS-signs the manifest on the
 *       publisher's behalf and the CLI writes `signature`/`publisherKeyId` back
 *       into the manifest file (or prints it with --stdout).
 *
 *   yolo tileapp publish <manifest.json> [--channel beta|stable] [--image-digest <d>]
 *     → POST /v1/publisher/publish — submits the SIGNED manifest as a quarantine
 *       (`submitted`) release; review promotes it later. Prints the releaseId.
 *
 * Both use the user JWT directly (the publisher endpoints are user-authed), so
 * no MCP delegation. The HTTP transport is injectable for unit tests.
 */

import fs from 'node:fs';
import { resolveUserToken } from './auth-context.js';

export type FetchLike = typeof fetch;

/**
 * Resolve the user JWT + API base for a publisher command. Unlike the substrate
 * `resolveSubstrateContext`, this does NOT require `SESSION_ID` — the publisher
 * CLI is run by a partner OFF-pod and hits the user-authed `/v1/publisher/*`
 * routes directly (no session-bound MCP token).
 */
type PublisherAuth = { ok: true; commonApiUrl: string; userToken: string } | { ok: false; message: string };
function resolvePublisherAuth(env: Record<string, string | undefined>): PublisherAuth {
  const commonApiUrl = env.YOLO_COMMON_API_URL || env.YOLO_API_URL;
  if (!commonApiUrl) return { ok: false, message: 'YOLO_COMMON_API_URL (or YOLO_API_URL) env var is required' };
  const userToken = resolveUserToken(env);
  if (!userToken) {
    return { ok: false, message: 'no user token: set YOLO_API_TOKEN or sign in (~/.config/yolo/token)' };
  }
  return { ok: true, commonApiUrl, userToken };
}

interface CommonOptions {
  manifestPath: string;
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
}

export interface SignOptions extends CommonOptions {
  publisherId: string;
  keyId?: string;
  /** Print the signed manifest to stdout instead of rewriting the file. */
  toStdout?: boolean;
}

export interface PublishOptions extends CommonOptions {
  channel?: 'beta' | 'stable';
  imageDigest?: string;
}

export type CmdResult =
  | { ok: true; output: string }
  | { ok: false; kind: 'usage' | 'auth' | 'io' | 'http'; message: string };

/** publisher routes live under `/v1`; `commonApiUrl` is the host base. */
function apiBase(commonApiUrl: string): string {
  const base = commonApiUrl.replace(/\/$/, '');
  return base.endsWith('/v1') ? base : `${base}/v1`;
}

function readManifest(path: string): { ok: true; manifest: Record<string, unknown> } | { ok: false; message: string } {
  let raw: string;
  try { raw = fs.readFileSync(path, 'utf-8'); }
  catch (e) { return { ok: false, message: `cannot read manifest '${path}': ${(e as Error).message}` }; }
  try { return { ok: true, manifest: JSON.parse(raw) as Record<string, unknown> }; }
  catch (e) { return { ok: false, message: `manifest '${path}' is not valid JSON: ${(e as Error).message}` }; }
}

async function safeText(res: { text(): Promise<string> }): Promise<string> {
  try { return await res.text(); } catch { return '<no body>'; }
}

export async function runTileAppSign(opts: SignOptions): Promise<CmdResult> {
  const env = opts.env ?? process.env;
  if (!opts.publisherId) return { ok: false, kind: 'usage', message: '--publisher <id> is required' };
  const auth = resolvePublisherAuth(env);
  if (!auth.ok) return { ok: false, kind: 'auth', message: auth.message };

  const read = readManifest(opts.manifestPath);
  if (!read.ok) return { ok: false, kind: 'io', message: read.message };

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    res = await fetchImpl(`${apiBase(auth.commonApiUrl)}/publisher/sign`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.userToken}` },
      body: JSON.stringify({ publisherId: opts.publisherId, keyId: opts.keyId, manifest: read.manifest }),
    });
  } catch (e) {
    return { ok: false, kind: 'http', message: `sign request failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, kind: 'http', message: `sign failed: HTTP ${res.status} — ${await safeText(res)}` };
  const json = (await res.json()) as { signature?: string; publisherKeyId?: string };
  if (!json.signature || !json.publisherKeyId) return { ok: false, kind: 'http', message: 'sign response missing signature/publisherKeyId' };

  const signed = { ...read.manifest, signature: json.signature, publisherKeyId: json.publisherKeyId };
  if (opts.toStdout) return { ok: true, output: JSON.stringify(signed, null, 2) };
  try { fs.writeFileSync(opts.manifestPath, `${JSON.stringify(signed, null, 2)}\n`); }
  catch (e) { return { ok: false, kind: 'io', message: `cannot write signed manifest: ${(e as Error).message}` }; }
  return { ok: true, output: `Signed ${String(read.manifest.id)}@${String(read.manifest.version)} with key ${json.publisherKeyId} → ${opts.manifestPath}` };
}

export async function runTileAppPublish(opts: PublishOptions): Promise<CmdResult> {
  const env = opts.env ?? process.env;
  const auth = resolvePublisherAuth(env);
  if (!auth.ok) return { ok: false, kind: 'auth', message: auth.message };

  const read = readManifest(opts.manifestPath);
  if (!read.ok) return { ok: false, kind: 'io', message: read.message };
  if (!read.manifest.signature) {
    return { ok: false, kind: 'usage', message: 'manifest is not signed — run `yolo tileapp sign` first' };
  }

  const fetchImpl = opts.fetchImpl ?? fetch;
  let res: Awaited<ReturnType<FetchLike>>;
  try {
    // Only send `channel` when the user explicitly passed --channel, so the
    // CLI default can't diverge from the server's (the publish endpoint defaults
    // to `stable`). Same for imageDigest.
    const body: Record<string, unknown> = { manifest: read.manifest };
    if (opts.channel) body.channel = opts.channel;
    if (opts.imageDigest) body.imageDigest = opts.imageDigest;
    res = await fetchImpl(`${apiBase(auth.commonApiUrl)}/publisher/publish`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: `Bearer ${auth.userToken}` },
      body: JSON.stringify(body),
    });
  } catch (e) {
    return { ok: false, kind: 'http', message: `publish request failed: ${(e as Error).message}` };
  }
  if (!res.ok) return { ok: false, kind: 'http', message: `publish failed: HTTP ${res.status} — ${await safeText(res)}` };
  const json = (await res.json()) as { releaseId?: string; status?: string };
  if (!json.releaseId) return { ok: false, kind: 'http', message: 'publish response missing releaseId' };
  return { ok: true, output: `Submitted ${json.releaseId} (status: ${json.status ?? 'submitted'}) — awaiting review` };
}

export function exitCodeForFailure(kind: 'usage' | 'auth' | 'io' | 'http'): number {
  return kind === 'http' ? 1 : 64;
}
