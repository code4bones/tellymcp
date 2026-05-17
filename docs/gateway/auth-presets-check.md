# Auth Presets Check

Дата: 2026-04-17

## Назначение

Этот документ нужен для двух задач:

- быстро проверить короткую backend-session без `offline_access`;
- безопасно вернуть систему обратно на `Preset A`.

## Где что настраивается

Backend:

- env переменная `SESSION_PRESET`
- код пресетов: [session_presets.ts](../src/services/core/api/mixins/session_presets.ts)

Keycloak 26.5.2:

- `Realm settings -> Sessions`
- `Realm settings -> Tokens`
- `Clients -> app -> Settings`
- `Clients -> app -> Login settings`
- `Clients -> app -> Client scopes`
- `Clients -> app -> Advanced`

## Быстрая проверка короткой сессии

Цель:

- убедиться, что без `offline_access` backend живет только на обычном refresh token;
- если пользователь ничего не делает и окно refresh/session истекает, следующая проверка `me` отправляет его на повторный login.

### 1. Включить короткий backend preset

На backend:

- установить `SESSION_PRESET=SHORT_NO_OFFLINE`
- перезапустить backend

Что делает этот preset:

- backend не запрашивает `offline_access` на `/api/auth/login`
- backend не шлет `scope=offline_access` при refresh
- session живет только на обычном refresh token

Базовые значения preset сейчас:

- `ACCESS_TOKEN_LIFETIME = 5m`
- `REFRESH_TOKEN_LIFETIME = 8h`
- `MAX_SESSION_LIFETIME = 8h`
- `POP_TOKEN_LIFETIME = 8h`
- `IDLE_TIMEOUT = 8h`

Для очень быстрого теста можно временно ужать значения в [session_presets.ts](../src/services/core/api/mixins/session_presets.ts):

- `ACCESS_TOKEN_LIFETIME = 1m`
- `REFRESH_TOKEN_LIFETIME = 5m`
- `MAX_SESSION_LIFETIME = 5m`
- `POP_TOKEN_LIFETIME = 5m`
- `IDLE_TIMEOUT = 5m`

Это удобно именно для dev-проверки, чтобы не ждать часы.

### 2. Временно настроить Keycloak под короткий сценарий

#### Realm settings -> Sessions

Поставить:

- `SSO Session Idle = 3m` или `5m`
- `SSO Session Max = 5m` или `10m`
- `Client Session Idle = 0`
- `Client Session Max = 0`

Важно:

- `Offline Session Idle` и `Offline Session Max Limited` в этом сценарии не используются, потому что backend не запрашивает `offline_access`

#### Realm settings -> Tokens

Поставить:

- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 1m` или `5m`
- `Client login timeout = 5m`
- `Login timeout = 10m`
- `Login action timeout = 5m`

#### Clients -> app -> Settings

Проверить:

- `Client authentication = ON`
- `Standard Flow Enabled = ON`
- `Direct Access Grants = OFF`
- `Implicit Flow Enabled = OFF`
- `Consent Required = OFF`

#### Clients -> app -> Advanced

Проверить:

- `Proof Key for Code Exchange Code Challenge Method = S256`

#### Clients -> app -> Client scopes

Минимальный вариант:

- можно ничего не менять
- backend сам не будет запрашивать `offline_access`

Строгий вариант для чистого теста:

- временно убрать `offline_access` из client scope policy для клиента `app`

Если нужен максимально чистый тест, лучше использовать строгий вариант.

### 3. Проверить, что offline token реально не выдан

После нового login проверить Redis session.

Ожидается:

- `scope` не содержит `offline_access`
- `refresh_token` не имеет `typ = "Offline"`
- `refresh_expires_in` должен быть обычным конечным значением, а не `0`

Если в Redis по-прежнему видно:

- `offline_access` в `scope`
- `typ = "Offline"`

значит short-session тест невалиден, и Keycloak все еще выдает offline token.

### 4. Проверить руками сам сценарий

Порядок:

1. Залогиниться.
2. Сразу сделать `me` или открыть приложение.
3. Через `70-90 секунд` снова сделать `me`.
4. Потом не делать ничего дольше `SSO Session Idle`.
5. После этого снова вызвать `me`.

Ожидаемое поведение:

- до истечения короткого окна refresh работает;
- после выхода из окна бездействия refresh не проходит;
- backend уничтожает локальную session;
- frontend редиректит на `LOGIN_URL`.

## Как вернуть все обратно на Preset A

### 1. Вернуть backend

На backend:

- установить `SESSION_PRESET=A`
- если временно менялись числа в `SHORT_NO_OFFLINE`, вернуть их обратно или откатить локальные dev-правки
- перезапустить backend

После этого backend снова работает как long-session policy:

- `Redis TTL = 90d`
- `session cookie = 90d`
- `PoP TTL = 90d`
- `IDLE_TIMEOUT = 90d`
- `MAX_SESSION_LIFETIME = 90d`
- `USE_OFFLINE_ACCESS = true`

### 2. Вернуть Keycloak для Preset A

#### Realm settings -> Sessions

Поставить:

- `SSO Session Idle = 8h`
- `SSO Session Max = 30d`
- `SSO Session Idle Remember Me = 0` или не использовать
- `SSO Session Max Remember Me = 0` или не использовать
- `Client Session Idle = 0`
- `Client Session Max = 0`
- `Offline Session Idle = 90d`
- `Offline Session Max Limited = OFF`

Если у вас ранее включался `Offline Session Max Limited = ON`, его нужно выключить.

#### Realm settings -> Tokens

Поставить:

- `Revoke Refresh Token = ON`
- `Access Token Lifespan = 5m`
- `Client login timeout = 5m`
- `Login timeout = 10m`
- `Login action timeout = 5m`

#### Clients -> app -> Settings

Проверить:

- `Client authentication = ON`
- `Standard Flow Enabled = ON`
- `Direct Access Grants = OFF`
- `Implicit Flow Enabled = OFF`
- `Consent Required = OFF`

#### Clients -> app -> Login settings

Проверить:

- `Valid Redirect URIs` содержит только backend callback
- `Web Origins` содержит только реальные frontend origins

#### Clients -> app -> Client scopes

Вернуть рабочее состояние:

- `offline_access` снова доступен клиенту `app`
- пользователь должен иметь право на `offline_access`

#### Clients -> app -> Advanced

Проверить:

- `Proof Key for Code Exchange Code Challenge Method = S256`

### 3. Проверить, что система снова в long-session режиме

После нового login проверить Redis session.

Ожидается:

- `scope` содержит `offline_access`
- `refresh_token` имеет `typ = "Offline"`
- `refresh_expires_in = 0`
- Redis TTL около `90d`
- `session cookie maxAge = 90d`
- `pop.ttl = 90d`

## Короткий итог

Для быстрой проверки short-session важны 3 признака:

- `SESSION_PRESET=SHORT_NO_OFFLINE`
- backend не запрашивает `offline_access`
- в Redis после login нет `Offline` refresh token

Для возврата в рабочий long-session режим важны 3 признака:

- `SESSION_PRESET=A`
- Keycloak снова разрешает и выдает `offline_access`
- в Redis после login снова появляется `refresh_token` с `typ = "Offline"`
