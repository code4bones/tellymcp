# S3 Backend Minimal Blueprint

Документ для случая, когда нужно собрать новый backend на базе текущего, но оставить только:

- S3 / MinIO storage
- VFS-таблицы и файловые ноды
- upload / open / download / preview
- базовую работу с БД

Исключено из этого blueprint:

- `transcoder`
- `migration`
- devtools / tools
- OSD-specific host frontend
- все, что не нужно для обычного файлового сервиса

## 1. Минимальная целевая модель

В минимальном backend файл живет как две связанные сущности:

1. объект в S3-совместимом storage
2. `FILE`-нода в `storage.nodes`

Источник истины разделен так:

- физические байты файла: S3 / MinIO
- имя, дерево, родительская папка, `public_url`, visibility: PostgreSQL `storage.nodes`

Это значит:

- наружу файл открывается по `public_url`
- внутри backend объект ищется по `hash`
- `hash` хранит `storageRef`, а не криптографический digest

## 2. Что обязательно оставить

Для нового сервиса нужен вот этот минимум.

### БД

- схема `storage`
- таблица `storage.nodes`
- таблицы ACL, если хотите сохранить текущую модель доступа

Текущий bootstrap:

- [deploy/postgres-init/010_storage_schema.sql](../../deploy/postgres-init/010_storage_schema.sql)
- [deploy/scripts/refresh-storage-schema.sh](../../deploy/scripts/refresh-storage-schema.sh)

Если нужен именно “чистый S3 backend”, но с каталогами и файлами, `storage.nodes` оставлять обязательно.

### Backend services

- [vfs.service.ts](../src/services/core/sys/vfs.service.ts)
- [minio.service.ts](../src/services/core/sys/minio.service.ts)
- [api.routes.ts](../src/services/core/api/api.routes.ts)
- [vfs.schema.ts](../src/services/core/sys/mixins/vfs/vfs.schema.ts)
- [storage-ref.ts](../src/services/core/sys/mixins/s3/storage-ref.ts)
- [minio.client.ts](../src/services/core/sys/mixins/s3/minio.client.ts)

### Runtime env

Минимально нужны:

- `MINIO_ENDPOINT`
- `MINIO_PORT`
- `MINIO_USE_SSL`
- `MINIO_ACCESS_KEY`
- `MINIO_SECRET_KEY`
- `MINIO_BUCKET`
- `DB_HOST`
- `DB_PORT`
- `DB_USER`
- `DB_PASSWORD`
- `DB_NAME`
- `PORT`

Если нужны backend-session и авторизованный доступ:

- Keycloak/session env
- Redis env

Если новый сервис будет внутренним и без user-session, auth слой можно упрощать отдельно. Этот документ описывает именно storage-core.

## 3. Что можно не переносить

Если цель только “S3 + DB + файлы”, эти части не нужны:

- `back/src/services/features/transcoder/**`
- `back/src/services/features/migration/**`
- OSD-specific tile workflow, если не нужны deep zoom tiles
- devtools service
- s3commander service

Важно: если вы убираете tiles, тогда можно не переносить:

- route `/api/tiles/vfs/:publicUrl/*`
- preview/tile object prefixes, связанные с slicing
- `minioSlice(...)`
- `minioTileInfo(...)`

Но базовые route для обычных файлов остаются.

## 4. Минимальные внешние контракты

Для нового сервиса я бы оставил ровно эти endpoint'ы.

### Upload

```text
POST /api/storage/ingest
```

Это основной и рекомендуемый путь.

Что делает:

1. принимает `multipart/form-data`
2. кладет файл в S3
3. создает `FILE`-ноду в VFS
4. возвращает `node + upload`

Документ:

- [storage-ingest-api-2026-04-17.md](./storage-ingest-api-2026-04-17.md)

### Open inline

```text
GET /api/storage/file/:publicUrl
```

### Download

```text
GET /api/storage/file/:publicUrl?download=1
```

### Preview

```text
GET /api/storage/preview/:publicUrl
GET /api/storage/preview/:publicUrl?size=...
```

Если preview в новом сервисе не нужен, эти route можно убрать вместе с preview generation.

## 5. Минимальные GraphQL операции

Если новый backend сохраняет GraphQL-слой, минимально нужны:

- `vfsScopes`
- `vfsNode`
- `vfsListFiles`
- `vfsCreateDir`
- `vfsCreateFile`
- `vfsRename`
- `vfsMoveNode`
- `vfsDeleteNode`
- `vfsGetIdsToNode`

Если новый сервис будет только REST-only, тогда можно:

- не переносить публичный GraphQL contract целиком
- но логика VFS/MinIO все равно должна остаться внутри backend

## 6. Работа с БД: что важно понять

### `storage.nodes`

Это главная таблица файловой модели.

Ключевые поля:

- `node_id`
- `parent_id`
- `name`
- `type`
- `scope`
- `host`
- `hash`
- `public_url`
- `visibility`
- `sub`

Для `FILE`:

- `type = 'FILE'`
- `hash = minio:<bucket>:<base64url(objectName)>`
- `public_url = UUID`

Для `DIR`:

- `type = 'DIR'`
- `hash = null`

### Почему не стоит выбрасывать VFS

Если оставить только S3-объекты без `storage.nodes`, вы теряете:

- человекочитаемые имена как источник истины
- иерархию каталогов
- `public_url`
- visibility / ACL / owner
- логическое удаление и каскадную чистку дерева

То есть “чистый S3 backend” в духе текущего проекта все равно лучше строить как `S3 + VFS metadata`, а не как просто bucket proxy.

## 7. Базовый bootstrap flow

### Шаг 1. Поднять схему БД

Источник истины:

- [deploy/postgres-init/010_storage_schema.sql](../../deploy/postgres-init/010_storage_schema.sql)

### Шаг 2. Подключить S3 client

Смотреть:

- [minio.client.ts](../src/services/core/sys/mixins/s3/minio.client.ts)
- [minio.config.js](../src/services/core/sys/mixins/s3/minio.config.js)

### Шаг 3. Оставить `storageRef` формат

Смотреть:

- [storage-ref.ts](../src/services/core/sys/mixins/s3/storage-ref.ts)

Формат:

```text
minio:<bucket>:<base64url(objectName)>
```

Этот формат уже хорошо развязывает VFS и конкретный object key.

### Шаг 4. Поднять `vfs.service` и `minio.service`

Именно эта пара дает нужный runtime:

- MinIO знает, как читать/писать объект
- VFS знает, как связать объект с `FILE`-нодой

### Шаг 5. Оставить `POST /api/storage/ingest`

Это главный внешний upload flow.

Почему:

- меньше шансов оставить orphan object
- rollback уже встроен
- внешний клиенту не нужно знать внутреннюю оркестрацию

## 8. Минимальный рабочий пользовательский сценарий

1. Получить root/нужную папку через `vfsNode`
2. При необходимости создать подкаталог через `vfsCreateDir`
3. Загрузить файл через `POST /api/storage/ingest`
4. Сохранить:
   - `node_id`
   - `public_url`
5. Открывать файл через:
   - `GET /api/storage/file/:publicUrl`
6. Удалять через:
   - `vfsDeleteNode(node_id)`

Это и есть минимальный end-to-end flow нового сервиса.

## 9. Что можно упростить дополнительно

Если новый backend не наследует весь ACL/session стек, можно отдельно упростить:

- owner/admin bypass
- `VFS_ADMIN_*` / `MINIO_*_ROLES`
- backend-session guards
- preview generation
- GraphQL surface

Но это уже второй этап.

Сначала лучше перенести ядро без изменения модели:

- S3 object
- `storageRef`
- `storage.nodes`
- `storage/ingest`
- `storage/file/:publicUrl`

А уже потом вырезать лишнее.

## 10. Что читать дальше

Если нужен краткий operational brief:

- [BASE_FS.md](./BASE_FS.md)

Если нужен полный MinIO/VFS контекст:

- [minio-vfs-context-2026-04-17.md](./minio-vfs-context-2026-04-17.md)

Если нужен внешний upload contract:

- [storage-ingest-api-2026-04-17.md](./storage-ingest-api-2026-04-17.md)

Если нужен frontend/backend integration flow:

- [files-backend-integration-guide-2026-04-17.md](./files-backend-integration-guide-2026-04-17.md)
