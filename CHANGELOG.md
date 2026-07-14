# Changelog

## Unreleased

### Changed

- Redis теперь используется только в режимах gateway и `both`. Client runtime
  больше не подключается к Redis и не требует `REDIS_*`; временное состояние
  хранится локально в процессе, а стабильный `gateway_client_uuid` — в
  `.mcpsession.json`. Клиентские шаблоны, migration, configure, doctor, prune и
  runtime diagnostics приведены к этой модели.

### Added

- Добавлен локальный web-конфигуратор `tellymcp configure`: browser wizard
  предлагает выбрать Client или Gateway, показывает role-specific поля,
  формирует HTTP/WS/WebApp/webhook/OAuth URL из одного Public base URL,
  показывает русские hints и примеры, выполняет role-specific live-check
  Telegram, Redis, PostgreSQL, gateway HTTP/WS и RabbitMQ, затем скачивает
  `.env-client` либо `.env-gateway`.
- Добавлен безопасный MCP tool `get_runtime_diagnostics` для end-to-end проверки
  версии/protocol, принятой env-схемы, runtime state store, PTY, gateway config и
  gateway-to-client relay без вывода секретов; Redis проверяется только на gateway.
- Добавлены связанные MCP tools `get_file_list` и `get_file` для получения
  файлов из workspace выбранной live-консоли через gateway. Первый возвращает
  список managed files и точные пути, второй принимает `file_path` либо
  `selector=latest_screenshot`. По умолчанию `get_file(type="url")` возвращает
  короткоживущую download-ссылку в `data`; временная gateway-копия хранится в
  `.tellymcp/tmp/file-links`, а `type="base64"` остаётся fallback.
- Добавлен явный режим `get_file(type="image")`: download URL остаётся в
  `structuredContent.data`, сам structured type равен `image`, а изображение
  возвращается отдельным нативным MCP-блоком, чтобы Claude и другие совместимые
  клиенты могли рендерить его inline.
- Для Claude.ai сохранён совместимый `type="base64"`: полный JSON вместе с raw
  base64 в `data` возвращается обычным MCP text-блоком без native image, поскольку
  некоторые MCP-host адаптеры заменяют изображение на `[image]` и скрывают
  structured output от модели.
- Добавлен `get_file(type="text")` для прямого чтения UTF-8 Markdown и исходников
  через native MCP text-блок. Для `.ts`, `.tsx` и других source-расширений добавлены
  текстовые MIME overrides.
- Доступ к live `.env`, credential stores, private-key расширениям и чувствительным
  директориям теперь блокируется на клиенте до чтения или отправки файла; выход
  за workspace и через symlink по-прежнему запрещён.
- Имена временных gateway-файлов очищаются до безопасного basename: управляющие
  и файлово-зарезервированные символы заменяются перед сохранением и формированием
  `Content-Disposition`.
- Перенос `telegram_mcp` на сервисную архитектуру `Moleculer`:
  - `telegramMcp.runtime`
  - `telegramMcp.http`
  - `telegramMcp.browser`
  - `telegramMcp.collaboration`
  - `telegramMcp.gateway`
  - `telegramMcp.gatewayDelivery`
  - `telegramMcp.ensuredb`
- MCP и WebApp теперь работают через общий HTTP runtime под `${ROOT_PREFIX}`:
  - `${ROOT_PREFIX}/mcp`
  - `${ROOT_PREFIX}/webapp`
  - `${ROOT_PREFIX}/healthz`
  - `${ROOT_PREFIX}/gateway`
- Добавлены проекты для межмашинной коллаборации:
  - создание проекта
  - join по invite token
  - список проектов
  - выход из проекта
  - список сессий проекта
- Добавлен project-based remote flow между разными машинами и разными ботами.
- Добавлен `📦 Storage` в session menu:
  - просмотр `.mcp-xchange` по текущей сессии
  - открытие storage entry
  - отправка note/file обратно в Telegram
- Добавлен `ws`-only control plane:
  - `Live`
  - delivery push
  - delivery status updates
  - project join/leave notifications
- Добавлен gateway-side `RabbitMQ` fanout:
  - `delivery.queued`
  - `delivery.status`
  - `project.member_joined`
  - `project.member_left`
- Добавлены sender-side delivery notices со статусами Telegram-сообщений:
  - `⏳ в очереди`
  - `✅ доставка выполнена`
  - `❌ доставка не выполнена`
- Добавлен gateway-relayed `Live View`:
  - Mini App может открываться через домен gateway
  - клиентской машине не нужен собственный публичный домен
  - relay работает для `bootstrap/view/action`
- Добавлены входящие Telegram-уведомления о remote delivery с контекстом:
  - проект
  - сессия
  - отправитель
  - список файлов
- Добавлен унифицированный note-based обмен; позже он переведён на structured xchange records на sqlite.
- Добавлен `send_partner_file` для реальной передачи локального файла через partner delivery.
- Добавлена `TOOLS.md` hash-синхронизация между gateway и client:
  - `session_tools` в `ws hello`
  - `tools_event` при mismatch
  - client-side self-check после `hello_ack`
  - периодический recheck online клиентов на gateway
- Добавлен version-handshake в `ws hello/hello_ack`:
  - client отправляет `package_version`, `protocol_version`, `capabilities`
  - gateway отвечает своим version/protocol/capabilities и verdict `ok|warn|reject`
  - major protocol mismatch теперь блокирует transport до обновления старой стороны
- Добавлены system inbox messages с `message_kind = "system"` для operational инструкций.
- В `TOOLS.md` введён явный human-readable version marker.
- Добавлен `Collab -> Tools -> History`:
  - one-shot export `.md`
  - последние 5 Collab-событий текущей активной сессии
  - без отдельного submenu и без новой таблицы
- Добавлен publish-ready npm/CLI контур:
  - package name `@deadragdoll/tellymcp`
  - bin `tellymcp`
  - команды `init` и `run`
  - безопасные packaged templates для `.env`

### Changed

- Общее чтение workspace-файлов теперь проверяет реальный путь после разрешения
  symlink и не позволяет выйти за пределы workspace.
- Telegram Mini App Live Console переведена на WS-only rendering:
  - HTTP polling и `/api/view` удалены
  - после разрыва WebSocket автоматически восстанавливается с exponential backoff
  - размеры xterm рассчитываются официальным `@xterm/addon-fit`
  - resize колонок и строк передаётся локальным и relay PTY
- Полностью убран legacy standalone MCP transport. `telegram_mcp` работает только через REST/MCP over HTTP.
- Локальный standalone HTTP listener убран; `telegram_mcp` больше не поднимает отдельный сервер вне Moleculer gateway.
- UI Telegram переосмыслен по двум режимам:
  - `🏠 Local` для локальной разработки и link внутри одного бота
  - `👥 Collab` для gateway/projects сценария
- Project flow упрощён:
  - вход в проект сразу открывает участников
  - отдельный `Set current` перестал быть обязательным для работы
- `Members` теперь используются как точка выбора remote target session внутри проекта.
- Отправка `Ask / Share / File` в `Collab` переведена на session-targeted messaging через gateway.
- Exchange files больше не зависят от `vfs/minio` в активном Telegram handoff path.
- Top-level `Files` меню удалено:
  - upload в открытой session/target context сразу создаёт handoff
  - `Local` и `Collab` стали основными точками file delivery
- Для upload и screenshot VFS path стал более устойчивым к коллизиям имён:
  - `files/YYYY-MM-DD/HH-mm-ss/<name>`
  - `screenshots/YYYY-MM-DD/HH-mm-ss/<name>`
- Для project members добавлен более понятный label:
  - `{session} · 👤{telegram_username} / 🤖{botname}`
- HTTP fallback для `Live` и delivery удалён:
  - больше нет `cron`
  - больше нет `poll/respond/status` HTTP fallback path
  - основной transport теперь `ws`
- Для `Collab -> Project -> Member` уточнена семантика действий:
  - `Ask` адресуется выбранной сессии
  - `Share` ставит задачу текущей сессии отправить результат в выбранную
  - `Live` добавлен второй строкой под `Ask | Share`
  - `Live` теперь требует подтверждения выбранной target-сессии
  - file upload в member screen остаётся прямой доставкой в target session
- Состояние `TOOLS.md` по сессии теперь разделено:
  - `lastSeenToolsHash` = реально применённый локально hash
  - `lastNotifiedToolsHash` = hash, про который уже отправляли уведомление
- Основная install-модель смещена на:
  - `npm install -g @deadragdoll/tellymcp`
  - `tellymcp init <client|gateway|both>`
  - `tellymcp run`
- старый `go/node terminal-proxy` path полностью удалён, поддерживается только прямой локальный terminal runtime

### Fixed

- Remote session-context actions больше не пытаются повторно уйти с client node
  обратно в gateway без `clientUuid`; backend error payload дополнительно
  ограничен по размеру, чтобы relay-сбой не создавал рекурсивный exception.
- Исправлен `Headers have already sent` при работе MCP/WebApp через общий HTTP runtime.
- Исправлены route/alias проблемы после перехода под `${ROOT_PREFIX}`.
- Исправлены зависания Mini App bootstrap и проблемы с relative WebApp routes.
- Исправлены wildcard routes после стабилизации общего HTTP runtime.
- Исправлен рекурсивный `logfeed -> graphql.publish -> logfeed` loop.
- Исправлены ошибки duplicate SSE stream и приглушён лишний шум в логах.
- Исправлены скрытые попытки инициализации Postgres в `client` режиме:
  - gateway DB bootstrap отключается
  - `DBMixin` умеет работать в no-op режиме без `DB_HOST`
- Исправлены project session registrations:
  - одна и та же локальная session теперь может жить в нескольких проектах
- Исправлены задержки gateway poller:
  - переход на cron/event tick
  - таймауты для poll/ack
  - корректный shutdown без лишнего warning
- Исправлены циклические повторы битых gateway deliveries:
  - irrecoverable delivery помечается как `failed`
  - poll больше не пытается бесконечно дочитать несуществующий объект
- Исправлены падения при чтении битых `storageRef`:
  - больше нет `Buffer.from(BackendError)`
  - ошибки чтения и resolve теперь обрабатываются явно
- Исправлены sender-side/receiver-side статусы и сообщения по remote file exchange.
- Исправлены временные синтаксические и debug-хвосты в Mini App `Live` relay shell.
- Исправлен project reply path:
  - gateway теперь принимает `in_reply_to` как `message_uuid` или как note `share_id`
  - во входящих notes/уведомлениях добавлены `Reply Params` и `Reply message_uuid`
- Исправлен loopback delivery для режима `both` на gateway-машине.
- Устаревшие Telegram member-menu сообщения теперь удаляются при клике по stale payload.
- Исправлена валидация `get_telegram_inbox` для системных сообщений с `telegram_message_id = 0`.
- Исправлены повторные холостые `TOOLS.md` alerts по одному и тому же hash.
- Исправлен reconnect-case для `TOOLS.md` sync:
  - если server-side push был пропущен, client сам сверяет hash после `hello_ack`
- Исправлен self-check `TOOLS.md` в `DISTRIBUTED_MODE=both`:
  - локальный gateway hash берётся без лишнего `fetch`
- `doctor` стал mode-aware:
  - `client` теперь проверяет внешний gateway `healthz`, `ws`, и public webapp URL
  - `gateway/both` теперь проверяют local/public `healthz`, public `ws/webapp`, `postgres`, `rmq`
- Исправлен build-контур для npm publish:
  - `dist` теперь всегда очищается перед сборкой
  - stale legacy build artifacts больше не попадают в пакет
