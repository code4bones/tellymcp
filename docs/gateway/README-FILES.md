# README: Files

Короткая памятка по текущей подсистеме `Files`.

## Что это

`Files` = `VFS + MinIO + ACL`.

Логика:
- дерево и имена живут в `storage.nodes`
- содержимое файлов живет в MinIO
- внешние file/tile URL строятся по `public_url`
- `node_id` остается внутренним идентификатором VFS
- доступ определяется через:
  - `visibility`
  - локальные ACL rules
  - owner/admin bypass

## Главное поведение

- `public`:
  - свободный `read/list`
- `private`:
  - доступен авторизованному пользователю
- ACL:
  - точечно донастраивает доступ к конкретным папкам и файлам
- `inherit`:
  - наследует visibility от родителя

## Главные route'ы

- файл:
  - `/api/storage/file/:publicUrl`
- preview:
  - `/api/storage/preview/:publicUrl`
- тайлы:
  - `/api/tiles/vfs/:publicUrl/*`
- upload:
  - `/api/storage/ingest`

## Где смотреть при проблеме

Фронт:
- [FilesPage.tsx](../../front/src/pages/files/ui/FilesPage.tsx)
- пакет `@code4bones/vfs-explorer`, который подключается в [main.tsx](../../front/src/main.tsx)

Бэк:
- [vfs.service.ts](../src/services/core/sys/vfs.service.ts)
- [minio.service.ts](../src/services/core/sys/minio.service.ts)
- [api.routes.ts](../src/services/core/api/api.routes.ts)

## Что проверять первым

1. Какой route реально дергается:
   - `/api/storage/file/:publicUrl`
   - `/api/tiles/vfs/:publicUrl/*`
   - GraphQL `vfsNode / vfsListFiles / vfsGetIdsToNode`
2. Есть ли у узла:
   - правильный `visibility`
   - локальный ACL
   - owner `sub`
3. Не срабатывает ли owner/admin bypass
4. Не обращается ли фронт к уже удаленному `node_id`

## Полезные документы

- [files-user-guide-2026-04-17.md](./files-user-guide-2026-04-17.md)
- [acl-testing-2026-04-17.md](./acl-testing-2026-04-17.md)
- [minio-vfs-context-2026-04-17.md](./minio-vfs-context-2026-04-17.md)
- [files-hotspots-2026-04-17.md](./files-hotspots-2026-04-17.md)
