# TODO

Current focus areas after the gateway-first refactor:

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
- keep project binding and live console binding paths explicit and observable

## Managed Agent Providers

- add an SDK-native Codex adapter behind the provider contract when structured
  thread ids and streamed final responses are needed; keep the PTY adapter as
  the console-compatible default
- evaluate the equivalent supported Claude SDK surface before adding a
  structured Claude adapter
- decide whether the selected agent/provider should persist in
  `.mcpsession.json` and auto-start on subsequent plain `tellymcp run`
- add provider-specific model/profile selection without exposing arbitrary shell
  command injection through Telegram callbacks

## Docs

- keep `TOOLS.md` aligned with the actual MCP surface
- keep screenshots folder labeled as current vs legacy
- keep internal docs aligned with the gateway-first model

## UX

- evaluate whether `Info` and project screens need more concise summaries
- review current Telegram menu wording after the removal of `Local` and inbox flows

## Packaging

- smoke-test npm global install on a clean machine
- smoke-test `tellymcp codex-plugin install` on a clean Codex host
- verify webhook mode setup docs against a real nginx deployment

## Data Model

- continue removing legacy assumptions around `gateway_sessions.project_uuid`
- keep `gateway_live_consoles` as the canonical live source
- keep project relations in dedicated binding tables
