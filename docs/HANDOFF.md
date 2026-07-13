# HANDOFF

Operational snapshot for the next session.

Last updated: `2026-07-13`

## Current State

- branch: `main`
- runtime model: gateway-first
- terminal model: built-in PTY only
- workspace marker: `.mcpsession.json` only
- browser attach: Firefox + Chrome local extensions are implemented and exported through CLI
- browser recording: structured bundles under `.mcp-xchange/web/<tab-title>-<timestamp>/`

## What Was Just Finished

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

## Files To Read First

1. `DECISIONS.md`
2. `docs/DEVELOPMENT.md`
3. `docs/IMPLEMENTATION_PLAN.md`
4. `TOOLS.md`
5. `docs/CODE_REVIEW_browser-attach.md`
6. `docs/CODE_REVIEW_browser-attach_FIXES.md`

## Verified Commands

These passed in this workspace after the latest browser-attach fixes:

```bash
yarn build
yarn build:extensions
yarn lint
yarn test
```

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
4. server-side stale-heartbeat reaping for attached-browser instances is still optional hardening, not implemented
5. DB-level functions/views/triggers for some gateway logic are still only a deferred idea, not an accepted direction

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

At the time of writing, this session added:

- `DECISIONS.md`
- `HANDOFF.md`
