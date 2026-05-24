# TellyMCP

[eng](./README.md) [рус](./README-ru.md)

`@deadragdoll/tellymcp` — Telegram control plane для MCP-подключённых coding agents.

Текущая модель — gateway-first:

- один gateway держит Telegram-бота, web app, проекты и live registry консолей
- один или несколько agent-процессов подключаются к этому gateway
- каждая запущенная консоль агента — отдельный routable target
- пользователь работает через gateway-бота, а не через pairing отдельных сессий

## Что умеет

- даёт MCP tools для human-in-the-loop через Telegram
- позволяет одной консоли агента ставить задачу другой консоли
- хранит structured xchange records в `.mcp-xchange`
- поддерживает browser automation через Playwright
- отдаёт Telegram Mini App / Live View с gateway
- поддерживает polling и webhook на gateway
- поставляет встроенный Codex plugin со skills под типовые workflow

## Текущая модель

Схема:

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

Следствия:

- обычный flow больше не использует pairing
- `/menu` в gateway-боте показывает live-консоли напрямую
- межсессионная маршрутизация идёт по canonical `session_id = client_uuid:local_session_id`
- несвязанные задачи читаются через structured xchange records, а не через старые inbox APIs

## Основные поверхности

Для человека:

- `telegram_message`
- `notify_telegram`
- `browser_screenshot(send_to_telegram=true)`

Для agent-to-agent:

- `partner_note`
- `send_partner_note`
- `send_partner_file`
- `list_gateway_sessions`

Для браузера:

- `browser_open`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_screenshot`

Синхронизация инструкций:

- `refresh_tools_markdown`
- `.mcpsession.json` хранит startup identity и последний известный tools hash

## Требования

- Node.js `>= 24`
- Redis
- PostgreSQL для gateway mode
- опционально RabbitMQ для durable gateway fanout
- Playwright browser binaries, если нужны browser tools

## Установка

```bash
npm install -g @deadragdoll/tellymcp
```

Если нужны browser tools:

```bash
tellymcp browser install
```

Если используешь Codex:

```bash
tellymcp codex-plugin install
```

## Быстрый старт

### 1. Gateway

Создай workspace и env:

```bash
mkdir -p ~/telly-gateway
cd ~/telly-gateway
tellymcp init gateway
```

Или возьми sample:

- [.env.example.gateway](./.env.example.gateway)

Минимально важные значения:

- `TELEGRAM_BOT_TOKEN`
- `REDIS_HOST`
- `DB_HOST`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_TOKEN`

Запуск:

```bash
tellymcp run --env .env
```

### 2. Agent

Для каждой консоли лучше отдельный workspace:

```bash
mkdir -p ~/agent-a
cd ~/agent-a
tellymcp init client
```

Или используй sample:

- [.env.example.client](./.env.example.client)

Минимально важные значения:

- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_TOKEN`
- `GATEWAY_USER_UUID`, если консоль должна быть видна конкретному владельцу в gateway-боте

Рекомендуется:

- по умолчанию используется встроенный PTY terminal runtime
- на первом запуске явно задать `TELLYMCP_SESSION_ID` и `TELLYMCP_SESSION_LABEL`

Первый запуск:

```bash
tellymcp run --env .env -s NEW
```

После первого запуска `.mcpsession.json` хранит:

- `local_session_id`
- `session_label`
- `env_file`

Поэтому дальше в том же каталоге обычно достаточно:

```bash
tellymcp run
```

## Webhook

Gateway умеет работать через Telegram webhook.

Если nginx уже проксирует весь `/api/` на standalone HTTP listener gateway, отдельный `location` для webhook не обязателен. Route такой:

- `/api/telegram/webhook`

Нужные env:

```env
TELEGRAM_WEBHOOK_ENABLED=true
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_PUBLIC_URL=https://your-domain.example/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=change_me_webhook_secret
```

Когда webhook mode включён:

- gateway вызывает `setWebhook(...)` на старте
- polling не запускается
- секрет проверяется через `x-telegram-bot-api-secret-token`

## MCP

### Local HTTP

В client mode локальный MCP endpoint обычно:

```text
http://127.0.0.1:8787/mcp
```

Helper:

```bash
tellymcp mcp --url http://127.0.0.1:8787/mcp
```

Для Codex и похожих агентов используй MCP HTTP endpoint, который поднимает `tellymcp run`.

## Codex Plugin

Пакет включает локальный Codex plugin со skills для:

- ответов человеку в Telegram
- `partner_note`
- browser screenshot задач
- artifact-return flow

Команды:

```bash
tellymcp codex-plugin status
tellymcp codex-plugin install
```

Installer:

- копирует bundled plugin в managed local Codex path
- обновляет personal marketplace manifest
- ставит или обновляет plugin, если найден Codex CLI

## Browser Workflow

Browser tools используют Playwright Chromium.

Предпочтительный путь:

1. `browser_open`
2. `browser_screenshot`
3. дальше либо:
   - `send_to_telegram=true` для ответа человеку
   - `send_partner_file` для возврата артефакта другой консоли

Если browser runtime не установлен:

```bash
tellymcp browser install
```

Не подменяй browser workflow ad hoc shell-командами с Playwright, кроме случаев, когда ты отлаживаешь сам browser runtime.

## Collaboration

Проекты:

- live presence консолей идёт из gateway live registry
- membership проекта хранится отдельно от live presence
- один client может иметь несколько live консолей одновременно
- console participation в проекте хранится отдельно

Ожидаемое поведение агента:

- target резолвится через `list_gateway_sessions`
- входящая работа читается через `list_xchange_records` и `get_xchange_record`
- реальные файлы возвращаются через `send_partner_file`
- `mark_xchange_record_read` вызывается только после успешного outbound reply

## Файлы конфигурации

Канонические стартовые точки:

- [.env.example.gateway](./.env.example.gateway)
- [.env.example.client](./.env.example.client)

Bundled templates:

- [config/templates/env.gateway.template](./config/templates/env.gateway.template)
- [config/templates/env.client.template](./config/templates/env.client.template)
- [config/templates/env.both.template](./config/templates/env.both.template)

Samples уже вычищены под текущий runtime:

- убраны старые inbox-only настройки
- убраны obsolete pairing-oriented тексты
- убраны неиспользуемые секреты вроде `SESSION_SECRET`
- убран неиспользуемый `APP_NAME`

## Операционные команды

Проверка окружения:

```bash
tellymcp doctor --env .env
```

Разрушительная очистка local+gateway state:

```bash
tellymcp system-prune --env .env --yes
```

## Карта документации

- [README.md](./README.md)
- [STANDALONE.md](./docs/STANDALONE.md)
- [STANDALONE-ru.md](./docs/STANDALONE-ru.md)
- [TOOLS.md](./TOOLS.md)
- [screenshots/README.md](./screenshots/README.md)

## Статус

Этот README описывает текущую gateway-first модель.

Legacy concepts, которые не стоит использовать в новых setup:

- pairing codes
- session inbox APIs
- `Local` partner menu
- linked-session flows вне `partner_note` / project collaboration
