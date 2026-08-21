# TODO

Accepted work that has not started yet. Move an item to `DOING.md` when work
actually begins; do not use this file for architectural invariants or recurring
maintenance policy.

## Reliability (verified still open on `2026-08-07`, see `docs/CODE_REVIEW_2026-07-13.md` for detail)

- make `sendPartnerNoteRecord()` (`gateway.service.ts`) transactional across message,
  artifact, and delivery inserts, with an idempotency key for retries (H-04)
- atomically claim `queued` deliveries (`FOR UPDATE SKIP LOCKED` or equivalent) and
  guard the `delivery_event` WS handler in `gateway-socket.service.ts` against acking
  a delivery whose target session is missing, matching the guard
  `handleLocalIncomingDelivery` already has (H-05)
- make xchange writes/deletes (`resolvePathInsideRoot`, `writeXchangeRelativeFile`,
  `deleteXchangeFile` in `terminal/client.ts`) symlink-safe via `realpath()`, matching
  the fix already applied to the `get_file` read path (H-06)
- serialize browser-recording event handling per recording id and throttle
  `session.json`/Redis writes instead of one write per event (M-01)
- reuse a single xchange SQLite connection instead of reopening + reapplying schema on
  every list/get/upsert/mark-read call (M-02)
- wrap PTY prepare+spawn in try/catch to avoid orphaned temp dirs, and delete stopped
  records from the PTY `sessions` map instead of accumulating them forever (M-03)
- rename shared `firefox*` browser-attach infra and widen the persisted `backend`
  literal beyond `"firefox-attached"` before more Chrome-session data accumulates
  under the wrong label (14 occurrences across 8 files as of `2026-08-07`)

## Runtime

- verify browser relay stability under repeated gateway-routed actions

## Managed Agent Providers

- add optional progress rendering from app-server item/turn events without
  flooding Telegram; completed final messages are already delivered
- decide whether active Codex thread ids should persist across a TellyMCP client
  restart or whether a new managed thread per launch remains the safer default
- evaluate the equivalent supported Claude SDK surface before adding a
  structured Claude adapter
- decide whether the selected agent/provider should persist in
  `.mcpsession.json` and auto-start on subsequent plain `tellymcp run`
- add provider-specific model/profile selection without exposing arbitrary shell
  command injection through Telegram callbacks

## UX

- evaluate whether `Info` and project screens need more concise summaries
- review current Telegram menu wording after the removal of `Local` and inbox flows

## Packaging

- smoke-test npm global install on a clean machine
- smoke-test `tellymcp codex-plugin install` on a clean Codex host
- verify webhook mode setup docs against a real nginx deployment

## Data Model

- continue removing legacy assumptions around `gateway_sessions.project_uuid`
