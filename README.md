# TellyMCP

[eng](./README.md) [рус](./README-ru.md)

`@deadragdoll/tellymcp` is a Telegram control plane for MCP-connected coding agents.

The current model is gateway-first:

- one gateway process owns the Telegram bot, web app, project state, and live console registry
- one or more agent processes connect to that gateway
- each running agent console is a routable target
- Telegram users work through the gateway menu instead of pairing individual sessions

## What It Does

- exposes MCP tools for human Telegram interaction
- lets one agent ask another agent to do work and return files or notes
- stores structured xchange records in `.mcp-xchange`
- supports browser automation with Playwright
- serves the Telegram Mini App / Live View from the gateway
- supports Telegram polling or webhook mode on the gateway
- ships a bundled Codex workflow plugin for better agent behavior

## Current Runtime Model

Topology:

```text
Telegram user
    |
Telegram bot + WebApp
    |
Gateway
    |
    +-- Agent console A
    +-- Agent console B
    +-- Agent console C
```

Important consequences:

- there is no session pairing flow in the normal model
- `/menu` on the gateway bot shows live consoles directly
- cross-console work uses canonical `session_id = client_uuid:local_session_id`
- unsolicited work is handled through structured xchange records, not inbox polling APIs

## Main Surfaces

Human-facing:

- `telegram_message` records
- `notify_telegram`
- `browser_screenshot(send_to_telegram=true)`

Agent-to-agent:

- `partner_note` records
- `send_partner_note`
- `send_partner_file`
- `list_gateway_sessions`

Browser:

- `browser_open`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_screenshot`

Tools sync:

- `refresh_tools_markdown`
- `.tellysession.json` keeps the last known tools hash

## Requirements

- Node.js `>= 24`
- Redis
- PostgreSQL for gateway mode
- optional RabbitMQ for durable gateway fanout
- Playwright browser binaries if you use browser tools
- `tmux` if you want tmux transport

If you prefer the built-in terminal backend, use:

```env
TERMINAL_TRANSPORT=pty
```

## Installation

```bash
npm install -g @deadragdoll/tellymcp
```

Optional browser runtime:

```bash
tellymcp browser install
```

Optional Codex workflow plugin:

```bash
tellymcp codex-plugin install
```

## Quick Start

### 1. Gateway

Create a gateway workspace and env:

```bash
mkdir -p ~/telly-gateway
cd ~/telly-gateway
tellymcp init gateway
```

Or copy the sample from this package:

- [.env.example.gateway](./.env.example.gateway)

Required gateway values:

- `TELEGRAM_BOT_TOKEN`
- `REDIS_HOST`
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_TOKEN`

Then run:

```bash
tellymcp run --env .env
```

### 2. Agent

Create one workspace per agent console:

```bash
mkdir -p ~/agent-a
cd ~/agent-a
tellymcp init client
```

Or copy:

- [.env.example.client](./.env.example.client)

Required client values:

- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_TOKEN`
- `GATEWAY_USER_UUID` if this console should be scoped to a specific Telegram owner

Recommended:

- `TERMINAL_TRANSPORT=pty` for simple host setups
- explicit `TELLYMCP_SESSION_ID` and `TELLYMCP_SESSION_LABEL` for the first run

First run:

```bash
tellymcp run --env .env -s NEW
```

After that, `.mcpsession.json` stores:

- `local_session_id`
- `session_label`
- `env_file`

So later the same workspace can usually start with:

```bash
tellymcp run
```

## Webhook Mode

Gateway supports Telegram webhook mode.

Typical nginx setup can proxy everything under `/api/` to the standalone gateway listener. The webhook route is just another backend route:

- `/api/telegram/webhook`

Relevant env:

```env
TELEGRAM_WEBHOOK_ENABLED=true
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_PUBLIC_URL=https://your-domain.example/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=change_me_webhook_secret
```

When webhook mode is enabled:

- the gateway registers Telegram webhook on startup
- polling is not started
- the secret is checked via `x-telegram-bot-api-secret-token`

## MCP Usage

### Local HTTP

In client mode the local MCP endpoint is usually:

```text
http://127.0.0.1:8787/mcp
```

Helper:

```bash
tellymcp mcp --url http://127.0.0.1:8787/mcp
```

### Stdio

Useful for Codex and similar agents:

```bash
tellymcp serve-stdio --env .env -s NEW
```

After `.mcpsession.json` is initialized:

```bash
tellymcp serve-stdio
```

## Codex Plugin

The package bundles a local Codex plugin with workflow skills for:

- human Telegram replies
- partner notes
- browser screenshot tasks
- artifact-return flows

Commands:

```bash
tellymcp codex-plugin status
tellymcp codex-plugin install
```

The installer:

- copies the bundled plugin into a managed local Codex path
- updates the personal marketplace manifest
- installs or updates the plugin if the Codex CLI is available

## Browser Workflows

Browser tools use Playwright Chromium.

Preferred path:

1. `browser_open`
2. `browser_screenshot`
3. either:
   - `send_to_telegram=true` for direct human reply
   - `send_partner_file` for cross-console artifact return

If browser binaries are missing:

```bash
tellymcp browser install
```

Do not replace browser workflows with ad hoc shell Playwright commands unless you are debugging the runtime itself.

## Collaboration Model

Projects:

- live console presence comes from gateway live registry
- project membership is tracked separately from live presence
- one console can participate in a project
- one client can have several live consoles at the same time

Expected agent behavior:

- resolve targets through `list_gateway_sessions`
- read incoming work through `list_xchange_records` and `get_xchange_record`
- return real files with `send_partner_file`
- call `mark_xchange_record_read` only after the required reply was successfully sent

## Environment Files

Use the shipped samples as the canonical starting point:

- [.env.example.gateway](./.env.example.gateway)
- [.env.example.client](./.env.example.client)

Bundled init templates:

- [config/templates/env.gateway.template](./config/templates/env.gateway.template)
- [config/templates/env.client.template](./config/templates/env.client.template)
- [config/templates/env.both.template](./config/templates/env.both.template)

The samples were cleaned to match the current runtime:

- removed old inbox-only settings
- removed obsolete pairing-oriented wording
- removed unused secrets like `SESSION_SECRET`
- removed unused `APP_NAME`

## Operational Commands

Health check:

```bash
tellymcp doctor --env .env
```

Destructive local+gateway cleanup:

```bash
tellymcp system-prune --env .env --yes
```

## Documentation Map

- [README-ru.md](./README-ru.md)
- [STANDALONE.md](./docs/STANDALONE.md)
- [STANDALONE-ru.md](./docs/STANDALONE-ru.md)
- [TOOLS.md](./TOOLS.md)
- [screenshots/README.md](./screenshots/README.md)

## Status

This README describes the current gateway-first model.

Legacy concepts that should not be used for new setups:

- pairing codes
- session inbox APIs
- `Local` partner menu
- linked-session flows outside `partner_note` / project collaboration
