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

- `transportContent.ts`
  Pure inbound/detail helpers.
  Contains:
  - inbox/file/storage/screenshot detail renderers
  - incoming text extraction
  - incoming attachment extraction

- `transportMenuText.ts`
  Pure menu screen text builders.
  Contains:
  - link/partner/local/projects text assembly
  - collab tools text assembly

- `transportLive.ts`
  Pure Live/WebApp helpers.
  Contains:
  - live availability checks
  - live target URL construction
  - launch keyboard builder
  - launcher text builder

- `transportTmuxActions.ts`
  Tmux action delegate.
  Contains:
  - tmux nudge flow
  - target recovery and user notices
  - prompt scan detection/notification
  - tmux buffer capture helpers

- `transportLiveActions.ts`
  Live action delegate.
  Contains:
  - live launcher delivery
  - relay/local live URL orchestration
  - live launch keyboard construction

- `transportAdminActions.ts`
  Gateway admin action delegate.
  Contains:
  - admin client/session menus
  - admin client session detail/live/bind callbacks
  - client `.env` export generation

- `transportBroadcastActions.ts`
  Broadcast action delegate.
  Contains:
  - linked broadcast flow
  - collab broadcast flow
  - gateway/local target fanout
  - pending broadcast cancel/cleanup

- `transportPartnerActions.ts`
  Partner note action delegate.
  Contains:
  - partner note prompt flow
  - executor/request routing
  - pending partner note cancel/resolve
  - current-session instruction enqueue

- `transportFileHandoffActions.ts`
  File handoff action delegate.
  Contains:
  - handoff prompt flow
  - pending handoff cancel/resolve
  - partner file delivery
  - local-agent file handoff materialization

- `transportMenuCallbacks.ts`
  Generic callback delegate.
  Contains:
  - inbox/storage/screenshots open/get/delete callbacks
  - session selection callback
  - partner entry and partner files callbacks
  - link-target callback

- `transportProjectActions.ts`
  Project/collab action delegate.
  Contains:
  - project/member/live approval callbacks
  - project create/join/delete/leave pending flow
  - project member note/file/live entry actions

- `transportProjectState.ts`
  Project/gateway state delegate.
  Contains:
  - gateway client registration for project scope
  - project/session/history fetches
  - active project activation/sync
  - project/member/admin payload resolution
  - relay session binding construction

- `transportProjectView.ts`
  Project/collab screen delegate.
  Contains:
  - projects/collab menu text assembly
  - collab history export
  - project members/session detail/file screens

- `transportMenuState.ts`
  Session menu state delegate.
  Contains:
  - main/sessions/inbox/storage/browser/screenshots/link/partner/local screens
  - settings/buffer/developer/unpair/prune screens
  - associated menu text assembly

- `transportProjectMenus.ts`
  Project-specific grammy menu factory.
  Contains:
  - projects dynamic menu
  - collab tools menu
  - collab delete dynamic menu

- `transportPayloadState.ts`
  Menu payload persistence delegate.
  Contains:
  - menu payload creation for inbox/file/session/link/admin/project/live approval targets
  - shared TTL/expiry wiring for payload records

- `transportAdminMenus.ts`
  Admin-specific grammy menu factory.
  Contains:
  - admin root menu
  - admin clients dynamic menu
  - admin session list/detail tools menus

- `transportXchangeState.ts`
  Session xchange/storage state delegate.
  Contains:
  - filesystem xchange listing
  - screenshot/storage/upload file filtering
  - reconciliation of stored file metadata against real files

- `transportMenuFingerprints.ts`
  Menu fingerprint and button-label delegate.
  Contains:
  - main/inbox/storage/screenshots/sessions/link fingerprints
  - dynamic inbox/screenshots/link button labels

- `transportMenuFactories.ts`
  Remaining non-project grammy menu factory.
  Contains:
  - main/browser/local/link/partner/buffer/settings/developer menus
  - inbox/storage/screenshots/sessions dynamic menus
  - inbox/storage/screenshot detail action menus

- `transportMenuFlow.ts`
  Menu/render/live/buffer flow delegate.
  Contains:
  - menu screen rendering
  - help/live launcher flow
  - active-session info flow
  - tmux buffer send flow
  - menu-state screen routing wrappers
  - pending-interaction cleanup for menu contexts

- `transportMessageFlow.ts`
  Inbound Telegram message delegate.
  Contains:
  - top-level message routing
  - `/menu`, `/help`, `/link`, `/admin`, `/auth` command handling
  - reply/waiter resolution
  - relay inbox routing
  - attachment upload and inbox capture flow

- `transportGatewayDirectory.ts`
  Gateway admin directory delegate.
  Contains:
  - gateway client listing
  - connected client listing
  - merged admin client view
  - gateway client session listing

- `transportRequestFlow.ts`
  Human request/notification delegate.
  Contains:
  - outbound Telegram requests
  - outbound Telegram notifications
  - gateway request proxying for headless clients
  - waiter lifecycle and reply resolution
  - admin registration notices

- `transportEventActions.ts`
  Gateway/runtime event delegate.
  Contains:
  - tools mismatch notices
  - gateway/client version mismatch notices
  - live approval request delivery
  - live approval resolution delivery

- `transportLifecycleActions.ts`
  Startup/lifecycle delegate.
  Contains:
  - startup inbox nudge recovery
  - startup Telegram notices
  - package update notice injection

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
4. Detail/content helpers
5. Menu text builders
6. Live helper extraction
7. Tmux action delegation
8. Live action delegation
9. Admin action delegation
10. Broadcast action delegation
11. Message routing delegation
12. Gateway directory delegation
13. Request/waiter delegation
14. Event delegation
15. Lifecycle delegation

## Next Recommended Extractions

- `transportSessionActions.ts`
  Remaining rename/unpair/prune/session-management actions.

- `transportProjectCallbacks.ts`
  Remaining project open/select/detail callback orchestration still left in `transport.ts`.

- `transportAttachmentStore.ts`
  File download, xchange file persistence, and upload metadata storage.
11. Partner action delegation
12. File handoff delegation
13. Generic callback delegation
14. Project action delegation
15. Project state delegation
16. Project view delegation
17. Session menu-state delegation
18. Project menu-factory delegation
19. Payload-state delegation
20. Admin menu-factory delegation
21. Xchange-state delegation
22. Menu fingerprint delegation
23. Remaining menu-factory delegation
24. Menu/live/render flow delegation
25. Remaining flow extraction

## Next Recommended Extractions

- `transportMessageFlow.ts`
  Telegram inbound message orchestration:
  - top-level message routing
  - admin auth command handling
  - pairing command handling
  - waiter reply resolution
  - inbox capture / relay delivery
  - attachment download/materialization

- `transportGatewayInboxFlow.ts`
  Gateway relay inbox routing and attachment-heavy local/remote inbox delivery.
