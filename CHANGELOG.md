# Changelog

## Unreleased

## 0.0.52 — 2026-11-09

- Enqueue project messages, attachments and delivery rows in one transaction.
  Optional request_id provides source-scoped retry deduplication and rejects
  changed payloads; direct routes reject the queued-only key.
- Claim queued deliveries with PostgreSQL row locks/SKIP LOCKED and a 60-second
  lease. Immediate pushes and periodic retries share the claim path. Missing
  recipient sessions fail retryably instead of ACKing discarded work.
- Persist notification completion and coalesce simultaneous materialization RPCs;
  retries preserve read records. An uncertain notification is reported explicitly.
- Cache SQLite xchange connections with WAL/busy timeout and shutdown cleanup.
  Constrain exchange writes/deletes, refuse symbolic links and allocate new files
  exclusively. Mark delivery completion without resetting concurrent read status.
- Fix repeated Firefox Inject and keep custom namespaces independent. Firefox
  extension0.0.15; Chrome remains0.0.15. Region stays screenshot-only.
- Add real PostgreSQL concurrency, rollback, retry and migration tests, enabled
  in package-build CI with an isolated temporary database. Align CLI/Russian MCP
  setup text and Nginx documentation with current behavior.

## 0.0.51 — 2026-11-08 (local build)

- Select Elements and toggle Marks with Ctrl+click. Ordinary clicks and typing
  reach the page, so popups can be opened before selection; Region keeps normal
  dragging. Suppress the complete selection gesture even if Ctrl is released early.
- Send requests an answer in the console only; Ctrl+Send also requests a browser
  reply and turns the hovered Send button green. Save this preference in the
  artifact, notification and xchange reply requirements. Older extensions retain
  their browser-reply workflow; explicit preferences require owner0.0.51.
- Save a local cropped image immediately on Element/Region selection, without
  a page scan or masking. Snapshot is an initially disabled-inclusion toggle:
  attach/remove the cached image without recapturing, including after the original
  popup disappears. Keep DOM sanitization and image-size/source checks.
- Chrome0.0.15 / Firefox0.0.14 and local package0.0.51. Restart the source owner
  and reload extensions/pages to use optional replies; no gateway deploy needed
  for artifact delivery and browser responses.

## 0.0.50 — 2026-11-08 (local extension build)

- Keep Element's sanitized snapshot from the moment of selection. DOM updates or
  removal no longer invalidate sending that snapshot or receiving the answer.
  Highlighting/new image capture still require the original node; page-change,
  viewport, expiry and request/selection identity checks remain.
- Replace Explain/Ask with one Send icon that submits the typed question.
  Chrome0.0.14 / Firefox0.0.13; existing0.0.48 gateway/owners remain compatible.

## 0.0.49 — 2026-11-08 (local extension build)

- Keep Picker focusin/focusout events inside its Shadow DOM so an open page
  Drawer cannot steal focus from the question field. Preserve default focus,
  real typing and Ask delivery; the page's focus trap resumes outside Picker.
  Chrome0.0.13 / Firefox0.0.12; compatible with existing0.0.48 owners/gateway.
- Remove raw selection JSON from the Picker preview; retain the question,
  controls, optional image and Copy context action.

## 0.0.48 — 2026-11-08

- Bundle an unmodified, pinned Telegram Mini Apps SDK and serve it from a
  fingerprinted gateway URL. Mini App startup no longer fetches telegram.org;
  browser token links continue without loading any Telegram SDK.
- Add a black public root page with three dim star layers, calm autonomous drift
  and cursor-controlled acceleration/parallax. No external assets are loaded.
- Hide the Live toolbar for browser links authenticated by token (query or hash),
  keeping the statusbar and the toolbar in Telegram Mini App launches.

## 0.0.47 — 2026-11-08

- Skip Telegram SDK loading for direct-token browser Live links, avoiding a
  parser-blocking dependency on telegram.org. Load the SDK asynchronously for
  Mini App authentication with a ten-second limit and actionable failure text.
- Automatically attach the source Picker tab on Ask/Explain for Element, Region
  and Marks. Await the owner's persisted attachment ACK before submitting the
  selection; gate the protocol on picker_auto_attach capability and reject
  changed/disconnected sources. Manual Control Panel attachment remains available.

## 0.0.46 — 2026-11-08

- Arrange Telegram Live as Fullscreen | Expand | Default, Link | Attach, Back.
  Link sends a private copyable URL on demand instead of opening the browser;
  the standalone Back callback returns to the selected session menu.

- Add Marks Picker mode: toggle whole DOM containers with a shared UUID, a
  numbered list and cleanup/restoration of marker attributes. Ask sends only
  group selectors/item IDs and question; the agent reads live DOM on demand.
  Extend `browser_dom` with bounded all-match reads and optional original-tab
  binding checks. Complete Marks workflows require the updated gateway schema.

- Deliver browser Picker Ask/Explain to the bound console: save question, context,
  optional PNG and exact reply IDs under `.mcp-xchange/{date}/picker/{id}`, create
  a structured local handoff and submit an artifact notification through existing
  terminal input. Confirm save/notification in the extension and deduplicate
  retries; retain saved artifacts if the live selection expires.
- Collapse the Picker panel into a small circle during selection, place Select
  again at the same upper-right position, and use accessible Ant Design SVG icon
  buttons in the panel and extension popup.

## 0.0.45 — 2026-11-08

- Allow simultaneous writable native local/remote attachments with independent
  snapshot/ACK/output queues. Keep last-attach/last-resize-wins dimensions,
  including Live; never resize on detach. Sequenced authoritative viewport
  snapshots and a native VT projector preserve cells in differently sized
  windows. Local protocol2 keeps safe protocol1 owner discovery/stop support.
- Add shared TypeScript AI Picker to Chrome0.0.10/Firefox0.0.9, popup/hotkey,
  element/ancestor and region selection, sanitized bounded previews, optional
  masked PNG crop, explicit session/tab binding, memory-only five-minute queue
  and five inspector MCP tools for pull/highlight/response/cleanup.

## 0.0.44 — 2026-11-08

### Telegram OAuth login

- Use the configured Telegram proxy for both authorization-code exchange and
  remote JWKS retrieval; direct OAuth fetches could time out before the bot's
  administrator approval appeared. Bound network waits and keep the signing-key
  cache per transport without changing global proxy settings.
- Start the connector authorization-code TTL after Telegram/admin approval so a
  slow approval does not issue an already expired code. Point missing-admin
  guidance to `/admin` instead of `/auth`.

### Remote terminal attach

- Add an Attach button beside Open in browser in Telegram Live. The owner receives
  a private eight-digit, one-use code valid for five minutes, with ready CLI commands.
- Add `attach --code <code> [--gateway <url>] [--env <file>]` through the gateway
  WSS relay, reusing the local terminal renderer and owner protocol. The viewer
  creates no shell, agent, runtime, console registration or workspace marker.
- Bind codes to server-verified ownership and the exact owner instance; store
  hashes with Redis TTL/atomic redemption and limit issuance/guessing attempts.
- Share native local/remote attach exclusivity, expire broken remote leases, and
  preserve existing mirrored writable Live View. Reconnect requires a fresh code
  and never automatically replays uncertain keystrokes.

### Local detached sessions (Linux)

- Client-mode `run` starts or reuses a background owner for the existing console,
  shell, provider and services; `run --detach` returns after readiness. Ctrl+] then d
  returns to the outer shell while the session continues running.
- Add `sessions [--json]`, `attach [handle]` and `stop [handle]`, faithful screen and
  buffered-output restoration, raw input/resize handling, private local discovery,
  startup conflict checks and one local interactive controller.
- Show interactive Clack pickers for attach and stop without a handle. Stop
  refreshes selection after each operation until no sessions remain or the user
  cancels. Align/color the sessions table, with a compact layout in narrow terminals.
- Silence only Node's SQLite startup ExperimentalWarning; retain other warnings.
- Native remote attach and Telegram code authorization are included in this release.

### Terminal shutdown

- Treat the Unix PTY socket's `read EIO` as EOF, including when it arrives before the process exit notification. Keep other fd errors visible and preserve normal exit handling.

### Client startup

- Discover the default client profile in `$HOME/.tellymcp/.env`, preserve explicit/workspace overrides and migrate legacy home-profile marker paths.
- Add validated `--ws <port>` / `--ws=<port>` per-process extension listener overrides without rewriting the shared env. Preserve env behavior when the flag is omitted.

### Client configuration

- Add application-scoped HTTP/WSS proxy routing and bypass rules without modifying global proxy variables or dispatchers. Apply the same routing to gateway collaboration, TOOLS.md checks, temporary file uploads and HTTP-proxied Telegram file downloads.
- Migrate `HTTP_PROXY`/`NO_PROXY` file keys to `TELLYMCP_HTTP_PROXY`/`TELLYMCP_NO_PROXY` and preserve parent-shell proxy settings for the agent.

### Deployment

- Inherit the deployment error trap inside shell functions so Compose failures restore the saved release as well as HTTP health-check failures.

- Add the `telly_savant` CI build and tagged deployment pipeline with versioned gateway images, native PTY checks, readiness checks, serialized releases, and configuration/image rollback.
- Deploy a dedicated Compose stack and container nginx under `/opt/tellymcp`, using `.env-gateway`, private infrastructure ports, persistent data, dynamic gateway DNS, and NPM TLS forwarding.

### Fixed

- Version compatibility events from the WebSocket startup/reconnect handshake no longer call the human-message terminal nudge. Diagnostics and Telegram version notifications remain available, including protocol rejection; reconnecting alone does not start an agent turn.
- Background console synchronization updates bindings without activating each console in turn. Both Redis and process-local stores support preserving the selected session; synchronization chooses a fallback only when needed. Live and nested menus keep the user's selected console across polling cycles and newly discovered connections.
- Active-session navigation groups relay sessions by the gateway account UUID instead of the connection UUID. Console synchronization retains the owner UUID; older records fall back to the owner label. Session-menu Back uses the same grouping, and existing connection-based buttons resolve to the account's full session list.

### Added

- Generic inbox offers accept optional `route.label`, `route.slug`, and `display.sender` snapshots. Active route summaries expose the supplied project name and slug, and Telegram renders project labels and assigning people without fetching data from the source integration. Older offers remain supported.
- OAuth token endpoint now also issues a `refresh_token` on the
  `authorization_code` grant (`TELLYMCP_OAUTH_REFRESH_TOKEN_TTL_SECONDS`,
  default 30 days) and supports `grant_type=refresh_token` to silently renew
  past the much shorter access-token TTL, instead of forcing a full
  interactive re-authorization every time it expires. Refresh tokens rotate
  on every use, so a replayed old one is rejected. Stored through the same
  `OAuthRefreshTokenStore` port as the rest of gateway state (Redis in
  gateway/`both` mode, process-local otherwise), so they survive a gateway
  restart instead of forcing re-auth on every redeploy too.
- Self-service "📬 Входящие" Telegram menu (same row as Settings in the
  session menu): lists projects/routes with pending tasks addressed to you,
  picking one binds the _current_ console to that route and shows its
  active tasks, and each task's card offers Approve/Reject/Postpone
  directly -- no need to wait for the reactive first-event prompt or stay
  on the console that received it. Fully generic (works for any inbox
  `namespace`, not just Marrow); internally a real grammY menu for the
  top-level route list and plain inline keyboards (dispatched via
  `inbox-message-open:`/`inbox-decision:`/`inbox-route-back:` callback
  prefixes) for the parameterized route/message screens, matching how the
  existing Collab project-members screens are built.
- Backend groundwork for a self-service "Входящие" Telegram menu: generic
  queries to list a recipient's active inbox routes and the active messages
  within one (`telegramMcp.externalInbox.listActiveRoutes`/
  `listActiveMessages`), a `telegramMcp.inboxWorker.resolve` action that
  approves/rejects/defers a message independent of any live prompt (re-
  resolving its route binding fresh), and matching `/gateway/inbox/*`
  HTTP passthroughs. No menu UI yet -- that's the next slice.
- Inbox offers now have a third Telegram option, "Postpone", alongside
  Approve/Reject -- marks the message `deferred` instead of losing it, and
  the approve/reject/defer decision is now its own reusable step
  (`resolveInboxMessage`) that a future menu can call directly on a message
  with no live prompt of its own (e.g. approving something deferred days
  earlier).
- Generic external inbox (`inbox_put`/`inbox_bind_identity`/`inbox_bind_route`,
  Marrow task-assignment integration): когда маршрут ни разу не привязан, но
  получатель уже известен Telly, воркер сам предлагает ему в Telegram выбрать
  одну из своих живых консолей, привязывает маршрут и тут же продолжает
  доставку того же сообщения (approve/reject-оффер), а не теряет его. Новый
  статус сообщения — `awaiting_route_binding`, также восстанавливается после
  перезапуска гейтвея наравне с `processing`/`offered`.

### Changed

- Inbox task IDs use the source-provided `display.url` in approval cards and Rich
  Markdown details. No source address is constructed; missing URLs keep plain text.

- Inbox message details use native Telegram Rich Markdown. The existing message
  is edited in place, preserving action buttons and navigation back to the project.

- CLI больше не загружает `node-pty` до разбора команды: `tellymcp --help`,
  setup и diagnostics остаются доступны при отсутствующем native addon.
  `doctor`, `run` и postinstall теперь реально проверяют `pty.node` и выводят
  platform-aware инструкции для Linux ARM64, npm lifecycle scripts и чистой
  переустановки пакета.
- Исправлен `tellymcp doctor`: WebSocket probe больше не удаляет error-listeners
  перед закрытием соединения и не падает с unhandled `WebSocket was closed before
the connection was established` на HTTP reject, timeout или раннем close.
- Redis теперь используется только в режимах gateway и `both`. Client runtime
  больше не подключается к Redis и не требует `REDIS_*`; временное состояние
  хранится локально в процессе, а стабильный `gateway_client_uuid` — в
  `.mcpsession.json`. Клиентские шаблоны, migration, configure, doctor, prune и
  runtime diagnostics приведены к этой модели.

### Added

- Добавлен provider-neutral managed agent runtime: `tellymcp provider
list|status|install`, `tellymcp run --agent codex|claude` и Telegram-меню
  `🤖 Агент`. Codex и Claude Code обнаруживаются на client-машине через `PATH`,
  защищены от двойного запуска, а gateway не требует установленного vendor CLI.
  Codex запускается через client-owned `codex app-server` на приватном Unix
  socket с TUI через `codex --remote`; Claude Code пока использует прямой PTY
  adapter. TellyMCP создаёт общий Codex thread до запуска TUI, подключает консоль
  через `resume`, отправляет Telegram-сообщения напрямую как app-server turns и
  возвращает завершённый final message через существующий Telegram notify route.
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

- Inbox message-list Back buttons return to the project list instead of reopening
  the same messages. Message-card Back buttons use stored route payloads to retain
  the selected session and project.

- Inbox routing converts Telegram relay session IDs to canonical console IDs and
  updates the recipient's project route when it is opened from a selected session.
  Accept uses that exact owned console, reports actual delivery failures, keeps
  failed offers available for retry, and deduplicates concurrent/repeated delivery.

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
