<div align="center">

# Standalone Deployment

**Deploy TellyMCP as one gateway and one or more agent nodes**

[English](./STANDALONE.md) · [Русский](./STANDALONE-ru.md) · [Main README](../README.md) · [README RU](../README-ru.md)

[![npm version](https://img.shields.io/npm/v/@deadragdoll/tellymcp.svg)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![node](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![gateway mode](https://img.shields.io/badge/deploy-gateway%20%2B%20agents-1f6feb.svg)](../README.md#current-runtime-model)
[![telegram webhook](https://img.shields.io/badge/telegram-webhook%20ready-26A5E4.svg)](../README.md#webhook-mode)

</div>

This guide describes the current standalone deployment model for `@deadragdoll/tellymcp`.

The recommended topology is:

- one gateway node
- one or more agent nodes
- one shared Telegram bot on the gateway

## 1. Install

```bash
sudo apt install -y python3 make g++
npm config set ignore-scripts false
npm install -g @deadragdoll/tellymcp --foreground-scripts
```

Linux installs compile the native `node-pty` addon locally; this is required on
Linux ARM64 because the dependency does not ship a matching prebuilt binary.
If `pty.node` is missing after an earlier install, run:

```bash
npm uninstall -g @deadragdoll/tellymcp
npm install -g @deadragdoll/tellymcp@latest --foreground-scripts
```

Optional:

```bash
tellymcp browser install
tellymcp extension firefox
tellymcp extension chrome
tellymcp codex-plugin install
```

## 2. Infrastructure

Required for gateway:

- Redis
- PostgreSQL

Optional:

- RabbitMQ

## 3. Gateway Env

Start from:

- [.env.example.gateway](../.env.example.gateway)

Minimum gateway settings:

```env
TELEGRAM_BOT_TOKEN=
REDIS_HOST=127.0.0.1
DB_HOST=127.0.0.1
DB_USER=
DB_PASSWORD=
DB_NAME=
GATEWAY_PUBLIC_URL=https://your-domain.example/api/gateway
GATEWAY_WS_URL=wss://your-domain.example/api/gateway/ws
GATEWAY_SCOPE_TOKEN=change_me_scope_token
GATEWAY_AUTH_TOKEN=put_strong_shared_transport_token_here
ROOT_PREFIX=/api
PORT=8080
DISTRIBUTED_MODE=gateway
```

## 4. Agent Env

Start from:

- [.env.example.client](../.env.example.client)

Minimum client settings:

```env
DISTRIBUTED_MODE=client
GATEWAY_PUBLIC_URL=https://your-domain.example/api/gateway
GATEWAY_WS_URL=wss://your-domain.example/api/gateway/ws
GATEWAY_SCOPE_TOKEN=change_me_scope_token
GATEWAY_AUTH_TOKEN=put_strong_shared_transport_token_here
GATEWAY_USER_UUID=put_owner_uuid_here
```

The agent/client machine does not need Redis. Its transient runtime state is
local, while the stable gateway client UUID is stored in `.mcpsession.json`.

Use the same strong `GATEWAY_AUTH_TOKEN` on the gateway and every client. Keep it
separate from `GATEWAY_SCOPE_TOKEN`, which scopes gateway data but does not authenticate
the HTTP or WebSocket transport. Generate it once, for example with
`openssl rand -hex 32`, and do not use the illustrative value above.

For the first run, also set:

```env
TELLYMCP_SESSION_ID=NEW
TELLYMCP_SESSION_LABEL=NEW
```

## 5. Attached Browser Extensions

If you want to attach TellyMCP to an already running Firefox or Chrome tab on an agent machine, enable the local attach bridge in that agent env:

```env
BROWSER_ATTACH_ENABLED=true
BROWSER_ATTACH_WS_HOST=127.0.0.1
BROWSER_ATTACH_WS_PORT=9999
BROWSER_ATTACH_WS_PATH=/browser-attach/ws
```

Export the unpacked extension bundle from the installed package:

```bash
tellymcp extension firefox
tellymcp extension chrome
```

This creates one of:

- `./tellymcp-firefox-attach`
- `./tellymcp-chrome-attach`

Load it into the local browser:

- Firefox: `about:debugging#/runtime/this-firefox` -> `Load Temporary Add-on` -> choose `manifest.json`
- Chrome: `chrome://extensions` -> enable Developer mode -> `Load unpacked` -> choose the exported directory

After that the browser control panel can:

- attach the current agent session to a live browser tab
- start and stop structured recording bundles in `.mcp-xchange/web/...`
- inject helper scripts into the attached tab

## 6. Run

Gateway:

```bash
tellymcp run --env .env
```

Agent:

```bash
tellymcp run --ws 9999 -s NEW
```

The shared client config lives in `$HOME/.tellymcp/.env` and is found automatically.
Use `--env <file>` for a specific profile; saved workspace profiles and a local
`.env` take precedence over the shared default. `--ws <port>` enables the extension
listener on that port for this process. Without it, the env settings apply.

After `.mcpsession.json` is created in the workspace, later runs can usually use:

```bash
tellymcp run
```

### Linux local sessions

Use `tellymcp run --detach`, `tellymcp sessions [--json]`,
`tellymcp attach [handle]` and `tellymcp stop [handle]`. Without a handle,
attach opens a session picker (arrows/Enter, Esc or Ctrl+C to cancel), initially
selecting the available current workspace session. Busy/unavailable sessions are
disabled. Stop without a handle shows a repeating picker, including attached
sessions: stop one, refresh the list, and choose again until empty or Esc/Ctrl+C.
Errors return to selection; cancellation leaves remaining sessions running.
`stop <handle>` stops exactly one session. Ctrl+] then d returns to the outer
shell; doubled Ctrl+] forwards the literal prefix. Interactive attach needs
Linux `stty`. Old foreground sessions require a fresh launch from the outer shell.
For local build testing, use `node /absolute/path/to/tellymcp/dist/cli.js` after
`yarn build`; no release/global install is implied. See
[the implementation contract](DETACHED_SESSIONS_DESIGN.md).

### Native terminal through the gateway

In Telegram Live, press **Attach** beside **Link**. Link sends a private copyable
Live address; the first row contains Fullscreen / Expand / Default and Back
returns to the session menu. The owner receives
a private single-use eight-digit code, valid for five minutes:
`tellymcp attach --code <code> [--gateway <url>] [--env <file>]`.
The same owner/shell/screen is restored; the viewing machine creates no console
or workspace marker. Native terminals and Live remain mirrored and writable
simultaneously. The latest attach or resize sets the common PTY size; detach
leaves it unchanged. Ctrl+] then d detaches only that viewer. Reconnect needs a
fresh code, with no input replay. Gateway **0.0.44+** supports the relay; owners
and viewers need **0.0.45+** for concurrent native attachments. See
[the authorization contract](DETACHED_SESSIONS_DESIGN.md#remote-attach-through-the-gateway).

## 7. Webhook

Gateway supports polling and webhook.

Webhook env:

```env
TELEGRAM_WEBHOOK_ENABLED=true
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_PUBLIC_URL=https://your-domain.example/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=change_me_webhook_secret
```

If nginx already proxies `location /api/ { ... }` to the standalone listener, that block also covers:

- `/api/telegram/webhook`
- `/api/gateway`
- `/api/files` for short-lived `get_file(type="url")` uploads and downloads
- `/api/webapp`
- `/api/healthz`

A dedicated `location ^~ /api/files/` is recommended, though not required for
routing. It should disable access logs because the path contains a token, set
`client_max_body_size 32m`, and disable proxy request/response buffering. See
`nginx/tellymcp.gw.conf` for the canonical block.

## 8. MCP

Local client-mode MCP:

```text
http://127.0.0.1:8787/mcp
```

Use the MCP HTTP endpoint exposed by `tellymcp run`.

## 9. Health Checks

Guided dotenv setup:

```bash
tellymcp configure
```

```bash
tellymcp doctor --env .env
```

Normalize a legacy env before startup:

```bash
tellymcp migrate-env ./old.env > ./.migrated-env
```

Destructive cleanup:

```bash
tellymcp system-prune --env .env --yes
```

## 10. Operational Notes

- the gateway bot is the user-facing control plane
- consoles are discovered from the gateway live registry
- cross-console tasks use xchange records and `partner_note`
- human Telegram replies use `notify_telegram`
- browser screenshot replies to humans should use `browser_screenshot(send_to_telegram=true)`
- file results between consoles should use `send_partner_file`

## 11. GitLab CI deployment on savant

The `telly_savant` shell runner builds and tests the npm package in a Node 24
build container, then builds a gateway image tagged with the package version and
commit. Pushes to `main` and merge requests build only. A `vX.Y.Z` tag deploys
after verifying that its commit belongs to `main` and its version matches the
package. Both jobs must run on the same savant Docker daemon; keep deployed and
previous images when cleaning up Docker storage.

The persistent installation is `/opt/tellymcp/docker-compose.yml`,
`/opt/tellymcp/.env-gateway`, and `/opt/tellymcp/nginx/default.conf`.
Nginx Proxy Manager terminates HTTPS for `tellymcp.deadragdoll.net` and forwards
HTTP to `192.168.1.68:18088`. Only container nginx publishes a host port; the
gateway, PostgreSQL, Redis, and RabbitMQ use the private Compose network.
NPM must allow WebSocket upgrades and unbuffered MCP streaming.

```bash
cd /opt/tellymcp
docker compose --env-file .env-gateway up -d
docker compose --env-file .env-gateway ps
docker compose --env-file .env-gateway logs --tail 100 tellymcp-gateway
```

`.env-gateway` supplies DB/RMQ credentials, gateway secrets and public URLs,
`TELLYMCP_IMAGE`, and optional `NGINX_BIND_IP`/`NGINX_PORT`. Infrastructure hosts
and the internal HTTP port are overridden by Compose. Never print `compose
config` without `--quiet` on this installation: the output includes credentials.
The gateway's session marker, exchange files, and file logs persist in `state/`;
database data persists in named volumes. `down -v` deletes these databases.

For an initial migration, provision the directory for `gitlab-runner`, copy and
adapt the existing gateway env file, start only `postgres redis rabbitmq`, and
verify that the destination databases are empty before stopping the source, then
restore PostgreSQL with `pg_restore --single-transaction` and restore Redis while
the source gateway is stopped. The dedicated volumes are explicitly named
`tellymcp_savant_postgres_v1`, `tellymcp_savant_redis_v1`, and
`tellymcp_savant_rabbitmq_v1`; do not reuse legacy `tellymcp_*_data` volumes.

When restoring an RDB backup into AOF-enabled Redis, load the backup in an isolated
temporary Redis with AOF disabled and transfer each key with `DUMP`/`RESTORE`,
preserving its remaining TTL. Verify the key contents before starting the gateway.
Simply placing `dump.rdb` next to an AOF directory does not restore the active data.

Check/drain RabbitMQ queues before moving; gateway queues are recreated automatically.
Copy the source session marker into `state/.mcpsession.json`. Create
`.migration-ready` only after data restoration; this marker gates CI deployment.
Start the application and proxy, check the public health endpoint and bot webhook,
then update clients to the new HTTP/WSS URLs and reconnect OAuth integrations.
Keep a protected backup of the original configuration and database dumps.

Normal tagged deployments update only the gateway and nginx, check the public
endpoint and infrastructure, and restore the previous configuration/image on
failure. Snapshots are stored under `releases/` with restricted permissions.
To roll back manually, restore the snapshot's `.env-gateway`, `docker-compose.yml`
and `default.conf` (into `nginx/`), then run `up -d --no-deps tellymcp-gateway nginx`
and `exec nginx nginx -s reload` with the same Compose flags. Image rollback does
not reverse database schema changes: restore the matching database backup when
required. Never copy an older snapshot over a live database volume.

## 12. Legacy Concepts To Avoid

Do not build new setups around:

- pairing codes
- inbox polling APIs
- `Local` linked-session menus
- old session-link workflows
