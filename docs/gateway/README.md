# Docs Index

Оглавление документации в `back/docs`.

## Files / VFS / MinIO

- [BASE_FS.md](./BASE_FS.md)  
  Короткий backend-brief по файловой логике: что является источником истины, какие route/mutation дергать и как устроены upload, delete, preview, create, rename и move.

- [README-FILES.md](./README-FILES.md)  
  Короткая оперативная памятка по файловой подсистеме: что смотреть первым делом и где лежат ключевые точки.

- [files-user-guide-2026-04-17.md](./files-user-guide-2026-04-17.md)  
  Пользовательская инструкция по экрану `Files`: папки, файлы, загрузка, права, ACL Index, tiles.

- [files-backend-integration-guide-2026-04-17.md](./files-backend-integration-guide-2026-04-17.md)  
  Инструкция для внешнего фронтенда, который работает только с нашим backend: как выбрать папку, загрузить файл, получить `node_id/public_url`, открыть файл и подключить OpenSeadragon.

- [storage-ingest-api-2026-04-17.md](./storage-ingest-api-2026-04-17.md)  
  Документ только про новый REST endpoint `POST /api/storage/ingest`: входные поля, rollback и пример вызова.

- [minio-vfs-context-2026-04-17.md](./minio-vfs-context-2026-04-17.md)  
  Технический контекст связки `MinIO -> storageRef -> VFS`: как это устроено и где какие файлы кода участвуют.

- [s3-backend-minimal.md](./s3-backend-minimal.md)  
  Короткий blueprint для нового backend только с `S3 + VFS + DB`: что переносить обязательно, что можно выбросить и какой минимальный контракт оставить.

- [files-hotspots-2026-04-17.md](./files-hotspots-2026-04-17.md)  
  Узкие и проблемные места файловой подсистемы: что чаще всего ломается, где искать причину и что проверять.

## ACL / Access

- [acl-testing-2026-04-17.md](./acl-testing-2026-04-17.md)  
  Чек-листы ручного тестирования ACL, visibility, inheritance, owner/admin bypass и связанных сценариев.

## Auth / Session

- [auth-presets-keycloak-26.5.2.md](./auth-presets-keycloak-26.5.2.md)  
  Основной документ по пресетам сессий, backend policy и настройкам Keycloak.

- [auth-presets-check.md](./auth-presets-check.md)  
  Практический чек-лист: как быстро проверять short/no-offline сценарии и как возвращаться к preset A.

- [auth-review-2026-04-16.md](./auth-review-2026-04-16.md)  
  Ранее собранный обзор auth-flow и замечаний по архитектуре/рискам.

## Project Map

- [feature-map-2026-04-17.md](./feature-map-2026-04-17.md)  
  Карта фич по `front/back`: где что лежит, как связаны основные подсистемы и с чего продолжать работу.

## Что читать в зависимости от задачи

Если нужно:

- быстро понять backend-файловую модель и основной контракт без migration/transcoder  
  читайте [BASE_FS.md](./BASE_FS.md)

- понять экран `Files` как пользователь  
  читайте [files-user-guide-2026-04-17.md](./files-user-guide-2026-04-17.md)

- подключить другой frontend к backend файлов  
  читайте [files-backend-integration-guide-2026-04-17.md](./files-backend-integration-guide-2026-04-17.md)

- использовать только upload + create node + slice endpoint  
  читайте [storage-ingest-api-2026-04-17.md](./storage-ingest-api-2026-04-17.md)

- понять внутреннюю архитектуру VFS/MinIO  
  читайте [minio-vfs-context-2026-04-17.md](./minio-vfs-context-2026-04-17.md)

- собрать новый backend только с S3/VFS/DB, без transcoder/migration  
  читайте [s3-backend-minimal.md](./s3-backend-minimal.md)

- искать баги в `Files`  
  читайте [README-FILES.md](./README-FILES.md) и [files-hotspots-2026-04-17.md](./files-hotspots-2026-04-17.md)

- тестировать права доступа  
  читайте [acl-testing-2026-04-17.md](./acl-testing-2026-04-17.md)

- разбираться с auth/session policy  
  читайте [auth-presets-keycloak-26.5.2.md](./auth-presets-keycloak-26.5.2.md) и [auth-presets-check.md](./auth-presets-check.md)
