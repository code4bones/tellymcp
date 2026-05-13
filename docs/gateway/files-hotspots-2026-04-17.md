# Files / VFS / MinIO Hotspots

Документ фиксирует узкие и значимые места текущей архитектуры `Files`, чтобы при поиске и исправлении ошибок было проще быстро сузить проблему.

## 1. Главная модель

Текущая схема:
- `storage.nodes` — логическая VFS-структура
- `hash` у `FILE` = MinIO `storageRef`
- файл открывается наружу по `public_url`
- обычные файлы идут через:
  - `/api/storage/file/:publicUrl`
- тайлы идут через:
  - `/api/tiles/vfs/:publicUrl/*`

Если что-то ломается в UI `Files`, почти всегда нужно проверять один из этих слоев:
1. `VfsExplorer.tsx`
2. `vfs.service.ts`
3. `minio.service.ts`
4. маршруты в `api.routes.ts`

## 2. Host-sensitive дерево

У VFS дерево и резолвер `children` завязаны на `host`.

Ключевое место:
- `vfs.resolveVFSDir_children`

Если узлы вставлены напрямую в БД и у них:
- `host = NULL`
- или `host` не совпадает с текущим хостом приложения,

то возможны симптомы:
- папка открывается, но счетчики `📁/📄` равны `0`
- дети не резолвятся как ожидается
- дерево выглядит неполным

Это уже проявлялось на тестовом дереве `deep`.

## 3. Visibility semantics

Текущая модель доступа:
- `public` = свободный `read/list`
- `private` = авторизованный пользователь
- ACL = fine-tune для конкретных узлов

Это важно:
- `private` сейчас не означает “строго только по ACL”
- если молча поменять это поведение, можно сломать реальный пользовательский сценарий

Критичное место:
- `evaluateNodePermission()` в [vfs.service.ts](../src/services/core/sys/vfs.service.ts)

## 4. Owner / admin bypass

Доступ сохраняют:
- владелец узла (`nodes.sub`)
- VFS admin через env

Системный bypass:
- `VFS_ADMIN_ROLES`
- `VFS_ADMIN_GROUPS`
- fallback:
  - `MINIO_ADMIN_ROLES`
  - `MINIO_ADMIN_GROUPS`

Если “ACL не действует”, сначала нужно проверить:
1. owner ли это
2. не попадает ли пользователь под VFS admin bypass

## 5. Удаление и stale path

После удаления узла фронт может еще короткое время жить со старым `node_id`.

Уже исправленные места:
- `vfsGetIdsToNode` возвращает `[]`, если узел уже удален
- `vfsDeleteNode` возвращает гидратированные удаленные узлы с `effectiveVisibility`

Симптомы, которые уже были:
- `Access denied for VFS read` сразу после удаления
- `Cannot return null for non-nullable field VFSNode.effectiveVisibility`

Если такие ошибки вернутся, сначала смотреть:
- `vfsGetPathIds`
- `vfsDeleteNode`

## 6. Основной file route

Новый основной route:
- `/api/storage/file/:publicUrl`

Важно:
- старый `files`-flow удален
- если в Network снова виден основной трафик на `/api/files/...`, это почти наверняка обращение к уже несуществующему legacy-контуру

## 7. Tiles routing

Для OpenSeadragon текущая точка истины:
- `/api/tiles/vfs/:publicUrl/*`

Проблемы, которые уже были:
- route не матчился и уходил в generic `/api`
- path-параметр ломался регуляркой
- DZI открывался, но контейнер viewer имел `height = 0`

Если тайлы снова перестанут открываться, проверять по порядку:
1. `minioTileInfo(nodeId)`
2. `GET /api/tiles/vfs/:publicUrl/source.dzi`
3. Network по tile requests
4. размер viewer container на фронте

## 8. Tree performance

Текущее ускорение дерева держится на нескольких вещах:
- lazy loading через `vfsNode`
- memoized `DirectoryTreeRow`
- imperative selected class через refs
- удален `startTransition` из `openDirectory`

Если при клике по дереву снова появится заметная пауза без сети:
- сначала смотреть `VfsExplorer.tsx`
- особенно:
  - `openDirectory`
  - `DirectoryTreeRow`
  - `treeSelectedNodeId`
  - ре-рендер правой панели

## 9. ACL Index

Индекс ACL сейчас имеет:
- `Nodes with rules`
- `Rules index`
- пагинацию
- `Clear`

Что важно:
- `Clear` снимает только локальные rules
- `visibility` не меняется
- inherited ACL продолжает действовать

Если после `Clear` доступ “не отпустило”, это не обязательно баг:
- возможно, действует родительский ACL

## 10. Direct DB writes

Прямые вставки в `storage.nodes` допустимы для тестов, но рискованные.

Нужно помнить про поля:
- `type`
- `name`
- `parent_id`
- `scope`
- `host`
- `sub`
- `visibility`

Если забыть `host` или задать нетипичную комбинацию:
- UI может выглядеть “почти рабочим”, но с неверными счетчиками или children

## 11. Что проверять первым делом при баге

Если баг в `Files`, сначала проверить:

1. Это баг в VFS, MinIO или фронте?
2. Какой route реально дергается?
   - `/api/storage/file/:publicUrl`
   - `/api/tiles/vfs/:publicUrl/*`
   - GraphQL `vfsNode / vfsListFiles / vfsGetIdsToNode`
3. Есть ли у узла:
   - правильный `host`
   - правильный `visibility`
   - локальный ACL
   - owner `sub`
4. Не срабатывает ли owner/admin bypass?
5. Не обращается ли фронт к уже удаленному `node_id`?

## 12. Полезные документы рядом

- [files-user-guide-2026-04-17.md](./files-user-guide-2026-04-17.md)
- [acl-testing-2026-04-17.md](./acl-testing-2026-04-17.md)
- [minio-vfs-context-2026-04-17.md](./minio-vfs-context-2026-04-17.md)
- [feature-map-2026-04-17.md](./feature-map-2026-04-17.md)
