# TellyMCP Standalone Guide

[English](STANDALONE.md) | [Русский](STANDALONE-ru.md)

Это пошаговая инструкция для самого простого сценария TellyMCP:

- одна машина
- один Telegram-бот
- без shared gateway
- без Postgres
- без RabbitMQ

Именно с этого режима лучше начинать.

## Что понадобится

Перед установкой нужны:

1. Node.js 24+
2. `tmux`
3. Redis
4. Telegram bot token из BotFather
5. опционально для `browser_*` tools: Playwright Chromium browser binaries

Зачем это нужно:

- Node.js запускает сервис
- `tmux` нужен для Live View, `nudge` и полноценной интерактивной работы
- Redis хранит состояние сессий, inbox, pairing и меню
- Telegram bot token связывает сервис с Telegram

## Шаг 1. Установить зависимости

Пример для Ubuntu / Debian:

```bash
sudo apt-get update
sudo apt-get install -y tmux redis-server
node -v
tmux -V
redis-cli ping
```

Ожидаемый результат:

- Node версии `24.x` или новее
- `tmux -V` показывает версию
- `redis-cli ping` возвращает `PONG`

Если планируешь использовать browser automation tools, один раз выполни ещё:

```bash
tellymcp browser install
```

## Шаг 2. Создать Telegram-бота

В Telegram:

1. Открой BotFather
2. Выполни `/newbot`
3. Выбери имя бота
4. Выбери username бота
5. Сохрани токен

Тебе понадобятся:

- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_BOT_USERNAME`

## Шаг 3. Установить TellyMCP

```bash
npm install -g @deadragdoll/tellymcp
```

Проверка CLI:

```bash
tellymcp help
```

## Шаг 4. Запустить агента в tmux

Это важный момент.

Для полноценной работы агент лучше запускать внутри `tmux`, а не в обычной shell-сессии.

Создать tmux-сессию:

```bash
tmux new -s backend
```

Хорошие имена:

- `backend`
- `frontend`
- `review`
- `ops`

Почему имя tmux-сессии важно:

- по нему проще различать агентов
- оно улучшает диагностику
- в Telegram и Live View проще понимать, какая сессия открыта

Если нужно выйти:

```bash
tmux detach
```

И вернуться:

```bash
tmux attach -t backend
```

## Шаг 5. Создать standalone-конфиг

В рабочей директории:

```bash
tellymcp init client
```

Команда создаст локальный `.env`.

## Шаг 6. Заполнить `.env`

Минимум:

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

Если tmux использует нестандартный socket:

```env
TMUX_SOCKET_PATH=/tmp/tmux-1000/default
```

## Шаг 7. Проверить конфиг

```bash
tellymcp doctor --env .env
```

В standalone `client` режиме он должен проверить:

- `tmux`
- `.env`
- Redis
- локальный MCP bind
- Playwright Chromium, если browser tools включены

## Шаг 8. Запустить сервис

```bash
tellymcp run --env .env
```

Обычный standalone MCP endpoint:

- `http://127.0.0.1:8787/mcp`

## Шаг 9. Подключить MCP к агенту

Чтобы получить готовый snippet:

```bash
tellymcp mcp --help
```

Типичный локальный endpoint:

- `http://127.0.0.1:8787/mcp`

Если используешь bearer auth, агент должен подключаться с тем же токеном, что и в `.env`.

## Шаг 10. Привязать агента к Telegram

После подключения MCP можно просто написать агенту:

- `привяжись к Telegram`
- `подключись к Telegram`
- `свяжи эту сессию с Telegram`
- `создай код привязки к Telegram`

Ожидаемый flow:

1. агент вызывает `create_session_pair_code`
2. отдаёт короткий код
3. ты отправляешь боту `/start <code>` или `/link <code>`
4. после успеха открываешь `/menu`

Если агент работает внутри `tmux`, ему желательно передать:

- `cwd`
- имя tmux-сессии
- tmux window/pane атрибуты

Тогда `Live` и `nudge` заработают сразу.

## Шаг 11. Что будет после pairing

После привязки Telegram можно использовать для:

- inbox
- вопросов к человеку
- local partner collaboration
- переключения сессий
- просмотра storage
- Live View

Агент сможет:

- вызывать `ask_user_telegram`
- читать несвязанные входящие сообщения
- отправлять note и файлы
- получать tmux `nudge`, когда появляется новая работа

## Что работает без tmux

TellyMCP можно запустить и без `tmux`, но это урезанный режим.

Не будет:

- Live View
- tmux `nudge`
- прямого управления из Telegram Mini App

Такой режим стоит использовать только если тебя устраивает пассивная работа.

## Troubleshooting

Если `doctor` ругается:

- проверь, что Redis запущен
- проверь, что установлен `tmux`
- проверь правильность bot token
- проверь, что bearer token совпадает с MCP-конфигом агента

Если pairing работает, а Live View нет:

- убедись, что агент действительно запущен внутри `tmux`
- убедись, что у tmux-сессии есть стабильное имя
- при необходимости задай `TMUX_SOCKET_PATH`

Если агент не может подключиться к MCP:

- проверь, что `tellymcp run --env .env` действительно запущен
- проверь endpoint `http://127.0.0.1:8787/mcp`
- проверь bearer token

## Следующий шаг

Когда standalone уже работает, дальше можно переходить к:

- `gateway`
- или `both`

Это нужно только если нужен `Collab` между машинами.
