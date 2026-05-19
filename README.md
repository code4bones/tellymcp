# TellyMCP

[English](README.md) | [Русский](README-ru.md) | [Standalone Guide](STANDALONE.md) | [Standalone RU](STANDALONE-ru.md) | [Screenshots](screenshots/README.md) | [Gallery](screenshots/GALLERY.md) | [Release Notes](VERSION.md)

[![npm version](https://img.shields.io/npm/v/%40deadragdoll%2Ftellymcp)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![npm downloads](https://img.shields.io/npm/dm/%40deadragdoll%2Ftellymcp)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![node >= 24](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TellyMCP is a self-hosted Telegram control plane for coding agents.

It pairs real agent sessions with Telegram, keeps them reachable from mobile, and lets them collaborate across local and remote machines.

It is not tied to one vendor or one coding assistant. If your agent can talk to an MCP server, it can use TellyMCP.

## Why it exists

Coding agents are useful until they leave the terminal:

- they need clarification while you are away from the desk
- they need approval before doing something risky
- they need screenshots, files, or notes passed between sessions
- they need a human or another agent to unblock work without breaking flow

TellyMCP gives each session a mobile control surface and a collaboration layer:

- `Live` tmux view and light control from Telegram
- session-scoped inbox and notifications
- workspace-aware file and note handoffs
- local and remote session collaboration
- support for mixed agent setups, as long as they speak MCP

## Core ideas

- `Live` tmux view and control inside Telegram Mini App
- `Collab` flows for local and remote agent sessions
- `.mcp-xchange` as a workspace-level handoff bus for notes, files, and screenshots
- MCP-native session pairing and session-scoped tools
- optional gateway mode for cross-machine and cross-bot projects

## Human-in-the-loop is one layer, not the whole product

Telegram HITL is still supported, but it is not the whole story:

- ask a human for clarification through Telegram
- receive unsolicited Telegram messages later through an inbox
- notify a human about progress, blockers, and approvals

## What makes it different from a simple Telegram bot bridge

- it is session-based, not just chat-based
- it understands local and remote collaboration targets
- it has a live terminal surface, not only message exchange
- it moves files through workspace-aware exchange paths, not just ad hoc uploads
- it can run as a standalone node or as a gateway-backed control plane

## Typical use cases

- keep a long-running agent reachable from your phone
- run different agents side by side, as long as each one can connect over MCP
- steer a tmux-based session without opening a laptop
- route work between `frontend`, `backend`, `review`, or other local sessions
- collaborate with remote sessions through a gateway-backed project
- send notes, screenshots, and real files through `.mcp-xchange`
- inspect or screenshot a local web app with `browser_*` tools and send results back to Telegram

## Tool groups

- session pairing and context
- Telegram ask/notify/inbox
- `Live` tmux control
- browser inspection and screenshots
- partner notes and partner files
- tools sync and version checks

The full MCP tool surface is documented later in this README and through the MCP server itself.

## Prerequisites

- Node.js 24+
- `tmux`
- Redis
- a Telegram bot token from BotFather
- for `gateway` / `both`: Postgres
- optional for durable fanout on gateway: RabbitMQ
- for `browser_*` tools: Playwright Chromium browser binaries

## tmux is strongly recommended

TellyMCP works best when the agent itself runs inside `tmux`.

Without `tmux`, the service can still run, but you lose the full interactive path:

- no Live View
- no tmux nudges
- no direct tmux control from Telegram Mini App

Typical start:

```bash
tmux new -s backend
```

or attach later:

```bash
tmux attach -t backend
```

Why the tmux session name matters:

- it helps you distinguish running agents
- it appears in tmux-related UI and diagnostics
- it makes Telegram session switching and Live targeting easier to understand

Use short, meaningful names such as:

- `backend`
- `frontend`
- `review`
- `ops`

If you run multiple agents, put each one in its own tmux session or pane and pair them separately.

If a tmux pane is recreated and its pane id changes, TellyMCP now tries to recover the live pane target automatically from saved tmux session, window, and pane hints.

If auto-recovery fails, Telegram sends an operational warning so the problem is visible to the human user, not only in backend logs.

## Quick start

### Standalone client node

This is the simplest setup. No shared gateway, no Postgres, no RabbitMQ.

1. Install:

```bash
npm install -g @deadragdoll/tellymcp
```

2. Create a client config:

```bash
tellymcp init client
```

3. Edit the generated `.env` and set at minimum:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `REDIS_HOST`
- `MCP_HTTP_BEARER_TOKEN`

4. Validate the setup:

```bash
tellymcp doctor --env .env
```

5. Run the node:

```bash
tellymcp run --env .env
```

6. Add MCP to your agent:

```bash
tellymcp mcp --help
```

Typical local MCP endpoint in `client` mode:

- `http://127.0.0.1:8787/mcp`

If you plan to use `browser_*` tools, install Chromium once:

```bash
tellymcp browser install
```

Detailed step-by-step guide:

- [STANDALONE.md](STANDALONE.md)
- [STANDALONE-ru.md](STANDALONE-ru.md)

### Shared gateway or combined `both` node

Use this when you want:

- cross-machine collaboration
- cross-bot projects
- gateway-relayed Live View
- persistent gateway-side project and delivery state

1. Create a gateway or combined config:

```bash
tellymcp init gateway
```

or

```bash
tellymcp init both
```

2. Edit `.env` and configure:

- `DISTRIBUTED_MODE=gateway|both`
- `PORT`
- `ROOT_PREFIX=/api`
- `TELEGRAM_BOT_TOKEN`
- `REDIS_*`
- `DB_*`
- `WEBAPP_PUBLIC_URL`
- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- optional `RMQ_*`

3. Put the node behind nginx or another reverse proxy on the same prefix:

- `/api/mcp`
- `/api/webapp`
- `/api/gateway`
- `/api/healthz`

Example nginx snippet:
- [docs/tellymcp.gw.conf](docs/tellymcp.gw.conf)

4. Validate the setup:

```bash
tellymcp doctor --env .env
```

5. Run it:

```bash
tellymcp run --env .env
```

Typical public MCP endpoint in `gateway` / `both` mode:

- `https://your-host.example/api/mcp`

## Start with the bot from inside an agent

Once MCP is connected, you can start Telegram pairing by asking the agent in plain language.

Typical phrases the agent should understand:

- `pair with Telegram`
- `link to Telegram`
- `connect this session to Telegram`
- `register this session in Telegram`
- `create a Telegram pairing code`
- `bind this agent to Telegram`

Expected pairing flow:

1. The agent calls `create_session_pair_code`.
2. It returns a short code and, when possible, a deep link.
3. You open Telegram and send `/start <code>` or `/link <code>` to the bot.
4. After successful pairing, `/menu` opens the session menu.

Recommended prompt if you want to be explicit:

```text
Pair this session with Telegram and give me the link code.
```

If the agent works inside `tmux`, it should also pass tmux attributes and `cwd` during pairing so Live View and nudges work immediately.

### Telegram setup

1. Open BotFather in Telegram.
2. Create a bot with `/newbot`.
3. Save the bot token.
4. Set `TELEGRAM_BOT_USERNAME` if you want deep-link pairing hints.

## MCP configuration helper

TellyMCP does not modify your agent config automatically.

Use:

```bash
tellymcp mcp --help
```

This prints ready-to-paste MCP JSON snippets for:

- local standalone client
- shared gateway endpoint
- optional bearer token usage

## Doctor

`doctor` is mode-aware.

`client` checks:

- `tmux`
- `.env`
- Redis
- local MCP bind
- external gateway `healthz` when `GATEWAY_PUBLIC_URL` is configured
- `GATEWAY_WS_URL`
- `WEBAPP_PUBLIC_URL`

`gateway` / `both` checks:

- `tmux`
- `.env`
- Redis
- local `healthz`
- public `healthz`
- public `ws`
- public `webapp`
- Postgres
- RabbitMQ when `RMQ_*` is configured

## Important configuration

Common:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_DB`
- `MODE=queue|reject`
- `PAIR_CODE_TTL_SECONDS`
- `MCP_HTTP_HOST`
- `MCP_HTTP_PORT`
- `MCP_HTTP_PATH`
- `MCP_HTTP_BEARER_TOKEN`
- `TMUX_SOCKET_PATH`
- `TMUX_NUDGE_ENABLED`
- `TMUX_NUDGE_DEBOUNCE_SECONDS`
- `TMUX_NUDGE_COOLDOWN_SECONDS`
- `WEBAPP_ENABLED`
- `WEBAPP_BASE_PATH`
- `WEBAPP_LAUNCH_MODE=default|expand|fullscreen`
- `MCP_XCHANGE_DIR`
- `PROXY_USE=http|socks5`
- `HTTP_PROXY`
- `SOCKS5_PROXY`

Client-only:

- `DISTRIBUTED_MODE=client`
- `GATEWAY_PUBLIC_URL` optional
- `GATEWAY_WS_URL` optional
- `GATEWAY_WS_PATH`
- `GATEWAY_AUTH_TOKEN` optional

Gateway / both:

- `DISTRIBUTED_MODE=gateway|both`
- `PORT`
- `ROOT_PREFIX=/api`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- optional `RMQ_HOST`
- optional `RMQ_PORT`
- optional `RMQ_USER`
- optional `RMQ_PASSWORD`
- optional `RMQ_VHOST`
- optional `RMQ_EXCHANGE`

For ready-to-edit templates, use:

- `.env.example.client`
- `.env.example.gateway`
- `tellymcp init client|gateway|both`

## What it does

Flow:

1. The MCP client creates or updates a session context.
2. The MCP client creates a short one-time 3-digit session pairing code.
   It should also pass the agent `cwd` when available.
3. The human user links that session in Telegram with `/start <code>` or `/link <code>`.
4. After pairing, Telegram shows an inline menu for session switching, inbox, content export, live tmux view, and maintenance actions. `/menu` opens the root switcher.
5. The MCP client calls `ask_user_telegram` with the linked `session_id`.
6. The server sends a redacted Telegram message and waits for the answer.
7. The answer is returned as structured MCP tool output.
8. Unsolicited Telegram messages are stored in a per-session inbox for later agent processing.
9. If the Telegram message contains a photo or document, the file is written into the session `.mcp-xchange/` and delivered according to the currently open session or collaboration target.

## Architecture

- TypeScript, strict mode
- official MCP SDK over Streamable HTTP
- `grammy` for Telegram transport
- pluggable `HumanTransport` interface
- `ioredis` for Redis access
- `@grammyjs/storage-redis` for Redis-backed session storage
- FSD-inspired backend structure

Telegram is implemented as the first transport backend. Tool orchestration does not depend on Telegram-specific APIs directly.

For maintainers and future extension work, see [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

Canonical instructions:

- gateway `TOOLS.md` is the canonical instruction source
- `TOOLS.md` now carries a human-readable version marker near the top of the file
- gateway/client sync still relies on content hash, not on the version string
- gateway/client runtime compatibility is checked separately in `ws hello/hello_ack`
- protocol major mismatch blocks gateway transport until the older side is upgraded
- when behavior changes materially, bump both:
  - the `TOOLS.md` version marker
  - the file content itself

Logs use one runtime model:

- `pino-pretty` console output to `stderr`
- optional JSONL file sink via `LOG_FILE_ENABLED=true` and `LOG_FILE_PATH=...`
- optional in-app `LogFeed` buffer for Telegram/UI diagnostics when `ENABLE_LOGFEED=1`

If Telegram access requires a proxy, the bot transport can use:

- HTTP proxy through `HTTP_PROXY`
- SOCKS5 proxy through `SOCKS5_PROXY`

The chosen proxy mode is controlled by `PROXY_USE`.

Debug/admin HTTP routes are disabled by default:

- `/sessions` requires `MCP_HTTP_ENABLE_DEBUG_ROUTES=true`
- `/prune` requires `MCP_HTTP_ENABLE_PRUNE_ROUTE=true`

If exposed outside localhost, also set `MCP_HTTP_BEARER_TOKEN`.

## Distributed modes

The service now has a role-oriented distributed scaffold:

- `DISTRIBUTED_MODE=client`
  - current default
  - full local Telegram/MCP/tmux/browser flow
  - local `🏠 Local` flow works directly
  - remote `👥 Collab` flow goes through gateway when `GATEWAY_PUBLIC_URL` is configured
- `DISTRIBUTED_MODE=gateway`
  - enables `/gateway/*` HTTP surface
  - serves as the shared relay/control plane
- `DISTRIBUTED_MODE=both`
  - exposes both local service behavior and gateway HTTP surface in one process

Current implementation status:

- `GET /gateway/healthz` works
- `POST /gateway/client/register` works
- `POST /gateway/projects/create` works
- `POST /gateway/projects/join` works
- `POST /gateway/sessions/register` works
- `POST /gateway/partner-note` works
- `ws` control-plane is active
- optional `RabbitMQ` exchange can be enabled for durable gateway-side event fanout
- if `GATEWAY_PUBLIC_URL` is configured, partner-note delivery goes through the gateway HTTP surface
- in `DISTRIBUTED_MODE=both`, this also covers same-bot local delivery transparently
- remote project messaging and delivery status go through the gateway DB and `ws`
- gateway-relayed `Live View` goes through `ws` for client nodes without their own public domain
- `Collab -> Tools -> History` sends a markdown export of the last 5 Collab events
  for the current active session
- `TOOLS.md` sync is state-based:
  - client sends per-session `tools_hash` in `ws hello`
  - gateway compares against canonical gateway `TOOLS.md`
  - mismatch triggers `tools_event`
  - client also self-checks on `hello_ack`
  - gateway periodically rechecks online sockets for changed gateway `TOOLS.md`

Mode-specific runtime requirements:

- `client`
  - local Redis
  - `GATEWAY_PUBLIC_URL`
  - no gateway Postgres bootstrap is performed
- `gateway`
  - Postgres is required for gateway persistence
  - optional `RMQ_*` enables durable gateway-side event dispatch
- `both`
  - Postgres is required because the gateway role is active
  - optional `RMQ_*` enables durable gateway-side event dispatch

Current file model:

- exchange files and screenshots live directly in local `.mcp-xchange`
- remote delivery sends payloads through gateway delivery events
- `vfs/minio` are no longer part of the active Telegram file exchange path
- if an agent must send a real local file to a partner, prefer `send_partner_file`
  over plain `send_partner_note`
- for `Share`, the current session must do the work itself and send only the result
- `Share` must not forward the original task into the target session as a new assignment

Current presence model:

- gateway knows whether a client node is online through active `ws`
- gateway also updates `gateway_clients.last_seen_at`
- there is no separate heartbeat of the coding agent process inside each session yet
- because of that, a status screen can honestly show client `online/offline`, but not guaranteed agent `online/offline`

## Mini App

If `WEBAPP_ENABLED=true`, the session menu exposes `🖥 Live`.

The Mini App:

- is served by this same Node service under `WEBAPP_BASE_PATH`
- in `client` mode can also be opened through the shared gateway domain
- uses vanilla JS and reads the visible tmux pane area through gateway/client relay
- validates Telegram `initData` server-side using the official hash check
- can auto-apply launch mode from env:
  - `default`
  - `expand`
  - `fullscreen` with fallback to `expand` when the Telegram client does not support fullscreen
- requires the Telegram user from `initData` to match the bound session user
- resolves the active session from the bound Telegram user, so a session id in the URL is not required for normal use
- deletes the temporary `Open Live View` launcher message after successful Mini App bootstrap
- auto-recovers after a short gateway restart:
  - short `502/503` periods are tolerated by polling
  - expired in-process WebApp sessions (`401/403`) trigger an automatic re-bootstrap
  - in normal restart cases the user does not need to reopen `Live`
- allows only a fixed control set:
  - `Esc`
  - `Tab`
  - `/`
  - `Backspace`
  - `Up`
  - `Down`
  - `Enter`

`WEBAPP_VISIBLE_SCREENS` controls how much content the live viewport captures relative to the visible tmux height. The default `2` means about two visible screens of content.

`WEBAPP_PUBLIC_URL` is only required when the node exposes its own public Mini App URL directly. In `DISTRIBUTED_MODE=client` with `GATEWAY_PUBLIC_URL` configured, `🖥 Live` can be opened through the gateway domain instead.

## Browser feedback

The service can also launch an internal Playwright runtime and keep one isolated browser context per `session_id`.

Current browser model:

- one shared browser process
- one isolated `BrowserContext + Page` per MCP session
- events are captured per session:
  - console messages
  - page runtime errors
  - failed or HTTP-error network requests
- screenshots are written into the same `.mcp-xchange` flow as Telegram file exchange
- exchange files use the same local `.mcp-xchange` handoff model as Telegram uploads

Recommended local dev settings:

- `BROWSER_ENABLED=true`
- `BROWSER_HEADLESS=false`
- `BROWSER_ADDRESS=http://localhost:5173`
- start your SPA dev server on `0.0.0.0:5173`
- open it through `browser_open`
- install browser binaries once with `npx playwright install chromium`
- install browser binaries once with `tellymcp browser install`

Recommended headless server settings:

- `BROWSER_HEADLESS=true`
- target the app through a reachable host or LAN address, for example `http://127.0.0.1:3000` or `http://192.168.x.x:3000`

Current browser tools:

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

Browser target convention:

- browser interaction tools support `ai_tag` in addition to `selector` and `text`
- frontend code may annotate elements with:
  - `data-drive-tag="save-button"`
  - or `ai-tag="save-button"`
- recommended convention is `data-drive-tag="..."` with an explicit value

If `BROWSER_ADDRESS` is configured, `browser_open` may use either:

- a full URL like `http://localhost:5173/settings`
- or a relative path like `/settings`

`browser_screenshot` returns:

- `file_path` full path to the written screenshot file
- `workspace_dir` the resolved workspace root for that session
- `exchange_dir` the resolved `.mcp-xchange` directory used for the write
- `telegram_message_id` when `send_to_telegram=true`

## Telegram UI

The Telegram bot exposes one root entrypoint:

- `/menu`

Current root menu behavior:

- shows the current active session
- shows the last worked session and update time
- shows tmux status
- lists paired sessions as one button per row
- keeps `Refresh` and `Tools` on the final row

Current session menu behavior:

- title is `Session: <name>`
- first row: `Live | Content | Browser`
- second row: `Local | Collab`
- third row: `Inbox | Storage | Settings`
- final row: `Back`

`Settings` contains:

- `Info`
- `Rename`
- `Unpair`
- `Back`

Current browser menu behavior:

- `Screenshots`
- browser screenshots are separated from ordinary uploaded files

Current storage behavior:

- `Storage` shows `.mcp-xchange` contents for the active session
- storage entries can be opened and sent back to Telegram as files

Current file behavior:

- top-level `Files` menu is removed
- `Browser -> Screenshots` still shows screenshots created by `browser_screenshot`
- if the user is inside:
  - the current session
  - `🏠 Local -> Напарник`
  - `👥 Collab -> Project -> Member`
  then the next uploaded file is delivered directly into that target

Local link behavior:

- `Link` opens a list of other sessions visible to the same Telegram identity
- choosing one creates a mutual partner link between the two sessions
- once linked, the button becomes `Unlink`
- this link is intended for backend/frontend or similar agent collaboration
- linked agents should use `send_partner_note` for structured collaboration

Local partner menu behavior:

- `Local` opens a linked-session collaboration menu
- available actions are:
  - `Ask`
  - `Share`
  - `Unlink`
- the Telegram prompt format is:
  - first line = short summary
  - optional blank line
  - remaining text = full message body
- partner wake-up semantics:
  - `TMUX_PARTNER_NUDGE_MESSAGE` is for collaboration notes, not for human Telegram inbox
  - the receiving agent should read `.mcp-xchange/SHARED_INDEX.md` and the newest note first

Linked-session collaboration contract:

- `send_partner_note` writes one note per event into the partner workspace
- collaborative notes live under `.mcp-xchange/shares/`
- copied artifacts live under `.mcp-xchange/shares/files/<share_id>/`
- `.mcp-xchange/SHARED_INDEX.md` acts as the append-only index of partner-facing notes
- `.mcp-xchange/LOCAL_INDEX.md` acts as the append-only index of local agent-facing handoffs
- supported note kinds are:
  - `share`
  - `question`
  - `reply`
  - `request`
  - `handoff`
- useful partner-facing content usually includes:
  - API summaries
  - what changed
  - current errors
  - sample payloads
  - relevant git changes from the agent workspace
- do not send raw implementation source files as partner artifacts; prefer summaries, specs, payload examples, logs, screenshots, and Markdown notes
- recommended mapping:
  - `question` for "what APIs do you expose?", "what's new?", "send the error details"
  - `reply` for direct answers, usually with `in_reply_to`
  - `share` for one-way status updates
  - `request` for explicit teammate actions
  - `handoff` for transferring results or artifacts
- before sending a local partner note, the agent should call `get_session_context` and verify that `linked_session_id` exists

Collab project behavior:

- `👥 Collab` is the project-based multi-machine and multi-bot collaboration flow
- target session is chosen from `Projects -> <project> -> <member>`
- member screen layout is:
  - first row: `Ask | Share`
  - second row: `Live`
- semantics inside `Project -> Member` depend on the action:
  - `Ask` sends a task to the selected member session
  - expected reply route is `member -> current session`
  - `Share` creates a task for the current session
  - expected send route is `current session -> member`
- `Live` now uses an approval flow before opening the selected member session
- after approval, the requester receives a fresh `Open Live View` button through the existing webapp relay path
- direct file uploads still go to that exact target session when a member screen is open
- if an old member-menu message becomes stale, clicking it deletes that outdated Telegram message instead of leaving a dead keyboard

Recommended share-note structure:

```md
---
share_id: 2026-05-12T22-10-00Z-frontend-question-api
kind: question
from_session_id: frontend-session
to_session_id: backend-session
created_at: 2026-05-12T22:10:00Z
requires_reply: true
in_reply_to: null
artifacts: []
---

# Summary
Need an up-to-date backend API summary.

# Message
- what endpoints exist
- what auth is required
- what changed recently

# Expected Reply
Short Markdown summary plus spec or sample payload files when available.
```

Current content menu behavior:

- `Visible`
- `Full`
- `Last 300`
- `Last 1000`

`Tools` currently contains:

- `Broadcast`
- `Prune all`

`Broadcast` uses a one-shot prompt. After a successful broadcast, only that prompt is deleted. Cancel returns to `Tools` without destroying the existing menu message.

## Telegram file exchange

Ordinary Telegram messages may include:

- text only
- photo with optional caption
- document with optional caption

When a photo or document arrives:

- the file is downloaded into `MCP_XCHANGE_DIR`, default `.mcp-xchange`, under the paired agent workspace
- if the user is already inside a concrete target context, the upload itself is the handoff action
- otherwise the file is delivered into the currently open session as a local session handoff
- there is no separate `Files` confirmation screen anymore

Runtime note:

- the main service writes these files directly in the local workspace

## Default session identity

If a tool call omits `session_id`, the server derives a stable default session automatically.

Resolution order for the human-readable project/session title:

1. `PROJECT_NAME` from `.env`
2. `package.json` `name`
3. git root directory name
4. current working directory name

The derived `session_id` is built from that title plus a short stable hash of the project path, so it remains consistent across restarts.

This means you can call session-oriented tools without explicitly passing `session_id` when working in a single project context.

## Repository development

```bash
yarn install
```

### Build

```bash
yarn build
```

### Run

Development:

```bash
yarn dev:gw
```

Production build:

```bash
yarn build
yarn start:gw
```

After startup you should see readiness logs in the console.

In repository dev mode, the HTTP service exposes:

- MCP endpoint at `http://127.0.0.1:8787/mcp` by default
- health check at `http://127.0.0.1:8787/healthz`

If `MCP_HTTP_BEARER_TOKEN` is configured:

- `/mcp` requires `Authorization: Bearer ...`
- `/sessions` and `/prune` also require the same bearer when enabled
- Telegram Mini App does not use this bearer directly; it has its own `initData` bootstrap and a short-lived WebApp session token

`yarn dev:gw:telegram` is still available, but it only starts the `telegram_mcp` feature node.
It does not expose HTTP by itself anymore. `/mcp`, `/webapp`, and `/healthz` are now served only through the Moleculer API gateway aliases in the full `dev:gw` / `start:gw` runtime, or through a separate gateway node in the same namespace.

## Optional Docker infrastructure

Docker is no longer the default way to run TellyMCP, but there is one supported container path:

- `gateway`-only container deployment

This is intended for a pure control-plane node:

- no local agent sessions
- no local `tmux`
- no `client` mode
- no `both` mode

The repository also keeps Docker for local infrastructure:

- `redis` for all modes
- `postgres` for `gateway` / `both`
- `rabbitmq` only if you want durable fanout on the gateway

Start Redis only, for `standalone` or `client` mode:

```bash
docker compose up -d redis
```

Start Redis + Postgres, for `gateway` or `both` mode:

```bash
docker compose --profile gateway up -d
```

Add RabbitMQ only when you need it:

```bash
docker compose --profile gateway --profile rmq up -d
```

Run a full gateway container stack with Redis and Postgres:

1. Copy the example:

```bash
cp .env.example.gateway .env-gateway
```

2. Edit `.env-gateway` and set at minimum:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `WEBAPP_PUBLIC_URL`
- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `MCP_HTTP_BEARER_TOKEN`

3. Start the stack:

```bash
docker compose up -d
```

This starts:

- `redis`
- `postgres`
- `tellymcp-gateway`

The gateway container installs the published `@deadragdoll/tellymcp` package directly.
It does not build local TypeScript sources inside Docker.

Inside Docker, compose overrides:

- `MCP_HTTP_HOST=0.0.0.0`
- `REDIS_HOST=redis`
- `DB_HOST=postgres`

Public endpoint expectations stay the same:

- `http://127.0.0.1:8080/api/healthz`
- `http://127.0.0.1:8080/api/mcp`
- `http://127.0.0.1:8080/api/webapp`
- `http://127.0.0.1:8080/api/gateway`

Example nginx snippet:
- [docs/tellymcp.gw.conf](docs/tellymcp.gw.conf)

Stop everything:

```bash
docker compose down
```

Default published ports:

- Redis: `6379`
- Postgres: `5432`
- RabbitMQ AMQP: `5672`
- RabbitMQ UI: `15672`

The TellyMCP process itself should run directly on the host:

```bash
tellymcp run --env .env
```

This keeps:

- direct `tmux` access
- simpler debugging
- the same runtime model for `standalone`, `client`, `gateway`, and `both`

For `client` and `both`, host execution is still the recommended model.

Optional if the local tmux server uses a non-default socket:

```bash
TMUX_SOCKET_PATH=/tmp/tmux-1000/default tellymcp run
```

## MCP usage

### 1. Save session context

Call `set_session_context`:

```json
{
  "session_id": "backend-refactor",
  "session_label": "Backend refactor",
  "task": "Admin API cleanup",
  "summary": "We are simplifying admin API response shapes and need product confirmations on compatibility-sensitive changes.",
  "files": [
    "backend/src/routes/admin.ts",
    "backend/src/services/adminService.ts"
  ],
  "decisions": ["Keep Telegram as the human clarification channel"],
  "risks": ["Breaking existing clients"]
}
```

### 2. Inspect session state

Call `get_session_context`:

```json
{
  "session_id": "backend-refactor"
}
```

This returns:

- saved context if it exists
- whether the session is currently paired
- stored tmux targeting data if configured
- Telegram binding metadata if pairing exists
- a `status_message` describing whether pairing and tmux delivery are active

### 2. Bind tmux context for Telegram delivery

If Codex is running inside tmux, capture the current tmux context before you leave the workstation. A reliable way is:

```bash
tmux display-message -p '#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}'
```

The preferred path is to pass these attributes, together with the agent workspace `cwd`, directly into `create_session_pair_code`, so pairing immediately creates a distinct session identity for this agent and gives the server the correct `.mcp-xchange` root:

```json
{
  "tmux_session_name": "dev",
  "tmux_window_name": "test",
  "tmux_window_index": 1,
  "tmux_pane_id": "%7",
  "tmux_pane_index": 0
}
```

Important:

- if you pair without tmux attributes, Telegram linking still succeeds
- but `tmux_target` stays empty
- in that state tmux nudges and Mini App controls will not work until `set_tmux_target` is called later

You can still call `set_tmux_target` later if you need to update or override the stored target:

```json
{
  "session_id": "backend-refactor",
  "tmux_session_name": "work",
  "tmux_window_name": "test",
  "tmux_window_index": 1,
  "tmux_pane_id": "%7",
  "tmux_pane_index": 0,
  "tmux_target": "%7"
}
```

After that, when the paired session receives an unsolicited inbox message, the service can run:

```bash
tmux send-keys -t %7 "проверь inbox" C-m
```

The service does not forward the Telegram message text into tmux. It only nudges the agent. The agent still reads actual message contents through `get_telegram_inbox` and `delete_telegram_inbox_message`, or through `get_telegram_inbox_count` first in passive no-tmux mode.
If several Telegram messages arrive close together, the nudge is debounced by `TMUX_NUDGE_DEBOUNCE_SECONDS` so the agent gets one wake-up for the batch instead of one wake-up per message.
Ordinary Telegram messages are always stored in the inbox of the currently active session for that Telegram identity.

### 3. Pair a session

If the user asks to register or link the current agent in Telegram, the agent should first collect:

- current `cwd`
- tmux attributes when running inside tmux

Only after that should it call `create_session_pair_code`.

Call `create_session_pair_code` with a stable session id:

```json
{
  "session_id": "backend-refactor",
  "session_label": "Backend refactor"
}
```

The tool returns a short-lived code, a status message for the agent, and optionally a Telegram deep link.

If you omit `session_id`, the server derives one automatically.

If multiple agents work from different tmux windows or panes, pass tmux attributes during pairing so the server derives distinct session identities automatically:

```json
{
  "tmux_session_name": "dev",
  "tmux_window_name": "test",
  "tmux_window_index": 1,
  "tmux_pane_id": "%7",
  "tmux_pane_index": 0
}
```

With tmux attributes present, they participate in the derived default `session_id` and `session_label`, which prevents multiple agents from collapsing into one Telegram session even if they share similar project structure. In practice this means `/menu` can later show both agents separately and let Telegram switch the active async context between them.

### 4. Link in Telegram

In Telegram, send one of:

```text
/start ABCD-EFGH
```

or

```text
/link ABCD-EFGH
```

After successful pairing, the bot sends a main inline menu. You can also reopen it later with:

```text
/menu
```

### 5. Ask the user

Call `ask_user_telegram`:

```json
{
  "session_id": "backend-refactor",
  "question": "Can I change the response shape for the admin API?",
  "task": "Admin API cleanup",
  "context": "The old shape is inconsistent and adds special cases in the client.",
  "options": [
    "Keep current response shape",
    "Change response shape and update all callers"
  ],
  "recommended_option": "Keep current response shape",
  "fallback_if_timeout": "Keep current response shape"
}
```

If you want the saved session context to be appended automatically, set:

```json
{
  "use_saved_context": true
}
```

### 6. Clear session context

Call `clear_session_context`:

```json
{
  "session_id": "backend-refactor"
}
```

This removes saved context and also removes Telegram pairing for the same session.

### 7. Clear session pairing

Call `clear_session_pairing`:

```json
{
  "session_id": "backend-refactor"
}
```

This removes the Telegram binding so the session can be paired again.

### 8. Send one-way notification

Call `notify_telegram`:

```json
{
  "session_id": "backend-refactor",
  "message": "Build finished successfully. Ready for review.",
  "task": "Admin API cleanup",
  "risk_level": "low",
  "use_saved_context": true
}
```

This sends a Telegram message without waiting for a reply.

### 9. Poll unsolicited Telegram inbox messages

If the user writes to the bot without replying to an active question, the message is stored in the session inbox.

If the paired session has a tmux target, the preferred path is event-driven:

- Telegram message arrives
- service stores it in inbox
- service nudges tmux
- agent wakes up and calls `get_telegram_inbox`

If there is no tmux nudge path, use passive mode. First call `get_telegram_inbox_count`:

```json
{
  "session_id": "backend-refactor"
}
```

Only if `total > 0`, call `get_telegram_inbox`:

```json
{
  "session_id": "backend-refactor"
}
```

After the agent processes an inbox item, delete it explicitly with `delete_telegram_inbox_message`:

```json
{
  "session_id": "backend-refactor",
  "message_id": "inbox_20260504120000_ab12cd"
}
```

## Telegram menu

The bot now exposes a small inline menu for Telegram-side control:

- `Inbox` shows the latest unsolicited inbox messages for the active session
- tapping an inbox item opens its full contents
- the detail card has a `Delete` action
- `Session: ...` shows the currently active linked session
- `Refresh` re-renders the current menu state

Menu callback payloads stay short. Buttons only carry a short Redis key, while the actual menu state is stored server-side with TTL in Redis.

## Queue mode

`MODE=reject`

- if one request is already active, the next tool call fails immediately

`MODE=queue`

- requests are queued FIFO
- queued requests are not sent to Telegram until they become active

## Connect to Codex

Recommended long-running service flow:

1. Start the service.

For local client mode:

```bash
yarn dev:client
```

Then register:

```bash
codex mcp add telegramHuman --url http://127.0.0.1:8787/mcp
```

For gateway/both mode behind nginx:

```bash
yarn dev:builder
```

2. Register the already-running MCP endpoint in Codex:

```bash
codex mcp add telegramHuman --url http://127.0.0.1:8080/api/mcp
```

If you enable bearer auth with `MCP_HTTP_BEARER_TOKEN`, register it like this:

```bash
export TELEGRAM_MCP_BEARER_TOKEN="your-token"
codex mcp add telegramHuman \
  --url http://127.0.0.1:8080/api/mcp \
  --bearer-token-env-var TELEGRAM_MCP_BEARER_TOKEN
```

Why these URLs differ:

- `dev:client` serves MCP directly from the local standalone listener, by default at `http://127.0.0.1:8787/mcp`
- `dev:builder` / `both` mode serves MCP through the shared backend ingress, by default at `http://127.0.0.1:8080/api/mcp`

For externally exposed deployments:

- prefer enabling `MCP_HTTP_BEARER_TOKEN`
- keep `/sessions` and `/prune` disabled unless you actively need them
- leave WebApp access to Telegram `initData` validation plus its short-lived session token flow

This project no longer uses stdio mode. MCP access is exposed only through the HTTP endpoint.

Current Moleculer feature services:

- `telegramMcp.runtime`
- `telegramMcp.pair`
- `telegramMcp.sessionContext`
- `telegramMcp.notify`
- `telegramMcp.inbox`
- `telegramMcp.approval`
- `telegramMcp.browser`
- `telegramMcp.collaboration`
- `telegramMcp.mcpServer`
- `telegramMcp.http`

## Example AGENTS.md snippet

```md
## Telegram clarification

If you need clarification from the user and the answer is required to continue safely,
use the MCP tools `create_session_pair_code` and `ask_user_telegram`.

Rules:

- prefer explicit `session_id` when multiple projects or sessions share one Telegram bot; otherwise the derived default session is acceptable
- save or refresh session context before risky question flows when it helps reuse context
- if the agent runs inside tmux, capture `#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}` and pass them to `create_session_pair_code`; use `set_tmux_target` later only if you need to refresh or override the target
- if the session is not linked yet, create a pair code first
- if a paired session has a configured tmux target, treat a tmux nudge as the signal to check the inbox
- if a paired session has no tmux target, periodically call `get_telegram_inbox_count`
- call `get_telegram_inbox` only if the count is greater than zero
- before the final answer in passive no-tmux mode, check `get_telegram_inbox_count`
- after handling an inbox item, call `delete_telegram_inbox_message`
- include concise task context
- include affected files when relevant
- include a conservative fallback if the request times out
- never send secrets, tokens, private keys, database URLs, or raw customer data
```

## Verification

Commands run locally:

- `npm run format:check`
- `npm run build`
- `npm run lint`

Tests are not implemented in this iteration.

## Known limitations

- Telegram is the only transport backend implemented right now
- no webhook support, long polling only
- no automated tests in the current iteration
- queued requests are coordinated in-process, with Redis used as the shared state backend
- session context tools are implemented, but there is no version history or merge strategy beyond last write wins
- inbox polling is explicit; unsolicited Telegram messages are not pushed into the agent automatically
- MCP HTTP sessions are kept in-process; restarting the service drops active MCP client sessions and they reconnect cleanly

## Security notes

- all outbound question content is redacted before sending to Telegram
- replies are accepted only from the Telegram user/chat bound to the session
- pairing codes are short-lived and one-time use
- do not use this server to send secrets, raw `.env` content, tokens, private keys, or customer data
