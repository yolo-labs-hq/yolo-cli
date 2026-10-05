/**
 * `yolo routing …` — Background Runner routing (which model runs each card)
 * and Jev from a shell: status, on/off, decisions, a route preview, and the
 * runner/board policy.
 *
 * Every verb is one of the owner REST routes in
 * `common-api/src/routes/yolo-background-routing.ts`, reached with the USER
 * token through `userRouteRequest`, like `yolo kanban models`. Nothing is
 * decided here: `--json` prints the response body as-is, and the default
 * output is a short reading of the same body.
 *
 * Exit codes as `kanban-cli.ts`: 0 success, 1 http, 64 usage/auth/workspace.
 */

import * as fs from 'node:fs';

import { type FetchLike, userRouteRequest } from './work-client.js';
import { exitCodeForFailure, resolveKanbanContext, type KanbanFailure, type KanbanResult } from './kanban-cli.js';

// ─── Parsed commands ──────────────────────────────────────────────────────

export type PolicyScope = { scope: 'runner' } | { scope: 'board'; scopeId: string } | { scope: 'card'; scopeId: string };

export type RoutingCommand =
  | { verb: 'status' }
  | { verb: 'on' | 'off' }
  | { verb: 'decisions'; cardId?: string; limit?: number }
  | { verb: 'preview'; cardId: string }
  | { verb: 'policy-get'; cardId?: string }
  | { verb: 'policy-set'; target: PolicyScope & { scope: 'runner' | 'board' }; policyFile?: string; policyJson?: string; expectedRevision?: number }
  | { verb: 'policy-delete'; target: PolicyScope; expectedRevision?: number };

export type ParsedRoutingArgs =
  | { ok: true; command: RoutingCommand; json: boolean; workspaceFlag?: string }
  | { ok: false; message: string };

const OBJECT_ID = /^[a-f0-9]{24}$/;

/** `args` is everything after `routing`. */
export function parseRoutingArgs(args: string[]): ParsedRoutingArgs {
  const positional: string[] = [];
  const flags: Record<string, string | true> = {};
  const VALUED = new Set(['--workspace', '--card', '--board', '--limit', '--file', '--policy', '--expected-revision']);
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    const eq = a.indexOf('=');
    const name = a.startsWith('--') && eq > 0 ? a.slice(0, eq) : a;
    if (VALUED.has(name)) {
      const v = eq > 0 && a.startsWith('--') ? a.slice(eq + 1) : args[++i];
      if (!v || (eq < 0 && v.startsWith('--'))) return { ok: false, message: `${name} requires a value` };
      flags[name] = v;
    } else if (a === '--json' || a === '--runner') {
      flags[a] = true;
    } else if (a.startsWith('-')) {
      return { ok: false, message: `unknown option: ${a}` };
    } else {
      positional.push(a);
    }
  }
  const json = flags['--json'] === true;
  const workspaceFlag = flags['--workspace'] as string | undefined;
  const allow = (...names: string[]) => {
    const extra = Object.keys(flags).find(f => f !== '--json' && f !== '--workspace' && !names.includes(f));
    return extra ? `${extra} does not apply here` : null;
  };
  const card = flags['--card'] as string | undefined;
  if (card !== undefined && !OBJECT_ID.test(card)) return { ok: false, message: '--card takes a card id (24 hex characters)' };
  const board = flags['--board'] as string | undefined;
  if (board !== undefined && !OBJECT_ID.test(board)) return { ok: false, message: '--board takes a board id (24 hex characters)' };
  const revision = flags['--expected-revision'] === undefined ? undefined : Number(flags['--expected-revision']);
  if (revision !== undefined && (!Number.isInteger(revision) || revision < 0)) {
    return { ok: false, message: '--expected-revision takes a non-negative integer' };
  }

  const [verb, sub, ...rest] = positional;
  const done = (command: RoutingCommand, ...names: string[]): ParsedRoutingArgs => {
    const problem = allow(...names);
    return problem ? { ok: false, message: problem } : { ok: true, command, json, workspaceFlag };
  };
  const noMore = (list: Array<string | undefined>) => list.find(v => v !== undefined);

  switch (verb) {
    case 'status':
    case 'on':
    case 'off': {
      const extra = noMore([sub, ...rest]);
      if (extra) return { ok: false, message: `unexpected positional argument: ${extra}` };
      return done(verb === 'status' ? { verb } : { verb });
    }
    case 'decisions': {
      const extra = noMore([sub, ...rest]);
      if (extra) return { ok: false, message: `unexpected positional argument: ${extra}` };
      const limit = flags['--limit'] === undefined ? undefined : Number(flags['--limit']);
      if (limit !== undefined && (!Number.isInteger(limit) || limit < 1 || limit > 200)) {
        return { ok: false, message: '--limit takes an integer from 1 to 200' };
      }
      return done({ verb, ...(card ? { cardId: card } : {}), ...(limit !== undefined ? { limit } : {}) }, '--card', '--limit');
    }
    case 'preview': {
      if (!sub) return { ok: false, message: 'a <cardId> is required' };
      if (!OBJECT_ID.test(sub)) return { ok: false, message: '<cardId> must be a card id (24 hex characters)' };
      const extra = noMore(rest);
      if (extra) return { ok: false, message: `unexpected positional argument: ${extra}` };
      return done({ verb, cardId: sub });
    }
    case 'policy': {
      const extra = noMore(rest);
      if (extra) return { ok: false, message: `unexpected positional argument: ${extra}` };
      if (sub === 'get') return done({ verb: 'policy-get', ...(card ? { cardId: card } : {}) }, '--card');
      const targets = [flags['--runner'] === true, board !== undefined, card !== undefined].filter(Boolean).length;
      if (sub === 'set') {
        if (card !== undefined) return { ok: false, message: 'a card\'s model pin is set on the card, not with `routing policy set`' };
        if (targets !== 1) return { ok: false, message: 'choose one of --runner or --board <id>' };
        const file = flags['--file'] as string | undefined;
        const inline = flags['--policy'] as string | undefined;
        if ((file === undefined) === (inline === undefined)) return { ok: false, message: 'give the policy with exactly one of --file <path> or --policy <json>' };
        const target = board ? { scope: 'board' as const, scopeId: board } : { scope: 'runner' as const };
        return done({ verb: 'policy-set', target, ...(file ? { policyFile: file } : { policyJson: inline }),
          ...(revision !== undefined ? { expectedRevision: revision } : {}) }, '--runner', '--board', '--file', '--policy', '--expected-revision');
      }
      if (sub === 'delete') {
        if (targets !== 1) return { ok: false, message: 'choose one of --runner, --board <id> or --card <id>' };
        if (revision === 0) return { ok: false, message: '--expected-revision for a delete is 1 or more' };
        const target: PolicyScope = board ? { scope: 'board', scopeId: board } : card ? { scope: 'card', scopeId: card } : { scope: 'runner' };
        return done({ verb: 'policy-delete', target, ...(revision !== undefined ? { expectedRevision: revision } : {}) },
          '--runner', '--board', '--card', '--expected-revision');
      }
      return { ok: false, message: sub ? `unknown policy subcommand '${sub}'` : 'policy requires get, set or delete' };
    }
    default:
      return { ok: false, message: verb ? `unknown routing subcommand '${verb}'` : 'routing requires a subcommand' };
  }
}

// ─── Running ──────────────────────────────────────────────────────────────

export interface RoutingDeps {
  fetchImpl?: FetchLike;
  env?: Record<string, string | undefined>;
  readFileImpl?: (filePath: string) => string;
}

interface Call { method: 'GET' | 'PUT' | 'POST' | 'DELETE'; path: string; body?: unknown; label: string }

export async function runRouting(parsed: Extract<ParsedRoutingArgs, { ok: true }>, deps: RoutingDeps = {}): Promise<KanbanResult> {
  const env = deps.env ?? process.env;
  const resolved = resolveKanbanContext(env, parsed.workspaceFlag);
  if (!resolved.ok) return resolved.failure;
  const { commonApiUrl, userToken, workspaceId } = resolved;
  const base = `/workspaces/${encodeURIComponent(workspaceId)}/yolo-background/routing`;
  const send = async ({ method, path, body, label }: Call): Promise<{ ok: true; text: string } | KanbanFailure> => {
    let response;
    try {
      response = await userRouteRequest({ commonApiUrl, userToken, fetchImpl: deps.fetchImpl }, `${base}/${path}`,
        { method, ...(body !== undefined ? { jsonBody: body } : {}) });
    } catch (err) {
      return fail('http', `${label} failed: ${err instanceof Error ? err.message : String(err)}`);
    }
    const text = await response.text().catch(() => '<no body>');
    if (!response.ok) return fail('http', `${label} failed: HTTP ${response.status} — ${text}`, { status: response.status });
    return { ok: true, text };
  };
  const finish = (text: string, human: (body: any) => string): KanbanResult => {
    if (parsed.json) return { ok: true, output: text, raw: true, workspaceId };
    let body: unknown;
    try { body = JSON.parse(text); } catch { return { ok: true, output: text, raw: false, workspaceId }; }
    return { ok: true, output: human(body), raw: false, workspaceId };
  };

  const { command } = parsed;
  switch (command.verb) {
    case 'status': {
      const r = await send({ method: 'GET', path: 'config', label: 'routing.config' });
      return r.ok ? finish(r.text, formatStatus) : r;
    }
    case 'on':
    case 'off': {
      const r = await send({ method: 'PUT', path: 'enabled', body: { enabled: command.verb === 'on' }, label: 'routing.enabled' });
      return r.ok ? finish(r.text, (body: { enabled?: boolean }) =>
        `Routing is ${body.enabled ? 'on: Jev assesses cards admitted from now on' : 'off: cards admitted from now on run on the background agent\'s default model'}. Running work is untouched.`) : r;
    }
    case 'decisions': {
      const qs = new URLSearchParams();
      if (command.cardId) qs.set('cardIds', command.cardId);
      if (command.limit !== undefined) qs.set('limit', String(command.limit));
      const q = qs.toString();
      const r = await send({ method: 'GET', path: `decisions${q ? `?${q}` : ''}`, label: 'routing.decisions' });
      return r.ok ? finish(r.text, formatDecisions) : r;
    }
    case 'preview': {
      const r = await send({ method: 'POST', path: 'preview', body: { cardId: command.cardId }, label: 'routing.preview' });
      // A preview's shape is the router's; the summary is its decision, the rest is `--json`.
      return r.ok ? finish(r.text, (body: { decision?: unknown }) => JSON.stringify(body.decision ?? body, null, 2)) : r;
    }
    case 'policy-get': {
      const r = await send({ method: 'GET', path: `config${command.cardId ? `?cardId=${command.cardId}` : ''}`, label: 'routing.config' });
      if (!r.ok) return r;
      if (parsed.json) {
        const body = JSON.parse(r.text) as { policies?: unknown; cardPolicies?: unknown };
        return { ok: true, output: JSON.stringify({ policies: body.policies ?? [], cardPolicies: body.cardPolicies ?? null }, null, 2), raw: false, workspaceId };
      }
      return finish(r.text, formatPolicies);
    }
    case 'policy-set': {
      let policy: unknown;
      try {
        const source = command.policyFile !== undefined ? (deps.readFileImpl ?? defaultReadFile)(command.policyFile) : command.policyJson!;
        policy = JSON.parse(source);
      } catch (err) {
        return fail('usage', `the policy is not readable JSON: ${err instanceof Error ? err.message : String(err)}`);
      }
      if (!policy || typeof policy !== 'object' || Array.isArray(policy)) return fail('usage', 'the policy must be a JSON object');
      const scopeId = command.target.scope === 'board' ? command.target.scopeId : null;
      let expectedRevision = command.expectedRevision;
      if (expectedRevision === undefined) {
        // Unfenced: overwrite what is stored now (revision 0: nothing is).
        const r = await send({ method: 'GET', path: 'config', label: 'routing.config' });
        if (!r.ok) return r;
        const policies = (JSON.parse(r.text) as { policies?: Array<{ scope: string; scopeId: string | null; revision: number }> }).policies ?? [];
        expectedRevision = policies.find(doc => doc.scope === command.target.scope && (doc.scopeId ?? null) === scopeId)?.revision ?? 0;
      }
      const r = await send({ method: 'PUT', path: 'policy', body: { scope: command.target.scope, scopeId, policy, expectedRevision }, label: 'routing.policy' });
      return r.ok ? finish(r.text, (body: { revision?: number }) => `Saved the ${describeScope(command.target)} policy (revision ${body.revision}).`) : r;
    }
    case 'policy-delete': {
      const t = command.target;
      const path = `policy/${t.scope}${t.scope === 'runner' ? '' : `/${t.scopeId}`}${command.expectedRevision !== undefined ? `?expectedRevision=${command.expectedRevision}` : ''}`;
      const r = await send({ method: 'DELETE', path, label: 'routing.policy.delete' });
      return r.ok ? finish(r.text, () => `Deleted the ${describeScope(t)} policy; it inherits again.`) : r;
    }
  }
}

// ─── Human output ─────────────────────────────────────────────────────────

const describeScope = (t: PolicyScope) => t.scope === 'runner' ? 'runner' : `${t.scope} ${t.scopeId}`;

interface ConfigBody {
  enabled?: boolean;
  jev?: { state?: string; reason?: string | null; credentials?: string; model?: string;
    usage?: Array<{ day: string; calls: number; failures: number; costUsd: number | null }> };
  policies?: Array<{ scope: string; scopeId: string | null; revision: number; updatedAt?: string }>;
  cardPolicies?: { count?: number };
}

export function formatStatus(body: ConfigBody): string {
  const jev = body.jev;
  const usage = jev?.usage ?? [];
  const calls = usage.reduce((n, d) => n + (d.calls ?? 0), 0);
  const cost = usage.every(d => typeof d.costUsd === 'number') ? usage.reduce((n, d) => n + (d.costUsd as number), 0) : null;
  return [
    `Routing: ${body.enabled ? 'on' : 'off'}`,
    `Jev:     ${jev?.state ?? 'unknown'}${jev?.reason ? ` (${jev.reason})` : ''}${jev?.model ? ` — ${jev.model}` : ''}`,
    `         ${calls} call${calls === 1 ? '' : 's'} in the last ${usage.length} day${usage.length === 1 ? '' : 's'}${cost === null ? '' : `, $${cost.toFixed(4)}`}`,
    formatPolicies(body),
  ].join('\n');
}

export function formatPolicies(body: ConfigBody): string {
  const lines = (body.policies ?? []).map(p => `  ${p.scope === 'runner' ? 'runner' : `${p.scope} ${p.scopeId}`}  revision ${p.revision}`);
  return [
    `Policies:${lines.length ? '' : ' none (built-in defaults)'}`,
    ...lines,
    `Card policies (model pins): ${body.cardPolicies?.count ?? 0}`,
  ].join('\n');
}

interface DecisionsBody { decisions?: Array<{ cardId: string; kind: string; createdAt: string;
  decision?: { status?: string; selected?: { configurationId?: string } | null; waiting?: { code?: string } | null } }> }

export function formatDecisions(body: DecisionsBody): string {
  const decisions = body.decisions ?? [];
  if (decisions.length === 0) return 'No routing decisions recorded.';
  return decisions.map(d => {
    const detail = d.decision?.selected?.configurationId ?? d.decision?.waiting?.code;
    return `${d.createdAt}  ${d.cardId}  ${d.kind}  ${d.decision?.status ?? '?'}${detail ? `  ${detail}` : ''}`;
  }).join('\n');
}

// ─── CLI surface ──────────────────────────────────────────────────────────

export const ROUTING_USAGE = [
  'Usage: yolo routing <subcommand> [--json] [--workspace <wsId>]',
  '',
  'Subcommands:',
  '  status                                    Routing on/off, Jev\'s state and why it is unavailable, policies',
  '  on | off                                  Turn routing on or off (cards admitted from now on)',
  '  decisions [--card <id>] [--limit <n>]     Recorded decisions for one card, or the latest (1-200)',
  '  preview <cardId>                          Where routing would send a card now (read-only)',
  '  policy get [--card <id>]                  Runner and board policies with their revisions',
  '  policy set (--runner | --board <id>)      Replace a policy: --file <path> or --policy <json>',
  '      [--expected-revision <n>]             Refuse if the policy changed since revision <n>',
  '  policy delete (--runner | --board <id> | --card <id>) [--expected-revision <n>]',
  '                                            Delete a policy so it inherits again',
  '',
  '--json prints the API response as-is.',
  '',
].join('\n');

/** `args` is everything after `routing`. */
export async function runRoutingCmd(args: string[], deps: RoutingDeps = {}): Promise<number> {
  if (args.length === 0 || args.some(a => a === '--help' || a === '-h') || args[0] === 'help') {
    (args.length === 0 ? process.stderr : process.stdout).write(ROUTING_USAGE);
    return args.length === 0 ? 64 : 0;
  }
  const parsed = parseRoutingArgs(args);
  if (!parsed.ok) {
    process.stderr.write(`yolo: routing: ${parsed.message}\n`);
    process.stderr.write(ROUTING_USAGE);
    return 64;
  }
  const result = await runRouting(parsed, deps);
  if (result.ok) {
    process.stdout.write(result.raw ? result.output : `${result.output}\n`);
    return 0;
  }
  process.stderr.write(`FAIL [${result.kind}]: ${result.message}\n`);
  return exitCodeForFailure(result.kind);
}

function fail(kind: KanbanFailure['kind'], message: string, detail?: Record<string, unknown>): KanbanFailure {
  return { ok: false, kind, message, detail };
}

function defaultReadFile(filePath: string): string {
  return fs.readFileSync(filePath, 'utf-8');
}
