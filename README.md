# @yolo-labs/yolo-cli

The `yolo` CLI provides workspace context, artifact reads, personal app development
and publishing, and hosting commands. Run `yolo --help` for all commands.

```sh
yolo context
yolo artifact list
yolo tileapp init my-app
yolo deploy --dry-run
```

Authenticated commands require `SESSION_ID`, `YOLO_COMMON_API_URL` (or
`YOLO_API_URL`), and a user access JWT. The CLI reads the rotated token at
`~/.config/yolo/token`, falling back to `YOLO_API_TOKEN`. The session record
supplies the workspace identity.

Artifact commands mint a scoped delegated token through
`POST /internal/mcp/tokens`; hosting commands authenticate with the user JWT.
Offline commands such as app scaffolding, validation, and local serving do not
require authentication.

Build and test locally:

```sh
npm ci
npm test
node dist/cli.js --help
```

This standalone package is installed in Studio containers through
`containers/sandboxes/yolo-main/Dockerfile`.

## Managed branch previews

Inside a Studio workspace, create a persistent preview of a repository branch:

```sh
yolo preview create --name 'Latest main' --branch main --cwd web \
  --setup 'npm ci' --build 'npm run build' \
  --command 'npm start -- --hostname "$HOST" --port "$PORT"'
yolo preview status
yolo preview status <tile-id> --json
yolo preview logs <tile-id> --tail 100
yolo preview stop <tile-id>
```

Choose commands appropriate to your app; the example assumes its start script
accepts `--hostname` and `--port`. Single-quote commands to preserve `$PORT` and
`$HOST` for the service. It uses isolated checkouts, checks candidate health, and
switches the tile's stable port only after a successful build and start. Failed
updates keep the last working version. The required runtime must already be
installed; this service targets stateless HTTP apps, not database migrations.

The session resolves the authoritative workspace. Preview operations use delegated
capabilities; no manual credentials or workspace ID are needed. `create` returns
the tile ID and starts asynchronously. Use `status` for progress, and reuse
`--request-id <stable-id>` if retrying creation after an uncertain response.
`status` without an ID lists managed branch previews only. `stop` retains the tile
and configuration in Studio, removes its running service, and prevents startup on
page reload. Click **Start** in the tile to resume. Logs are bounded and in-memory;
stopping the service discards them. All commands accept `--json`.

`yolo preview --help` lists polling, timeout, port and health-check options. New CLI,
API, agent-registry scopes and container-api versions must be deployed together;
older deployments return an error rather than run a different preview mode.

## Source & contributing

[github.com/yolo-labs-hq/yolo-cli](https://github.com/yolo-labs-hq/yolo-cli) is a public mirror of `packages/yolo-cli` in YOLO Labs' private monorepo, which stays the source of truth. The mirror is synced automatically on every change. Issues are welcome. Pull requests are welcome too: we apply them in the monorepo, keeping you as the author, and the change then syncs back here.

## License

MIT. See [LICENSE](./LICENSE).
