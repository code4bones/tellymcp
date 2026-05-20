# Telegram Integration Index

This directory now holds the Telegram transport in smaller pieces. Use this as the entry map.

## Files

- `transport.ts`
  Main orchestrator.
  Wires grammy menus, runtime services, gateway calls, tmux nudges, live relay, inbox routing, and human-transport behavior.

- `transportTypes.ts`
  Local transport-only TypeScript types.
  Contains menu context types, pending interaction records, gateway admin/client view records, and attachment/helper data shapes.

- `transportUtils.ts`
  Pure helpers with no transport state.
  Contains:
  - Telegram command parsing
  - URL/base-path helpers
  - markdown/html escaping
  - text chunking
  - admin client title/button builders
  - local handoff note helpers

- `transportFormatting.ts`
  Small presentation/data-shaping helpers used by `transport.ts`.
  Contains:
  - admin client session button labels
  - inbox/file/storage/session labels
  - inbox text builder
  - partner note text parser

- `transportAdminView.ts`
  Admin-specific merge/view helpers.
  Contains:
  - merge of registered + connected gateway clients
  - merge of collab + all sessions for a client
  - admin clients menu text builder

- `messageFormat.ts`
  Formatting for outbound request/notification messages.

- `collabUi.ts`
  Collaboration-specific text builders for project/member detail views.

- `collabSemantics.ts`
  Collaboration semantic helpers such as target-kind checks.

- `proxyFetch.ts`
  Telegram HTTP fetch setup, including proxy-aware fetch creation.

## Current Split Strategy

The decomposition is being done in low-risk layers:

1. Types
2. Pure helpers
3. Presentation/formatting helpers
4. Flow extraction

## Next Recommended Extractions

- `transportAdmin.ts`
  Gateway admin menus, client/session listing, env generation.

- `transportLive.ts`
  Live launcher, approval flow, relay launcher payloads.

- `transportBroadcast.ts`
  Broadcast, partner notes, file handoff prompts.

- `transportTmux.ts`
  Tmux nudge, prompt scan, failure notices.
