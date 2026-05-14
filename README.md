# Telegram Human-in-the-Loop MCP Server

This project is a local MCP server that lets a coding agent ask a human user for clarification through Telegram and wait for a reply.

Current tools:

- `create_session_pair_code`
- `clear_session_pairing`
- `set_session_context`
- `set_tmux_target`
- `get_tmux_target`
- `get_session_context`
- `clear_session_context`
- `rename_session`
- `notify_telegram`
- `get_telegram_inbox_count`
- `get_telegram_inbox`
- `delete_telegram_inbox_message`
- `ask_user_telegram`
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
- `send_partner_note`

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
8. Unsolicited Telegram messages are stored in a per-session inbox for later polling by the agent.
9. If the Telegram message contains a photo or document, the file is written into the session `.mcp-xchange/`, uploaded into the existing core MinIO storage flow, and exposed to the agent through the inbox item.

## Architecture

- TypeScript, strict mode
- official MCP SDK over Streamable HTTP
- `grammy` for Telegram transport
- pluggable `HumanTransport` interface
- `ioredis` for Redis access
- `@grammyjs/storage-redis` for Redis-backed session storage
- FSD-inspired backend structure

Telegram is implemented as the first transport backend. Tool orchestration does not depend on Telegram-specific APIs directly.

For maintainers and future extension work, see [DEVELOPMENT.md](/home/code4bones/Devs/coding/mcp/telegram_mcp/docs/DEVELOPMENT.md).

## Requirements

- Node.js 24+
- Redis
- a Telegram bot token from BotFather

## Telegram setup

1. Open BotFather in Telegram.
2. Create a bot with `/newbot`.
3. Save the bot token.
4. If you want deep-link hints in tool output, also set `TELEGRAM_BOT_USERNAME`.

## Environment

Copy `.env.example` to `.env` and fill in the values.

Important variables:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME` optional, used for `https://t.me/<bot>?start=<code>` hints
- `PROJECT_NAME` optional, used as the preferred default project/session title
- `TELEGRAM_MENU_PAYLOAD_TTL_SECONDS`
- `TELEGRAM_INBOX_BATCH_SIZE`
- `PROXY_USE=http|socks5` optional
- `HTTP_PROXY` required when `PROXY_USE=http`
- `SOCKS5_PROXY` required when `PROXY_USE=socks5`
- `REDIS_HOST`
- `REDIS_PORT`
- `REDIS_DB`
- `MODE=queue|reject`
- `PAIR_CODE_TTL_SECONDS`
- `MCP_HTTP_HOST`
- `MCP_HTTP_PORT`
- `MCP_HTTP_PATH`
- `MCP_HTTP_BEARER_TOKEN` optional
- `MCP_HTTP_ENABLE_DEBUG_ROUTES=false` enables HTTP `/sessions`
- `MCP_HTTP_ENABLE_PRUNE_ROUTE=false` enables HTTP `POST /prune`
- `DISTRIBUTED_MODE=client|gateway|both`
- `GATEWAY_PUBLIC_URL` optional relay URL for client mode; if set, partner-note delivery goes through the gateway HTTP surface
- `GATEWAY_BIND_HOST`
- `GATEWAY_BIND_PORT`
- `GATEWAY_AUTH_TOKEN`
- `GATEWAY_DATABASE_URL`
- `GATEWAY_S3_ENDPOINT`
- `GATEWAY_S3_BUCKET`
- `GATEWAY_S3_ACCESS_KEY`
- `GATEWAY_S3_SECRET_KEY`
- `WEBAPP_ENABLED=false`
- `WEBAPP_BASE_PATH=/webapp`
- `WEBAPP_PUBLIC_URL=https://builder.undoo.ru/webapp` required for Telegram Mini App launcher
- `WEBAPP_INITDATA_TTL_SECONDS=300`
- `WEBAPP_SESSION_TTL_SECONDS=900`
- `WEBAPP_VISIBLE_SCREENS=2`
- `WEBAPP_POLL_INTERVAL_MS=2000`
- `WEBAPP_ACTION_COOLDOWN_MS=150`
- `TMUX_NUDGE_ENABLED`
- `TMUX_PROXY_URL` optional, used when tmux stays on the host and the main service runs elsewhere
- `TMUX_PROXY_TOKEN` optional bearer for the host tmux proxy
- `TMUX_SOCKET_PATH` optional explicit tmux socket path
- `TMUX_NUDGE_DEBOUNCE_SECONDS`
- `TMUX_NUDGE_COOLDOWN_SECONDS`
- `TMUX_NUDGE_MESSAGE`
- `LOG_LEVEL`
- `BROWSER_ENABLED=true`
- `BROWSER_HEADLESS=false` for local dev visibility, `true` for Docker/headless usage
- `BROWSER_DEVTOOLS=false`
- `BROWSER_ADDRESS=http://localhost:5173` optional default base URL for the dev server
- `BROWSER_TIMEOUT_MS=20000`
- `BROWSER_MAX_EVENTS=200`
- `BROWSER_WAIT_UNTIL=load`
- `BROWSER_EXECUTABLE_PATH` optional explicit browser binary path
- `BROWSER_CHANNEL=chrome|chromium|msedge` optional system browser channel
- `BROWSER_SLOW_MO_MS=0`

Logs are written in two places at the same time:

- pretty console output to `stderr`
- JSONL file at `.telegram-human-mcp/log.jsonl`

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
  - collaboration currently uses the local linked-session backend
- `DISTRIBUTED_MODE=gateway`
  - enables `/gateway/*` HTTP surface
  - intended future relay role for multi-developer / multi-bot setups
- `DISTRIBUTED_MODE=both`
  - exposes both local service behavior and gateway HTTP surface in one process

Current implementation status:

- `GET /gateway/healthz` works
- `POST /gateway/client/register` works
- `POST /gateway/projects/create` works
- `POST /gateway/projects/join` works
- `POST /gateway/sessions/register` works
- `POST /gateway/partner-note` works
- if `GATEWAY_PUBLIC_URL` is configured, partner-note delivery goes through the gateway HTTP surface
- in `DISTRIBUTED_MODE=both`, this also covers same-bot local delivery transparently
- remote relay persistence/polling through shared DB is still not implemented yet

## Mini App

If `WEBAPP_ENABLED=true` and `WEBAPP_PUBLIC_URL` is configured, the session menu exposes `🖥 Live`.

The Mini App:

- is served by this same Node service under `WEBAPP_BASE_PATH`
- uses vanilla JS and polls the visible tmux pane area
- validates Telegram `initData` server-side using the official hash check
- requires the Telegram user from `initData` to match the bound session user
- resolves the active session from the bound Telegram user, so a session id in the URL is not required for normal use
- deletes the temporary `Open Live View` launcher message after successful Mini App bootstrap
- allows only a fixed control set:
  - `/`
  - `Backspace`
  - `Up`
  - `Down`
  - `Enter`

`WEBAPP_VISIBLE_SCREENS` controls how much content the live viewport captures relative to the visible tmux height. The default `2` means about two visible screens of content.

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
- exchange files now use MinIO as the durable backend and `.mcp-xchange` as the local agent-facing cache

Recommended local dev settings:

- `BROWSER_ENABLED=true`
- `BROWSER_HEADLESS=false`
- `BROWSER_ADDRESS=http://localhost:5173`
- start your SPA dev server on `0.0.0.0:5173`
- open it through `browser_open`

Recommended Docker settings:

- `BROWSER_HEADLESS=true`
- target the host dev server through `http://host.docker.internal:3000`

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
- shows tmux bridge status
- lists paired sessions as one button per row
- keeps `Refresh` and `Tools` on the final row

Current session menu behavior:

- title is `Session: <name>`
- primary actions are `Live`, `Content`, `Browser`, `Files`, and `Inbox`
- collaboration/maintenance actions are `Info`, `Rename`, `Link` or `Unlink`, `Unpair`, `Refresh`, `Back`
- when a partner session is linked, the menu also shows a short teammate hint in the session text
- when a partner is linked, the session menu also exposes `Partner`

Current browser menu behavior:

- `Screenshots`
- browser screenshots are separated from ordinary uploaded files

File separation rules:

- `Files` shows only files uploaded from Telegram
- file detail actions are:
  - `Передать агенту`
  - `Передать партнёру`
  - `Delete`
- `Browser -> Screenshots` shows only files created by `browser_screenshot`
- both menus are now backed by Redis file metadata plus MinIO object storage, not by raw directory listing alone

Partner link behavior:

- `Link` opens a list of other sessions visible to the same Telegram identity
- choosing one creates a mutual partner link between the two sessions
- once linked, the button becomes `Unlink`
- this link is intended for backend/frontend or similar agent collaboration
- linked agents should use `send_partner_note` for structured collaboration

Partner menu behavior:

- `Partner` opens a linked-session collaboration menu
- available actions are:
  - `Ask`
  - `Share`
  - `Reply`
  - `Handoff`
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
- before sending a partner note, the agent should call `get_session_context` and verify that `linked_session_id` exists

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

When a photo or document arrives for the active session:

- the file is downloaded into `MCP_XCHANGE_DIR`, default `.mcp-xchange`, under the paired agent workspace
- the same file is uploaded through the existing core `minio` service and tracked in Redis file metadata
- files are written directly into that exchange directory with safe generated names
- the upload itself does not wake the agent
- the file appears in the `Files` menu for that session
- `Передать агенту` creates the inbox item that tells the agent to read that file

Runtime note:

- in local mode, the main service writes these files directly
- in Docker mode with `TMUX_PROXY_URL`, the host bridge creates the exchange directory and writes the files on the host side

## Default session identity

If a tool call omits `session_id`, the server derives a stable default session automatically.

Resolution order for the human-readable project/session title:

1. `PROJECT_NAME` from `.env`
2. `package.json` `name`
3. git root directory name
4. current working directory name

The derived `session_id` is built from that title plus a short stable hash of the project path, so it remains consistent across restarts.

This means you can call session-oriented tools without explicitly passing `session_id` when working in a single project context.

## Install

```bash
yarn install
```

## Build

```bash
yarn build
```

## Run

Development:

```bash
yarn dev:gw
```

Production build:

```bash
yarn build
yarn start:gw
```

After startup you should see readiness logs in the console. The HTTP service exposes:

- MCP endpoint at `http://127.0.0.1:8787/mcp` by default
- health check at `http://127.0.0.1:8787/healthz`

If `MCP_HTTP_BEARER_TOKEN` is configured:

- `/mcp` requires `Authorization: Bearer ...`
- `/sessions` and `/prune` also require the same bearer when enabled
- Telegram Mini App does not use this bearer directly; it has its own `initData` bootstrap and a short-lived WebApp session token

`yarn dev:gw:telegram` is still available, but it only starts the `telegram_mcp` feature node.
It does not expose HTTP by itself anymore. `/mcp`, `/webapp`, and `/healthz` are now served only through the Moleculer API gateway aliases in the full `dev:gw` / `start:gw` runtime, or through a separate gateway node in the same namespace.

If tmux stays on the host but the main service runs in Docker or elsewhere, run the lightweight host-side tmux proxy.

Recommended host deployment is the Go binary built inside Docker and exported to the host:

```bash
./build-tmux-proxy.sh
TMUX_PROXY_HOST=0.0.0.0 TMUX_PROXY_TOKEN=your-token ./artifacts/tmux-proxy-go
```

The Go proxy reads the same local `.env` file by default, so `TMUX_PROXY_HOST`, `TMUX_PROXY_PORT`, `TMUX_PROXY_TOKEN`, and `TMUX_SOCKET_PATH` can live in the shared project configuration.

`build-tmux-proxy.sh` accepts an optional target platform:

```bash
./build-tmux-proxy.sh linux/amd64
./build-tmux-proxy.sh darwin/arm64
./build-tmux-proxy.sh darwin/amd64
```

Default target is `linux/amd64`. For non-default targets, the script exports into `./artifacts/<os>-<arch>/` unless you pass an explicit output directory as the second argument.

For a Linux host, a minimal `systemd` example is included at [docs/tmux-proxy.service](/home/code4bones/Devs/coding/mcp/telegram_mcp/docs/tmux-proxy.service).

If you need a development fallback, the repository also keeps the tiny Node-based proxy:

```bash
npm run build
TMUX_PROXY_HOST=0.0.0.0 TMUX_PROXY_TOKEN=your-token npm run start:tmux-proxy
```

Then point the main service at it:

```env
TMUX_PROXY_URL=http://host.docker.internal:8788
TMUX_PROXY_TOKEN=your-token
```

The host-side proxy exposes only a tiny tmux HTTP surface for:

- visible buffer capture
- fixed control actions
- wake-up line pasting

## Docker deployment

This repository includes a single-container deployment path without an internal nginx layer.

Inside the container:

- `node` runs the MCP HTTP service on `0.0.0.0:8787`
- `redis-server` runs on `127.0.0.1:6379`
- the application itself serves:
  - `/mcp`
  - `/webapp`
  - `/healthz`
  - `/sessions`
  - `/prune`

This means an external reverse proxy can forward directly to container port `8787`, while all app routing stays inside the Node service.

Build the image fully inside Docker:

```bash
docker compose build
```

Run it:

```bash
docker compose up -d
```

Stop it:

```bash
docker compose down
```

The compose file:

- builds the image from this repository
- injects `.env`
- overrides runtime networking so the app talks to local in-container Redis and listens on `0.0.0.0:8787`
- publishes only `8787:8787`
- adds `host.docker.internal` so the container can reach a host-side tmux proxy
- persists Redis state in `./data/redis`

After startup:

- MCP is reachable at `http://<host>:8787/mcp`
- Mini App static/API routes are reachable under `http://<host>:8787/webapp/`
- health check is at `http://<host>:8787/healthz`

Recommended external reverse proxy pattern:

- external proxy forwards `/mcp` to `http://<container-host>:8787/mcp`
- external proxy forwards `/webapp/` to `http://<container-host>:8787/webapp/`
- or, if you prefer, the external proxy can forward a wider prefix directly to `http://<container-host>:8787`
- no direct external access is needed to in-container Redis

If tmux-driven features are required in Docker mode:

1. Build and run the host-side tmux proxy on the host:

```bash
./build-tmux-proxy.sh
TMUX_PROXY_HOST=0.0.0.0 TMUX_PROXY_TOKEN=your-token ./artifacts/tmux-proxy-go
```

2. Set in `.env` for the containerized service:

```env
TMUX_PROXY_URL=http://host.docker.internal:8788
TMUX_PROXY_TOKEN=your-token
```

This keeps Redis inside the container, while tmux access remains on the host through a minimal HTTP bridge.

Important:

- pairing state
- active session bindings
- inbox messages
- menu payload buffers
- WebApp launch/session state

are all stored in Redis. In the Docker deployment they survive restarts because `./data/redis` is mounted into the container and Redis AOF is enabled.

Optional if the host tmux server uses a non-default socket:

```bash
TMUX_SOCKET_PATH=/tmp/tmux-1000/default \
TMUX_PROXY_HOST=0.0.0.0 \
TMUX_PROXY_TOKEN=your-token \
./artifacts/tmux-proxy-go
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

1. Start the service:

```bash
yarn dev:gw
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
