# Telegram Human MCP Spec

This file describes the current MCP-facing behavior of TellyMCP at a high level.

## Scope

TellyMCP is no longer only an `ask_user_telegram` server.

It now provides a gateway-first Telegram control plane for agent consoles with:

- direct human interaction
- cross-console collaboration
- browser workflows
- live/web app flows

## Primary Human-Facing Tools

- `notify_telegram`
- `ask_user_telegram` where available through the active MCP surface
- `browser_screenshot(send_to_telegram=true)`

Human-originated tasks are represented as structured `telegram_message` xchange records.

## Primary Collaboration Tools

- `list_gateway_sessions`
- `list_xchange_records`
- `get_xchange_record`
- `mark_xchange_record_read`
- `send_partner_note`
- `send_partner_file`

Cross-console work is based on:

- canonical live console ids
- project bindings where applicable
- xchange records as the delivery contract

## Browser Tools

- `browser_open`
- `browser_reload`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_wait_for_url`
- `browser_console`
- `browser_errors`
- `browser_network_failures`
- `browser_clear_logs`
- `browser_dom`
- `browser_computed_style`
- `browser_screenshot`
- `browser_close`

Browser screenshots should use:

- `send_to_telegram=true` for direct human delivery
- `send_partner_file` for inter-console return paths

## Routing Rules

Canonical identity:

- `session_id = client_uuid:local_session_id` for gateway-routed work

Do not route by:

- `cwd`
- guessed labels
- old pairing state

## Startup Markers

Workspace markers:

- `.mcpsession.json`
  - startup identity
  - env file
  - tools hash state

These files support plain:

```bash
tellymcp run
```

after the first initialized run.

## Webhook

Gateway can run Telegram via:

- polling
- webhook

Typical webhook endpoint:

- `/api/telegram/webhook`

## Safety

- do not send secrets to Telegram
- do not hide routing or binding errors behind fallbacks
- prefer explicit failures over guessed recovery when expected state is missing
