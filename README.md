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

Reads the Round 5 env trio:

- `SESSION_ID` (load-bearing — workspace derives from the session record)
- `YOLO_COMMON_API_URL`
- `INTERNAL_API_KEY`

The CLI mints a short-lived delegated MCP token via the existing
session-bound endpoint (`POST /internal/mcp/tokens`) with
`agentId: 'substrate-cli'` and a capped scope set, then calls
`/internal/work/*` REST routes. Implementation in Phase 8c.

## Local build

```sh
npm install
npm run build
node dist/cli.js --version
```

Standalone package — not a workspace member. Container install is an
explicit `COPY` + `npm install -g` block in `containers/sandboxes/yolo-main/Dockerfile`.
