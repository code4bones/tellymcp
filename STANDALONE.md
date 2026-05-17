# TellyMCP Standalone Guide

[English](STANDALONE.md) | [Русский](STANDALONE-ru.md)

This guide explains the simplest TellyMCP setup:

- one machine
- one Telegram bot
- no shared gateway
- no Postgres
- no RabbitMQ

This is the best way to start.

## What you need

Before installation, make sure you have:

1. Node.js 24+
2. `tmux`
3. Redis
4. a Telegram bot token from BotFather

Why these matter:

- Node.js runs the service
- `tmux` enables Live View, nudges, and direct Telegram-side interaction
- Redis stores session state, inbox, pairing state, and menu state
- Telegram bot token connects your bot to Telegram

## Step 1. Install prerequisites

Ubuntu / Debian example:

```bash
sudo apt-get update
sudo apt-get install -y tmux redis-server
node -v
tmux -V
redis-cli ping
```

Expected:

- Node version is `24.x` or newer
- `tmux -V` prints a version
- `redis-cli ping` returns `PONG`

## Step 2. Create a Telegram bot

In Telegram:

1. Open BotFather
2. Run `/newbot`
3. Choose a bot name
4. Choose a bot username
5. Save the token

You will need:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`

## Step 3. Install TellyMCP

```bash
npm install -g @deadragdoll/tellymcp
```

Check that the CLI works:

```bash
tellymcp help
```

## Step 4. Start a tmux session for the agent

This part is important.

Run the agent inside `tmux`, not in a plain shell, if you want the full experience.

Create a session:

```bash
tmux new -s backend
```

Good session names:

- `backend`
- `frontend`
- `review`
- `ops`

Why the session name matters:

- it helps identify the agent in practice
- it improves diagnostics
- it makes Telegram and Live View easier to understand

If you later detach:

```bash
tmux detach
```

and return:

```bash
tmux attach -t backend
```

## Step 5. Create the standalone config

Inside the workspace where you want to run TellyMCP:

```bash
tellymcp init client
```

This creates a local `.env`.

## Step 6. Fill `.env`

At minimum, set:

```env
TELEGRAM_BOT_TOKEN=...
TELEGRAM_BOT_USERNAME=@your_bot
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=1
MCP_HTTP_HOST=127.0.0.1
MCP_HTTP_PORT=8787
MCP_HTTP_PATH=/mcp
MCP_HTTP_BEARER_TOKEN=choose-a-secret-token
DISTRIBUTED_MODE=client
WEBAPP_ENABLED=true
```

If your tmux server uses a non-default socket:

```env
TMUX_SOCKET_PATH=/tmp/tmux-1000/default
```

## Step 7. Validate the setup

```bash
tellymcp doctor --env .env
```

In standalone `client` mode it should verify:

- `tmux`
- `.env`
- Redis
- local MCP bind

## Step 8. Run the service

```bash
tellymcp run --env .env
```

Standalone MCP endpoint is normally:

- `http://127.0.0.1:8787/mcp`

## Step 9. Add MCP to your agent

To get a ready-to-paste config snippet:

```bash
tellymcp mcp --help
```

Typical local MCP config target:

- `http://127.0.0.1:8787/mcp`

If you use bearer auth, configure your agent with the same token from `.env`.

## Step 10. Pair the agent with Telegram

Once MCP is connected, tell the agent something like:

- `pair with Telegram`
- `link to Telegram`
- `connect this session to Telegram`
- `create a Telegram pairing code`

Expected flow:

1. the agent calls `create_session_pair_code`
2. it gives you a short code
3. you send `/start <code>` or `/link <code>` to the bot
4. after success, open `/menu`

If the agent is running inside `tmux`, it should pass:

- `cwd`
- tmux session name
- tmux window/pane attributes

This lets Live View and tmux nudges work immediately.

## Step 11. What you get after pairing

After pairing, Telegram can be used for:

- inbox messages
- clarifying questions
- local partner collaboration
- session switching
- storage inspection
- Live View

The agent can:

- call `ask_user_telegram`
- read unsolicited inbox messages
- send notes and files
- receive tmux nudges when new work arrives

## What works without tmux

TellyMCP can still run without `tmux`, but this is a reduced mode.

You lose:

- Live View
- tmux nudges
- direct Telegram Mini App controls

Use this only if you accept a passive workflow.

## Troubleshooting

If `doctor` fails:

- verify Redis is running
- verify `tmux` is installed
- verify the bot token is correct
- verify your bearer token matches the MCP client config

If pairing works but Live View does not:

- make sure the agent is really inside `tmux`
- make sure the tmux session has a stable name
- if needed, set `TMUX_SOCKET_PATH`

If the agent cannot connect to MCP:

- confirm `tellymcp run --env .env` is running
- confirm the endpoint is `http://127.0.0.1:8787/mcp`
- confirm the bearer token matches

## Next step

After standalone is working, the next upgrade path is:

- `gateway`
- or `both`

Use that only when you need cross-machine collaboration.
