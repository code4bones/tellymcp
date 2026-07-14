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
- `get_file` for returning console-owned screenshots and artifacts to an MCP chat client
- `get_file_list` for discovering paths of managed files before calling `get_file`

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
- `get_file(file_path=...)` for returning a newly created screenshot to the connected MCP chat client
- `get_file(selector="latest_screenshot")` when the human asks for the most recent screenshot without knowing its path

## File Retrieval

`get_file_list` returns managed files newest first with exact paths accepted by
`get_file`. It may be filtered by `telegram-upload`, `browser-screenshot`, or
`partner-artifact`; it does not recursively enumerate arbitrary workspace files.

`get_file` returns:

- `type`
- `data`
- `mimetype`
- `filename`
- `size_bytes`
- `expires_at?`

The gateway routes the request to the selected live console. URL mode is the
default: the client streams the file to `.tellymcp/tmp/file-links` on the gateway and `data`
contains a short-lived HTTPS link. If the chat client cannot fetch it, the caller
retries with `type="base64"`, in which case `data` contains base64. Paths are
confined to the workspace after symlink resolution, and payload sizes are bounded.
With `type="image"`, structured output is `{type: "image", data: downloadUrl,
...}` while the top-level MCP content additionally contains the native image
block.
For `type="image"`, the final MCP tool result uses a native top-level
`{type: "image", data, mimeType}` content block so compatible chat clients can
render the image inline. `type="base64"` remains the explicit raw-data mode.
It returns the complete JSON payload, including raw base64 in `data`, inside a
regular top-level MCP text block. It deliberately does not emit a native image:
this keeps the fallback usable when a host replaces native images with `[image]`
or omits `structuredContent` from the model context.

With `type="text"`, an exact project-relative or absolute-in-workspace path is
decoded as UTF-8 and returned directly in a top-level MCP text block. This mode
is intended for Markdown, source code, configuration templates, and other text
that a chat should read without `web_fetch` or base64 decoding. Invalid UTF-8
and binary NUL content are rejected.

All modes enforce workspace confinement after symlink resolution. A client-side
sensitive-path policy also blocks live environment files, credential stores,
private-key extensions, and secret-bearing directories before content is read
or uploaded. Environment examples and templates remain readable.

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
