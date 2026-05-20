# TODO

Current state:

- `telegram_mcp` переведён на `Moleculer`.
- MCP работает через `${ROOT_PREFIX}/mcp`.
- Mini App `Live` работает через `${ROOT_PREFIX}/webapp`.
- Control plane переведён на `ws`.
- Gateway-side `RabbitMQ` fanout подключён и работает.
- `🏠 Local` flow работает:
  - pairing
  - link
  - `Ask / Share / File`
  - `Передать агенту`
  - sqlite-backed xchange records
- `👥 Collab` flow работает:
  - projects
  - members
  - `Ask / Share / File`
  - `Ask -> reply` с `Reply message_uuid` / `target_session_id`
  - delivery/status через `ws`
  - `Live` выбранного участника через approval flow
- `Storage` работает от файловой системы:
  - истина — локальный `.mcp-xchange`
  - stale meta не показываются
  - stale meta подчищаются при открытии списка
- Exchange files больше не зависят от `vfs/minio`.
- Базовый regression-suite собран:
  - `17` test files
  - `74` tests
  - `yarn test / build / lint` проходят
- `TOOLS.md` sync работает:
  - gateway/client сверяют `tools_hash`
  - online клиенты получают `tools_event`
  - reconnect-case закрыт через self-check после `hello_ack`
  - system inbox messages используют `message_kind = "system"`
- Версионный handshake работает:
  - client шлёт `package_version`, `protocol_version`, `capabilities`
  - gateway отвечает verdict `ok|warn|reject`
  - `protocol major mismatch` блокирует `ws` transport
  - локальные сессии получают system inbox / Telegram notice на `warn` и `reject`
- `tmux target` теперь умеет auto-recovery:
  - stale pane id после пересоздания tmux больше не требует немедленной ручной перепривязки
  - сервис пытается найти новый pane по tmux hints и обновить Redis сам
  - если это не удалось, пользователь получает Telegram notice
- Появился optional `tmux prompt scan`:
  - периодически сканирует хвост tmux buffer
  - использует `strict|balanced` scoring вместо реакции на одно слово
  - шлёт Telegram notice только при достаточном score
  - делает dedupe/cooldown по fingerprint prompt-а
- `Share` inbox semantics ужесточены:
  - текущая сессия выполняет работу сама
  - target-сессии отправляется только результат
  - исходное поручение не должно пересылаться дальше как новая задача
- Логирование сведено к единой модели:
  - `pino-pretty` в консоль
  - optional JSONL sink через `LOG_FILE_ENABLED/LOG_FILE_PATH`
  - optional `LogFeed` для UI/диагностики

Next session:

- [ ] Пройти ручной smoke-pass `Storage`:
  - пустая сессия
  - реальные files
  - screenshots
  - stale entry -> `Get`
  - stale entry -> `Delete`
  - nested paths `YYYY-MM-DD/HH-mm-ss`

- [ ] Пройти ручной smoke-pass `Live approval`:
  - local partner
  - collab member на другой машине
  - approve
  - deny
  - повторный запрос после deny
  - что происходит со старыми approval messages

- [ ] Подчистить UX `Storage`:
  - решить, нужен ли отдельный раздел `Files / Screenshots / Notes`
  - решить, нужен ли bulk cleanup stale meta
  - проверить, не нужны ли подписи по source/type в списке

- [ ] Подумать над следующей итерацией `Collab` UX:
  - нужен ли более глубокий delivery history beyond current `.md` export
  - нужен ли manual retry для failed delivery
  - нужен ли отдельный просмотр последних `Ask / Share / File`

- [ ] Подумать над следующей итерацией `tmux target` recovery:
  - нужно ли обновлять target не только на nudge, но и на `Live` open/action path
  - нужно ли пробовать auto-refresh target при `set_session_context`
  - нужен ли отдельный tool/command для “repair tmux target”

- [ ] Подкрутить `tmux prompt scan` после реального использования:
  - проверить, хватает ли `strict` scoring без ложных срабатываний
  - решить, нужен ли отдельный admin/user toggle для scan на уровне сессии
  - решить, нужно ли добавлять быстрые action buttons (`Open Live`, `Send Enter`, `Ctrl+C`) прямо в notice

- [ ] Подумать над policy для `Live` approval:
  - one-shot approve only
  - remember approve for session/member/project
  - revoke existing approval policy

- [ ] Продумать session presence/status screen:
  - что показываем как `client online/offline`
  - нужен ли отдельный heartbeat самого агента
  - как не путать живой бот, живой сервис и закрытый агент

- [ ] Доделать packaging/publish polish:
  - проверить publish/upgrade flow для `0.0.10`
  - проверить install/smoke на чистой машине

- [ ] Дочистить operational logs:
  - оставить только полезные lifecycle logs
  - убрать оставшийся шум из стабильных happy-path маршрутов

- [ ] Подумать над следующей итерацией version handshake:
  - нужен ли capability-based degrade вместо простого `warn`
  - нужен ли persist последнего `gateway package/protocol` в session state
  - нужен ли отдельный UI-экран со статусом совместимости client <-> gateway

- [ ] Решить, нужен ли полноценный `RabbitMQ` queue flow поверх fanout:
  - retry / backoff
  - DLQ
  - offline delivery beyond DB backlog

- [ ] Исследовать Telegram `bot-to-bot communication` как future control-plane layer:
  - может ли `gateway bot` отправлять admin/control-команды `client bots`
  - может ли `client bot` отправлять `gateway bot` status/events без user-mediated flow
  - что из текущего `ws` нужно оставить low-latency transport, а что можно вынести в bot-to-bot
  - как подписывать команды и делать dedupe / rate limits / loop prevention
  - нужен ли отдельный fleet-model для `gateway bot` + many `client bots`

- [ ] Исследовать Codex/OpenAI `computer use` / remote-control как optional fallback для `tmux`:
  - может ли это заменить только `nudge` / простые control-actions там, где нет `tmux`
  - как объявлять capability на уровне session/client: `tmux`, `remote_control`, `none`
  - можно ли использовать это только для desktop/local clients, не ломая headless Linux path
  - где провести границу:
    - `tmux` как primary deterministic path
    - `computer use` как optional fallback
    - не использовать это как основной low-latency transport для `Live`
  - какие user/admin flows реально выигрывают:
    - wake-up
    - открыть окно/терминал
    - вставить текст
    - простые локальные действия
  - какие риски нужно принять:
    - beta / preview nature
    - GUI dependency
    - ниже надёжность, чем у `tmux`
    - higher HITL / safety oversight

- [ ] Следующий большой шаг: `gateway-bot-only` / `agent-only clients`
  - ввести `GATEWAY_TOKEN` как visibility scope / tenant layer на шлюзе
  - перевести client enrollment на `GATEWAY_TOKEN -> client_uuid/client_secret`
  - оставить один Telegram bot на gateway, убрать обязательный local client bot
  - перенести `/link` на gateway-side flow:
    - пользователь авторизуется в gateway bot
    - выбирает scope
    - выбирает client/session, видимые только внутри своего `GATEWAY_TOKEN`
  - оставить `ws` как transport/presence/live layer, не делать `Redis-over-WS`
  - пока сохранить local Redis/client state как transition step
  - позже отдельно решить:
    - нужен ли переход client-local state с Redis на sqlite
    - как хранить `active session` и bindings уже без local Telegram bot
    - как revoke/rotate `client_secret` без смены `GATEWAY_TOKEN`
