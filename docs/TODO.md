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
  - `LOCAL_INDEX.md`
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

- [ ] Подумать над policy для `Live` approval:
  - one-shot approve only
  - remember approve for session/member/project
  - revoke existing approval policy

- [ ] Продумать session presence/status screen:
  - что показываем как `client online/offline`
  - нужен ли отдельный heartbeat самого агента
  - как не путать живой бот, живой сервис и закрытый агент

- [ ] Доделать packaging/publish polish:
  - проверить publish/upgrade flow для `0.0.8`
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
