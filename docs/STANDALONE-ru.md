<div align="center">

# Standalone Deployment

**Развёртывание TellyMCP как одного gateway и одной или нескольких agent-консолей**

[English](./STANDALONE.md) · [Русский](./STANDALONE-ru.md) · [Main README](../README.md) · [README RU](../README-ru.md)

[![npm version](https://img.shields.io/npm/v/@deadragdoll/tellymcp.svg)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![node](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![gateway mode](https://img.shields.io/badge/deploy-gateway%20%2B%20agents-1f6feb.svg)](../README-ru.md#текущая-модель)
[![telegram webhook](https://img.shields.io/badge/telegram-webhook%20ready-26A5E4.svg)](../README-ru.md#webhook)

</div>

Этот файл описывает текущую standalone-модель для `@deadragdoll/tellymcp`.

Рекомендуемая топология:

- один gateway node
- одна или несколько agent nodes
- один общий Telegram-бот на gateway

## 1. Установка

```bash
sudo apt install -y python3 make g++
npm config set ignore-scripts false
npm install -g @deadragdoll/tellymcp --foreground-scripts
```

На Linux native addon `node-pty` собирается локально; для Linux ARM64 это
обязательно, потому что зависимость не поставляет подходящий готовый binary.
Если после предыдущей установки `pty.node` отсутствует, выполни:

```bash
npm uninstall -g @deadragdoll/tellymcp
npm install -g @deadragdoll/tellymcp@latest --foreground-scripts
```

Опционально:

```bash
tellymcp browser install
tellymcp extension firefox
tellymcp extension chrome
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
GATEWAY_SCOPE_TOKEN=change_me_scope_token
GATEWAY_AUTH_TOKEN=put_strong_shared_transport_token_here
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
GATEWAY_SCOPE_TOKEN=change_me_scope_token
GATEWAY_AUTH_TOKEN=put_strong_shared_transport_token_here
GATEWAY_USER_UUID=put_owner_uuid_here
```

На машине agent/client Redis не нужен. Временное runtime-состояние хранится
локально, а стабильный gateway client UUID — в `.mcpsession.json`.

Используйте один и тот же стойкий `GATEWAY_AUTH_TOKEN` на gateway и всех клиентах.
Не смешивайте его с `GATEWAY_SCOPE_TOKEN`: последний разделяет данные gateway по scope,
но не аутентифицирует HTTP- или WebSocket-транспорт. Сгенерируйте токен один раз,
например командой `openssl rand -hex 32`, и не используйте пример значения выше.

Для первого запуска также желательно задать:

```env
TELLYMCP_SESSION_ID=NEW
TELLYMCP_SESSION_LABEL=NEW
```

## 5. Attach extensions для браузера

Если нужно attach'иться к уже открытому Firefox или Chrome на агентской машине, включи локальный attach bridge в env этого агента:

```env
BROWSER_ATTACH_ENABLED=true
BROWSER_ATTACH_WS_HOST=127.0.0.1
BROWSER_ATTACH_WS_PORT=9999
BROWSER_ATTACH_WS_PATH=/browser-attach/ws
```

Выгрузи unpacked extension bundle из установленного пакета:

```bash
tellymcp extension firefox
tellymcp extension chrome
```

Команда создаст один из каталогов:

- `./tellymcp-firefox-attach`
- `./tellymcp-chrome-attach`

Дальше загрузи его в локальный браузер:

- Firefox: `about:debugging#/runtime/this-firefox` -> `Load Temporary Add-on` -> выбрать `manifest.json`
- Chrome: `chrome://extensions` -> включить Developer mode -> `Load unpacked` -> выбрать выгруженный каталог

После этого browser control panel умеет:

- attach'ить текущую agent-сессию к живой вкладке
- запускать и останавливать structured recording bundles в `.mcp-xchange/web/...`
- инжектить helper scripts в attached tab

## 6. Запуск

Gateway:

```bash
tellymcp run --env .env
```

Agent:

```bash
tellymcp run --ws 9999 -s NEW
```

Общий конфиг клиента `$HOME/.tellymcp/.env` находится автоматически. Явный
`--env <file>`, сохранённый профиль workspace и локальный `.env` имеют приоритет.
`--ws <port>` включает WebSocket для расширения на этом порту для текущего
процесса. Без флага используются настройки из env.

После того как в workspace появится `.mcpsession.json`, дальше обычно достаточно:

```bash
tellymcp run
```

### Локальные сессии Linux (ещё не выпущены)

Команды: `tellymcp run --detach`, `tellymcp sessions [--json]`,
`tellymcp attach [handle]`, `tellymcp stop [handle]`. Без handle attach открывает
меню (стрелки/Enter, Esc или Ctrl+C для отмены); доступная сессия текущего workspace
выделена по умолчанию. Занятые и недоступные сессии выбрать нельзя. Stop без handle
использует marker текущего workspace. Ctrl+], затем d возвращает в исходную
консоль; двойной Ctrl+] передаёт буквальный префикс. Интерактивный attach использует
Linux `stty`. Старую foreground-сессию нужно запустить заново из исходной консоли.
Локальная проверка: `yarn build`, затем `node /полный/путь/tellymcp/dist/cli.js`
вместо `tellymcp`; это не релиз и не глобальная установка.
[Контракт реализации](DETACHED_SESSIONS_DESIGN.md).

## 7. Webhook

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
- `/api/files` для короткоживущих upload/download запросов `get_file(type="url")`
- `/api/webapp`
- `/api/healthz`

Отдельный `location ^~ /api/files/` рекомендуется, хотя для самой маршрутизации
он не обязателен. В нём следует отключить access log, потому что путь содержит
токен, задать `client_max_body_size 32m` и отключить buffering запросов и
ответов. Канонический блок приведён в `nginx/tellymcp.gw.conf`.

## 8. MCP

Локальный client-mode MCP endpoint:

```text
http://127.0.0.1:8787/mcp
```

Используй MCP HTTP endpoint, который поднимает `tellymcp run`.

## 9. Проверки

Настройка dotenv через локальный web-конфигуратор:

```bash
tellymcp configure
```

```bash
tellymcp doctor --env .env
```

Перед запуском старый env можно нормализовать командой:

```bash
tellymcp migrate-env ./old.env > ./.migrated-env
```

Разрушительная очистка:

```bash
tellymcp system-prune --env .env --yes
```

## 10. Операционные заметки

- gateway-бот — это основной user-facing control plane
- консоли видны из gateway live registry
- межсессионные задачи идут через xchange records и `partner_note`
- ответы человеку в Telegram идут через `notify_telegram`
- browser screenshot для человека лучше отправлять через `browser_screenshot(send_to_telegram=true)`
- файлы между консолями лучше отправлять через `send_partner_file`

## 11. Деплой через GitLab CI на savant

Shell runner с тегом `telly_savant` проверяет и собирает npm-пакет в контейнере
Node 24, затем собирает gateway image с версией и SHA коммита. Push в `main` и
merge request выполняют только сборку. Тег `vX.Y.Z` запускает деплой после
проверки версии пакета и принадлежности коммита к `main`. Обе job должны
использовать Docker daemon на savant. При очистке Docker сохраняйте текущий и
предыдущий образы.

Постоянные файлы: `/opt/tellymcp/docker-compose.yml`,
`/opt/tellymcp/.env-gateway`, `/opt/tellymcp/nginx/default.conf`.
Nginx Proxy Manager обслуживает HTTPS для `tellymcp.deadragdoll.net` и направляет
HTTP на `192.168.1.68:18088`. Порт на хосте публикует только nginx-контейнер;
gateway, PostgreSQL, Redis и RabbitMQ работают в собственной Docker-сети.
В NPM нужны WebSocket upgrade и передача MCP stream без буферизации.

```bash
cd /opt/tellymcp
docker compose --env-file .env-gateway up -d
docker compose --env-file .env-gateway ps
docker compose --env-file .env-gateway logs --tail 100 tellymcp-gateway
```

В `.env-gateway` находятся пароли DB/RMQ, gateway secrets, публичные URL,
`TELLYMCP_IMAGE` и необязательные `NGINX_BIND_IP`/`NGINX_PORT`. Compose задаёт
внутренние адреса инфраструктуры и HTTP-порт. Проверяйте конфигурацию через
`compose config --quiet`: полный вывод `config` содержит секреты.
В `state/` сохраняются session marker, файлы обмена и файловые логи;
данные инфраструктуры — в именованных volumes. `down -v` удаляет базы.

При первом переносе подготовьте каталог для `gitlab-runner`, скопируйте и
адаптируйте env действующего gateway, поднимите только `postgres redis rabbitmq`.
До остановки исходного gateway проверьте, что целевые базы пусты. Затем
остановите gateway, сохраните и восстановите PostgreSQL одной транзакцией
(`pg_restore --single-transaction`) и восстановите Redis. Volumes имеют явные
имена `tellymcp_savant_postgres_v1`, `tellymcp_savant_redis_v1` и
`tellymcp_savant_rabbitmq_v1`; не используйте старые `tellymcp_*_data`.

Для импорта RDB в Redis с включённым AOF загрузите backup во временный
изолированный Redis без AOF и перенесите ключи через `DUMP`/`RESTORE` с сохранением
оставшегося TTL. До запуска gateway проверьте содержимое ключей: одного
копирования `dump.rdb` рядом с AOF-файлами недостаточно.

Проверьте/опустошите очереди RabbitMQ перед переносом. Gateway создаёт свои
очереди автоматически. Перенесите session marker в `state/.mcpsession.json`.
Файл `.migration-ready` создавайте после восстановления данных — без него CI
не выполняет деплой. После запуска приложения и nginx проверьте публичный
health endpoint и bot webhook, обновите HTTP/WSS URL клиентов и переподключите
OAuth-интеграции. Сохраните исходный env и дампы в защищённом backup-каталоге.

Обычный деплой обновляет только gateway и nginx, проверяет публичный endpoint
и инфраструктуру, при ошибке возвращает прошлую конфигурацию и образ.
Снимки сохраняются в `releases/` с ограниченными правами. Для ручного отката
восстановите `.env-gateway`, `docker-compose.yml` и `default.conf` (в `nginx/`)
из снимка, затем выполните с теми же Compose flags
`up -d --no-deps tellymcp-gateway nginx` и `exec nginx nginx -s reload`.
Откат образа не отменяет изменения схемы БД: при необходимости нужен
соответствующий backup базы. Не копируйте старый снимок поверх работающего volume.

## 12. Чего не делать в новых setup

Не строй новые setup вокруг:

- pairing codes
- inbox polling APIs
- `Local` linked-session меню
- старых session-link workflow
