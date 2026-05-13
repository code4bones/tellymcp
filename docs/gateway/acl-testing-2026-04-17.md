# ACL Testing

Документ для ручной проверки `visibility + ACL` в связке `VFS -> MinIO -> Files -> OpenSeadragon`.

## Что уже реализовано

- `storage.nodes.visibility`: `inherit | public | private`
- `storage.node_acl`: ACL-правила на узле
- наследование ACL и visibility идет сверху вниз по дереву
- `deny` имеет приоритет над `allow`
- обычные файлы открываются по `public_url` через `/api/storage/file/:publicUrl`
- тайлы OpenSeadragon открываются через `/api/tiles/vfs/:publicUrl/*`

## Текущая модель доступа

- `public`:
  - свободный `read/list`
- `private`:
  - доступен авторизованному пользователю
- локальные ACL rules:
  - используются для точечной настройки доступа на конкретных узлах
- `inherit`:
  - берет visibility от ближайшего родителя, где visibility задан явно

## Важные правила модели

- Если на узле нет локального ACL, действует унаследованный ACL родителя.
- Если ACL нет ни на узле, ни у предков, остается compatibility fallback:
  - `private` остается доступным авторизованному пользователю.
- `public` дает свободный `read/list`.
- `inherit` берет visibility от ближайшего родителя.
- Владелец узла (`storage.nodes.sub == ctx.meta.user.sub`) всегда сохраняет доступ к своему узлу, даже если локальный ACL содержит `deny` для его `user/role/group`.
- Отдельно существует системный admin-bypass для VFS:
  - `VFS_ADMIN_ROLES`
  - `VFS_ADMIN_GROUPS`
  - если они не заданы, используется fallback на:
    - `MINIO_ADMIN_ROLES`
    - `MINIO_ADMIN_GROUPS`
- Этот bypass задается через env и не означает, что в коде есть жестко зашитое имя роли.

## Подготовка

1. Перезапустить backend после последних изменений.
2. Проверить, что в env заданы:
   - `MINIO_BUCKET`
3. Проверить, что backend поднял runtime policy заново.

## Проверка 1. Базовые маркеры visibility

1. Открыть `Files`.
2. Убедиться, что у узлов в дереве и таблице видны только иконки visibility:
   - `🌐` для public
   - `🔒` для private
3. Навести курсор на иконку и проверить `title`:
   - `Public`
   - `Inherited public`
   - `Private`
   - `Inherited private`

Ожидание:
- текст `Private/Public` в UI не показывается, только значок.

## Проверка 2. Открытие файла по public_url

1. Выбрать файл в `Files`.
2. Нажать `Открыть`.
3. Проверить в Network URL:
   - `/api/storage/file/<publicUrl>`
4. Нажать `Скачать`.
5. Проверить, что имя скачанного файла соответствует `VFSNode.name`.

Ожидание:
- фронт не должен обращаться к уже удаленному `/api/files/...`
- скачивание не зависит от `storageRef`

## Проверка 3. Public file

1. Выбрать файл.
2. Нажать `🔐 Access`.
3. Поставить:
   - `visibility = public`
4. Сохранить.
5. Проверить:
   - badge стал `🌐`
   - `effectiveVisibility = public`
   - `Открыть` работает
   - `Скачать` работает

Ожидание:
- объект доступен как public через VFS/runtime policy

## Проверка 4. Private file

1. Для того же файла открыть `🔐 Access`.
2. Поставить:
   - `visibility = private`
3. Сохранить.
4. Проверить:
   - badge стал `🔒`
   - `effectiveVisibility = private`
   - `Открыть` работает в текущей сессии
   - `Скачать` работает в текущей сессии

Ожидание:
- объект остается в том же storage layout, но доступ режется через VFS/runtime policy

## Проверка 5. Inherit visibility

1. На папке выставить `visibility = public`.
2. На дочернем файле выставить `visibility = inherit`.
3. Проверить, что у файла:
   - badge `🌐`
   - `effectiveVisibility = public`
4. Потом на папке поменять visibility на `private`.
5. Проверить, что дочерний файл стал `effectiveVisibility = private`.

Ожидание:
- дочерний узел меняет effective visibility без ручной правки самого узла

## Проверка 6. ACL по роли

1. На каталоге оставить `visibility = private`.
2. Добавить ACL:
   - `principal_type = role`
   - `principal_id = <test-role>`
   - `permission = read/list`
   - `effect = allow`
3. Сохранить.

Под пользователем с ролью:
4. Проверить, что каталог и файлы видны и открываются.

Под пользователем без роли:
5. Проверить, что применяются локальные ограничения, которые вы задали на этот раздел.

Ожидание:
- ACL реально донастраивает private-зону

## Проверка 7. ACL inheritance

1. ACL добавить на каталог.
2. На дочернем файле ACL не задавать.
3. Проверить, что файл наследует доступ.
4. Затем на файле задать локальное правило:
   - `role = <test-role>`
   - `permission = read`
   - `effect = deny`
5. Проверить, что файл больше не открывается.

Ожидание:
- child rule влияет на сам файл
- `deny` побеждает

## Проверка 7.1. Owner self-lock protection

1. Открыть узел, владельцем которого является текущий пользователь.
2. Добавить ACL rule:
   - `principal_type = user`
   - `principal_id = <свой sub>`
   - `effect = deny`
   - права: `read/list/write/delete`
3. Сохранить.
4. Проверить, что:
   - узел не исчезает из листинга владельца
   - его все еще можно открыть
   - его ACL все еще можно редактировать

Ожидание:
- владелец не может сам себе заблокировать доступ к своему узлу ACL-правилами

## Проверка 7.2. VFS admin bypass

1. Проверить env:
   - `VFS_ADMIN_ROLES` / `VFS_ADMIN_GROUPS`
   - либо fallback `MINIO_ADMIN_ROLES` / `MINIO_ADMIN_GROUPS`
2. Войти пользователем, который попадает под этот bypass.
3. На чужом private-узле задать restrictive ACL, который обычного пользователя отрежет.
4. Проверить, что VFS-admin:
   - все еще видит узел
   - может открыть его
   - может менять ACL / visibility

Ожидание:
- системный VFS-admin bypass работает поверх обычного ACL

## Проверка 8. OpenSeadragon public

1. Взять файл, который уже умеет резаться в tiles.
2. Поставить `visibility = public`.
3. Открыть `Develop -> OpenSeadragon`.
4. Выбрать файл.
5. Нажать `Нарезать`, если нужно.
6. Нажать `Показать`.

Ожидание:
- viewer работает
- DZI и tiles грузятся через backend route `/api/tiles/vfs/:publicUrl/...`

## Проверка 9. OpenSeadragon private

1. Для того же файла поставить `visibility = private`.
2. Снова открыть viewer.
3. Проверить, что изображение открывается в текущей авторизованной сессии.
4. Проверить Network:
   - тайлы идут на `/api/tiles/vfs/:publicUrl/...`

Ожидание:
- private tiles уважают ту же auth-модель, что и сам файл

## Проверка 10. Смена visibility после нарезки

1. Файл уже нарезан.
2. Переключить:
   - `public -> private`
3. Открыть viewer.
4. Переключить:
   - `private -> public`
5. Открыть viewer снова.

Ожидание:
- тайлы продолжают открываться
- при смене visibility происходит синхронизация tile bucket

## Проверка 11. Rename / move

1. Переименовать файл.
2. Проверить:
   - `Открыть` работает
   - `Скачать` отдает новое имя
3. Переместить файл в другой каталог.
4. Проверить:
   - выдача по `public_url` продолжает работать
   - visibility/ACL не потерялись

## Проверка 12. Delete subtree

1. Создать каталог с файлами.
2. Задать visibility/ACL.
3. Удалить каталог.

Ожидание:
- `storage.nodes` удалены каскадно
- MinIO source objects удалены
- если были tiles, их нужно проверить отдельно и при необходимости дочистить

## Что смотреть в логах

- `VFS_DEBUG` сейчас выключен по умолчанию.
- Для временной отладки можно включить:
  - backend: `VFS_DEBUG=true`
  - frontend: `localStorage.setItem("VFS_DEBUG", "true")`
