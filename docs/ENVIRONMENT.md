# Environment Configuration

This document is the canonical operator contract for TellyMCP environment files.
Keep real deployment values in ignored files such as `prod/.env-gateway` and
`prod/.env-client`. Use the tracked `.env.example.*` files and `config/templates/*`
only as secret-free starting points.

## Rules

- Use one role per file: `gateway`, `client`, or `both`.
- Keep only required values and intentional overrides. Defaults do not need to be
  copied into production files.
- A gateway and its clients must share `GATEWAY_AUTH_TOKEN`.
- `GATEWAY_SCOPE_TOKEN` is an optional data-partition key, not an authentication
  credential.
- Never keep old credentials in commented lines. Git and backups still retain them.
- Legacy or removed TellyMCP keys fail startup with a migration-required error and
  the `tellymcp migrate-env` command instead of being silently ignored.
- There is deliberately no runtime fallback: migrate the file or the process does
  not start.

## Gateway

Required for a normal gateway deployment:

```env
DISTRIBUTED_MODE=gateway
TELEGRAM_BOT_TOKEN=
REDIS_HOST=127.0.0.1
REDIS_PORT=6379
REDIS_DB=1
DB_HOST=127.0.0.1
DB_PORT=5432
DB_USER=
DB_PASSWORD=
DB_NAME=
DB_SCHEMA=mcp
GATEWAY_PUBLIC_URL=https://example.com/api/gateway
GATEWAY_WS_URL=wss://example.com/api/gateway/ws
GATEWAY_AUTH_TOKEN=
ROOT_PREFIX=/api
PORT=8080
MCP_HTTP_HOST=0.0.0.0
```

Common optional gateway groups:

- scope and owner-independent partitioning: `GATEWAY_SCOPE_TOKEN`
- Telegram: `TELEGRAM_BOT_USERNAME`, `ADMIN_TOKEN`, `DEBUG_LANGUAGE`,
  `TELEGRAM_POLL_INTERVAL_MS`, `TELEGRAM_DEFAULT_TIMEOUT_SECONDS`,
  `TELEGRAM_MAX_CONTEXT_CHARS`, `TELEGRAM_MAX_QUESTION_CHARS`,
  `TELEGRAM_MAX_MESSAGE_CHARS`, `TELEGRAM_MENU_PAYLOAD_TTL_SECONDS`
- webhook: `TELEGRAM_WEBHOOK_ENABLED`, `TELEGRAM_WEBHOOK_PATH`,
  `TELEGRAM_WEBHOOK_PUBLIC_URL`, `TELEGRAM_WEBHOOK_SECRET`,
  `TELEGRAM_WEBHOOK_TRACE`, `TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES`
- PostgreSQL/Redis auth: `DB_SCHEMA`, `REDIS_USERNAME`, `REDIS_PASSWORD`
- RabbitMQ: `RMQ_HOST`, `RMQ_PORT`, `RMQ_USER`, `RMQ_PASSWORD`, `RMQ_VHOST`,
  `RMQ_EXCHANGE`
- public WebApp: `WEBAPP_ENABLED`, `WEBAPP_BASE_PATH`, `WEBAPP_PUBLIC_URL`,
  `WEBAPP_INITDATA_TTL_SECONDS`, `WEBAPP_SESSION_TTL_SECONDS`,
  `WEBAPP_LAUNCH_MODE`, `WEBAPP_VISIBLE_SCREENS`, `WEBAPP_ACTION_COOLDOWN_MS`
- prompt detection: `TERMINAL_PROMPT_SCAN_ENABLED`,
  `TERMINAL_PROMPT_SCAN_INTERVAL_SECONDS`,
  `TERMINAL_PROMPT_SCAN_COOLDOWN_SECONDS`, `TERMINAL_PROMPT_SCAN_STRATEGY`,
  `TERMINAL_PROMPT_SCAN_MIN_SCORE`

## Client / Agent Console

Required for a gateway-connected console:

```env
DISTRIBUTED_MODE=client
GATEWAY_PUBLIC_URL=https://example.com/api/gateway
GATEWAY_WS_URL=wss://example.com/api/gateway/ws
GATEWAY_AUTH_TOKEN=
```

Common client settings:

Client runtime state is process-local. Redis is not used or required by a client;
the stable gateway client UUID is kept in `.mcpsession.json`.

`REDIS_HOST`, `REDIS_PORT`, `REDIS_DB`, `REDIS_USERNAME`, and `REDIS_PASSWORD`
are gateway/`both` settings. `tellymcp migrate-env` drops them from client output.

- identity: `PROJECT_NAME`, `TELLYMCP_SESSION_ID`, `TELLYMCP_SESSION_LABEL`,
  `GATEWAY_USER_UUID`, `NAMESPACE`, `NODE_ID`
- optional scope: `GATEWAY_SCOPE_TOKEN`
- local MCP: `MCP_HTTP_HOST`, `MCP_HTTP_PORT`, `MCP_HTTP_PATH`,
  `MCP_HTTP_BEARER_TOKEN`, `MCP_HTTP_ENABLE_DEBUG_ROUTES`,
  `MCP_HTTP_ENABLE_PRUNE_ROUTE`
- local storage: `MCP_XCHANGE_DIR`
- PTY: `TERMINAL_SHELL`, `TERMINAL_COLS`, `TERMINAL_ROWS`,
  `TERMINAL_SCROLLBACK_LINES`, `TERMINAL_CAPTURE_MODE`, `TERMINAL_CAPTURE_LINES`
- nudges: `TERMINAL_NUDGE_ENABLED`, `TERMINAL_NUDGE_DEBOUNCE_SECONDS`,
  `TERMINAL_NUDGE_COOLDOWN_SECONDS`, `TERMINAL_NUDGE_MESSAGE`,
  `TERMINAL_PARTNER_NUDGE_MESSAGE`, `TERMINAL_PARTNER_REPLY_NUDGE_MESSAGE`
- prompt detection: the `TERMINAL_PROMPT_SCAN_*` group listed above
- browser: `BROWSER_ENABLED`, `BROWSER_HEADLESS`, `BROWSER_DEVTOOLS`,
  `BROWSER_ADDRESS`, `BROWSER_TIMEOUT_MS`, `BROWSER_MAX_EVENTS`,
  `BROWSER_WAIT_UNTIL`, `BROWSER_EXECUTABLE_PATH`, `BROWSER_CHANNEL`,
  `BROWSER_SLOW_MO_MS`
- browser attach: `BROWSER_ATTACH_ENABLED`, `BROWSER_ATTACH_WS_HOST`,
  `BROWSER_ATTACH_WS_PORT`, `BROWSER_ATTACH_WS_PATH`

## Shared Optional Settings

- request policy: `TELEGRAM_REQUEST_MODE=queue|reject`
- proxy: `PROXY_USE=http|socks5`, `HTTP_PROXY`, `SOCKS5_PROXY`, `NO_PROXY`
- logging: `LOG_LEVEL`, `LOG_STDERR_LEVEL`, `LOG_FILE_ENABLED`,
  `LOG_FILE_LEVEL`, `LOG_FILE_PATH`, `LOGFEED_ENABLED`
- broker diagnostics: `TRANSPORT`, `MOLECULER_TRACE`, `MOLECULER_METRICS`,
  `METRICS_PORT`, `METRICS_PATH`
- standalone HTTP internals: `ENV_FILE`, `TELLYMCP_STANDALONE_HTTP`

## Chat Connector OAuth

OAuth is enabled when any connector setting is present. It then requires
`TELLYMCP_PUBLIC_URL` and exactly one of `TELLYMCP_MAGIC_TOKEN` or
`TELLYMCP_MAGIC_TOKEN_HASH`.

Supported keys:

- `TELLYMCP_PUBLIC_URL`
- `TELLYMCP_OAUTH_ISSUER`
- `TELLYMCP_OAUTH_AUDIENCE`
- `TELLYMCP_MAGIC_TOKEN`
- `TELLYMCP_MAGIC_TOKEN_HASH`
- `TELLYMCP_OAUTH_CLIENT_ID`
- `TELLYMCP_OAUTH_CLIENT_SECRET`
- `TELLYMCP_ALLOWED_REDIRECT_URIS`
- `TELLYMCP_OAUTH_PRIVATE_KEY_PEM`
- `TELLYMCP_AUTH_CODE_TTL_SECONDS`
- `TELLYMCP_OAUTH_SCOPES`
- `TELLYMCP_OAUTH_KEY_ID`

## Migration From Legacy Names

| Old                | Current                                     |
| ------------------ | ------------------------------------------- |
| `MODE`             | `TELEGRAM_REQUEST_MODE`                     |
| `GATEWAY_TOKEN`    | `GATEWAY_SCOPE_TOKEN`                       |
| `DB_SCHEME`        | `DB_SCHEMA`                                 |
| `ENABLE_LOGFEED`   | `LOGFEED_ENABLED`                           |
| `TMUX_<NAME>`      | `TERMINAL_<NAME>`                           |
| `TMUX_SOCKET_PATH` | remove; the built-in PTY has no tmux socket |

Removed without replacement:

- `APP_NAME`
- `BROWSER_ATTACH_TOKEN`
- `GATEWAY_BIND_HOST`, `GATEWAY_BIND_PORT`
- `GATEWAY_DATABASE_URL`, `GATEWAY_S3_*`
- `MAX_BODY_SIZE` (the limit is a code-level security constant)
- `MCP_VFS_SCOPE`
- `PAIR_CODE_TTL_SECONDS`
- `SESSION_SECRET`, `TOKEN_BINDING_SECRET`
- `TELEGRAM_INBOX_BATCH_SIZE`
- `TERMINAL_TRANSPORT`
- `WEBAPP_POLL_INTERVAL_MS`

The retained examples intentionally omit many values that already have safe
defaults. Add an optional key only when the deployment needs a non-default value.

## Migration Command

Normalize an existing gateway, client, or combined env without printing secret
values in diagnostics:

```bash
tellymcp migrate-env ./old.env > ./.migrated-env
```

The command:

1. reads or infers the role from the input;
2. prefers a canonical key if both old and new names exist;
3. renames supported legacy keys and removes retired or role-inapplicable keys;
4. writes deterministic, sectioned dotenv to stdout;
5. writes key-name-only migration notes to stderr.

Use `>` for a fresh output file. `>>` appends and should only be used when the
target is known to be empty.

## Local Web Configurator

For guided setup, start the local wizard:

```bash
tellymcp configure
```

The configurator:

1. binds only to `127.0.0.1` on a random available port;
2. protects the local URL with a one-time random token;
3. asks whether the machine is a Client or Gateway;
4. exposes all keys from the selected role-specific packaged template;
5. validates role requirements and dependent values;
6. downloads `.env-client` or `.env-gateway` through the browser.

The wizard accepts one `Public base URL`. If only an origin is entered, the
default `/api` root is applied. It also accepts an existing derived endpoint
such as `/api/gateway` and normalizes it back to the API base. From that source
it derives gateway HTTP/WS paths and, for gateway mode, WebApp, webhook,
`ROOT_PREFIX`, and enabled OAuth connector URLs.

The Russian-language wizard shows an explanation and safe example for every
field. Connection-check buttons perform real, redacted probes for Telegram bot
`getMe`, Redis `PING` and PostgreSQL `SELECT 1` on gateways, gateway health plus
WebSocket handshake on clients, and RabbitMQ when configured.

Use `--no-open` on a headless machine and open the printed URL through an
appropriate local tunnel. The configurator does not bind to a public interface.
Browser downloads do not guarantee Unix permissions, so set mode `0600` on the
downloaded dotenv before starting TellyMCP.
