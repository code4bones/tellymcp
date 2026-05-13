# BASE_FS

Краткий operational brief по файловому слою backend.

Фокус документа:
- только рабочая файловая логика;
- без migration;
- без transcoder;
- без UI-деталей фронта.

## 1. Что является источником истины

Файловая подсистема = `VFS + MinIO`.

Где что живет:
- дерево, имена, папки, порядок доступа: `storage.nodes`
- физическое содержимое файла: MinIO
- путь наружу для клиента: `public_url`
- внутренний pointer на объект: `hash`

Для `FILE`-узла:
- `storage.nodes.type = 'FILE'`
- `storage.nodes.public_url = UUID`
- `storage.nodes.hash = minio:<bucket>:<base64url(objectName)>`

Для `DIR`-узла:
- `storage.nodes.type = 'DIR'`
- `storage.nodes.hash = null`

Вывод:
- наружу клиент должен жить на `public_url`
- физическое хранилище backend ищет через `hash/storageRef`

## 2. Главные идентификаторы

Новый разработчик должен различать 3 сущности:

1. `node_id`
- внутренний integer id VFS-узла;
- нужен для GraphQL mutations и служебных backend-операций.

2. `public_url`
- публичный UUID файла;
- используется во внешних HTTP route для чтения/скачивания/preview/tiles.

3. `hash`
- не legacy hash, а MinIO storage ref;
- формат: `minio:<bucket>:<base64url(objectName)>`

Правило:
- клиенту не нужно строить URL по `hash`
- клиенту нужен `public_url`

## 3. Основные backend entry points

### GraphQL

Основные операции VFS:
- `vfsScopes`
- `vfsNode`
- `vfsListFiles`
- `vfsCreateDir`
- `vfsCreateFile`
- `vfsRename`
- `vfsMoveNode`
- `vfsDeleteNode`
- `vfsCreatePreview`
- `vfsGetIdsToNode`

Схема:
- `back/src/services/core/sys/mixins/vfs/vfs.schema.ts`
- `back/src/services/core/sys/vfs.service.ts`

### REST

Основные route:
- `POST /api/storage/ingest`
- `GET /api/storage/file/:publicUrl`
- `GET /api/storage/file/:publicUrl?download=1`
- `GET /api/storage/preview/:publicUrl`
- `GET /api/storage/preview/:publicUrl?size=...`

Роутинг:
- `back/src/services/core/api/api.routes.ts`

MinIO/runtime:
- `back/src/services/core/sys/minio.service.ts`

## 4. Базовый сценарий работы с файлами

### Рекомендуемый путь загрузки

Нормальный путь для внешнего клиента:

1. найти папку через `vfsNode`
2. загрузить файл через `POST /api/storage/ingest`
3. получить:
   - `node.node_id`
   - `node.public_url`
   - `node.hash`
4. открывать файл по `/api/storage/file/:publicUrl`

Почему именно так:
- upload и создание VFS-ноды идут одним backend-потоком;
- rollback уже встроен;
- меньше шансов получить объект в MinIO без ноды или наоборот.

### Ручной путь

Если нужен полный контроль:

1. upload в MinIO
2. `vfsCreateFile`
3. optional `vfsCreatePreview`

Но для обычной интеграции это хуже, чем `ingest`.

## 5. Создание директории

Mutation:

```graphql
mutation CreateDir($node: VFSCreateNode!, $scope: String) {
  vfsCreateDir(node: $node, scope: $scope) {
    node_id
    parent_id
    name
    type
    scope
    visibility
    effectiveVisibility
  }
}
```

Пример variables:

```json
{
  "scope": "fs",
  "node": {
    "parent_id": 17,
    "name": "contracts/2026"
  }
}
```

Поведение:
- если в `name` есть слеши, backend создаст цепочку директорий;
- родитель должен быть доступен на `write`;
- директория создается с `visibility = inherit`.

## 6. Загрузка файла

### Рекомендуемый endpoint

`POST /api/storage/ingest`

`multipart/form-data`:
- `parent_id` - обязательный `node_id` папки
- `file` - обязательный файл
- `name` - optional имя VFS-ноды
- `slice` - optional
- `force` - optional

Пример:

```bash
curl 'https://example.com/api/storage/ingest' \
  -b cookies.txt \
  -F 'parent_id=17' \
  -F 'name=manual.pdf' \
  -F 'file=@/tmp/manual.pdf'
```

Типовой ответ:

```json
{
  "node": {
    "node_id": 123,
    "public_url": "550e8400-e29b-41d4-a716-446655440000",
    "parent_id": 17,
    "name": "manual.pdf",
    "type": "FILE",
    "hash": "minio:atlas:..."
  },
  "upload": {
    "bucketName": "atlas",
    "objectName": "files/vfs/55/550e8400....pdf",
    "storageRef": "minio:atlas:..."
  },
  "tileInfo": null
}
```

Что делает backend:
1. принимает multipart
2. кладет объект в MinIO
3. создает `FILE`-узел в `storage.nodes`
4. при необходимости перемещает объект из direct-upload prefix в managed storage
5. при ошибке откатывает и MinIO, и node

## 7. Создание FILE-ноды вручную

Mutation:

```graphql
mutation CreateFile($file: VFSCreateFile!) {
  vfsCreateFile(file: $file) {
    node_id
    public_url
    parent_id
    name
    type
    hash
    visibility
    effectiveVisibility
  }
}
```

Variables:

```json
{
  "file": {
    "parent_id": 17,
    "name": "manual.pdf",
    "hash": "minio:atlas:..."
  }
}
```

Важные проверки внутри:
- `hash` должен быть валидным MinIO storage ref;
- объект обязан реально существовать в MinIO;
- в одной папке нельзя создать второй `FILE` с тем же `name`.

## 8. Чтение и скачивание файла

### Inline/open

```text
GET /api/storage/file/:publicUrl
```

### Download

```text
GET /api/storage/file/:publicUrl?download=1
```

Поведение:
- backend ищет `FILE`-узел по `public_url`;
- проверяет VFS access;
- читает MinIO-объект по `node.hash`;
- имя файла для download берется из `node.name`, не из object key.

## 9. Preview

### Чтение preview

```text
GET /api/storage/preview/:publicUrl
GET /api/storage/preview/:publicUrl?size=512
```

### Создание preview

```graphql
mutation CreatePreview($nodeId: Int!, $size: Int, $force: Boolean) {
  vfsCreatePreview(node_id: $nodeId, size: $size, force: $force)
}
```

Preview-модель:
- preview хранится отдельно как backend-managed derivative;
- наличие отражается флагом `has_preview`;
- route preview работает по `public_url`, но генерация идет по `node_id`.

Если preview нет:
- route вернет `404 PREVIEW_NOT_FOUND`

## 10. Навигация по дереву

### Scope list

```graphql
query VfsScopes {
  vfsScopes
}
```

### Получить директорию / children

```graphql
query Children($parentId: Int, $scope: String) {
  vfsNode(parent_id: $parentId, scope: $scope) {
    node_id
    public_url
    parent_id
    name
    type
    hash
    visibility
    effectiveVisibility
    has_acl
    has_tiles
    has_preview
    children {
      node_id
      type
    }
  }
}
```

Типовая модель:
- root получают как `vfsNode(parent_id: null, scope: "fs")`
- дальше идут итеративно по `parent_id`

## 11. Переименование узла

Mutation:

```graphql
mutation Rename($nodeId: Int!, $name: String!) {
  vfsRename(node_id: $nodeId, name: $name) {
    node_id
    parent_id
    public_url
    name
    type
    hash
  }
}
```

Что меняется:
- меняется только `storage.nodes.name`

Что не меняется:
- `public_url`
- `hash/storageRef`
- MinIO object key

То есть rename у нас логический, не физический.

## 12. Перемещение узла

Mutation:

```graphql
mutation Move($nodeId: Int!, $destinationId: Int!) {
  vfsMoveNode(node_id: $nodeId, destination_id: $destinationId) {
    node_id
    parent_id
    public_url
    name
    type
  }
}
```

Что делает:
- меняет `parent_id` у узла

Что не делает:
- не перемещает физический объект в MinIO

Запреты:
- нельзя переместить узел в своего потомка;
- destination должен быть `DIR`.

## 13. Удаление узла

Mutation:

```graphql
mutation Delete($ids: [Int!]!) {
  vfsDeleteNode(node_id: $ids) {
    node_id
    parent_id
    public_url
    name
    type
    hash
  }
}
```

Поведение:
- удаляет корневые node ids и всех потомков;
- удаляет preview-артефакты;
- удаляет связанные MinIO objects для `FILE`-узлов;
- публикует VFS events;
- возвращает уже удаленные узлы в гидратированном виде.

Важно:
- delete завязан на VFS access (`delete`);
- backend также проверяет, можно ли удалять узлы с точки зрения внутренних ограничений.

## 14. Права и минимальные предположения

Файловый слой работает через VFS permission-модель:
- `read`
- `list`
- `write`
- `delete`
- `manage`

Практически:
- создать директорию / загрузить файл -> нужен `write` на parent
- rename -> нужен `manage` на node
- move -> `manage` на source node и `write` на destination dir
- delete -> нужен `delete`
- открыть файл/preview -> нужен `read`

## 15. Что дергать новому разработчику

Если задача: “сделать обычный файловый UI без экзотики”, набор такой:

1. `vfsScopes`
2. `vfsNode`
3. `POST /api/storage/ingest`
4. `vfsCreateDir`
5. `vfsRename`
6. `vfsMoveNode`
7. `vfsDeleteNode`
8. `GET /api/storage/file/:publicUrl`
9. `GET /api/storage/preview/:publicUrl`
10. optional `vfsCreatePreview`

Этого достаточно для:
- дерева папок;
- загрузки;
- чтения и скачивания;
- preview;
- создания, переименования, перемещения и удаления узлов.

## 16. Что читать дальше

Если brief уже понятен, дальше читать так:

- внешний frontend integration:
  - `back/docs/files-backend-integration-guide-2026-04-17.md`
- внутренний storage context:
  - `back/docs/minio-vfs-context-2026-04-17.md`
- проблемные места и отладка:
  - `back/docs/files-hotspots-2026-04-17.md`
- ACL-проверки:
  - `back/docs/acl-testing-2026-04-17.md`
