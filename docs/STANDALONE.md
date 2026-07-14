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
npm install -g @deadragdoll/tellymcp
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
GATEWAY_TOKEN=change_me_gateway_token
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
GATEWAY_TOKEN=change_me_gateway_token
GATEWAY_AUTH_TOKEN=put_strong_shared_transport_token_here
GATEWAY_USER_UUID=put_owner_uuid_here
```

Use the same strong `GATEWAY_AUTH_TOKEN` on the gateway and every client. Keep it
separate from `GATEWAY_TOKEN`, which scopes gateway data but does not authenticate
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
tellymcp run --env .env -s NEW
```

After `.mcpsession.json` is created in the workspace, later runs can usually use:

```bash
tellymcp run
```

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

```bash
tellymcp doctor --env .env
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

## 11. Legacy Concepts To Avoid

Do not build new setups around:

- pairing codes
- inbox polling APIs
- `Local` linked-session menus
- old session-link workflows
