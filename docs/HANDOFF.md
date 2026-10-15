# HANDOFF

Operational snapshot for the next session.

Last updated: `2026-08-07`

Note on this file's own history: the `2026-07-14` snapshot below was never fully
retired — a `2026-07-15` commit touched only the "Current State" bullets (added the
Redis-gateway-only line) without bumping this header or updating "What Was Just
Finished"/"Known Remaining Follow-Ups", and several commits after `2026-07-14` were
never reflected here at all until this pass. Treat any single bullet list in this file
as current only as of the date next to it, not as of the header date, until this file
is next fully reconciled against `git log`.

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
  `https://your-gateway-domain.example/api/mcp`; reconnect and tool refresh succeeded
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

## What Landed After The 2026-07-14 Snapshot (added 2026-08-07)

The block above stopped being updated after `2026-07-14` even though development
continued. Confirmed from `git log` and `CHANGELOG.md` (not independently re-tested in
this pass beyond the source-audit described below):

- webapp live console made WS-only: the Mini App terminal now reconnects `/api/live/ws`
  with backoff instead of permanently downgrading to polling after one drop; polling
  was removed entirely. See `docs/CODE_REVIEW_webapp-live-console.md` for the
  before/after (commits `defc4b3`, `c1ed83a`).
- `get_file` / `get_file_list` MCP tools were added for chat-client file retrieval, with
  `url`/`image`/`text`/`base64` modes and symlink-safe read confinement (commit
  `25b07e9`; see `docs/DECISIONS.md` D-029). Read confinement is verified via
  `realpath()`; the equivalent write/delete paths in the same storage layer are not —
  see the H-06 update in `docs/CODE_REVIEW_2026-07-13.md`.
- Redis was made gateway/`both`-only; client runtimes no longer connect to Redis or
  require `REDIS_*`, and keep only the stable gateway client UUID in
  `.mcpsession.json` (see `docs/DECISIONS.md` D-031). This shipped alongside a local
  web configurator (`tellymcp configure`) and the `get_runtime_diagnostics` MCP tool.
- `tellymcp run`/`doctor`/postinstall now genuinely probe whether the native
  `node-pty` addon loads, instead of assuming successful compilation, with
  platform-aware remediation instructions (commit `9f093da`).
- `tellymcp doctor`'s WebSocket probe no longer strips error listeners before closing,
  fixing an unhandled-rejection crash on HTTP reject/timeout/early close (commit
  `c11319e`).
- The ChatGPT/Claude OAuth connector work described below shipped to production; see
  `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md` (unchanged, still current as its own file).

## Files To Read First

1. `DECISIONS.md`
2. `docs/CODE_REVIEW_2026-07-13.md` — the current-state review with per-finding
   `Status:` lines; the most reliable single source for "what reliability/security
   issues are actually still open right now" (added to this list on `2026-08-07`; it
   existed before but was never linked from here)
3. `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md` when continuing connector work
4. `docs/CHAT_CONNECTOR.md`
5. `docs/DEVELOPMENT.md`
6. `docs/IMPLEMENTATION_PLAN.md`
7. `TOOLS.md`
8. `docs/CODE_REVIEW_browser-attach.md`
9. `docs/CODE_REVIEW_browser-attach_FIXES.md`

## Verified Commands

These passed in this workspace as of `2026-07-14`, during the OAuth connector work
(full suite reached `150` passing tests; build/lint passed before the final
request/response diagnostic logging change, which was not re-validated per explicit
user instruction at the time):

```bash
yarn build
yarn build:extensions
yarn lint
yarn test
```

Not re-run since. At least `9` commits have landed after `2026-07-14` (see "What
Landed After The 2026-07-14 Snapshot" above), so do not describe the current working
tree as validated by this section — re-run these commands before relying on them.

## Known Accepted Invariants

- do not reintroduce pairing-first, inbox-first, or tmux-first flows
- do not add hidden routing/session fallbacks
- gateway-side prompt scanning is event-driven and should not depend on manual `/menu`
- blocker actions stay limited to digits `1..N`, `Enter`, `Esc`
- attached browser control state is backend-owned, not popup-owned

## Known Remaining Follow-Ups

These are known backlog items, not regressions from the last pass. Items 1-3 were
re-verified against current source on `2026-08-07`; items 5-10 were added on that date
because they were confirmed still open but had never been listed in this file before
(they were only tracked in `docs/CODE_REVIEW_2026-07-13.md`, and a reader who trusted
this "read first" file's follow-up list alone would have missed them entirely).

1. browser-attach naming debt still exists, with concrete counts as of `2026-08-07`:
   - shared infra is still named `firefox*` (`FirefoxAttachRegistry`, `FirefoxAttachServer`)
   - persisted `backend` literal is still `"firefox-attached"` in 8 files / 14
     occurrences; `"chrome-attached"` is never used, so Chrome-originated sessions are
     currently persisted under the wrong label
2. attached-browser injected export semantics still differ across Chrome/Firefox for some bare `window.foo = ...` cases
3. `activeTab` in attach registry can still become stale after tab close
4. DB-level functions/views/triggers for some gateway logic are still only a deferred idea, not an accepted direction
5. **gateway message enqueue is not transactional** (`H-04`): `sendPartnerNoteRecord()`
   in `gateway.service.ts:1862-2128` inserts message/artifacts/delivery as separate
   unwrapped statements; a retry after partial failure cannot dedupe. See
   `docs/CODE_REVIEW_2026-07-13.md` H-04.
6. **delivery consumption can duplicate or silently drop work** (`H-05`):
   `pollDeliveriesRecord()` claims no rows atomically, and the `delivery_event` WS
   handler at `gateway-socket.service.ts:2782-2814` acks unconditionally even when the
   target session is missing (one of its two call sites has a partial guard, the other
   does not). See `docs/CODE_REVIEW_2026-07-13.md` H-05.
7. **workspace symlink confinement covers reads only** (`H-06`): `get_file` and other
   read paths resolve `realpath()` before serving a file, but
   `resolvePathInsideRoot`/`writeXchangeRelativeFile`/`deleteXchangeFile` in
   `terminal/client.ts` — used for browser-recording writes, partner-artifact writes,
   and xchange-file deletion — remain lexical-only. Do not read `docs/DECISIONS.md`
   D-029's symlink-resolution language as covering these write/delete paths; it does
   not. See `docs/CODE_REVIEW_2026-07-13.md` H-06.
8. **browser recording events are unsynchronized and write-amplified** (`M-01`): no
   per-recording lock/queue; `session.json` is rewritten and Redis is `SET` on every
   single event with no throttling. See `docs/CODE_REVIEW_2026-07-13.md` M-01.
9. **xchange SQLite reopens and reapplies schema on every call** (`M-02`):
   `sqliteRecordStore.ts`'s `withDatabase` opens a fresh synchronous `DatabaseSync`,
   runs full DDL, and closes it on every list/get/upsert/mark-read. See
   `docs/CODE_REVIEW_2026-07-13.md` M-02.
10. **PTY records leak on failure and never get removed on stop** (`M-03`): a
    synchronous `spawn()` failure orphans a temp directory (no `try`/`catch` around
    prepare+spawn), and `stopPtyTarget` never deletes the record from the global
    `sessions` map, so `hasPtyTarget()` reports stopped targets as present
    indefinitely — an unbounded accumulation on long-lived processes. See
    `docs/CODE_REVIEW_2026-07-13.md` M-03.

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

## Working Tree Note (historical — 2026-07-14, superseded)

At the time of writing, the connector work was uncommitted and spanned source,
tests, env templates, Nginx, and documentation. The primary new files were:

- `src/services/features/telegram-mcp/src/app/oauthFacade.ts`
- `tests/oauthFacade.test.ts`
- `docs/CHAT_CONNECTOR.md`
- `docs/HANDOFF_CHAT_CONNECTOR_OAUTH.md`

The user supplied `docs/CHAT_CONNECTOR_OAUTH_GUIDE.md` and
`nginx/tellymcp.gw.conf`; these were preserved. The Nginx file was intentionally
edited in place as part of the connector work.

Update (`2026-08-07`): this work was committed (`ed94aa1`, "ChatGPT Connector") and
several more commits have landed on top of it since. As of this pass, `git status` on
`main` is clean — there is no uncommitted connector work outstanding. This section is
kept only as history of what that working tree once contained; do not use it to infer
the current working-tree state.
