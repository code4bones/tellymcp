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
  - `15` test files
  - `68` tests
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

- [ ] Подумать над policy для `Live` approval:
  - one-shot approve only
  - remember approve for session/member/project
  - revoke existing approval policy

- [ ] Продумать session presence/status screen:
  - что показываем как `client online/offline`
  - нужен ли отдельный heartbeat самого агента
  - как не путать живой бот, живой сервис и закрытый агент

- [ ] Доделать packaging/publish polish:
  - решить, оставляем ли `1.0.0` или откатываемся на `0.1.0`
  - проверить первый публичный `npm publish`
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
