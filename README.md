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
