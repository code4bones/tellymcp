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
- process-local transient runtime state; no Redis connection

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
  - stable gateway client UUID
- `.mcp-xchange/`
  - local structured records
  - file artifacts
  - screenshots

Redis belongs to gateway and `both` runtimes. Client bindings, pending requests,
browser attachment state, and other transient coordination state are kept in the
client process. Do not restore a client-side Redis fallback.

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

MCP chat-client file delivery:

- `get_file_list(...)` returns the selected console's managed Telegram uploads, browser screenshots, and partner artifacts with paths accepted by `get_file`
- `get_file(file_path=...)` retrieves the exact file returned by another tool
- `get_file(selector="latest_screenshot")` resolves the newest recorded browser screenshot when no path is known
- `type="url"` is the default: the client streams the file to gateway storage under `.tellymcp/tmp/file-links` and the tool returns a 10-minute download URL
- the gateway sanitizes the uploaded basename before temporary storage and `Content-Disposition`; control characters and filesystem-reserved punctuation are replaced without trusting the client header
- `type="image"` returns `{type: "image", data: downloadUrl, ...}` as structured output and emits the pixels as the first native MCP content block, subject to a safe inline-size limit
- `type="text"` accepts exact UTF-8 project paths and returns their content as a native MCP text block; source MIME overrides keep `.ts`, `.tsx`, and similar files text-readable
- `type="base64"` is the explicit raw-data and Claude compatibility fallback; it returns the complete JSON payload in a regular MCP text block so hosts that hide structured output or replace native images with `[image]` still expose `data` to the model
- client-side file access remains confined to the selected session workspace, including after symlink resolution
- client-side policy rejects live environment files, credential stores, private-key extensions, and sensitive directories before reading or uploading them

## Terminal Model

The runtime uses a built-in PTY-backed terminal layer.

- `src/cli.ts` must not statically import the PTY runtime: help, setup, MCP config, and diagnostics must remain usable when the native addon is unavailable
- `tellymcp run` validates `node-pty` before loading runtime services and reports platform, architecture, Node version, Linux build prerequisites, lifecycle-script configuration, and the global rebuild command
- `tellymcp doctor` performs the same native-module probe without crashing
- the package postinstall probe reports whether `pty.node` can actually be loaded instead of assuming successful native compilation
- Linux ARM64 installations compile `node-pty` locally and therefore require Python 3, `make`, and a C/C++ toolchain

Prompt scan model:

- prompt scanning is gateway-side
- the gateway captures relay console buffer tails through gateway live relay routes
- scanner lifecycle is event-driven:
  - gateway boot arms the scanner
  - live client `hello` starts prompt scanning
  - last live client disconnect pauses scanning
- relay session materialization should happen from owner-route hydration on client connect, not from manual `/menu`

Prompt detection model:

- detection runs on the normalized tail of the captured terminal buffer
- the main anchor is a contiguous numbered menu block near the end of that buffer
- exact footer phrases are secondary; the primary signal is:
  - numbered choices
  - nearby action-hint language like `press`, `input`, `choose`, `enter`, `esc`, `yes`, `no`
- excerpt output should include a small amount of context above the menu block

Prompt action model:

- when possible, Telegram notices can include inline blocker buttons
- current supported actions are intentionally simple:
  - digits `1..N`
  - `Enter`
  - `Esc`
- callbacks send exactly the digit or terminal action
- do not reintroduce marker navigation or alternative hotkey parsing here unless the simple model proves insufficient

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
- update `docs/ENVIRONMENT.md` whenever an environment key is added, renamed, or removed
- update `TOOLS.md` if tool behavior changed
- update this file if the architectural model changed

Do not leave legacy pairing/inbox documentation in place after model changes.

Environment migrations must go through
`tellymcp migrate-env <input> > <output>` so production files, examples, and
startup validation follow the same contract.
