# Development Guide

This document describes the current architecture of `telegram_mcp`.

## Current Product Model

The repository no longer models Telegram as a per-session pairing tool.

The active architecture is:

- gateway-first
- live console registry on the gateway
- one Telegram bot as the user-facing control plane
- agent-to-agent work through xchange records and partner notes

## Main Runtime Layers

### Gateway

Responsibilities:

- Telegram bot
- Telegram webhook or polling
- Mini App / Live View
- live console registry
- project registry and project membership
- gateway-routed deliveries

Key services:

- `gateway.service.ts`
- `gateway-socket.service.ts`
- `ensuredb.service.ts`
- `gateway-delivery.service.ts`

### Client / Agent Console

Responsibilities:

- terminal integration
- local xchange store
- browser runtime
- direct MCP endpoint for the agent
- gateway registration and hello/refresh

Key runtime entrypoints:

- `runtime.ts`
- `foregroundTerminalRuntime.ts`
- `browserService.ts`
- `xchangeService.ts`

## Persistence Model

### Local Workspace State

- `.mcpsession.json`
  - local session identity
  - session label
  - env file path
  - last seen tools hash
  - last notified tools hash
- `.mcp-xchange/`
  - local structured records
  - file artifacts
  - screenshots

### Gateway Database

Important tables:

- `gateway_users`
- `gateway_clients`
- `gateway_live_consoles`
- `gateway_sessions`
- `gateway_projects`
- `gateway_project_members`
- `gateway_project_consoles`
- `gateway_messages`
- `gateway_message_artifacts`
- `gateway_deliveries`

Model:

- `gateway_live_consoles` is the live source
- `gateway_sessions` is durable console identity
- `gateway_project_consoles` binds a console to a project

Do not collapse these concerns again.

## Messaging Model

### Human Telegram

Human-originated work is stored as structured xchange records.

Preferred handling:

1. `list_xchange_records`
2. `get_xchange_record`
3. do the work
4. answer with `notify_telegram` or direct browser screenshot send

### Partner / Collaboration

Cross-console work also uses structured xchange records.

Preferred handling:

1. `get_xchange_record`
2. perform the requested work
3. return with `send_partner_note` or `send_partner_file`
4. then `mark_xchange_record_read`

Do not reintroduce old inbox-style partner semantics.

## Browser Model

Browser work is Playwright-based and console-scoped.

Canonical browser path:

- `browser_open`
- browser actions
- `browser_screenshot`

Direct human screenshot delivery:

- `browser_screenshot(send_to_telegram=true)`

Inter-console screenshot delivery:

- `browser_screenshot(...)`
- then `send_partner_file(...)`

## Terminal Model

The runtime uses a built-in PTY-backed terminal layer.

## Webhook Model

Gateway supports:

- Telegram polling
- Telegram webhook

Webhook route lives in the standalone HTTP layer and is served under:

- `${ROOT_PREFIX}${TELEGRAM_WEBHOOK_PATH}`

Typical example:

- `/api/telegram/webhook`

## Codex Plugin

The package ships a bundled Codex plugin with static workflow skills.

Installer commands:

```bash
tellymcp codex-plugin status
tellymcp codex-plugin install
```

Keep the plugin as:

- static workflow/rules layer

Keep gateway `TOOLS.md` as:

- dynamic capability/instruction layer

Do not merge them into one mutable local file source.

## Documentation Rule

When updating runtime behavior:

- update `README.md`
- update `README-ru.md`
- update `.env` examples/templates
- update `TOOLS.md` if tool behavior changed
- update this file if the architectural model changed

Do not leave legacy pairing/inbox documentation in place after model changes.
