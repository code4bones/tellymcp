# Standalone Deployment

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

- [.env.example.gateway](/home/code4bones/Devs/coding/mcp/telegram_mcp/.env.example.gateway)

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
ROOT_PREFIX=/api
PORT=8080
DISTRIBUTED_MODE=gateway
```

## 4. Agent Env

Start from:

- [.env.example.client](/home/code4bones/Devs/coding/mcp/telegram_mcp/.env.example.client)

Minimum client settings:

```env
DISTRIBUTED_MODE=client
GATEWAY_PUBLIC_URL=https://your-domain.example/api/gateway
GATEWAY_WS_URL=wss://your-domain.example/api/gateway/ws
GATEWAY_TOKEN=change_me_gateway_token
GATEWAY_USER_UUID=put_owner_uuid_here
TERMINAL_TRANSPORT=pty
```

For the first run, also set:

```env
TELLYMCP_SESSION_ID=NEW
TELLYMCP_SESSION_LABEL=NEW
```

## 5. Run

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

## 6. Webhook

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
- `/api/webapp`
- `/api/healthz`

## 7. MCP

Local client-mode MCP:

```text
http://127.0.0.1:8787/mcp
```

Stdio mode:

```bash
tellymcp serve-stdio --env .env -s NEW
```

## 8. Health Checks

```bash
tellymcp doctor --env .env
```

Destructive cleanup:

```bash
tellymcp system-prune --env .env --yes
```

## 9. Operational Notes

- the gateway bot is the user-facing control plane
- consoles are discovered from the gateway live registry
- cross-console tasks use xchange records and `partner_note`
- human Telegram replies use `notify_telegram`
- browser screenshot replies to humans should use `browser_screenshot(send_to_telegram=true)`
- file results between consoles should use `send_partner_file`

## 10. Legacy Concepts To Avoid

Do not build new setups around:

- pairing codes
- inbox polling APIs
- `Local` linked-session menus
- old session-link workflows
