# TODO

Current state:

- `telegram_mcp` переведён на `Moleculer`.
- MCP работает через `${ROOT_PREFIX}/mcp`.
- Mini App `Live` работает через `${ROOT_PREFIX}/webapp`.
- Локальный `Local` flow работает:
  - pairing
  - link
  - `Передать агенту`
  - local notes через `LOCAL_INDEX.md`
- Remote `Collab` flow работает:
  - projects
  - members
  - `Ask / Share / Reply / Handoff / File`
  - `SHARED_INDEX.md`
  - gateway delivery queue/status/ack/fail
- Exchange files работают через `vfs + minio`.
- Доставка файлов между машинами и между локальными сессиями работает.

Current tails:

- [ ] Переход на `ws + RabbitMQ`:
  - [x] Поднять базовый `ws` control plane между `client` и `gateway`
  - [ ] Перевести `Live relay` с HTTP poll на `ws` request/response
  - [ ] Перевести delivery status/update push на `ws`
  - [ ] Ввести `RabbitMQ` для durable remote delivery:
    - очередь handoff/messages
    - retry / DLQ
    - offline client delivery
  - [ ] Оставить `DB` источником истины для:
    - projects
    - sessions
    - deliveries
    - statuses

- [x] Gateway-relayed `Live View` реализован:
  - Mini App открывается через домен gateway
  - клиентской машине не нужен собственный публичный домен
  - gateway релеит `bootstrap/view/action` до нужного client session

- [ ] Причесать документацию под текущее состояние:
  - `README.md`
  - `TOOLS.md`
  - `docs/DEVELOPMENT.md`
  - убрать устаревшие упоминания `Partner`, `Link`, `SHARE_INDEX.md`, если они ещё где-то остались

- [ ] Пройти полный smoke-pass `Local` flow:
  - `Link`
  - `Ask / Share / Reply / Handoff`
  - `Передать агенту`
  - `LOCAL_INDEX.md`
  - поведение после рестарта сервиса

- [ ] Пройти полный smoke-pass `Collab` flow между машинами:
  - `Create / Join project`
  - `Members`
  - `Ask / Share / Reply / Handoff`
  - `File`
  - sender status:
    - `⏳`
    - `✅`
    - `❌`
  - обработка битого delivery без зацикливания

- [ ] Проверить file lifecycle после handoff:
  - удаление исходного файла после отправки
  - повторная отправка того же файла
  - одинаковые имена файлов
  - dated VFS paths `YYYY-MM-DD/HH-mm-ss`

- [ ] Дочистить логи:
  - убедиться, что poll/status/gateway не шумят в `info`
  - оставить только полезные operational logs

- [ ] Подумать над следующей итерацией UX:
  - нужен ли отдельный экран истории delivery
  - нужен ли просмотр failed deliveries из Telegram
  - нужен ли manual retry для failed delivery
