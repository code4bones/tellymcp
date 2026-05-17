# TellyMCP

[English](README.md) | [Русский](README-ru.md) | [Standalone Guide](STANDALONE.md) | [Standalone RU](STANDALONE-ru.md) | [Release Notes](VERSION.md)

[![npm version](https://img.shields.io/npm/v/%40deadragdoll%2Ftellymcp)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![npm downloads](https://img.shields.io/npm/dm/%40deadragdoll%2Ftellymcp)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![node >= 24](https://img.shields.io/badge/node-%3E%3D24-339933)](https://nodejs.org/)
[![license: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

TellyMCP — это Telegram Human-in-the-Loop MCP server для coding agents.

Он позволяет агенту:

- задавать человеку уточняющие вопросы через Telegram
- получать несвязанные входящие сообщения позже через inbox
- привязывать несколько agent-сессий
- работать с локальными и удалёнными партнёрскими сессиями
- открывать Live tmux view внутри Telegram Mini App
- обмениваться note, скриншотами и файлами через `.mcp-xchange`

## Prerequisites

- Node.js 24+
- `tmux`
- Redis
- Telegram bot token от BotFather
- для `gateway` / `both`: Postgres
- опционально для durable fanout на шлюзе: RabbitMQ

## `tmux` настоятельно рекомендуется

TellyMCP лучше всего работает, когда сам агент запущен внутри `tmux`.

Без `tmux` сервис всё равно может работать, но полноценный интерактивный режим будет неполным:

- не будет `Live View`
- не будет tmux `nudge`
- не будет прямого управления tmux из Telegram Mini App

Типичный старт:

```bash
tmux new -s backend
```

Позже можно просто подключиться:

```bash
tmux attach -t backend
```

Почему имя tmux-сессии важно:

- по нему проще различать агентов
- оно участвует в tmux-related UI и диагностике
- с ним проще понимать, какую сессию ты открываешь в Telegram и `Live`

Лучше использовать короткие осмысленные имена:

- `backend`
- `frontend`
- `review`
- `ops`

Если агентов несколько, лучше запускать каждого в своей tmux-сессии или pane и привязывать отдельно.

## Быстрый старт

### 1. Standalone client без шлюза

Это самый простой режим:

- без shared gateway
- без Postgres
- без RabbitMQ

Установка:

```bash
npm install -g @deadragdoll/tellymcp
```

Создай клиентский конфиг:

```bash
tellymcp init client
```

В `.env` заполни минимум:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`
- `REDIS_HOST`
- `MCP_HTTP_BEARER_TOKEN`

Проверь конфиг:

```bash
tellymcp doctor --env .env
```

Запусти сервис:

```bash
tellymcp run --env .env
```

Локальный MCP endpoint в `client`-режиме:

- `http://127.0.0.1:8787/mcp`

Чтобы получить готовый JSON snippet для агента:

```bash
tellymcp mcp --help
```

### 2. Gateway или combined `both`

Используй этот режим, если нужен:

- `Collab` между машинами
- проекты между разными ботами
- gateway-relayed Live View
- persistent gateway-side состояние по проектам и доставке

Создай конфиг:

```bash
tellymcp init gateway
```

или

```bash
tellymcp init both
```

В `.env` настроить:

- `DISTRIBUTED_MODE=gateway|both`
- `PORT`
- `ROOT_PREFIX=/api`
- `TELEGRAM_BOT_TOKEN`
- `REDIS_*`
- `DB_*`
- `WEBAPP_PUBLIC_URL`
- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- при необходимости `RMQ_*`

Ожидаемый публичный ingress:

- `/api/mcp`
- `/api/webapp`
- `/api/gateway`
- `/api/healthz`

Проверка:

```bash
tellymcp doctor --env .env
```

Запуск:

```bash
tellymcp run --env .env
```

Типовой публичный MCP endpoint:

- `https://your-host.example/api/mcp`

## Как начать работу с ботом изнутри агента

После подключения MCP можно просто написать агенту обычной фразой, что нужно привязаться к Telegram.

Типовые фразы, которые агент должен понимать:

- `привяжись к Telegram`
- `подключись к Telegram`
- `зарегистрируй эту сессию в Telegram`
- `свяжи эту сессию с ботом`
- `создай код привязки к Telegram`
- `дай код для pairing с Telegram`

Ожидаемый flow:

1. Агент вызывает `create_session_pair_code`.
2. Возвращается короткий код и, если возможно, deep link.
3. Ты открываешь Telegram и отправляешь боту `/start <code>` или `/link <code>`.
4. После успешной привязки можно открыть `/menu`.

Если хочешь написать совсем явно, используй так:

```text
Привяжись к Telegram и дай мне код для pairing.
```

Если агент работает внутри `tmux`, ему желательно передать `cwd` и tmux-атрибуты уже на этапе pairing, чтобы `Live` и `nudge` заработали сразу.

## Telegram setup

1. Открой BotFather.
2. Создай бота через `/newbot`.
3. Сохрани токен.
4. Укажи `TELEGRAM_BOT_USERNAME`, если хочешь deep-link подсказки для pairing.

## MCP helper

TellyMCP сам не прописывает себя в конфиг агента.

Команда:

```bash
tellymcp mcp --help
```

печатает готовые snippets для:

- локального standalone клиента
- общего gateway endpoint
- варианта с bearer token

## Doctor

`doctor` mode-aware.

В `client` режиме проверяет:

- `tmux`
- `.env`
- Redis
- локальный MCP bind
- внешний `gateway healthz`, если задан `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `WEBAPP_PUBLIC_URL`

В `gateway` / `both` режиме проверяет:

- `tmux`
- `.env`
- Redis
- локальный `healthz`
- публичный `healthz`
- публичный `ws`
- публичный `webapp`
- Postgres
- RabbitMQ, если настроен

## Ключевые переменные

Общие:

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

Только client:

- `DISTRIBUTED_MODE=client`
- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_WS_PATH`
- `GATEWAY_AUTH_TOKEN`

Gateway / both:

- `DISTRIBUTED_MODE=gateway|both`
- `PORT`
- `ROOT_PREFIX=/api`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `RMQ_HOST`
- `RMQ_PORT`
- `RMQ_USER`
- `RMQ_PASSWORD`
- `RMQ_VHOST`
- `RMQ_EXCHANGE`

Готовые шаблоны:

- `.env.example.client`
- `.env.example.gateway`
- `tellymcp init client|gateway|both`

## Что умеет

Базовый поток такой:

1. Агент создаёт или обновляет session context.
2. Агент вызывает `create_session_pair_code`.
3. Человек делает `/start <code>` или `/link <code>` в Telegram.
4. После pairing бот открывает меню сессий, inbox, storage, local/collab и live view.
5. Агент вызывает `ask_user_telegram` для связанной `session_id`.
6. Ответ пользователя возвращается как MCP tool output.
7. Несвязанные входящие Telegram-сообщения остаются в inbox этой сессии.
8. Файлы и note попадают в `.mcp-xchange`.

## Полезные команды

```bash
tellymcp help
tellymcp doctor --env .env
tellymcp mcp --help
tellymcp run --env .env
```

## Для разработки

См.:

- [README.md](README.md)
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)
- [TOOLS.md](TOOLS.md)
