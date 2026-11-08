<div align="center">

# TellyMCP

**Telegram control plane для MCP-подключённых coding agents**

[English](./README.md) · [Русский](./README-ru.md) · [Standalone](./docs/STANDALONE.md) · [Standalone RU](./docs/STANDALONE-ru.md)

[![npm version](https://img.shields.io/npm/v/@deadragdoll/tellymcp.svg)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![node](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@deadragdoll/tellymcp.svg)](./LICENSE)
[![gateway--first](https://img.shields.io/badge/runtime-gateway--first-1f6feb.svg)](./README-ru.md#текущая-модель)
[![telegram webhook](https://img.shields.io/badge/telegram-webhook%20%7C%20polling-26A5E4.svg)](./README-ru.md#webhook)

</div>

`@deadragdoll/tellymcp` — Telegram control plane для MCP-подключённых coding agents.

Текущая модель — gateway-first:

- один gateway держит Telegram-бота, web app, проекты и live registry консолей
- один или несколько agent-процессов подключаются к этому gateway
- каждая запущенная консоль агента — отдельный routable target
- пользователь работает через gateway-бота, а не через pairing отдельных сессий

## Что умеет

- даёт MCP tools для human-in-the-loop через Telegram
- позволяет одной консоли агента ставить задачу другой консоли
- позволяет MCP chat-клиенту получать проектный текст, изображения и артефакты выбранной консоли
- хранит structured xchange records в `.mcp-xchange`
- поддерживает browser automation через Playwright
- умеет attach к уже открытому Firefox или Chrome через bundled local extensions
- умеет писать structured browser bundles в `.mcp-xchange/web/...` с HTML, network и console артефактами
- умеет инжектить helper scripts в attached tabs или Playwright pages через `browser_inject_script`
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
- `get_file` для возврата скриншотов и артефактов в MCP chat-клиент

Для agent-to-agent:

- `partner_note`
- `send_partner_note`
- `send_partner_file`
- `list_gateway_sessions`

Для диагностики:

- `get_runtime_diagnostics` для безопасной end-to-end проверки gateway/client

Для браузера:

- `browser_open`
- `browser_click`
- `browser_fill`
- `browser_inject_script`
- `browser_press`
- `browser_wait_for`
- `browser_screenshot`
- `browser_recording_start`
- `browser_recording_stop`
- `browser_recording_status`

Файлы:

- `get_file_list(source=..., limit=...)`
- `get_file(file_path=..., type="url")`
- `get_file(file_path=..., type="image")`
- `get_file(file_path=..., type="text")`
- `get_file(file_path=..., type="base64")`
- `get_file(selector="latest_screenshot")`

Синхронизация инструкций:

- `refresh_tools_markdown`
- `.mcpsession.json` хранит startup identity и последний известный tools hash

## Требования

- Node.js `>= 24`
- Python 3, `make` и C/C++ toolchain на Linux для локальной сборки native addon `node-pty`; npm lifecycle scripts должны быть включены
- Redis только для режимов gateway и `both`; клиент Redis не использует
- PostgreSQL для gateway mode
- опционально RabbitMQ для durable gateway fanout
- Playwright browser binaries, если нужны browser tools

## Установка

На Debian/Ubuntu сначала установи зависимости для сборки native PTY:

```bash
sudo apt install -y python3 make g++
npm config set ignore-scripts false
```

```bash
npm install -g @deadragdoll/tellymcp --foreground-scripts
```

Опубликованная зависимость `node-pty` не содержит готового Linux ARM64 binary,
поэтому install lifecycle собирает `pty.node` локально. Если пакет ранее
установился без него, восстанови глобальную установку:

```bash
npm uninstall -g @deadragdoll/tellymcp
npm install -g @deadragdoll/tellymcp@latest --foreground-scripts
tellymcp doctor --env <file>
```

`tellymcp --help` и setup-команды не загружают native PTY. Runtime проверяет
модуль перед запуском и вместо сырого stack trace выводит те же инструкции по
восстановлению.

Если нужны browser tools:

```bash
tellymcp browser install
```

Если нужны attach extensions для существующего Firefox/Chrome:

```bash
tellymcp extension firefox
tellymcp extension chrome
```

Команда выгружает готовые unpacked bundles в текущий каталог:

- `./tellymcp-firefox-attach`
- `./tellymcp-chrome-attach`

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
tellymcp configure
```

Команда открывает защищённую одноразовым токеном локальную страницу на
`127.0.0.1`. Выбери в wizard роль `Gateway`, заполни и проверь настройки, затем
сохрани `.env-gateway` обычным browser download. Перед использованием выставь
файлу права `0600`. `tellymcp init gateway` остаётся вариантом для ручного
редактирования шаблона.

Публичный origin или API base вводится один раз. Wizard сам формирует gateway
HTTP, WebSocket, Mini App, webhook, root-prefix и опциональные OAuth URL.
На ключевых этапах доступны реальные проверки Telegram, Redis, PostgreSQL,
gateway HTTP/WebSocket и опционального RabbitMQ.

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
- `GATEWAY_SCOPE_TOKEN`
- `GATEWAY_AUTH_TOKEN`

Запуск:

```bash
tellymcp run --env .env-gateway
```

### 2. Agent

Для каждой консоли лучше отдельный workspace:

```bash
mkdir -p ~/agent-a
cd ~/agent-a
tellymcp configure
```

Выбери в wizard роль `Client`. В форме есть подключение к gateway, identity
консоли, terminal, browser, MCP и расширенные runtime-настройки. После
валидации браузер скачает `.env-client`. Флаг `--no-open` выводит локальный URL
без автоматического открытия браузера.

Для клиента тот же Public base URL автоматически формирует
`GATEWAY_PUBLIC_URL`, `GATEWAY_WS_URL` и `GATEWAY_WS_PATH`.

Или используй sample:

- [.env.example.client](./.env.example.client)

Минимально важные значения:

- `GATEWAY_PUBLIC_URL`
- `GATEWAY_WS_URL`
- `GATEWAY_SCOPE_TOKEN`
- `GATEWAY_AUTH_TOKEN` (тот же transport-токен, который задан на gateway)
- `GATEWAY_USER_UUID`, если консоль должна быть видна конкретному владельцу в gateway-боте

Рекомендуется:

- по умолчанию используется встроенный PTY terminal runtime
- задать имя консоли через `-s`; идентичность сохранится в marker-файле workspace

Первый запуск:

```bash
tellymcp run --ws 9999 -s NEW
```

Общий профиль клиента — `$HOME/.tellymcp/.env`; его создаёт `tellymcp init client`.
Приоритет: явный `--env`, сохранённый профиль workspace, локальный `.env`, затем
общий файл в домашнем каталоге. `--ws 9999` включает подключение браузерного
расширения на этом порту для текущего запуска. Без `--ws` используются настройки
из env; сам флаг их не перезаписывает.

После первого запуска `.mcpsession.json` хранит:

- `local_session_id`
- `session_label`
- `env_file`
- `gateway_client_uuid`

Runtime-состояние клиента локальное и не требует Redis. Сохранённый
`gateway_client_uuid` обеспечивает стабильную идентичность после перезапуска.

Поэтому дальше в том же каталоге обычно достаточно:

```bash
tellymcp run
```

### Локальный detach/attach (Linux)

В client mode обычный `run` запускает или повторно использует фонового owner и
подключается к прежнему shell. `run --detach` возвращает после ready без TTY.

```bash
tellymcp run --detach
tellymcp sessions           # --json для машинного вывода
tellymcp attach             # выбор сессии, либо сразу attach <handle>
tellymcp stop               # выбор сессий для остановки, либо stop <handle>
```

Без handle attach открывает меню: стрелки для выбора, Enter для подключения,
Esc или Ctrl+C для отмены. Доступная сессия текущего workspace выделена по
умолчанию; занятые и недоступные сессии выбрать нельзя.
Stop без handle открывает повторяющееся меню: выбор останавливает сессию и
обновляет список. Подключённые сессии тоже можно остановить. Меню завершается,
когда сессий больше нет, либо по Esc/Ctrl+C; оставшиеся сессии продолжают работать.
При ошибке остановки меню показывает её и возвращается к выбору.

Для возврата в исходную консоль нажми **Ctrl+]**, затем **d**. Двойной Ctrl+]
передаёт буквальный префикс; bracketed paste сохраняет префикс внутри вставки.
Одновременно доступен один controller. Потеря frontend сохраняет owner и сервисы;
выход shell или stop завершает их. Attach/list/stop не требуют профиля и связи
с gateway. Смена конфигурации или явного provider/bridge требует сначала остановить
старый owner. Управляемые агенты запускаются через прежний `--agent`.

Запускай из исходной консоли: старую foreground-сессию нельзя преобразовать на
месте. Интерактивный attach использует Linux `stty`. Для проверки исходников после
`yarn build` используй `node /полный/путь/tellymcp/dist/cli.js`. Для локальной установки
выполни `npm pack`, затем `npm install -g /путь/deadragdoll-tellymcp-<version>.tgz`.
SSH/cgroup, настоящие TUI агентов и remote attach требуют отдельной
приёмки. [Контракт реализации](docs/DETACHED_SESSIONS_DESIGN.md).

### Attach терминалом через шлюз

В Telegram открой Live нужной сессии и нажми **Attach** рядом с **Link**. Владельцу придёт личное сообщение с одноразовым восьмизначным кодом
на пять минут и готовой командой для другой машины:

```bash
tellymcp attach --code 12345678
tellymcp attach --code 12345678 --gateway https://example.com/api/gateway
```

Вариант с `--gateway` работает без настроенного адреса шлюза; `--env <file>`
позволяет выбрать настройки шлюза/прокси. Доступ даёт код: копировать конфиг и
marker владельца не нужно. Несколько локальных и удалённых терминалов могут
одновременно подключаться к одному shell и вводить команды. Live View сохраняет
зеркальный экран и ввод. Размер общего PTY задаёт последний attach или resize,
включая Live; detach размер не меняет. Маленькое окно показывает обрезанную часть
общего экрана без изменения переносов строк.
Ctrl+], затем d отключает только этот терминал, сессия продолжает работать.
Для следующего подключения получи новый код; ввод автоматически не повторяется.
Пять минут — срок погашения кода, длительность подключения им не ограничена.

Для remote attach нужен шлюз **0.0.44 или новее**. Для параллельных native attach
нужны session owner и клиенты подключения **0.0.45 или новее** (локальный протокол2).
Уже запущенный owner загружает новый bridge после перезапуска; установка пакета
сама по себе не заменяет код работающего процесса.

### AI Picker в подключённом браузере

В Chrome0.0.15 и Firefox0.0.15 есть **Element / Region / Mark elements** и команда
**Alt+Shift+P**. Подключи расширение к консоли в Control Panel. **Ctrl+клик**
выбирает элемент или переключает метку; обычный клик работает на странице,
позволяя сначала открыть popup. В Region область выделяется обычным
перетаскиванием и служит только для скриншота, без сбора DOM. Для отправки
содержимого Region включи Snapshot. Локальный кадр сохраняется при выборе без маскирования;
**Snapshot** включает его превью и отправку (изначально выключен). **Send**
запрашивает ответ в консоли, **Ctrl+Send** — также в браузере через
`inspector_response`; при Ctrl кнопка Send зелёная на hover. Исходная консоль
сохраняет артефакт и уведомляет своего агента. Для опционального ответа нужны
owner0.0.51 и его перезапуск. На Send исходная
вкладка привязывается автоматически с подтверждением консоли перед отправкой;
ручной Attach не нужен. Mark elements переключает
метки целых DOM-контейнеров и отправляет только селекторы группы и вопрос;
агент читает живой DOM через `browser_dom(all=true)`. Для автоматической привязки
нужны owner0.0.47, его перезапуск и перезагрузка расширений.
Отдельный AI-провайдер или агент не запускается. Живое выделение хранится пять
минут, сохранённые артефакты остаются. Esc/Forget очищает живое состояние.
[Границы и реализация](docs/AI_PICKER_EXTENSION.md#13-карта-реализации-mvp-2026-11-08).

### Запуск и продолжение coding agent

В TellyMCP встроены provider adapters для Codex и Claude Code. Vendor CLI
остаётся опциональным: на client-машине можно использовать любой из них, а на
gateway не требуется устанавливать ни Codex, ни Claude.

Проверить client-машину:

```bash
tellymcp provider list
tellymcp provider status codex
tellymcp provider status claude
```

Подготовить интеграцию и сразу запустить агента вместе с консолью:

```bash
tellymcp provider install codex
tellymcp run --env .env-client --agent codex
```

`provider install codex` также подготавливает встроенный workflow plugin
TellyMCP для Codex. Для Claude Code используется встроенный adapter и
существующий helper `tellymcp mcp --format claude`; сам vendor CLI нужно
установить отдельно.

Агента запускай локально через `tellymcp run --agent codex|claude`, затем выбери
его работающую консоль в Telegram. Обычный текст, подписи к файлам и загрузки
файлов отправляются в терминальный ввод именно этой консоли. Отдельного меню
«Агент» и переключателя режима доставки в Telegram больше нет. Служебные команды
и ответы на явные запросы подтверждения обрабатываются своими обработчиками.

Для Codex TellyMCP поднимает локальный `codex app-server` и подключает консольный
TUI; Claude Code использует PTY adapter. Ввод из Telegram идёт в тот же TUI, что и
локальная клавиатура. Оставь MCP endpoint TellyMCP подключённым к агенту, чтобы его
workflow мог возвращать ответы и файлы в Telegram через существующие notify-tools.
На gateway vendor CLI не требуется.

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

Для обычного gateway-first запуска используй MCP endpoint шлюза:

```text
https://example.com/api/mcp
```

Helper:

```bash
tellymcp mcp --url https://example.com/api/mcp
```

Интерактивный `tellymcp run` не открывает локальный MCP HTTP listener. Локальный
порт8787 относится к отдельно настроенному standalone/dev runtime.

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

## Terminal Blockers

Gateway prompt scanner теперь живёт от live-client lifecycle:

- на старте gateway scanner только armed, но не крутится вхолостую
- реальная работа начинается после подключения live client
- relay console materialization идёт из `hello` и owner-route hydration, а не из `/menu`
- детект работает по хвосту захваченного terminal buffer

Основная эвристика blocker-а:

- подряд идущие numbered choices: `1.`, `2.`, `3.`
- рядом есть action hints вроде `press`, `input`, `choose`, `enter`, `esc`, `yes`, `no`
- в Telegram notice попадают и 1-2 строки контекста выше menu block

Когда blocker найден, gateway может отправить inline-кнопки:

- `1..N`
- `Enter`
- `Esc`

Эти кнопки отправляют в консоль ровно цифру или terminal action. Навигация маркером не используется.

Операционные заметки:

- одинаковый blocker fingerprint не перевысылается повторно
- relay capture miss для offline agent считается debug-only шумом
- `Storage` и `Screenshots` на gateway теперь relay-aware и читают metadata через gateway routes, а не через filesystem самого gateway

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

- [Контракт env и руководство по миграции](./docs/ENVIRONMENT.md)
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
- неоднозначные старые имена заменены на `TERMINAL_*`, `GATEWAY_SCOPE_TOKEN`,
  `TELEGRAM_REQUEST_MODE`, `DB_SCHEMA` и `LOGFEED_ENABLED`

## Операционные команды

Проверка окружения:

```bash
tellymcp doctor --env .env
```

Разрушительная очистка local+gateway state:

```bash
tellymcp system-prune --env .env --yes
```

Миграция старого env в текущий ролевой контракт:

```bash
tellymcp migrate-env ./old.env > ./.migrated-env
```

Fallback на старую схему отсутствует. Если найдены legacy-ключи, запуск
останавливается и выводит команду миграции.

## Карта документации

- [README.md](./README.md)
- [STANDALONE.md](./docs/STANDALONE.md)
- [STANDALONE-ru.md](./docs/STANDALONE-ru.md)
- [CHAT_CONNECTOR.md](./docs/CHAT_CONNECTOR.md) — OAuth-коннектор ChatGPT/Claude
- [TOOLS.md](./TOOLS.md)
- [screenshots/README.md](./screenshots/README.md)

## Статус

Этот README описывает текущую gateway-first модель.

Legacy concepts, которые не стоит использовать в новых setup:

- pairing codes
- session inbox APIs
- `Local` partner menu
- linked-session flows вне `partner_note` / project collaboration
