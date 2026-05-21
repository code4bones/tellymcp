# Telegram Integration Index

This directory holds the decomposed Telegram transport. `transport.ts` is now the main composition root; behavior is split into delegates next to it.

## Core

- `transport.ts`
  Main composition root.
  Owns shared runtime state plus the final runtime shell:
  start/stop, admin auth gate, top-level gateway HTTP helper, file/document helpers, and TOOLS/version glue.

- `transportConstructorWiring.ts`
  Constructor-time composition builder.
  Creates delegate graph, menu graph, menu registration, and the cross-wired closures between Telegram transport modules.

- `transportTypes.ts`
  Transport-only types for menu context, gateway/admin records, pending interaction records, attachment descriptors, waiter records, and related shapes.

## Pure Helpers

- `transportUtils.ts`
  Stateless helpers:
  command parsing, URL/path normalization, escaping, text chunking, menu payload parsing, local handoff helpers.

- `transportFormatting.ts`
  Small formatting helpers:
  inbox/file/storage/session labels, inbox text assembly, partner-note text parsing.

- `transportContent.ts`
  Inbound/detail helpers:
  incoming text/attachment extraction, inbox/file/storage/screenshot detail rendering.

- `transportMenuText.ts`
  Pure screen text builders for menu pages.

- `transportLive.ts`
  Pure Live/WebApp helpers:
  live availability checks, live URL construction, launcher keyboard/text builders.

- `transportAdminView.ts`
  Admin merge/view helpers:
  registered + connected gateway clients, collab + all session views, admin client list text.

- `transportMenuFingerprints.ts`
  Dynamic menu fingerprint and label helpers.

## Menu/Render State

- `transportMenuState.ts`
  Session menu-state screens and stateful page rendering inputs.

- `transportMenuFlow.ts`
  Menu/render flow:
  render helpers, help/live launcher flow, active-session info, tmux buffer send, pending-interaction cleanup.

- `transportPayloadState.ts`
  Menu payload persistence and lookup helpers.

- `transportMenuFactories.ts`
  Non-project grammy menu factories.

- `transportAdminMenus.ts`
  Admin grammy menu factories.

- `transportProjectMenus.ts`
  Project/collab grammy menu factories.

- `transportMenuCallbacks.ts`
  Generic callback handlers for inbox/storage/screenshots/session/link/partner flows.

- `transportMenuShell.ts`
  Top-level grammy shell registration:
  polling error handler, callbackQuery routing, and the top-level `message` hook.

## Runtime/Delivery Actions

- `transportTmuxActions.ts`
  Tmux flow:
  nudges, prompt scan, cooldown/fingerprint logic, tmux buffer capture helpers.

- `transportLiveActions.ts`
  Live/WebApp action flow:
  launcher delivery, relay/local live URL orchestration, keyboard delivery.

- `transportBroadcastActions.ts`
  Broadcast flow:
  linked and collab fanout, gateway/local routing, pending broadcast resolution/cancel.

- `transportPartnerActions.ts`
  Partner-note flow:
  prompt start, request/share routing, pending note resolution/cancel, current-session enqueue.

- `transportFileHandoffActions.ts`
  File handoff flow:
  prompt start, pending handoff resolution/cancel, partner file delivery, local materialization.

- `transportLinkingActions.ts`
  Local link/session-pair flow:
  link/unlink persistence, link button behavior, local/projects entry-point routing.

- `transportSessionActions.ts`
  Session-management flow:
  unpair, rename prompt/commit, prune-all.

- `transportProjectEntryActions.ts`
  Project entry/navigation flow:
  create/join prompts, project open, delete selection, leave current project.

- `transportProjectActions.ts`
  Project/collab callbacks and pending project actions:
  member open/note/live, live approval, project delete/leave/detail, create/join completion.

- `transportAdminActions.ts`
  Gateway-admin flow:
  client/session admin menus, client session detail/live/bind callbacks, `.env-client` export.

- `transportEventActions.ts`
  Runtime/gateway event delivery:
  tools mismatch notices, version mismatch notices, live approval request/resolution notices.

- `transportLifecycleActions.ts`
  Startup/lifecycle flow:
  startup inbox recovery, startup notices, package update notices.

- `transportRequestFlow.ts`
  Human request/notification flow:
  outbound Telegram requests/notifications, gateway request proxying for headless clients, waiter lifecycle, admin registration notices.

- `transportMessageFlow.ts`
  Inbound Telegram message flow:
  top-level message routing, `/menu`/`/help`/`/link`/`/admin`/`/auth`, waiter replies, relay inbox routing, attachment upload/capture.

## Gateway/Project State

- `transportGatewayDirectory.ts`
  Gateway admin directory queries:
  gateway client listing, connected client listing, merged admin client view, client session listing.

- `transportProjectState.ts`
  Gateway/project/session state helpers:
  client registration, project/session/history fetches, active project sync, payload resolution, relay session binding context.

- `transportProjectView.ts`
  Project/collab screen rendering:
  projects/collab page text, collab history export, project members/session detail/file screens.

- `transportProjectEvents.ts`
  Project membership/project deletion notices routed back to bound Telegram principals.

- `transportGatewayActions.ts`
  Gateway/project wrapper actions:
  partner-note dispatch, gateway directory/project access, active-project synchronization.

- `transportProjectEntryActions.ts`
  Project entry/navigation flow:
  create/join prompts, project open, delete selection, leave current project.

## Persistence / Xchange

- `transportAttachmentStore.ts`
  Attachment persistence:
  upload metadata persistence, object-store materialization, Telegram file download flow, attachment batch orchestration.

- `transportDocumentActions.ts`
  Document send/retry helpers:
  Telegram document retry with backoff for menu/admin/project flows.

- `transportXchangeState.ts`
  Session xchange/storage state:
  xchange listing, screenshot/storage/upload file filtering, file metadata reconciliation.

- `transportContext.ts`
  Telegram identity/locale/i18n context:
  principal extraction, locale resolution, localized text lookup, gateway actor profile.

- `transportOutputActions.ts`
  Outbound Telegram output path:
  chunked send, message retry, reply/edit helpers.

- `transportTmuxRuntime.ts`
  Tmux scheduler/runtime loop:
  prompt-scan interval, debounce timers, inbox nudge scheduling, typing action.

## External Helpers

- `messageFormat.ts`
  Formatting for outbound request/notification messages.

- `collabUi.ts`
  Collaboration-specific text builders.

- `collabSemantics.ts`
  Collaboration semantic helpers.

- `proxyFetch.ts`
  Telegram HTTP fetch creation, including proxy-aware transport setup.

## Current Split Strategy

The safe order has been:

1. Types and pure helpers
2. Text/render helpers
3. Menu state and menu factories
4. Runtime action delegates
5. Message/request/event/lifecycle delegates
6. Callback shell and remaining orchestration

## Next Recommended Extractions

- `transportLifecycleShell.ts`
  Start/stop/admin-access middleware and the remaining top-level runtime shell still live in `transport.ts`.

- `transportToolsSyncEvents.ts`
  TOOLS/version mismatch event glue can be split further now that constructor wiring is out.
