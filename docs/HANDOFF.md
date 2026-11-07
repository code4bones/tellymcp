# HANDOFF

## Current continuation: detach/attach (2026-11-07)

This section supersedes the historical snapshot below. The user selected
detach/attach as the next feature. Single-binary packaging is off the active
plan: `T-TELLYMCP-033` is cancelled and research decision `D-TELLYMCP-038`
is archived in Marrow. Retain the research; resume only on a new request.

### Repository and installed client

- Runtime baseline: `main` at `be12ca8`, package and locally installed client
  **0.0.43**. GitLab and GitHub are synchronized. This documentation may have
  a newer commit; use the latest `main` when preparing the feature branch.
- `feature/detached-sessions` was updated from latest `main` (`13a14e0`) by
  merge **`b34bb74`**, preserving runtime baseline **0.0.43**. Stage-1 prototype
  changes are in the local working tree; they have not been committed/pushed.
  The earlier design-only commit `5ef06a2` remains on both remotes.
- Read `docs/DETACHED_SESSIONS_DESIGN.md`, especially **Stage 1 prototype**,
  for the confirmed restoration/query contract, bounds, evidence and limits.
  The design's original **0.0.38** baseline is historical.
- `autotests`, `gateway`, `onebot` and `ws` are already ancestors of `main`;
  they contain no unmerged commits. Branch audit found no stash or other worktree.
- Canonical shared client profile: `~/.tellymcp/.env`, mode `0600`, directory
  `0700`. `~/.env-client` is a compatibility symlink. All 45 active settings
  were preserved during migration. Never print credentials or replace user edits.
- Config precedence: explicit `--env`, saved `.mcpsession.json` profile,
  workspace `.env`, then the shared home profile. Workspace identity stays local.
  Current workspace keeps session `New` and its stable gateway client UUID.
- **0.0.41:** use `TELLYMCP_HTTP_PROXY` / `TELLYMCP_NO_PROXY`; preserve the
  standard proxy environment inherited by the shell and agent.
- **0.0.42:** `run --ws 9999` enables the extension bridge on that port for
  this launch. **Without `--ws`, use env settings**, including enabled/port.
  `init client` without a directory creates the shared home profile.
- **0.0.43:** normal Unix PTY `read EIO` is quiet, including before `onExit`;
  other fd errors and the actual shell exit status are preserved.
- Local updates use `npm pack` (builds runtime and extensions), then
  `npm install -g ./deadragdoll-tellymcp-<version>.tgz`, then a client restart.
  Current install belongs to NVM Node **24.13.0**. No npm registry publication
  or automatic local updater was added. Codex plugin and Playwright browsers
  have separate CLI install commands.

### Production deployment — keep distinct from the client version

- Gateway remains **0.0.40**, image `tellymcp-gateway:0.0.40-39cd1273b39f` on
  **savant**, not fr-vpn. Read-only inspection on 2026-11-07 found all five
  Compose services running and healthy. No gateway release accompanied the
  local client 0.0.41–0.0.43 updates.
- `/opt/tellymcp`: `docker-compose.yml`, secret `.env-gateway` (`0600`),
  `nginx/default.conf`, `state/`, `backups/`, `releases/`. PostgreSQL 16, Redis 7
  and RabbitMQ 3 are dedicated private containers with persistent volumes.
- HTTPS domain `tellymcp.deadragdoll.net` -> existing Nginx Proxy Manager ->
  `192.168.1.68:18088` -> container nginx -> private gateway `8080`.
  HTTP client endpoint: `https://tellymcp.deadragdoll.net/api/gateway`;
  WSS: `wss://tellymcp.deadragdoll.net/api/gateway/ws`.
- GitLab CI uses shell runner tag **`telly_savant`**. Main/MR builds produce
  npm `.tgz` artifacts and gateway images. A matching **`vX.Y.Z` tag** deploys
  production after main-ancestry/version checks. A main push alone does not
  deploy. Latest production release: `v0.0.40`, pipeline **7527**.
- Telegram uses **polling**, `TELEGRAM_WEBHOOK_ENABLED=false`: inbound webhook
  traffic cannot reach this network. User confirmed messages, menu and Live work.
  Keep polling during future deploys and rollbacks; older snapshots have webhook
  enabled. Telegram egress still uses the existing HTTP proxy on fr-vpn:33128.
- Old fr-vpn PM2 gateway, source infrastructure and temporary legacy URL proxy
  are stopped; data/backups remain. The fr-vpn host/HTTP egress proxy still matters.
  Do not use `dev2.sh` or PM2 to deploy the gateway again.
- Manual recovery: `cd /opt/tellymcp`, then
  `docker compose --env-file .env-gateway up -d`. Never print the full env or
  interpolated Compose config. Deployment rollback restores app/config, not DB.
- Detailed recovery paths, volume names and migration incidents:
  Marrow **`I-TELLYMCP-039`**. Client handoffs: **042**, **043**, **044**.

### T-TELLYMCP-040 prototype and next steps

1. Read this section, Marrow result **I-TELLYMCP-046** (T040 is in review) and the design's prototype
   contract. Refresh Git status; preserve the current uncommitted prototype.
2. Stage 1 now has `TerminalRestorationPrototype`, a snapshot adapter and VT
   query framing under `features/detached-terminal/model/`, plus replay and real
   PTY integration tests. `@xterm/addon-serialize` **0.13.0** works with xterm
   **5.5.0**, with tested corrections for omitted state and alternate SGR bleed.
   One headless owner answers supported queries in both attached/detached
   states; the display stream removes queries to avoid duplicate replies.
   Ordered snapshot/live frames, input ACK, resize, Unicode, queue limits,
   stale-controller rejection and draining final output before exit are tested.
   The standalone manual harness is
   `yarn tsx tools/prototype-terminal-restoration.ts`: Ctrl+] detaches, a attaches,
   q while detached stops. It owns one clean Bash and no broker/identity/services.
   Neither the prototype nor harness is connected to ordinary `tellymcp run`.
3. Then follow existing Marrow tasks: **041** background owner/private local
   protocol/discovery; **042** `run --detach`, `sessions`, `attach`, `stop` and
   terminal cleanup; **043** account authorization and one controller lease;
   **044** remote attach through the gateway; **045** real console checks/docs/release.
4. Keep one package, one PTY/agent/console identity and the existing raw terminal
   experience. No tmux dependency or client Redis. Attach starts no duplicate
   shell, agent, broker or browser bridge. Preserve the shared profile, scoped
   proxies, `--ws` semantics and workspace marker.
5. Local detach/reattach comes first. Remote attach must authenticate ownership
   of the target account; the shared gateway bearer alone is insufficient.
   Disconnecting an attachment must leave the owner and PTY alive; actual shell
   exit or explicit stop must shut down owned services with the real exit status.
6. Stage 1 is a fidelity experiment, not a daemon or product detach command.
   Its fixed palette and unsupported terminal extensions are documented in the
   design. Integrate one authoritative screen into `ptyRegistry` in stage 2;
   do not retain the prototype as a second screen/query owner. Do not create a
   release tag or deploy the experimental branch as part of this prototype.

Latest source checks including the prototype: build/lint passed;
**396 tests passed, 2 skipped** (18 new restoration/PTY cases).
Real PTY tests preserved shell/interactive-child PIDs, detached progress, raw
Unicode input and one reply per query through attach/detach, final output and
exit 7. The manual harness reported Bash PID `1411199` both before and after
detach/reattach, delivered `FINAL_OUTPUT`, and propagated exit 7.
This is tool-PTY evidence; two physical emulator and real provider checks
are still pending. No package install, release or production mutation occurred.
Installed client auto-discovery, authenticated gateway HTTPS/WSS and foreground
shell exit were verified in the previous client work. Optional Playwright Chromium
binaries are missing in the local installation. Actual SSH disconnect survival,
product detach/attach, Codex/Claude terminal fidelity and remote attach remain
future acceptance checks.

## Historical snapshot (2026-08-07)

The material below is retained for history. Its versions, deployment assumptions
and backlog statuses are not current; use the continuation section above and Marrow.

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
