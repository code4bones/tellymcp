# Keycloak 26.5.2: пресеты и тайминги для backend-session auth

Дата: 2026-04-17

## Контекст

Целевая модель авторизации:

- frontend работает только через `sid + pop` cookies;
- backend хранит session state в Redis;
- access token и refresh token живут только на backend;
- access token обновляется backend-ом через `onBeforeCall`;
- долгоживущая авторизация строится на Keycloak `offline_access`.

Текущий факт по рабочей системе:

- в Redis хранится `refresh_token` с `typ = "Offline"`;
- `scope` содержит `offline_access`;
- `refresh_expires_in = 0`;
- Redis TTL, session cookie и PoP выровнены под `90d`;
- backend использует PKCE `S256`;
- logout на backend завершает и локальную session, и Keycloak-side refresh/offline session.

Это подтверждает, что backend уже использует offline token как основу долгой сессии.

## Что реально определяет длительность сессии

В этой модели срок жизни авторизации определяется не одной настройкой, а связкой:

1. `Offline Session Idle` в Keycloak
2. `Offline Session Max Limited` / `Offline Session Max` в Keycloak
3. TTL Redis-session
4. lifetime session cookie
5. lifetime PoP cookie

Если хотя бы один из этих слоев живет заметно меньше остальных, именно он и становится фактическим лимитом.

## Рекомендуемый базовый пресет

Это основной рекомендуемый режим: долгая backend-session без бессрочной бесконтрольной авторизации.

### Realm Settings -> Sessions

Где настраивать:

- `Realm settings`
- вкладка `Sessions`

Рекомендуемые значения:

- `SSO Session Idle = 8h`
- `SSO Session Max = 30d`
- `SSO Session Idle Remember Me = 0` или не использовать
- `SSO Session Max Remember Me = 0` или не использовать
- `Client Session Idle = 0`
- `Client Session Max = 0`
- `Offline Session Idle = 90d`
- `Offline Session Max Limited = OFF`

Что это означает:

- обычная browser SSO-сессия ограничена;
- backend offline token может жить долго;
- если пользователь не возвращается в систему 90 дней, следующий refresh приведет к необходимости повторного login.

### Realm Settings -> Tokens

Где настраивать:

- `Realm settings`
- вкладка `Tokens`

Рекомендуемые значения:

- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`
- `Access Token Lifespan For Implicit Flow` неважен, если implicit flow не используется
- `Client login timeout = 5m`
- `Login timeout = 10m`
- `Login action timeout = 5m`

Что это означает:

- refresh token ротируется;
- access token короткоживущий;
- backend обязан сохранять новый refresh/offline token после refresh.

### Client -> Settings

Где настраивать:

- `Clients`
- выбрать клиент `app`
- вкладка `Settings`

Рекомендуемые значения:

- `Client authentication = ON`
- `Standard Flow Enabled = ON`
- `Direct Access Grants = OFF`
- `Implicit Flow Enabled = OFF`
- `Authorization Enabled = OFF`, если для этого клиента не используется отдельный authorization services flow
- `Consent Required = OFF`

Что это означает:

- клиент работает как confidential client;
- используется authorization code flow;
- не используются устаревшие или лишние auth-механизмы.

### Client -> Login settings

Где настраивать:

- `Clients`
- выбрать клиент `app`
- вкладка `Login settings`

Рекомендуемые значения:

- `Valid Redirect URIs`: только backend callback URL  
  пример: `https://api.example.com/api/auth/callback`
- `Web Origins`: только frontend origins  
  пример: `https://builder.local`

Принцип:

- не использовать широкие wildcard-значения без необходимости;
- ограничивать только реальными доменами приложения.

### Client -> Client scopes

Где настраивать:

- `Clients`
- выбрать клиент `app`
- вкладка `Client scopes`

Нужно проверить:

- клиенту доступен `offline_access`
- backend запрашивает `scope=offline_access`
- пользователю доступна роль `offline_access`

Признаки корректной настройки:

- в Redis хранится `refresh_token` с `typ = "Offline"`
- в token scope присутствует `offline_access`

### Client -> Advanced

Где настраивать:

- `Clients`
- выбрать клиент `app`
- вкладка `Advanced`

Рекомендуемое значение:

- `Proof Key for Code Exchange Code Challenge Method = S256`

Важно:

- backend уже отправляет `code_challenge` на `/auth/login` и `code_verifier` на `/auth/callback`;
- для этого проекта `PKCE S256` должен быть включен у клиента постоянно.

## Backend: рекомендуемое выравнивание таймингов

Где настраивать:

- backend env: `SESSION_PRESET`
- backend код: [session_presets.ts](../src/services/core/api/mixins/session_presets.ts)
- Redis session store
- session cookie settings
- PoP TTL

Рекомендуемая схема:

- `Redis session TTL = 90d`
- `session cookie maxAge = 90d`
- `PoP TTL = 90d`
- `Keycloak Offline Session Idle = 90d`

Почему так:

- вся система живет по одному числу;
- нет расхождения между browser cookie, Redis и backend session;
- поведение пользователя становится предсказуемым.

## Backend: как теперь выбирается пресет

Где настраивать:

- env переменная `SESSION_PRESET`
- backend файл [session_presets.ts](../src/services/core/api/mixins/session_presets.ts)

Как это работает:

- `SESSION_PRESET=A` используется по умолчанию;
- backend поднимает `SESSION_STRATEGY` из выбранного пресета;
- от него зависят:
  - Redis TTL
  - session cookie `maxAge`
  - PoP TTL
  - idle timeout
  - max session lifetime
  - использование `offline_access` в login/refresh flow

Текущие preset names:

- `A`
- `B`
- `C`
- `SHORT_NO_OFFLINE`

## Практический смысл каждого слоя

### Keycloak Offline Session Idle

Это главный параметр долгой авторизации.

Если пользователь не заходит дольше этого срока, backend не сможет обновить access token, даже если:

- Redis session еще существует
- cookie еще жива
- PoP cookie еще жива

### Redis TTL

Это срок жизни backend session state.

Если Redis key удален раньше, чем живет offline token, пользователь также потеряет сессию, потому что backend больше не знает token set.

### Session cookie maxAge

Это срок, в течение которого браузер вообще присылает `sid`.

Если cookie истекла раньше остальных слоев, backend уже не сможет найти session.

### PoP TTL

Это срок жизни связанного защитного cookie `pop`.

Если он короче session cookie, пользователь начнет терять авторизацию по PoP mismatch раньше истечения session.

## Готовые пресеты

### Preset A: Долгая сессия, но безопасно

Рекомендуется по умолчанию.

Backend:

- `SESSION_PRESET=A`

Keycloak:

- `Offline Session Idle = 90d`
- `Offline Session Max Limited = OFF`
- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`

Backend policy:

- `Redis TTL = 90d`
- `session cookie = 90d`
- `PoP TTL = 90d`
- `IDLE_TIMEOUT = 90d`
- `MAX_SESSION_LIFETIME = 90d`
- `USE_OFFLINE_ACCESS = true`

Когда использовать:

- обычное веб-приложение с удобным persistent login;
- нормальный баланс UX и контроля.

### Preset B: Почти бессрочная сессия

Подходит, если нужен максимально редкий relogin.

Backend:

- `SESSION_PRESET=B`

Keycloak:

- `Offline Session Idle = 180d` или `365d`
- `Offline Session Max Limited = OFF`
- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`

Backend policy:

- `Redis TTL = 180d`
- `session cookie = 180d`
- `PoP TTL = 180d`
- `IDLE_TIMEOUT = 180d`
- `MAX_SESSION_LIFETIME = 180d`
- `USE_OFFLINE_ACCESS = true`

Риск:

- длинная авторизация увеличивает окно жизни украденной session state.

### Preset C: Корпоративный строгий режим

Подходит для более жесткой безопасности.

Backend:

- `SESSION_PRESET=C`

Keycloak:

- `Offline Session Idle = 30d`
- `Offline Session Max Limited = ON`
- `Offline Session Max = 90d`
- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`

Backend policy:

- `Redis TTL = 30d`
- `session cookie = 30d`
- `PoP TTL = 30d`
- `IDLE_TIMEOUT = 30d`
- `MAX_SESSION_LIFETIME = 30d`
- `USE_OFFLINE_ACCESS = true`

Когда использовать:

- корпоративный внутренний сервис;
- повышенные требования к пересогласованию логина.

### Preset SHORT_NO_OFFLINE: Короткая сессия без offline access

Подходит, если нужна обычная короткая веб-сессия без долгоживущего backend login.

Backend:

- `SESSION_PRESET=SHORT_NO_OFFLINE`

Keycloak:

- `Offline Session Idle` не используется этим сценарием
- `Offline Session Max Limited` не влияет на эту схему
- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`
- обычные `SSO Session Idle` и `SSO Session Max` должны соответствовать короткой политике

Рекомендуемые значения в Keycloak:

- `SSO Session Idle = 8h`
- `SSO Session Max = 8h` или `12h`
- `Client Session Idle = 0`
- `Client Session Max = 0`
- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`

Что важно по client scopes:

- backend в этом режиме не запрашивает `offline_access`
- клиенту можно оставить scope доступным, но он не будет использоваться
- если хотите жестко исключить длинные сессии, уберите `offline_access` из client scope policy для этого клиента

Backend policy:

- `Redis TTL = 8h`
- `session cookie = 8h`
- `PoP TTL = 8h`
- `IDLE_TIMEOUT = 8h`
- `MAX_SESSION_LIFETIME = 8h`
- `USE_OFFLINE_ACCESS = false`

Что это означает:

- backend работает только с обычным refresh token
- если пользователь выпал из короткого окна активности и refresh token истек, следующая попытка приведет к relogin
- это режим “обычной короткой сессии”, а не persistent login

## Что уже подтверждено по текущей системе

По текущему Redis session object подтверждено:

- access token живет 300 секунд;
- refresh token является offline token (`typ = "Offline"`);
- `scope` содержит `offline_access`;
- `refresh_expires_in = 0`;
- `refresh_expires_at = 0`;
- Redis TTL фактически около `90d`;
- session cookie и PoP также выровнены на `90d`.

Это значит:

- backend уже способен поддерживать долгую session;
- главный реальный лимит теперь определяется настройками offline session в Keycloak.

## Что нужно проверить отдельно в действующей инсталляции

Перед финальной фиксацией прод-политики нужно проверить:

1. текущее значение `Offline Session Idle`
2. включен ли `Offline Session Max Limited`
3. какое значение у `Offline Session Max`, если ограничение включено
4. включен ли `Revoke Refresh Token`
5. используется ли confidential client
6. включен ли PKCE и готов ли под него backend

## Рекомендуемое целевое состояние для этого проекта

Если делать “правильно” под текущую архитектуру:

### Keycloak

- `Offline Session Idle = 90d`
- `Offline Session Max Limited = OFF`
- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`
- client `Confidential`
- `Standard Flow Enabled = ON`
- `Implicit Flow Enabled = OFF`
- `Direct Access Grants = OFF`
- `PKCE = S256`

### Backend

- `SESSION_PRESET = A`
- `Redis TTL = 90d`
- `session cookie maxAge = 90d`
- `PoP TTL = 90d`
- backend всегда хранит последний refresh/offline token

### Frontend

- только `sid + pop`
- login/logout только через backend endpoints
- auth state определяется через `query me`

## Итог

Для текущей архитектуры именно Keycloak offline access является основой “долгой сессии”. Redis, session cookie и PoP должны быть выровнены под ту же политику, чтобы не создавать неожиданных ранних истечений или ложных logout.

Этот документ следует использовать как baseline перед финальной настройкой realm/client и перед выравниванием backend lifetime-параметров.
