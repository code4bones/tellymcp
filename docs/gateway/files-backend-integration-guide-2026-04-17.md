# Files Backend Integration Guide

Документ для внешнего фронтенда, который знает только наш backend.

Предположение:

- пользователь уже авторизован
- frontend уже умеет вызывать наши REST и GraphQL endpoints
- frontend ничего не знает о нашем UI

---

## 1. Базовая модель

В системе файл живет как:

1. объект в MinIO
2. `FILE`-нода в VFS

Для внешнего клиента основным идентификатором файла считается `public_url` UUID на VFS-ноде.
`node_id` остается внутренним идентификатором VFS и нужен для GraphQL/mutations/служебных операций.

Из этого следуют правила:

- загружать файл лучше так, чтобы сразу создавалась VFS-нода
- открывать и скачивать файл нужно по `public_url`
- tiles наружу тоже открываются по `public_url`

---

## 2. Что нужно знать внешнему frontend

Минимальный рабочий набор:

- найти `parent_id` папки, куда нужно положить файл
- загрузить файл в эту папку
- получить `node_id` и `public_url` созданного файла
- при необходимости вызвать нарезку по `node_id`
- для просмотра и скачивания использовать `public_url`

---

## 3. Как выбрать папку

### 3.1 Получить список scope

GraphQL:

```graphql
query VfsScopes {
  vfsScopes
}
```

Обычно основной scope: `fs`.

### 3.2 Получить root scope

GraphQL:

```graphql
query Root($scope: String!) {
  vfsNode(parent_id: null, scope: $scope) {
    node_id
    name
    type
    scope
  }
}
```

Для root ожидается узел:

- `name = "/"`
- `type = DIR`

### 3.3 Идти по дереву итеративно

Для перехода по папкам:

```graphql
query Children($parentId: Int!, $scope: String!) {
  vfsNode(parent_id: $parentId, scope: $scope) {
    node_id
    parent_id
    name
    type
    visibility
    effectiveVisibility
    has_acl
    has_tiles
  }
}
```

Это основной способ навигации.  
Дерево нужно раскрывать постепенно, по `parent_id`.

---

## 4. Рекомендуемый способ загрузки файла

Самый простой и правильный путь:

- `POST /api/storage/ingest`

Этот endpoint делает сразу:

1. upload в MinIO
2. создание `FILE`-ноды в VFS
3. опционально нарезку tiles

### 4.1 FormData поля

- `parent_id` - обязательный `node_id` папки
- `file` - обязательный файл
- `name` - опциональное имя ноды
- `slice` - опционально `true/false`
- `force` - опционально `true/false`

### 4.2 Пример

```bash
curl 'http://builder.local/api/storage/ingest' \
  -b cookies.txt \
  -F 'parent_id=17' \
  -F 'name=manual.pdf' \
  -F 'slice=true' \
  -F 'force=false' \
  -F 'file=@/tmp/manual.pdf'
```

### 4.3 Ответ

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
    "objectName": "files/vfs/17/manual-....pdf",
    "storageRef": "minio:atlas:..."
  },
  "tileInfo": null
}
```

Если `slice=true`, `tileInfo` будет заполнен.

---

## 5. Ручной сценарий, если нужен полный контроль

Для внешнего frontend публичный и рекомендуемый contract сейчас один:

- `POST /api/storage/ingest`

Отдельный внешний upload-only REST endpoint больше не является частью supported contract.
Если нужен полный контроль, он должен жить на стороне backend/internal orchestration, а не как отдельный публичный frontend flow.

Ручной сценарий на уровне внутренней backend-логики остается таким:

### Шаг 1. Создать или получить `storageRef` на backend-side

Источник `storageRef` может быть:

- direct upload flow;
- внутренний backend helper;
- уже существующий MinIO объект.

### Шаг 2. Создать VFS-ноду

GraphQL:

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

Пример variables:

```json
{
  "file": {
    "parent_id": 17,
    "name": "manual.pdf",
    "hash": "minio:atlas:..."
  }
}
```

### Шаг 3. При необходимости нарезать tiles

GraphQL:

```graphql
mutation Slice($nodeId: Int!, $force: Boolean) {
  minioSlice(nodeId: $nodeId, force: $force)
}
```

---

## 6. Как открыть или скачать файл

Сейчас основной внешний route один:

- public route по `public_url` UUID

`hash` по-прежнему не должен использоваться как внешний URL.

### Открыть inline

```text
GET /api/storage/file/:publicUrl
```

Пример:

```text
GET /api/storage/file/550e8400-e29b-41d4-a716-446655440000
```

### Скачать

```text
GET /api/storage/file/:publicUrl?download=1
```

Пример:

```text
GET /api/storage/file/550e8400-e29b-41d4-a716-446655440000?download=1
```

Имя скачивания берется из VFS-ноды, а не из MinIO object key.

### Открыть по public UUID

```text
GET /api/storage/file/:publicUrl
```

Пример:

```text
GET /api/storage/file/550e8400-e29b-41d4-a716-446655440000
```

### Скачать по public UUID

```text
GET /api/storage/file/:publicUrl?download=1
```

---

## 7. Как получить metadata файла

Для списка файлов в папке:

```graphql
query Files($parentId: Int!) {
  vfsListFiles(list: { parent_id: $parentId }) {
    node_id
    public_url
    parent_id
    name
    type
    path
    mime
    size
    created
    visibility
    effectiveVisibility
    has_acl
    has_tiles
  }
}
```

Это основной query для правой панели каталога.

---

## 8. Как понять, что файл уже нарезан

Есть 2 способа.

### 8.1 Через `has_tiles`

Во многих VFS-query уже приходит:

- `has_tiles`

Если `true`, у файла уже есть tiles.

### 8.2 Через отдельный index

GraphQL:

```graphql
query Tiles($scope: String, $first: Int, $max: Int) {
  vfsTileNodes(scope: $scope, first: $first, max: $max) {
    first
    max
    total
    hasMore
    items {
      node_id
      name
      path
      has_tiles
      bucket_name
      dzi_object_name
      tile_prefix
    }
  }
}
```

---

## 9. Как удалить tiles

GraphQL:

```graphql
mutation DeleteTiles($nodeId: Int!) {
  vfsDeleteTiles(node_id: $nodeId)
}
```

Это удаляет:

- tile assets из MinIO
- запись о tiles из БД

Сам исходный файл при этом не удаляется.

---

## 10. Как подключить OpenSeadragon

Есть 2 способа.

### 10.1 Рекомендуемый: через `minioTileInfo`

GraphQL:

```graphql
query TileInfo($nodeId: Int!) {
  minioTileInfo(nodeId: $nodeId)
}
```

В ответе есть:

- `dziUrl`
- `tileUrl`
- `tileSource`

Важно:

- `minioTileInfo(nodeId)` по-прежнему принимает внутренний `node_id`
- но наружу уже возвращает `dziUrl/tileUrl`, построенные через `public_url`

Самый простой вариант для OpenSeadragon:

- использовать `dziUrl`

Пример:

```js
OpenSeadragon({
  id: "viewer",
  prefixUrl: "https://cdnjs.cloudflare.com/ajax/libs/openseadragon/4.1.1/images/",
  tileSources: tileInfo.dziUrl,
  showNavigationControl: true,
  ajaxWithCredentials: true,
  crossOriginPolicy: "include"
});
```

### 10.2 Прямой доступ по URL

DZI:

```text
/api/tiles/vfs/:publicUrl/source.dzi
```

Tiles:

```text
/api/tiles/vfs/:publicUrl/source_files/...
```

Пример:

```text
http://builder.local/api/tiles/vfs/550e8400-e29b-41d4-a716-446655440000/source.dzi
```

Важно:

- для private-файлов запросы должны идти с той же авторизацией/cookies
- если frontend и backend на разных origin, нужно отдельно учитывать credentials/CORS

---

## 11. Какие операции обычно нужны внешнему frontend

Базовый набор:

1. выбрать scope
2. найти нужную папку и ее `parent_id`
3. загрузить файл через `POST /api/storage/ingest`
4. сохранить `node.node_id` и `node.public_url`
5. открыть файл через `/api/storage/file/:publicUrl`
6. при необходимости вызвать `minioSlice(nodeId)`
7. для viewer использовать `minioTileInfo(nodeId)`

---

## 12. Что лучше использовать в новом коде

Рекомендуется:

- для upload: `POST /api/storage/ingest`
- для чтения/скачивания: `/api/storage/file/:publicUrl`
- для tiles: `minioTileInfo(nodeId)` + `/api/tiles/vfs/:publicUrl/...`

Не рекомендуется строить новую интеграцию вокруг:

- прямой работы с `storageRef` как внешним идентификатором

---

## 13. Минимальный рабочий сценарий

### Вариант без tiles

1. Найти `parent_id`
2. `POST /api/storage/ingest`
3. Получить `node.public_url`
4. Открывать файл по `/api/storage/file/:publicUrl`

### Вариант с tiles

1. Найти `parent_id`
2. `POST /api/storage/ingest` с `slice=true`
3. Получить `node.node_id` и `node.public_url`
4. Запросить `minioTileInfo(nodeId)`
5. Передать `dziUrl` в OpenSeadragon

---

## 14. Важные замечания

- `parent_id` достаточно, отдельно передавать `scope` не нужно
- права доступа берутся из VFS и родительского контекста
- `private` в текущей архитектуре означает: доступен авторизованному пользователю
- ACL на конкретных папках и файлах делает fine-tune поверх этого
- при удалении файла его tiles тоже удаляются
