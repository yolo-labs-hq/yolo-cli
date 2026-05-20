# @yololabs/yolo-cli — YOLO Studio substrate CLI

The `yolo` binary owns substrate-tooling subcommands (Plan import/export,
future workspace and artifact primitives). Distinct from:

- **`yolo-code`** — YOLO Studio's built-in coding agent CLI (separate package).
- **`yolo-router`** — the LLM gateway client (separate package).

## Status

Phase 8a Group 9 scaffold. v1 ships only `yolo --version` and
`yolo context` (resolves and prints the container ambient session
context). Plan import/export lands in Phase 8c.

## Usage (in-container)

```sh
yolo --version
yolo context
```

Outside a Studio container the CLI exits with `session-required`. A future
external-login flow is planned but out of scope for Phase 8.

## Auth contract

Requires:

- `SESSION_ID` (load-bearing — workspace derives from the session record)
- `YOLO_COMMON_API_URL` (or `YOLO_API_URL`)
- A credential — resolved by precedence (AUTH_AND_ONBOARDING Slice 0):
  1. `~/.config/yolo/token` — the rotated **user access JWT**, rewritten
     every ~10 min by container-api's token-refresh service. Preferred;
     reading the file (not the env var) avoids the stale-shell problem.
  2. `YOLO_API_TOKEN` env — the pod-injected user JWT (≤24h).
  3. `INTERNAL_API_KEY` env — service master-key fallback, kept for
     lane-runner / service callers. **No longer required in user shells**
     and intentionally excluded from the sandbox env.

The CLI mints a short-lived delegated MCP token via the session-bound
endpoint (`POST /internal/mcp/tokens`) with `agentId: 'substrate-cli'`
and a capped scope set, authenticating with the user JWT
(`Authorization: Bearer`) when available, falling back to
`X-Internal-Auth` otherwise. It then calls `/internal/work/*` REST
routes with the delegated bearer (which is the capability — the
service header is no longer required by `requireMcpAuth`).

## Local build

```sh
npm install
npm run build
node dist/cli.js --version
```

Standalone package — not a workspace member. Container install is an
explicit `COPY` + `npm install -g` block in `containers/sandboxes/yolo-main/Dockerfile`.
