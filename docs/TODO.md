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
  - `12` test files
  - `52` tests
  - `yarn test / build / lint` проходят

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

- [ ] Усилить `Action Required` / agent discipline:
  - короткий и жёсткий шаблон для обязательного `send_partner_note(...)`
  - проверить, хватает ли текущего notice без лишнего шума
  - при необходимости сократить frontmatter note ещё сильнее

- [ ] Подумать над следующей итерацией `Collab` UX:
  - нужен ли delivery history screen
  - нужен ли manual retry для failed delivery
  - нужен ли отдельный просмотр последних `Ask / Share / File`

- [ ] Подумать над policy для `Live` approval:
  - one-shot approve only
  - remember approve for session/member/project
  - revoke existing approval policy

- [ ] Дочистить operational logs:
  - оставить только полезные lifecycle logs
  - убрать оставшийся шум из стабильных happy-path маршрутов

- [ ] Решить, нужен ли полноценный `RabbitMQ` queue flow поверх fanout:
  - retry / backoff
  - DLQ
  - offline delivery beyond DB backlog
