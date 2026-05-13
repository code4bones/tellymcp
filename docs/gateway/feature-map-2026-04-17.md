# Feature Map

Этот документ фиксирует текущее состояние проекта после серии работ по `auth`, `front`, `VFS/MinIO`, `ACL`, `Tools` и `Develop`.

Цель документа:
- быстро понять, какие фичи уже есть;
- где лежит код;
- как front и back связаны между собой;
- где безопасно продолжать разработку.

## 1. Общая карта

Система сейчас состоит из 5 основных блоков:

1. `Auth + session`
   Front работает только через backend-session (`sid + pop` cookies), без хранения access/refresh token на клиенте.

2. `Files`
   Это VFS-обертка над MinIO. Пользователь видит дерево каталогов и файлы через `storage.nodes`, а физическое хранилище файлов находится в MinIO.

3. `Tools`
   Это внутренний dev/admin toolbox поверх backend `devtools` service. Здесь живут инспекторы, action-runner и утилиты для данных.

4. `Develop`
   Экспериментальная зона для feature-lab. Сейчас там реализован OpenSeadragon workflow поверх VFS/MinIO tiles.

5. `GraphQl`
   Главная страница фронта. Открывается backend GraphQL sandbox через `iframe`.

## 2. Основные роуты фронта

Файл:
- [front/src/app/router/router.tsx](../../front/src/app/router/router.tsx)

Текущие маршруты:
- `/` -> `GraphQl`
- `/files` -> файловый менеджер VFS/MinIO
- `/tools` -> набор внутренних инструментов
- `/develop` -> develop/lab pages
- `/profile` -> профиль пользователя
- `/login` -> техническая страница входа

Все защищенные страницы идут через:
- `AuthGate`
- `ProtectedRoute`

Файлы:
- [front/src/features/auth/ui/AuthGate.tsx](../../front/src/features/auth/ui/AuthGate.tsx)
- [front/src/features/auth/ui/ProtectedRoute.tsx](../../front/src/features/auth/ui/ProtectedRoute.tsx)

## 3. Shell и навигация

Файл:
- [front/src/widgets/app-shell/ui/AppShell.tsx](../../front/src/widgets/app-shell/ui/AppShell.tsx)

Что делает:
- рисует top navigation:
  - `GraphQl`
  - `Files`
  - `Tools`
  - `Develop`
- показывает user dropdown вместо отдельной кнопочной зоны справа
- dropdown содержит:
  - `Profile`
  - `Theme`
  - `Logout`

Стили shell:
- [front/src/styles.css](../../front/src/styles.css)

Тема:
- `dark/light`, default = `dark`
- управляется через:
  - [front/src/features/theme/model/ThemeProvider.tsx](../../front/src/features/theme/model/ThemeProvider.tsx)
  - [front/src/features/theme/model/useTheme.ts](../../front/src/features/theme/model/useTheme.ts)

## 4. Auth / session model

Актуальная модель:
- login/logout идут только через backend endpoints
- frontend не владеет access token
- признак авторизации на фронте: успешный `me`
- если `me` возвращает ошибку или `null`, фронт уходит на backend login

Фронтовые точки:
- [front/src/features/auth/model/useAuth.ts](../../front/src/features/auth/model/useAuth.ts)
- [front/src/features/auth/ui/AuthGate.tsx](../../front/src/features/auth/ui/AuthGate.tsx)
- [front/src/shared/lib/auth/redirects.ts](../../front/src/shared/lib/auth/redirects.ts)

Важные env на фронте:
- `VITE_LOGIN_URL`
- `VITE_LOGOUT_URL`
- `VITE_AUTH_ME_POLL_INTERVAL_MS`

Backend auth/session:
- [back/src/services/core/auth/kc.service.ts](../src/services/core/auth/kc.service.ts)
- [back/src/services/core/api/mixins/session.ts](../src/services/core/api/mixins/session.ts)
- [back/src/services/core/api/mixins/session_presets.ts](../src/services/core/api/mixins/session_presets.ts)

Что уже реализовано на backend:
- server-side session в Redis
- PKCE
- logout через backend-held refresh/offline token
- PoP cookie
- session presets
- single-flight refresh, чтобы параллельные запросы не ломали refresh rotation

Документы по auth:
- [auth-review-2026-04-16.md](./auth-review-2026-04-16.md)
- [auth-presets-keycloak-26.5.2.md](./auth-presets-keycloak-26.5.2.md)
- [auth-presets-check.md](./auth-presets-check.md)

## 5. Files = VFS + MinIO + ACL

### Front

Главная страница файлового менеджера:
- [front/src/pages/files/ui/FilesPage.tsx](../../front/src/pages/files/ui/FilesPage.tsx)

Host-страница:
- [FilesPage.tsx](../../front/src/pages/files/ui/FilesPage.tsx)

Пакет:
- `@code4bones/vfs-explorer`
- глобальные стили пакета подключаются в [main.tsx](../../front/src/main.tsx)

Что умеет `VfsExplorer`:
- resizable split layout
- lazy tree loading через `vfsNode`
- правая панель с содержимым каталога
- нижний inspector/info panel
- CRUD каталогов
- upload файлов в текущую папку
- preview файлов
- сохранение layout в `localStorage`
- сохранение текущего состояния:
  - scope
  - текущий каталог
  - выбранный узел
- ACL dialog
- ACL Index dialog
- badges `🌐 / 🔒 / 🔐`
- переход в `Tools` inspectors из `Info`

Поддерживающие файлы:
- [front/src/shared/api/graphql/vfs.ts](../../front/src/shared/api/graphql/vfs.ts)
- [front/src/entities/vfs/model/types.ts](../../front/src/entities/vfs/model/types.ts)
- [front/src/shared/lib/vfs/storageRef.ts](../../front/src/shared/lib/vfs/storageRef.ts)

### Backend

Ключевые сервисы:
- [back/src/services/core/sys/vfs.service.ts](../src/services/core/sys/vfs.service.ts)
- [back/src/services/core/sys/minio.service.ts](../src/services/core/sys/minio.service.ts)

Текущая логика:
- `storage.nodes` — логическая VFS-структура
- `hash` для `FILE` в VFS = `storageRef` MinIO
- обычные user uploads физически лежат в MinIO
- имя, которое видит пользователь, живет в VFS
- физический object key в MinIO отделен от пользовательского имени
- внешняя выдача файла идет по `public_url`, а не по `storageRef`
- `node_id` остается внутренним идентификатором VFS и служебных GraphQL/mutation-операций

Главные route'ы:
- `POST /api/storage/ingest`
- `GET /api/storage/file/:publicUrl`
- `GET /api/tiles/vfs/:publicUrl/*`

### Текущая модель доступа

- `public`:
  - свободный `read/list`
- `private`:
  - доступен авторизованному пользователю
- ACL rules:
  - используются для точечной настройки доступа на конкретных каталогах и файлах
- `inherit`:
  - наследует visibility от родителя

Отдельные bypass:
- owner bypass:
  - владелец узла (`nodes.sub`) всегда сохраняет доступ
- VFS admin bypass:
  - `VFS_ADMIN_ROLES`
  - `VFS_ADMIN_GROUPS`
  - fallback на:
    - `MINIO_ADMIN_ROLES`
    - `MINIO_ADMIN_GROUPS`

### Visibility / ACL

В `storage.nodes`:
- `visibility`

В отдельной таблице:
- `storage.node_acl`

GraphQL / backend умеют:
- смотреть локальный ACL узла
- менять ACL узла
- менять visibility узла
- строить индекс узлов с ACL
- строить индекс правил

### Важные детали

- удаление узла VFS каскадно удаляет:
  - дочерние `nodes`
  - связанные MinIO objects
- `vfsDeleteNode` возвращает уже гидратированные удаленные узлы
- `vfsGetIdsToNode` возвращает `[]`, если узел уже удален
- deep-tree и любые узлы, вставленные напрямую в БД, должны иметь корректный `host`, иначе резолвер `children` и счетчики будут вести себя некорректно

Контекст по MinIO/VFS:
- [minio-vfs-context-2026-04-17.md](./minio-vfs-context-2026-04-17.md)
- ACL/manual tests:
  - [acl-testing-2026-04-17.md](./acl-testing-2026-04-17.md)
- user guide:
  - [files-user-guide-2026-04-17.md](./files-user-guide-2026-04-17.md)

## 6. DB init / schema bootstrap

DDL больше не инициализируется backend-сервисом.

Текущий источник истины:
- [deploy/postgres-init/010_storage_schema.sql](../../deploy/postgres-init/010_storage_schema.sql)
- [deploy/scripts/refresh-storage-schema.sh](../../deploy/scripts/refresh-storage-schema.sh)

Что это дает:
- схема `storage` поднимается стандартным PostgreSQL init flow
- backend не зависит от `INIT_DB_DIR` и не исполняет SQL при старте
- deploy и локальный docker stack используют один и тот же bootstrap

## 7. Tools

Страница:
- [front/src/pages/tools/ui/ToolsPage.tsx](../../front/src/pages/tools/ui/ToolsPage.tsx)
- [front/src/pages/tools/ui/ToolsPage.css](../../front/src/pages/tools/ui/ToolsPage.css)

Общие стили:
- [front/src/features/tools-common/ui/ToolsWorkbench.css](../../front/src/features/tools-common/ui/ToolsWorkbench.css)

### 7.1 Структура групп

Сейчас `Tools` разбит на:

- `API`
  - `Services`
  - `Action Runner`
- `Storage`
  - `VFS Inspector`
  - `MinIO Inspector`
- `Data`
  - `JWT`
  - `Base64`
  - `Base64url`
  - `JSON`
  - `JSON Diff`
  - `URL`
  - `URL Builder`
  - `Hash`
  - `Regex`
  - `Unix Time`
  - `UUID`
- `System`
  - `Session`
  - `Env`

### 7.2 Backend source for Tools

Все server-side данные для `Tools` идут через:
- [back/src/services/core/sys/devtools.service.ts](../src/services/core/sys/devtools.service.ts)

Текущие GraphQL endpoints:
- `devtoolsServices`
- `devtoolsRunAction`
- `devtoolsCurrentMeta`
- `devtoolsSessionInspect`
- `devtoolsVfsInspect`
- `devtoolsMinioInspect`
- `devtoolsEnv`

Фронтовые GraphQL queries:
- [front/src/shared/api/graphql/devtools.ts](../../front/src/shared/api/graphql/devtools.ts)

### 7.3 Реализованные инструменты

API:
- [front/src/features/tools-api-services/ui/ServicesExplorerTool.tsx](../../front/src/features/tools-api-services/ui/ServicesExplorerTool.tsx)
- [front/src/features/tools-api-runner/ui/ActionRunnerTool.tsx](../../front/src/features/tools-api-runner/ui/ActionRunnerTool.tsx)

Storage:
- [front/src/features/tools-vfs/ui/VfsInspectorTool.tsx](../../front/src/features/tools-vfs/ui/VfsInspectorTool.tsx)
- [front/src/features/tools-minio/ui/MinioInspectorTool.tsx](../../front/src/features/tools-minio/ui/MinioInspectorTool.tsx)

System:
- [front/src/features/tools-auth/ui/SessionInspectorTool.tsx](../../front/src/features/tools-auth/ui/SessionInspectorTool.tsx)
- [front/src/features/tools-system/ui/EnvViewerTool.tsx](../../front/src/features/tools-system/ui/EnvViewerTool.tsx)

Data:
- [front/src/features/tools-base64/ui/Base64Tool.tsx](../../front/src/features/tools-base64/ui/Base64Tool.tsx)
- [front/src/features/tools-data/ui/Base64UrlTool.tsx](../../front/src/features/tools-data/ui/Base64UrlTool.tsx)
- [front/src/features/tools-jwt/ui/JwtDecoderTool.tsx](../../front/src/features/tools-jwt/ui/JwtDecoderTool.tsx)
- [front/src/features/tools-json/ui/JsonViewerTool.tsx](../../front/src/features/tools-json/ui/JsonViewerTool.tsx)
- [front/src/features/tools-data/ui/JsonDiffTool.tsx](../../front/src/features/tools-data/ui/JsonDiffTool.tsx)
- [front/src/features/tools-url/ui/UrlDecoderTool.tsx](../../front/src/features/tools-url/ui/UrlDecoderTool.tsx)
- [front/src/features/tools-data/ui/UrlBuilderTool.tsx](../../front/src/features/tools-data/ui/UrlBuilderTool.tsx)
- [front/src/features/tools-data/ui/HashTool.tsx](../../front/src/features/tools-data/ui/HashTool.tsx)
- [front/src/features/tools-data/ui/RegexTool.tsx](../../front/src/features/tools-data/ui/RegexTool.tsx)
- [front/src/features/tools-data/ui/UnixTimeTool.tsx](../../front/src/features/tools-data/ui/UnixTimeTool.tsx)
- [front/src/features/tools-data/ui/UuidTool.tsx](../../front/src/features/tools-data/ui/UuidTool.tsx)

### 7.4 Persist state в Tools

Есть 2 механизма:

1. Redux-backed persist для базовых старых tool states
   - [front/src/features/tools/model/slice.ts](../../front/src/features/tools/model/slice.ts)
   - [front/src/features/tools/model/selectors.ts](../../front/src/features/tools/model/selectors.ts)
   - [front/src/features/tools/model/storage.ts](../../front/src/features/tools/model/storage.ts)
   - [front/src/app/store/store.ts](../../front/src/app/store/store.ts)

2. `localStorage` hook для новых tools
   - [front/src/features/tools/model/usePersistentToolState.ts](../../front/src/features/tools/model/usePersistentToolState.ts)

Практически:
- значения не сбрасываются при переключении tool tabs
- значения сохраняются после reload страницы

## 8. Develop

Страница:
- [front/src/pages/develop/ui/DevelopPage.tsx](../../front/src/pages/develop/ui/DevelopPage.tsx)

Сейчас в `Develop` реализован OpenSeadragon lab.

Пакет аннотаций и zoom controls:
- `@code4bones/osd`

Host runtime-shell:
- [OpenSeadragonLab.tsx](../../front/src/features/develop-openseadragon/ui/OpenSeadragonLab.tsx)
- [OpenSeadragonLab.css](../../front/src/features/develop-openseadragon/ui/OpenSeadragonLab.css)

Host-страница:
- [DevelopPage.tsx](../../front/src/pages/develop/ui/DevelopPage.tsx)

Как это связано:
- пользователь выбирает обычный файл из VFS
- backend mutation `slice(nodeId)` режет его на tiles
- tiles кладутся в MinIO
- host shell открывает viewer, а preset toolbar / selector / inspector / zoom navigator приходят из `@code4bones/osd`
- OpenSeadragon получает `dziUrl` на backend route `/api/tiles/vfs/:publicUrl/source.dzi`

Backend-связка:
- [back/src/services/core/sys/minio.service.ts](../src/services/core/sys/minio.service.ts)

## 9. GraphQl

Главная страница фронта:
- [front/src/pages/home/ui/HomePage.tsx](../../front/src/pages/home/ui/HomePage.tsx)
- [front/src/pages/graphql/ui/GraphQlPage.tsx](../../front/src/pages/graphql/ui/GraphQlPage.tsx)

Текущее решение:
- не локальный GraphiQL
- а `iframe` на backend sandbox

Причина:
- меньше frontend bundle
- backend sandbox уже существует и не дублируется на клиенте

## 10. Profile

Страница:
- [front/src/pages/profile/ui/ProfilePage.tsx](../../front/src/pages/profile/ui/ProfilePage.tsx)

Сейчас там:
- профиль пользователя
- access summary
- `sessionInfo`

Важное замечание:
- `Profile` больше не в верхней навигации
- попасть туда можно через user dropdown в header

## 11. Важные связи между фичами

### Files -> Tools

Из `Files` можно открыть:
- `VFS Inspector`
- `MinIO Inspector`

Это сделано через persisted state в `localStorage`, который заполняется из `Files -> Info`.

### Tools -> backend

Практически весь прикладной `Tools`-UI опирается на `devtools.service.ts`.

Если добавляется новый backend inspector/tool:
1. новый action/query в `devtools.service.ts`
2. новый GraphQL query в `front/src/shared/api/graphql/devtools.ts`
3. новый tool component
4. регистрация в `ToolsPage.tsx`

### VFS -> MinIO

Логическая модель:
- `storage.nodes` управляет деревом и именами
- `MinIO` хранит содержимое
- `hash` для `FILE` = `storageRef`
- выдача файла наружу идет по `public_url`
- `node_id` остается внутренним идентификатором для VFS state и GraphQL mutations

Если нужно работать с storage на уровне разработчика:
- сначала смотреть в `VFS Inspector`
- потом при необходимости в `MinIO Inspector`

### Session -> Redis

`Tools -> Session` показывает не `sessionInfo`, а реальный snapshot Redis-session плюс decoded token claims.

Это основной инструмент для дебага текущей auth-session.

## 12. Что важно не сломать

1. `Files`
   Не трогать ленивую загрузку дерева через `vfsNode` и не возвращаться к полному `vfsDirTree`.

2. `Session`
   Не уводить auth обратно на frontend token model. Текущий контракт — server-side session.

3. `MinIO`
   Не смешивать обычные uploads и tile storage в одну и ту же схему путей без причины.

4. `Files / ACL`
   Не менять незаметно семантику `private`:
   сейчас это внутренняя зона для авторизованных пользователей, а ACL делает fine-tune на отдельных узлах.

5. `Files / node_id routes`
   Новый UI должен строиться вокруг `node_id`, а не вокруг legacy `hash`-ссылок.

## 13. Логичные точки продолжения

Если следующий агент/разработчик продолжает работу, самые логичные направления:

1. `Files`
   Доделывать DnD, context menu, bulk actions, richer preview.

2. `Tools`
   Добавлять новые backend-aware inspectors и utility tools.

3. `Develop`
   Расширять лаборатории поверх `VFS/MinIO`.

4. `Auth`
   Улучшать диагностику session/preset behavior и operational tooling.

5. `VFS/MinIO`
   Развивать structured asset workflows поверх уже готового storage foundation.
