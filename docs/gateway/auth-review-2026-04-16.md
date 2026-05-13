# Анализ backend-авторизации

Дата: 2026-04-16

## Область анализа

Проверены:

- `src/services/core/auth`
- `src/services/core/api`
- `src/lib`
- связанные места, где используется `ctx.meta.user`, session-based auth и object access

## Текущая схема авторизации

Сейчас авторизация построена как смесь нескольких подходов:

1. Keycloak используется как внешний OIDC-провайдер.
2. После login/callback access token, refresh token и user profile сохраняются в server-side session через `express-session`.
3. Сессия хранится в Redis через `connect-redis`.
4. Поверх session-cookie используется дополнительный `pop` cookie через самописный PoP-механизм.
5. HTTP и GraphQL используют `onBeforeCall`, который прокидывает `$session`, `$request`, `$response`, `$cookies` и `ctx.meta.user`.
6. GraphQL subscriptions работают отдельным потоком и читают пользователя напрямую из Redis по `sid`.

Ключевые точки истины сейчас:

- `ctx.meta.$session.token`: `access_token`, `refresh_token`, `id_token`, expiry
- `ctx.meta.$session.user`: профиль пользователя из Keycloak
- `ctx.meta.$session.sessionData`: `createdAt`, `lastActivity`, `rememberMe`, `trusted`, `deviceFingerprint`
- `ctx.meta.user`: runtime-копия пользователя из session
- `AuthMixin`: object access, groups/roles checks

## Основные проблемы

### 1. Отключена TLS-проверка и есть небезопасные дефолты секретов

Риски:

- глобально отключена проверка TLS;
- для `SESSION_SECRET` и `TOKEN_BINDING_SECRET` оставлены небезопасные fallback-значения.

Последствия:

- возможен MITM при обращениях к внешним auth endpoints;
- можно случайно запустить production-like среду в небезопасной конфигурации.

Файлы:

- `back/src/moleculer.config.ts:41`
- `back/src/services/core/api/mixins/session.ts:149`
- `back/src/lib/tokenBinder.ts:10`

### 2. HTTP gateway не является реальной точкой аутентификации

Сейчас:

- `authentication: false`
- `authorization: false`
- `whitelist: ["**"]`
- `authenticate()` и `authorize()` в `api.service.ts` пустые

Последствия:

- защита держится только на локальных service hooks;
- если action забыли прикрыть хуком, он будет доступен без централизованной проверки;
- auth boundary размазан по сервисам.

Файлы:

- `back/src/services/core/api/api.routes.ts:25`
- `back/src/services/core/api/api.routes.ts:29`
- `back/src/services/core/api/api.service.ts:94`

### 3. WebSocket/subscription auth слишком доверяет `sid`

Сейчас backend:

- возвращает `sid` из `userinfo`;
- затем принимает `sid` в `connectionParams` для GraphQL subscriptions;
- читает пользователя из Redis без дополнительной проверки PoP/cookie/session ownership.

Последствия:

- утечка `sid` эквивалентна подписке от имени другого пользователя;
- subscription auth живет по отдельному, более слабому контракту.

Файлы:

- `back/src/services/core/auth/kc.service.ts:381`
- `back/src/services/core/api/mixins/apollo.ts:124`
- `back/src/services/core/api/mixins/apollo.ts:138`

### 4. OAuth callback реализован без `session.regenerate()` и без PKCE

Сейчас:

- callback пишет auth-данные в существующую session;
- `state` генерируется через `Math.random()`;
- PKCE не используется.

Последствия:

- повышенный риск session fixation;
- криптографическая стойкость state хуже, чем должна быть;
- flow слабее типового server-side OIDC implementation.

Файлы:

- `back/src/services/core/auth/kc.service.ts:100`
- `back/src/services/core/auth/kc.service.ts:401`

## 5. Refresh/session lifecycle реализованы с дефектами

### Ошибка единиц времени при refresh

Сейчас:

- `token.expires_at` хранится в миллисекундах;
- `bufferTime` считается в секундах;
- сравнение идет напрямую.

Последствия:

- рефреш выполняется позднее ожидаемого;
- есть риск гонок на почти истекшем access token.

Файл:

- `back/src/services/core/api/mixins/session.ts:270`

### Ошибки в ветке `kcauth.refresh`

Сейчас:

- при некоторых ошибках action возвращает объект ошибки как value, а не бросает исключение;
- вызывающий код может трактовать refresh как успешный.

Последствия:

- нестабильное поведение auth-flow;
- сложнее гарантировать корректный logout/invalidation после ошибки refresh.

Файл:

- `back/src/services/core/auth/kc.service.ts:257`

### Sliding session обновляет не то поле

Сейчас:

- в `onBeforeCall` обновляется `ctx.meta.$session.lastActivity`;
- проверки idle timeout смотрят на `ctx.meta.$session.sessionData.lastActivity`.

Последствия:

- пользователь может быть активен, но логика сочтет session idle;
- фактический контракт session lifecycle расходится с ожидаемым.

Файлы:

- `back/src/services/core/api/mixins/session.ts:253`
- `back/src/services/core/api/mixins/session.ts:309`

### Ошибки в `rememberMe` / `trustDevice`

Сейчас:

- `cookie.maxAge` местами задается в секундах, а `express-session` ожидает миллисекунды;
- в `trustDevice` используется `ctx.meta.session.cookie.maxAge` вместо `ctx.meta.$session.cookie.maxAge`.

Последствия:

- срок жизни cookie может выставляться неверно;
- `trustDevice` содержит явный runtime bug.

Файлы:

- `back/src/services/core/auth/kc.service.ts:121`
- `back/src/services/core/auth/kc.service.ts:293`

### 6. Самописный PoP-механизм недореализован

Сейчас:

- TTL PoP-токена при проверке не используется;
- nonce не валидируется;
- cookie живет до 2 лет;
- fingerprint зависит от IP/User-Agent и может быть нестабилен.

Последствия:

- защита от replay по сути отсутствует;
- механизм добавляет хрупкость, но не дает надежной криптографической гарантии;
- возможны ложные logout/invalid session при смене IP/headers.

Файлы:

- `back/src/lib/tokenBinder.ts:22`
- `back/src/lib/tokenBinder.ts:61`
- `back/src/services/core/api/mixins/session.ts:45`
- `back/src/services/core/api/mixins/session.ts:68`

### 7. Контракт `roles/groups` и object access не нормализован

Сейчас:

- `AuthMixin` ожидает массивы `groups`/`roles`;
- доступы в БД местами сохраняются как `JSON.stringify(...)`;
- при чтении не видно нормализации обратно в массивы;
- часть логики опирается на `ctx.meta.user`, часть на ad-hoc access tables.

Последствия:

- высок риск тихих ошибок в access checks;
- поведение access layer зависит от формата, пришедшего из БД.

Файлы:

- `back/src/lib/mixins/auth.ts:38`
- `back/src/lib/mixins/auth.ts:165`
- `back/src/services/core/sys/ui.service.ts:84`

### 8. Ошибки авторизации превращаются в `502`

Сейчас:

- `BackendError` сохраняется как есть;
- обычный `Error` в глобальном `errorHandler` конвертируется в `502`.

Последствия:

- ошибки access/auth теряют корректную HTTP/GraphQL-семантику;
- клиенту и фронту сложнее отличать `401`, `403` и реальные backend failures.

Файл:

- `back/src/moleculer.config.ts:188`

### 9. Нет тестового контура auth-flow

По коду не видно тестов на:

- login/callback
- token refresh
- idle timeout
- logout/session destroy
- GraphQL subscription auth
- object access / groups / roles

Последствия:

- любые изменения в auth-слое рискованны;
- регрессии будут всплывать только интеграционно или в production-like среде.

## Важные наблюдения для дальнейшей разработки

### Auth boundary сейчас размазан

Аутентификация распределена между:

- `api.routes.ts` / `onBeforeCall`
- hooks `refreshToken` / `requireActiveToken`
- `kcauth.*`
- GraphQL subscription handshake

Это усложняет расширение системы: любая новая auth-фича должна учитывать сразу несколько путей.

### Сейчас смешаны 3 модели

Фактически проект одновременно использует:

- session-based auth
- token-based auth
- самописный token binding через `pop`

Пока не выбрана одна опорная модель, auth-слой будет расти как набор частных исключений.

### `ctx.meta.user` является критическим контрактом

На него опираются:

- subscriptions filters
- object access
- часть sys/core сервисов
- UI access checks

Значит дальнейшая разработка должна явно зафиксировать:

- кто и когда наполняет `ctx.meta.user`
- какой у него shape
- какие поля обязательны
- как он синхронизируется с Keycloak claims

## Базовый контекст для следующего этапа разработки

Ниже то, что стоит считать опорными решениями перед внедрением новых auth-функций.

## Уточненный целевой контракт

Ниже зафиксирована ожидаемая модель авторизации, которую нужно считать целевой для дальнейшей разработки.

### Login flow

1. Клиент инициирует авторизацию через `/api/auth/login`.
2. Backend делает redirect в Keycloak.
3. Пользователь проходит авторизацию в Keycloak.
4. После callback backend создает и сохраняет server-side session в Redis.
5. Клиенту отдаются только cookie с `sid` и `pop`.
6. Дальнейшее взаимодействие front-back идет только через эти cookie, без отдельной работы фронта с bearer/access token.

### Session model

Целевая модель:

- access token и refresh token живут только на backend;
- frontend не должен оперировать access token;
- backend является владельцем session state;
- Redis является primary storage для backend session;
- `sid` и `pop` являются единственными клиентскими auth-артефактами.

### Refresh model

Целевое поведение:

- refresh access token выполняется на backend;
- refresh организован через `onBeforeCall`;
- клиент не участвует в refresh-flow;
- внешний признак истечения auth для клиента определяется только результатом backend-запросов.

### Защита actions

Целевой подход:

- actions защищаются через `hooks.before`;
- базовые проверки: `requireSession`, `requireActiveToken`;
- проверки на роли и группы могут быть реализованы в том же формате, как отдельные auth hooks;
- legacy `AuthMixin` не должен использоваться в новой auth-архитектуре.

Следствие:

- authorization logic должна быть hook-based, а не завязанной на старый mixin и object access слой.

### Frontend auth contract

Признак авторизованности пользователя со стороны фронта:

- успешный запрос к `query me` и получение пользователя;
- если `me` возвращает `null`, пользователь считается неавторизованным.

Следствие:

- backend должен уметь безопасно и предсказуемо отдавать `null` для неавторизованного клиента там, где это часть frontend-контракта;
- frontend не должен делать вывод об авторизации по локальному состоянию токенов.

## Что это меняет относительно исходного анализа

После уточнения требований ряд выводов нужно трактовать так:

- session-based auth через Redis является не временным компромиссом, а целевой основой;
- `onBeforeCall` должен стать центральной точкой refresh/session lifecycle;
- hook-based guards являются целевым способом защиты actions;
- legacy `AuthMixin` не нужно развивать;
- `query me` является canonical frontend probe для определения auth state.

При этом остаются актуальными критичные замечания:

- безопасность cookie/session boundary;
- корректность refresh в `onBeforeCall`;
- надежность схемы `sid + pop`;
- корректность subscription auth;
- корректная семантика `401/403/null`;
- нормализация контрактов `ctx.meta.user`, session и auth hooks.

### 1. Нужна одна основная auth-модель

После уточнения требований выбор фактически сделан:

- целевая модель: полноценная server-side session модель;
- access token и refresh token живут только на backend;
- фронт работает только через cookie-bound session;
- любые дополнительные механизмы должны подчиняться этой модели, а не конкурировать с ней.

Текущий гибридный слой все еще стоит считать технически нестабильным в тех местах, где он расходится с этой целью.

### 2. Нужен единый authentication layer

HTTP, GraphQL и subscriptions должны использовать один и тот же контракт:

- извлечение identity;
- проверка session/token;
- нормализация `ctx.meta.user`;
- единые коды ошибок.

### 3. Нужно нормализовать authorization layer

Нужно централизовать:

- object access
- groups / roles
- формат хранения access rules
- маппинг Keycloak claims -> internal permissions model

### 4. Ошибки доступа должны быть семантически корректными

Нужно четко разделить:

- `401 Unauthorized` / unauthenticated
- `403 Forbidden` / authenticated but denied
- `5xx` / инфраструктурные или backend failures

### 5. Security-blockers лучше закрыть до расширения auth-flow

Минимальный обязательный набор:

- вернуть TLS verification;
- убрать insecure defaults для секретов;
- добавить `session.regenerate()` после успешного callback;
- пересобрать subscription auth без доверия к открытому `sid`;
- исправить refresh/session lifetime bugs;
- решить, нужен ли вообще текущий PoP-механизм.

## Рекомендуемый порядок работ

### Quick wins

- исправить баги единиц времени;
- исправить `trustDevice`;
- привести auth-errors к `401/403`;
- убрать возврат ошибок как value из `kcauth.refresh`.

### Обязательные security fixes

- включить TLS verification;
- убрать небезопасные секреты по умолчанию;
- добавить regeneration session после login callback;
- пересмотреть subscription auth;
- либо довести PoP до рабочей схемы, либо удалить.

### Архитектурный этап

- определить целевую auth-модель;
- зафиксировать shape `ctx.meta.user`;
- централизовать auth boundary;
- нормализовать access tables и формат `groups/roles`.

### Тестовый этап

- покрыть login/callback;
- покрыть refresh и idle timeout;
- покрыть logout/session invalidation;
- покрыть subscriptions auth;
- покрыть object access.

## Итог

Текущее состояние backend-авторизации можно использовать как рабочую основу, но не как устойчивую платформу для безопасного развития auth-функций без предварительной стабилизации. Основные проблемы лежат не в одном конкретном сервисе, а в отсутствии единого auth boundary, в смешении нескольких моделей авторизации и в нескольких прямых security/consistency дефектах.

Этот документ стоит использовать как baseline перед следующим этапом: уточнением целевого сценария авторизации и планированием рефакторинга под него.
