# AGENTS.md

This file describes how coding agents should behave when working through TellyMCP today.

## Runtime Model

Assume the current production model is:

- one gateway owns the Telegram bot and web app
- one or more agent consoles connect to the gateway
- each running console is a routable target
- cross-console work is done through xchange records and partner notes

Do not assume:

- pairing codes
- inbox polling APIs
- local linked-session menus
- hidden partner inference

## Human Telegram Work

If the current console received a human Telegram task:

1. read the relevant `telegram_message` record
2. do the requested work in the current console
3. return the result through:
   - `notify_telegram`
   - or `browser_screenshot(send_to_telegram=true)` for direct screenshot delivery

Do not:

- stop at analysis only
- read local sqlite files directly if structured xchange tools work
- substitute a partner reply path when the user asked the current console directly

## Partner Note Work

If the current console received a `partner_note`:

1. call `get_xchange_record`
2. do the work in this console
3. return the result with:
   - `send_partner_note`
   - or `send_partner_file` if the result is a real file
4. only then call `mark_xchange_record_read`

Rules:

- if `requires_reply=true`, the task is not complete until the outbound reply succeeds
- do not mark the record as read before the required reply succeeds
- do not stop at a summary when the note asks for concrete work
- do not invent a new partner reply after receiving a `reply` note

## Cross-Console Routing

Use canonical console ids.

Preferred source of truth:

1. `list_gateway_sessions`
2. choose target by `session_label`, `client_uuid`, `node_id`, or canonical `session_id`
3. route with explicit target fields

Do not route by:

- `cwd`
- guessed labels
- old linked-session state

## Artifact Rules

If the result exists as a local file:

- prefer `send_partner_file`
- do not embed file contents into `send_partner_note` unless the file path route is genuinely broken and you are debugging it

If the result is a browser screenshot:

Preferred path:

1. `browser_open`
2. `browser_screenshot`
3. either:
   - `send_to_telegram=true` for direct human delivery
   - `send_partner_file` for inter-console return

Do not replace browser workflows with shell Playwright by default.

## Browser Rules

If the task says:

- open a page
- inspect DOM
- take a screenshot
- send screenshot to Telegram

then browser tools are the canonical path.

Use shell/browser fallbacks only when debugging a real browser runtime failure.

## Waiting And Polling

Do not send a partner request and then sit in `sleep + list_xchange_records` polling in the same turn.

After `send_partner_note` or `send_partner_file`:

- your part is done
- the target console will be nudged separately

The same rule applies to delegated screenshot/file tasks.

## Session Identity

For client workspaces:

- `.mcpsession.json` stores:
  - `local_session_id`
  - `session_label`
  - `env_file`
- `.tellysession.json` stores per-console tools hash state

If the workspace already has `.mcpsession.json`, plain:

```bash
tellymcp run
```

is expected to work without `-s` or `--env`.

## Security

Never send secrets to Telegram.

Before sending any text to a human:

- avoid raw tokens
- avoid raw cookies
- avoid private keys
- avoid passwords
- avoid internal credentials in logs or context

## Legacy Concepts

If a user explicitly asks about legacy behavior, answer carefully.

But for active work, do not base behavior on:

- `create_session_pair_code`
- `/link`
- `get_telegram_inbox`
- `get_telegram_inbox_count`
- `delete_telegram_inbox_message`
- local partner linking
