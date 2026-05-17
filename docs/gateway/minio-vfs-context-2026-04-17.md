# MinIO + VFS Context

Дата: 2026-04-17

## Что сделано

- Backend `minio` сервис используется как основной storage backend для VFS.
- Legacy-связка `VFS -> storage.files` убрана из основного VFS-потока.
- Для файловых узлов `storage.nodes.hash` хранит MinIO `storageRef`.
- `VFSNode.file` в GraphQL резолвится напрямую в MinIO.
- Обычные файлы и tiles наружу открываются по `public_url` UUID, а не по `storageRef`.
- `node_id` остается внутренним идентификатором VFS.
- Инициализация SQL для VFS теперь идет через PostgreSQL init scripts в `deploy/postgres-init`.

## Текущая модель хранения

### Storage ref

Формат ссылки на объект:

```text
minio:<bucket>:<base64url(objectName)>
```

Реализация:

- [storage-ref.ts](../src/services/core/sys/mixins/s3/storage-ref.ts)

Основные функции:

- `formatMinioStorageRef(bucketName, objectName)`
- `parseStorageRef(value)`
- `isMinioStorageRef(value)`

### VFS

Файловый узел в `storage.nodes`:

- `type = 'FILE'`
- `hash = 'minio:...'`
- `sub = ctx.meta.user.sub`
- `scope`, `host`, `parent_id` берутся из родительского контекста
- `visibility = inherit | public | private`

Директория:

- `type = 'DIR'`
- `hash = null`

### Логическая модель доступа

- `public`:
  - свободный `read/list`
- `private`:
  - доступен авторизованному пользователю
- локальный ACL:
  - используется для точечной настройки конкретных разделов
- owner:
  - узел с `nodes.sub == ctx.meta.user.sub` не может сам себя запереть
- VFS admin:
  - получает bypass через env (`VFS_ADMIN_*` или fallback на `MINIO_ADMIN_*`)

## Основные файлы

- [minio.service.ts](../src/services/core/sys/minio.service.ts)
- [minio.client.ts](../src/services/core/sys/mixins/s3/minio.client.ts)
- [minio.config.js](../src/services/core/sys/mixins/s3/minio.config.js)
- [storage-ref.ts](../src/services/core/sys/mixins/s3/storage-ref.ts)
- [vfs.service.ts](../src/services/core/sys/vfs.service.ts)
- [vfs.schema.ts](../src/services/core/sys/mixins/vfs/vfs.schema.ts)
- [deploy/postgres-init/010_storage_schema.sql](../../deploy/postgres-init/010_storage_schema.sql)
- [deploy/scripts/refresh-storage-schema.sh](../../deploy/scripts/refresh-storage-schema.sh)

## Что сейчас делает MinIO сервис

### Upload

Публичный внешний upload contract:

```text
POST /api/storage/ingest
```

Поведение:

- принимает `multipart/form-data`;
- кладет файл в `MINIO_BUCKET` через backend flow;
- сразу создает `FILE`-ноду в VFS;
- опционально запускает slice;
- возвращает `node + upload + tileInfo`.

Физический layout в bucket:

- `direct/...`
- `files/vfs/...`
- `preview/vfs/...`
- `tiles/vfs/...`

`storageRef` по-прежнему живет в формате:

- `minio:<bucket>:<base64url(objectName)>`

Типовой ответ:

```json
{
  "node": {
    "node_id": 123,
    "public_url": "550e8400-e29b-41d4-a716-446655440000",
    "name": "manual.pdf",
    "type": "FILE",
    "storageRef": "minio:atlas:...",
    "hash": "minio:atlas:..."
  },
  "upload": {
    "bucketName": "atlas",
    "objectName": "files/vfs/123/manual-....pdf",
    "storageRef": "minio:atlas:..."
  },
  "tileInfo": null
}
```

Для обычной внешней интеграции именно `storage/ingest` считается supported path.

### Bucket

Текущий runtime опирается на один bucket:

- `MINIO_BUCKET`

Default:

- `atlas`

Отдельная старая multi-bucket модель больше не является основной runtime-моделью.

### Доступ к файлу по public_url

Основной внешний route:

```text
GET /api/storage/file/:publicUrl
```

Он идет напрямую в `minio.getByPublicUrl` и:

- проверяет доступ через VFS;
- отдает файл по актуальному `storageRef`;
- при download использует имя из VFS, а не технический object key.

### Доступ к объекту по ref

Сервис `minio` умеет:

- `resolveFileRef`
- `objectExistsByRef`
- `deleteByRef`

Это используется VFS при создании и удалении `FILE`-узлов.

### Тайлы

Для OpenSeadragon:

- нарезка идет по `node_id`
- DZI и tiles открываются через backend route:

```text
/api/tiles/vfs/:publicUrl/*
```

Visibility тайлов следует visibility исходного VFS-узла.

Важно:

- `minioTileInfo(nodeId)` принимает внутренний `node_id`
- но `dziUrl` и `tileUrl` в ответе уже строятся через `public_url`

### Авторизация MinIO

MinIO actions защищены backend session hooks:

- `requireSession`
- `refreshToken`

И role/group gates:

- `enforceReadAccess`
- `enforceWriteAccess`
- `enforceDeleteAccess`
- `enforceAdminAccess`

ENV-ключи для ролей/групп:

- `MINIO_ADMIN_ROLES`
- `MINIO_ADMIN_GROUPS`
- `MINIO_READ_ROLES`
- `MINIO_READ_GROUPS`
- `MINIO_WRITE_ROLES`
- `MINIO_WRITE_GROUPS`
- `MINIO_DELETE_ROLES`
- `MINIO_DELETE_GROUPS`

Если списки пустые, доступ определяется валидной backend-session.

## Что сейчас делает VFS

### Создание директории

GraphQL mutation:

```graphql
mutation {
  vfsCreateDir(node: { parent_id: 1, name: "manual-checks/minio" }, scope: "fs") {
    node_id
    parent_id
    name
    type
    scope
  }
```

### Создание файла

GraphQL mutation:

```graphql
mutation {
  vfsCreateFile(
    file: {
      parent_id: 123
      name: "test.txt"
      hash: "minio:atlas:..."
    }
  ) {
    node_id
    parent_id
    name
    type
    hash
    scope
  }
}
```

Проверки внутри:

- `hash` обязан быть MinIO `storageRef`
- объект обязан существовать в MinIO
- в одной директории нельзя создать второй `FILE` с тем же `name`

### Чтение файла из VFS

`VFSNode.file` резолвится через:

- `minio.resolveFileRef`

GraphQL type:

- `VFSMinioFile`

### Удаление

При `vfsDeleteNode`:
- каскадно удаляются дочерние `storage.nodes`
- удаляются связанные MinIO objects
- mutation возвращает уже гидратированные VFS-узлы с `effectiveVisibility`

## GraphQL схема VFS

Файл:

- [vfs.schema.ts](../src/services/core/sys/mixins/vfs/vfs.schema.ts)

Ключевые моменты:

- `VFSNode.file: VFSMinioFile`
- `VFSNode.file` резолвится action'ом `minio.resolveFileRef`
- у `VFSNode` есть:
  - `visibility`
  - `effectiveVisibility`
  - `acl_count`
  - `has_acl`
- legacy `File` для VFS больше не используется

## Legacy files flow

Старый `files.service.ts` и `/api/files/...` больше не используются.

Текущий файловый поток для VFS идет через:

- `/api/storage/file/:publicUrl`

## DB init

Инициализация схемы:

- выполняется PostgreSQL через `docker-entrypoint-initdb.d`
- текущий dump лежит в [deploy/postgres-init/010_storage_schema.sql](../../deploy/postgres-init/010_storage_schema.sql)
- refresh делается скриптом [deploy/scripts/refresh-storage-schema.sh](../../deploy/scripts/refresh-storage-schema.sh)
