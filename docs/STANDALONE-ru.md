# Standalone Deployment

[eng](./STANDALONE.md) [рус](./STANDALONE-ru.md)

Этот файл описывает текущую standalone-модель для `@deadragdoll/tellymcp`.

Рекомендуемая топология:

- один gateway node
- одна или несколько agent nodes
- один общий Telegram-бот на gateway

## 1. Установка

```bash
npm install -g @deadragdoll/tellymcp
```

Опционально:

```bash
tellymcp browser install
tellymcp codex-plugin install
```

## 2. Инфраструктура

Для gateway обязательно:

- Redis
- PostgreSQL

Опционально:

- RabbitMQ

## 3. Gateway Env

Стартовая точка:

- [.env.example.gateway](../.env.example.gateway)

Минимально нужные параметры gateway:

```env
TELEGRAM_BOT_TOKEN=
REDIS_HOST=127.0.0.1
DB_HOST=127.0.0.1
DB_USER=
DB_PASSWORD=
DB_NAME=
GATEWAY_PUBLIC_URL=https://your-domain.example/api/gateway
GATEWAY_WS_URL=wss://your-domain.example/api/gateway/ws
GATEWAY_TOKEN=change_me_gateway_token
ROOT_PREFIX=/api
PORT=8080
DISTRIBUTED_MODE=gateway
```

## 4. Agent Env

Стартовая точка:

- [.env.example.client](../.env.example.client)

Минимально нужные параметры agent:

```env
DISTRIBUTED_MODE=client
GATEWAY_PUBLIC_URL=https://your-domain.example/api/gateway
GATEWAY_WS_URL=wss://your-domain.example/api/gateway/ws
GATEWAY_TOKEN=change_me_gateway_token
GATEWAY_USER_UUID=put_owner_uuid_here
```

Для первого запуска также желательно задать:

```env
TELLYMCP_SESSION_ID=NEW
TELLYMCP_SESSION_LABEL=NEW
```

## 5. Запуск

Gateway:

```bash
tellymcp run --env .env
```

Agent:

```bash
tellymcp run --env .env -s NEW
```

После того как в workspace появится `.mcpsession.json`, дальше обычно достаточно:

```bash
tellymcp run
```

## 6. Webhook

Gateway поддерживает polling и webhook.

Нужные env:

```env
TELEGRAM_WEBHOOK_ENABLED=true
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_PUBLIC_URL=https://your-domain.example/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=change_me_webhook_secret
```

Если nginx уже проксирует `location /api/ { ... }` на standalone listener, этот же блок покроет:

- `/api/telegram/webhook`
- `/api/gateway`
- `/api/webapp`
- `/api/healthz`

## 7. MCP

Локальный client-mode MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

Используй MCP HTTP endpoint, который поднимает `tellymcp run`.

## 8. Проверки

```bash
tellymcp doctor --env .env
```

Разрушительная очистка:

```bash
tellymcp system-prune --env .env --yes
```

## 9. Операционные заметки

- gateway-бот — это основной user-facing control plane
- консоли видны из gateway live registry
- межсессионные задачи идут через xchange records и `partner_note`
- ответы человеку в Telegram идут через `notify_telegram`
- browser screenshot для человека лучше отправлять через `browser_screenshot(send_to_telegram=true)`
- файлы между консолями лучше отправлять через `send_partner_file`

## 10. Чего не делать в новых setup

Не строй новые setup вокруг:

- pairing codes
- inbox polling APIs
- `Local` linked-session меню
- старых session-link workflow
