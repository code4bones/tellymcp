# TODO

Current state:

- Moleculer migration for `telegram_mcp` is done.
- MCP works through `${ROOT_PREFIX}/mcp`.
- Mini App `Live` works through `${ROOT_PREFIX}/webapp`.
- local agent pairing, browser flow, and local partner collaboration are working.
- GraphQL subscriptions are working again after the `graphql-ws` downgrade fix.

Plan for tomorrow:

- [ ] Run a full local collaboration smoke pass:
  - `Link`
  - `Ask / Share / Reply / Handoff`
  - `SHARE_INDEX.md`
  - partner wake-up and note reading flow
- [ ] Run a full local browser smoke pass:
  - `open`
  - `reload`
  - `click/fill/press/wait`
  - screenshot save
  - screenshot send to Telegram
- [ ] Remove or reduce temporary `telegram_mcp` debug logs added during the gateway/webapp migration.
- [ ] Do a short documentation pass for the final local architecture:
  - Moleculer services layout
  - `${ROOT_PREFIX}` routes
  - local collaboration workflow
  - browser workflow
- [ ] Start the distributed gateway track:
  - define the first real `client | gateway | both` flow
  - pick the first metadata model for remote note relay
