## Переход на Moleculer Framework

- добавлены директории src/lib/ & src/services/
- добавлен src/index.ts & moleculer.config.ts

# Общая структура

 - services/core - базовые сервисы и api. ядро системы. как првило нет необходимости изменять
 - services/fetaures/  - директория для расширения функционала, строится по принципу features/feature_xxx/{xxx.service.ts,mixins/}

# Порядок перехода и работы на новой архитектуре
 - старый функционал переносится как отдельные features/
 - утилитарные методы добавляются в сервис через миксины
 - допускается вынос общих уитилит src/lib/xx/


# Текущее состояние
 - Реализована работа с БД
 - Реализован CRUD для S3 
 - telegram_mcp перенесён под feature-root:
   - код живёт в `src/services/features/telegram-mcp/src/{app,entities,features,processes,shared}`
   - `runtime.service.ts` остаётся core runtime service для этой feature
 - Moleculer bootstrap для telegram_mcp подключен:
  - legacy standalone MCP transport удалён
   - HTTP runtime обслуживается самим `telegram_mcp`
   - в `gateway/both` режиме listener садится на общий `PORT` и `${ROOT_PREFIX}`
   - `${ROOT_PREFIX}/mcp`, `${ROOT_PREFIX}/webapp`, `${ROOT_PREFIX}/healthz`, `${ROOT_PREFIX}/gateway` обслуживаются текущим standalone HTTP слоем
   - текущая сервисная схема:
     - `telegramMcp.runtime` — config, redis, state store, telegram transport, shared runtime dependencies
     - `telegramMcp.sessionContext` — session metadata management
     - `telegramMcp.notify` — Telegram notify delivery
     - `telegramMcp.inbox` — inbox read/count/delete service
     - `telegramMcp.approval` — ask-user / human approval orchestration
     - `telegramMcp.browser` — Playwright browser service
     - `telegramMcp.collaboration` — linked-session collaboration service
     - `telegramMcp.mcpServer` — MCP tool composition and server factory
     - `telegramMcp.http` — MCP/WebApp request handler service for gateway aliases
   - `yarn build` и `yarn dev:gw:telegram` проходят на новой раскладке

# Сопутствующее описание можно найти в  
 - docs/gateway/*.md
