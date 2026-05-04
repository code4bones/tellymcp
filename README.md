# Telegram Human-in-the-Loop MCP Server

This project is a local MCP server that lets a coding agent ask a human user for clarification through Telegram and wait for a reply.

Current tools:

- `create_session_pair_code`
- `clear_session_pairing`
- `set_session_context`
- `set_human_channel_mode`
- `set_tmux_target`
- `get_tmux_target`
- `get_human_channel_mode`
- `get_session_context`
- `clear_session_context`
- `notify_telegram`
- `get_telegram_inbox_count`
- `get_telegram_inbox`
- `delete_telegram_inbox_message`
- `ask_user_telegram`

## What it does

Flow:

1. The MCP client creates or updates a session context.
2. The MCP client creates a session pairing code.
3. The human user links that session in Telegram with `/start <code>` or `/link <code>`.
4. After pairing, Telegram shows an inline menu for inbox and session status.
5. The MCP client calls `ask_user_telegram` with the linked `session_id`.
6. The server sends a redacted Telegram message and waits for the answer.
7. The answer is returned as structured MCP tool output.
8. Unsolicited Telegram messages are stored in a per-session inbox for later polling by the agent.

## Architecture

- TypeScript, strict mode
- official MCP SDK over Streamable HTTP
- `grammy` for Telegram transport
- pluggable `HumanTransport` interface
- `ioredis` for Redis access
- `@grammyjs/storage-redis` for Redis-backed session storage
- FSD-inspired backend structure

Telegram is implemented as the first transport backend. Tool orchestration does not depend on Telegram-specific APIs directly.

For maintainers and future extension work, see [DEVELOPMENT.md](/home/code4bones/Devs/coding/mcp/telegram_mcp/DEVELOPMENT.md).

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
- `TMUX_NUDGE_ENABLED`
- `TMUX_NUDGE_DEBOUNCE_SECONDS`
- `TMUX_NUDGE_COOLDOWN_SECONDS`
- `TMUX_NUDGE_MESSAGE`
- `LOG_LEVEL`
- `LOG_FILE_PATH`

Logs are written in two places at the same time:

- pretty console output to `stderr`
- JSONL file at `LOG_FILE_PATH`

Default file path:

```text
.telegram-human-mcp/log.jsonl
```

If Telegram access requires a proxy, the bot transport can use:

- HTTP proxy through `HTTP_PROXY`
- SOCKS5 proxy through `SOCKS5_PROXY`

The chosen proxy mode is controlled by `PROXY_USE`.

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
npm install
```

## Build

```bash
npm run build
```

## Run

Development:

```bash
npm run dev:service
```

Legacy stdio development:

```bash
npm run dev
```

Production build:

```bash
npm run build
npm start
```

Legacy stdio mode is still available:

```bash
npm run dev:stdio
```

After startup you should see readiness logs in the console. The HTTP service exposes:

- MCP endpoint at `http://127.0.0.1:8787/mcp` by default
- health check at `http://127.0.0.1:8787/healthz`

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
- current human channel mode
- whether proactive Telegram inbox polling is currently enabled
- stored tmux targeting data if configured
- Telegram binding metadata if pairing exists
- a `status_message` describing whether pairing is active, pending, or absent

### 2a. Switch between direct mode and Telegram mode

Use `set_human_channel_mode` when you want to explicitly tell the agent whether it should proactively watch Telegram for asynchronous guidance.

When leaving the workstation:

```json
{
  "session_id": "backend-refactor",
  "mode": "telegram"
}
```

When returning to direct interaction:

```json
{
  "session_id": "backend-refactor",
  "mode": "direct"
}
```

Practical meaning:

- `direct`:
  - do not proactively poll Telegram inbox
  - use Telegram only for explicit `ask_user_telegram` / `notify_telegram`
- `telegram`:
  - if a tmux target is configured, the long-running service debounces new non-reply Telegram messages and then nudges the agent pane
  - after a tmux nudge, the agent should call `get_telegram_inbox` directly and process a batch
  - `get_telegram_inbox_count` is still available for lightweight passive checks when no tmux nudge path is configured

### 2b. Bind a tmux pane for Telegram mode

If Codex is running inside tmux, save the current pane target before you leave the workstation. A reliable way is:

```bash
tmux display-message -p '#{session_name} #{pane_id}'
```

Then call `set_tmux_target`:

```json
{
  "session_id": "backend-refactor",
  "tmux_session_name": "work",
  "tmux_target": "%7"
}
```

After that, when the session is in Telegram mode and the unsolicited inbox receives a new message, the service can run:

```bash
tmux send-keys -t %7 "проверь inbox" C-m
```

The service does not forward the Telegram message text into tmux. It only nudges the agent. The agent still reads actual message contents through `get_telegram_inbox_count`, `get_telegram_inbox`, and `delete_telegram_inbox_message`.
If several Telegram messages arrive close together, the nudge is debounced by `TMUX_NUDGE_DEBOUNCE_SECONDS` so the agent gets one wake-up for the batch instead of one wake-up per message.

### 3. Pair a session

Call `create_session_pair_code` with a stable session id:

```json
{
  "session_id": "backend-refactor",
  "session_label": "Backend refactor"
}
```

The tool returns a short-lived code, a status message for the agent, and optionally a Telegram deep link.

If you omit `session_id`, the server uses the derived default project session.

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

First call `get_telegram_inbox_count`:

```json
{
  "session_id": "backend-refactor"
}
```

Only if `total > 0`, call `get_telegram_inbox`:

```json
{
  "session_id": "backend-refactor",
  "limit": 20
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
npm run dev:service
```

2. Register the already-running MCP endpoint in Codex:

```bash
codex mcp add telegramHuman --url http://127.0.0.1:8787/mcp
```

If you enable bearer auth with `MCP_HTTP_BEARER_TOKEN`, register it like this:

```bash
export TELEGRAM_MCP_BEARER_TOKEN="your-token"
codex mcp add telegramHuman \
  --url http://127.0.0.1:8787/mcp \
  --bearer-token-env-var TELEGRAM_MCP_BEARER_TOKEN
```

Legacy stdio registration remains available:

```bash
chmod +x /home/code4bones/Devs/coding/mcp/telegram_mcp/run-mcp.sh
codex mcp add telegramHuman -- /home/code4bones/Devs/coding/mcp/telegram_mcp/run-mcp.sh
```

Then verify inside Codex with:

```text
/mcp
```

## Example AGENTS.md snippet

```md
## Telegram clarification

If you need clarification from the user and the answer is required to continue safely,
use the MCP tools `create_session_pair_code` and `ask_user_telegram`.

Rules:

- prefer explicit `session_id` when multiple projects or sessions share one Telegram bot; otherwise the derived default session is acceptable
- save or refresh session context before risky question flows when it helps reuse context
- if the user wants asynchronous Telegram-first interaction, call `set_human_channel_mode` with `mode: "telegram"`
- if the agent runs inside tmux, capture `#{session_name}` and `#{pane_id}` and store them with `set_tmux_target` before switching fully to Telegram mode
- if the user is back at the workstation, call `set_human_channel_mode` with `mode: "direct"`
- if the session is not linked yet, create a pair code first
- if Telegram mode has a configured tmux target, treat a tmux nudge as the signal to check the inbox
- if Telegram mode has no tmux target, periodically call `get_telegram_inbox_count`
- call `get_telegram_inbox` only if the count is greater than zero
- before the final answer in Telegram mode, check `get_telegram_inbox_count`
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
