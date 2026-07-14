# HANDOFF

Operational snapshot for the next session.

Last updated: `2026-07-14`

## Current State

- branch: `main`
- runtime model: gateway-first
- terminal model: built-in PTY only
- workspace marker: `.mcpsession.json` only
- persistence split: Redis is gateway-only; clients use process-local transient
  state and keep their stable gateway client UUID in `.mcpsession.json`
- browser attach: Firefox + Chrome local extensions are implemented and exported through CLI
- browser recording: structured bundles under `.mcp-xchange/web/<tab-title>-<timestamp>/`

## What Was Just Finished

- ChatGPT/Claude OAuth connector support was implemented around the existing
  Streamable HTTP MCP endpoint
- the connector was validated in production with ChatGPT on
  `https://drd.undoo.ru/api/mcp`; reconnect and tool refresh succeeded
- OAuth discovery, PKCE authorization-code exchange, RS256 JWT bearer auth,
  exact redirect allowlisting, confidential-client auth, JWKS, dual MCP auth,
  Nginx routes, signing-key CLI support, and safe diagnostics are present
- the production incident was caused by entering the OAuth base `/api` in the
  ChatGPT `Connection` field; the required endpoint is `/api/mcp`
- detailed continuation notes are in `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md`
- browser-attach connectivity fixes landed:
  - Firefox global recorder injection removed
  - Firefox/Chrome fetch wrapper no longer blocks page `fetch()` on body capture
  - Chrome MV3 keepalive/reconnect backstop now uses `alarms`
- browser-attach server-side fixes landed:
  - reconnect close-race fixed
  - `startRecording()` now checks `tabId`
  - `stopRecording()` works against persisted state after restart and finalizes bundles when session cwd exists
- browser attached-tab output schemas were relaxed from strict URL validation to plain strings where needed
- browser-attach review/plan docs were updated to reflect fixed vs still-open items
- `DECISIONS.md` was created as the living source of truth for accepted project decisions
- browser-attach WS inputs now have Origin checks, strict bounded schemas, rate limiting,
  stale-heartbeat reaping, contained handler failures, and deterministic duplicate replacement
- Chrome attach extension `0.0.2` uses a Manifest V3-compatible static executor for DOM/click/press
  and returns correlated action errors instead of remote WS timeouts

## Files To Read First

1. `DECISIONS.md`
2. `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md` when continuing connector work
3. `docs/CHAT_CONNECTOR.md`
4. `docs/DEVELOPMENT.md`
5. `docs/IMPLEMENTATION_PLAN.md`
6. `TOOLS.md`
7. `docs/CODE_REVIEW_browser-attach.md`
8. `docs/CODE_REVIEW_browser-attach_FIXES.md`

## Verified Commands

These passed in this workspace after the latest browser-attach fixes:

```bash
yarn build
yarn build:extensions
yarn lint
yarn test
```

During the OAuth implementation, the full suite reached 150 passing tests and
build/lint passed before the final request/response diagnostic logging change.
At the user's request, no validation suite was run after that last logging-only
change. Do not describe the final working tree as fully revalidated until that
is done explicitly.

## Known Accepted Invariants

- do not reintroduce pairing-first, inbox-first, or tmux-first flows
- do not add hidden routing/session fallbacks
- gateway-side prompt scanning is event-driven and should not depend on manual `/menu`
- blocker actions stay limited to digits `1..N`, `Enter`, `Esc`
- attached browser control state is backend-owned, not popup-owned

## Known Remaining Follow-Ups

These are known backlog items, not regressions from the last pass:

1. browser-attach naming debt still exists:
   - shared infra is still named `firefox*`
   - persisted backend literals are still `"firefox-attached"`
2. attached-browser injected export semantics still differ across Chrome/Firefox for some bare `window.foo = ...` cases
3. `activeTab` in attach registry can still become stale after tab close
4. DB-level functions/views/triggers for some gateway logic are still only a deferred idea, not an accepted direction

## If Continuing Browser-Attach Work

Primary files:

- `src/services/features/telegram-mcp/src/features/browser/model/browserService.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachRegistry.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/browserRecordingBundle.ts`
- `packages/firefox-attach-extension/src/*`
- `packages/chrome-attach-extension/src/*`

## If Continuing Docs Work

Keep these aligned together:

- `README.md`
- `README-ru.md`
- `TOOLS.md`
- `docs/DEVELOPMENT.md`
- `docs/IMPLEMENTATION_PLAN.md`
- `DECISIONS.md`

## Working Tree Note

At the time of writing, the connector work is uncommitted and spans source,
tests, env templates, Nginx, and documentation. The primary new files are:

- `src/services/features/telegram-mcp/src/app/oauthFacade.ts`
- `tests/oauthFacade.test.ts`
- `docs/CHAT_CONNECTOR.md`
- `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md`

The user supplied `docs/CHAT_CONNECTOR_OAUTH_GUIDE.md` and
`nginx/tellymcp.gw.conf`; preserve them. The Nginx file was intentionally
edited in place as part of the connector work.
