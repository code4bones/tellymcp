<div align="center">

# TellyMCP

**Telegram control plane for MCP-connected coding agents**

[English](./README.md) · [Русский](./README-ru.md) · [Standalone](./docs/STANDALONE.md) · [Standalone RU](./docs/STANDALONE-ru.md)

[![npm version](https://img.shields.io/npm/v/@deadragdoll/tellymcp.svg)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![node](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@deadragdoll/tellymcp.svg)](./LICENSE)
[![gateway--first](https://img.shields.io/badge/runtime-gateway--first-1f6feb.svg)](./README.md#current-runtime-model)
[![telegram webhook](https://img.shields.io/badge/telegram-webhook%20%7C%20polling-26A5E4.svg)](./README.md#webhook-mode)

</div>

`@deadragdoll/tellymcp` is a Telegram control plane for MCP-connected coding agents.

The current model is gateway-first:

- one gateway process owns the Telegram bot, web app, project state, and live console registry
- one or more agent processes connect to that gateway
- each running agent console is a routable target
- Telegram users work through the gateway menu instead of pairing individual sessions

## What It Does

- exposes MCP tools for human Telegram interaction
- lets one agent ask another agent to do work and return files or notes
- lets MCP chat clients retrieve project text, images, and artifacts from a selected console
- stores structured xchange records in `.mcp-xchange`
- supports browser automation with Playwright
- can attach to an already running Firefox or Chrome tab through bundled local extensions
- records browser sessions into structured `.mcp-xchange/web/...` bundles with HTML, network and console artifacts
- can inject helper scripts into attached tabs or Playwright pages through `browser_inject_script`
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
- `get_file` for returning screenshots and artifacts to MCP chat clients

Agent-to-agent:

- `partner_note` records
- `send_partner_note`
- `send_partner_file`
- `list_gateway_sessions`

Diagnostics:

- `get_runtime_diagnostics` for safe end-to-end gateway/client health checks

Browser:

- `browser_open`
- `browser_click`
- `browser_fill`
- `browser_inject_script`
- `browser_press`
- `browser_wait_for`
- `browser_screenshot`
- `browser_recording_start`
- `browser_recording_stop`
- `browser_recording_status`

Files:

- `get_file_list(source=..., limit=...)`
- `get_file(file_path=..., type="url")`
- `get_file(file_path=..., type="image")`
- `get_file(file_path=..., type="text")`
- `get_file(file_path=..., type="base64")`
- `get_file(selector="latest_screenshot")`

Tools sync:

- `refresh_tools_markdown`
- `.mcpsession.json` keeps startup identity and the last known tools hashes

## Requirements

- Node.js `>= 24`
- Python 3, `make`, and a C/C++ toolchain on Linux so `node-pty` can build its native addon; npm lifecycle scripts must be enabled
- Redis for gateway and `both` modes only; clients do not use Redis
- PostgreSQL for gateway mode
- optional RabbitMQ for durable gateway fanout
- Playwright browser binaries if you use browser tools

## Installation

On Debian/Ubuntu, install the native PTY build prerequisites first:

```bash
sudo apt install -y python3 make g++
npm config set ignore-scripts false
```

```bash
npm install -g @deadragdoll/tellymcp --foreground-scripts
```

The published `node-pty` dependency does not provide a Linux ARM64 binary, so
the install lifecycle builds `pty.node` locally. If a previous installation
completed without it, repair the global package with:

```bash
npm uninstall -g @deadragdoll/tellymcp
npm install -g @deadragdoll/tellymcp@latest --foreground-scripts
tellymcp doctor --env <file>
```

`tellymcp --help` and setup commands do not load the native PTY module. Runtime
startup validates it and prints the same recovery instructions instead of a
raw native-module stack trace.

Optional browser runtime:

```bash
tellymcp browser install
```

Optional attached-browser extensions:

```bash
tellymcp extension firefox
tellymcp extension chrome
```

This exports unpacked extension bundles into the current directory:

- `./tellymcp-firefox-attach`
- `./tellymcp-chrome-attach`

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
tellymcp configure
```

This opens a token-protected local page on `127.0.0.1`. Choose `Gateway` in the
wizard, fill and validate the settings, then save `.env-gateway` through the
normal browser download flow. Set its permissions to `0600` before use. Use
`tellymcp init gateway` when you specifically want a commented template for
manual editing.

Enter the public origin or API base only once. The wizard derives gateway HTTP,
WebSocket, Mini App, webhook, root-prefix, and optional OAuth connector URLs.
The key stages include live connection checks for Telegram, Redis, PostgreSQL,
the gateway HTTP/WebSocket endpoints, and optional RabbitMQ.

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
- `GATEWAY_SCOPE_TOKEN`
- `GATEWAY_AUTH_TOKEN`

Then run:

```bash
tellymcp run --env .env
```

### 2. Agent

Create one workspace per agent console:

```bash
mkdir -p ~/agent-a
cd ~/agent-a
tellymcp configure
```

Choose `Client` in the wizard. The form includes the gateway connection, local
console identity, terminal, browser, MCP, and advanced runtime settings.
After validation the browser downloads `.env-client`. Use `--no-open` to print
the local URL without opening a browser automatically.

For clients, the same Public base URL automatically produces
`GATEWAY_PUBLIC_URL`, `GATEWAY_WS_URL`, and `GATEWAY_WS_PATH`.

Or copy:

- [.env.example.client](./.env.example.client)

Required client values:

- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_SCOPE_TOKEN`
- `GATEWAY_AUTH_TOKEN` (the same transport token configured on the gateway)
- `GATEWAY_USER_UUID` if this console should be scoped to a specific Telegram owner

Recommended:

- built-in PTY terminal runtime is used by default
- name the console with `-s`; its identity is saved in the workspace marker

First run:

```bash
tellymcp run --ws 9999 -s NEW
```

The shared client profile is `$HOME/.tellymcp/.env`; `tellymcp init client`
creates it. An explicit `--env` takes precedence, followed by the workspace's
saved profile and local `.env`, then the shared home profile.
`--ws 9999` enables the browser-extension listener on that port for this launch.
Without `--ws`, browser attach uses the env settings; the flag does not rewrite them.

After that, `.mcpsession.json` stores:

- `local_session_id`
- `session_label`
- `env_file`
- `gateway_client_uuid`

Client runtime state is local and does not require Redis. The persisted
`gateway_client_uuid` keeps the client identity stable across restarts.

So later the same workspace can usually start with:

```bash
tellymcp run
```

### Local detach/attach (Linux)

Client-mode `run` now starts or reuses a background owner and attaches to its
existing shell. `run --detach` returns after readiness without requiring a TTY.

```bash
tellymcp run --detach
tellymcp sessions           # add --json for machine-readable output
tellymcp attach             # choose a session, or attach <handle> directly
tellymcp stop               # choose sessions to stop, or stop <handle> directly
```

Without a handle, attach opens an interactive session picker: arrows to move,
Enter to attach, Esc or Ctrl+C to cancel. The current workspace is selected by
default when available; busy and unavailable sessions cannot be selected.
Stop without a handle opens a repeating picker: each selection stops that session
and refreshes the list. Attached sessions can also be stopped. The menu ends when
no sessions remain, or with Esc/Ctrl+C; cancellation leaves the remaining sessions
running. A stop error is shown and returns to selection.

Press **Ctrl+]**, then **d** to return to the outer shell. Double Ctrl+] forwards
a literal prefix; bracketed paste preserves pasted prefix bytes. One interactive
controller is allowed. Frontend loss keeps the owner and services alive; shell
exit or stop ends them. Attach/list/stop need no profile or gateway connection.
Changed startup configuration or a different explicit provider/bridge setting
requires stopping the old owner first. Managed agents still use `--agent`.

Launch from the outer shell: old foreground sessions cannot be converted in place.
Interactive attach needs Linux `stty`. For source testing, run `yarn build`, then
use `node /absolute/path/to/tellymcp/dist/cli.js`. To install a local build, run
`npm pack`, then `npm install -g /path/to/deadragdoll-tellymcp-<version>.tgz`.
SSH/cgroup, real agent TUIs and remote attach remain separate acceptance
checks. See [the contract](docs/DETACHED_SESSIONS_DESIGN.md).

### Terminal attach through the gateway

In Telegram, open the session's Live menu and press **Attach**, beside **Open in
browser**. The owner receives an eight-digit, single-use code valid for five
minutes, with a ready command for another workstation:

```bash
tellymcp attach --code 12345678
tellymcp attach --code 12345678 --gateway https://example.com/api/gateway
```

Use the command with `--gateway` if no gateway is configured on that machine;
`--env <file>` can select gateway/proxy settings. The code supplies session access,
so the owner's credentials and workspace marker are not needed. Multiple local
and remote terminals can attach to the same shell and write simultaneously.
Live View keeps its mirrored screen and input. The latest attachment or resize,
including Live, sets the shared PTY dimensions; detach does not change them.
Smaller windows show a clipped view rather than rewrapping the shared screen.
Ctrl+] then d disconnects only that terminal while the owner keeps running.
After disconnection, generate a fresh code; keystrokes are never automatically
replayed. The five-minute limit applies to code redemption, not connection length.

Remote attach needs gateway **0.0.44 or newer**. Concurrent native attachments
require a session-owner and viewing clients **0.0.45 or newer** (local protocol2).
Restart an existing owner when ready to load the new bridge; installing a package
does not replace code in an already running owner.

### AI Picker in the attached browser

Chrome0.0.15 and Firefox0.0.14 provide **Element / Region / Mark elements** and an
**Alt+Shift+P** command. Connect the extension to a console in the Control Panel,
use **Ctrl+click** to select an element or toggle a mark. Ordinary clicks work
on the page, so you can open a popup before selecting it. Region uses normal
dragging. A local image is captured at selection time without masking; toggle
**Snapshot** to preview and include it (off by default). **Send** asks the agent
to answer in its console; **Ctrl+Send** also requests `inspector_response` back
to the browser, with a green Send hover. The owning console saves an artifact
and notifies its agent. Optional browser replies require owner0.0.51 and a
restart of that owner. The
source tab is automatically attached on Send, with confirmation from the
console before delivery; no manual tab attachment is needed.
Mark elements toggles whole DOM containers and sends only group selectors and
the question; the agent reads their live contents with `browser_dom(all=true)`.
Automatic tab attachment requires0.0.47 owner builds, an owner restart
and reloaded extensions. No separate AI provider or agent is started. Live
selection state expires after five minutes; saved artifacts remain available.
Use Esc or Forget to clear the live state. See [scope and implementation](docs/AI_PICKER_EXTENSION.md#13-карта-реализации-mvp-2026-11-08).

### Start and continue a coding agent

TellyMCP has built-in provider adapters for Codex and Claude Code. The vendor
CLIs are optional: a client can use either one, and the gateway does not need to
have either CLI installed.

Inspect the client machine:

```bash
tellymcp provider list
tellymcp provider status codex
tellymcp provider status claude
```

Prepare the integration and start an agent together with the console:

```bash
tellymcp provider install codex
tellymcp run --env .env-client --agent codex
```

`provider install codex` also prepares the bundled TellyMCP Codex workflow
plugin. Claude Code uses the built-in adapter and the existing
`tellymcp mcp --format claude` configuration helper; install the vendor CLI
itself separately.

After selecting a console in Telegram, open `🤖 Agent` to see which providers
are available on that client and start Codex or Claude Code. For Codex, TellyMCP
starts a local `codex app-server` on a private Unix socket and connects the
console TUI with `codex --remote`; Claude Code currently uses the direct PTY
adapter. Telegram messages then go to that same terminal conversation. The
gateway never needs either vendor CLI. TellyMCP prevents a second agent from
being launched into a console while the first one is still running and stops
the managed Codex app-server when its TUI exits.

Keep the TellyMCP MCP endpoint configured in the selected agent so its workflow
can return files to Telegram with the existing notify tools. Codex text messages
from Telegram are submitted directly with app-server `turn/start`, and the final
agent message is delivered back through the selected console's Telegram route.
The PTY keyboard relay remains the fallback for Claude Code and other
non-structured providers. A second Telegram turn is rejected while the first is
still running; app-server approval requests are currently denied safely until
the Telegram approval UI is connected to this provider adapter.

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

Use the MCP HTTP endpoint exposed by `tellymcp run` for Codex and similar agents.

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

## Terminal Blockers

Gateway prompt scanning is now live-client driven:

- the scanner is armed on gateway startup but starts working only after a live client connects
- relay console materialization happens from gateway hello/owner-route hydration, not from `/menu`
- prompt detection works on the tail of the captured terminal buffer

Primary blocker heuristic:

- contiguous numbered choices like `1.`, `2.`, `3.`
- nearby action hints such as `press`, `input`, `choose`, `enter`, `esc`, `yes`, `no`
- optional context lines above the menu block are included in the Telegram notice

When a blocker is detected, the gateway can send inline Telegram buttons for:

- `1..N`
- `Enter`
- `Esc`

Those buttons send exactly the digit or terminal action to the target console. No marker navigation is used.

Operational notes:

- repeated scans of the same blocker fingerprint do not resend the notice
- relay capture misses for offline agents are treated as debug-only noise
- `Storage` and `Screenshots` on the gateway are relay-aware and read console metadata through gateway routes instead of the gateway filesystem

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

- [Environment contract and migration guide](./docs/ENVIRONMENT.md)
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
- renamed ambiguous legacy keys to `TERMINAL_*`, `GATEWAY_SCOPE_TOKEN`,
  `TELEGRAM_REQUEST_MODE`, `DB_SCHEMA`, and `LOGFEED_ENABLED`

## Operational Commands

Health check:

```bash
tellymcp doctor --env .env
```

Destructive local+gateway cleanup:

```bash
tellymcp system-prune --env .env --yes
```

Normalize an older env file to the current role-aware contract:

```bash
tellymcp migrate-env ./old.env > ./.migrated-env
```

The runtime does not fall back to the old schema. If legacy keys are detected,
startup stops and prints the migration command.

## Documentation Map

- [README-ru.md](./README-ru.md)
- [STANDALONE.md](./docs/STANDALONE.md)
- [STANDALONE-ru.md](./docs/STANDALONE-ru.md)
- [CHAT_CONNECTOR.md](./docs/CHAT_CONNECTOR.md) — ChatGPT/Claude OAuth connector
- [TOOLS.md](./TOOLS.md)
- [screenshots/README.md](./screenshots/README.md)

## Status

This README describes the current gateway-first model.

Legacy concepts that should not be used for new setups:

- pairing codes
- session inbox APIs
- `Local` partner menu
- linked-session flows outside `partner_note` / project collaboration
