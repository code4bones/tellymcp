# Storage Ingest API

Единая точка входа для внешнего сервиса:

- загрузка файла в MinIO
- создание `FILE`-ноды в VFS
- опциональная нарезка tiles

## Endpoint

`POST /api/storage/ingest`

Контент:

- `multipart/form-data`

## FormData поля

- `parent_id` - обязательный `node_id` родительской папки VFS
- `file` - обязательный файл
- `name` - опциональное имя VFS-ноды; если не передано, берется исходное имя файла
- `slice` - опционально: `true/false`, запускать ли нарезку tiles
- `force` - опционально: `true/false`, пересоздавать ли tiles принудительно

## Почему достаточно `parent_id`

Из родительской ноды берутся и наследуются:

- `scope`
- `host`
- `visibility = inherit`
- ACL / effective access

Поэтому отдельно передавать `scope`, `host` или `visibility` не нужно.

## Поведение

Пайплайн:

1. upload в MinIO
2. `vfsCreateFile`
3. если `slice=true` -> `minio.slice`

Если ошибка происходит:

- после upload, но до создания ноды: MinIO-объект удаляется
- после создания ноды: VFS-нода удаляется каскадно вместе с привязанным файлом/tiles

## Ответ

```json
{
  "node": {
    "node_id": 123,
    "parent_id": 45,
    "name": "document.pdf",
    "type": "FILE",
    "hash": "minio:atlas:..."
  },
  "upload": {
    "bucketName": "atlas",
    "objectName": "files/vfs/45/document-uuid.pdf",
    "storageRef": "minio:atlas:..."
  },
  "tileInfo": null
}
```

Если `slice=true`, `tileInfo` будет содержать результат `minioTileInfo`.

## Пример curl

```bash
curl 'http://builder.local/api/storage/ingest' \
  -b cookies.txt \
  -F 'parent_id=17' \
  -F 'name=manual.pdf' \
  -F 'slice=true' \
  -F 'force=false' \
  -F 'file=@/tmp/manual.pdf'
```

## Ограничения

- сейчас endpoint принимает ровно один файл
- endpoint требует авторизованную backend-session
- право записи в целевую папку проверяется через VFS ACL
