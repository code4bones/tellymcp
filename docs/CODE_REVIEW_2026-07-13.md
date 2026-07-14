# Code Review: Current Project State

Review date: `2026-07-13`

Scope: current `main` at `ab34903`, including gateway HTTP/WS, Telegram WebApp auth,
gateway delivery, xchange/file storage, browser attach/recording, PTY lifecycle,
packaging, deployment examples, and current tests.

This review is a current-state snapshot. It supplements the existing browser-attach
reviews rather than replacing them.

## Remediation Status

- `CR-01`: **Resolved** on `2026-07-13` in commit `d0f497d`.
  Signed raw init data is now the only source for Telegram identity and other
  security-relevant fields. `initDataUnsafe` is consistency-checked, the alternate
  user-fields validation protocol and sensitive validation logging were removed, and
  regression coverage includes local and relay mismatch scenarios.
- `CR-02`: **Resolved** on `2026-07-14`.
  Gateway and combined modes now require `GATEWAY_AUTH_TOKEN` at startup, configured
  remote clients require it as well, and HTTP/WS authorization fails closed. Token
  comparison is constant-time, WS requests are rejected before upgrade, only the
  gateway health route remains public, and all env templates and standalone docs now
  require the transport token. The updated deployment was verified operationally on
  `2026-07-14`.
- Environment follow-up: the scope-only `GATEWAY_TOKEN` name referenced by this
  historical review was renamed to `GATEWAY_SCOPE_TOKEN`. It remains distinct from
  the required `GATEWAY_AUTH_TOKEN` transport credential.
- `H-01`: **Resolved** on `2026-07-14`.
  The direct `ws` dependency is now `8.21.0`, the MCP SDK and vulnerable transitive
  dependencies were refreshed to patched versions, and every inbound WebSocket
  protocol has an explicit payload limit. Gateway limits are also applied to the WS
  client. Regression coverage verifies that an oversized fragmented gateway message
  is rejected with close code `1009` without reaching the message handler.
- `H-02`: **Resolved** on `2026-07-14` under the accepted trusted-network model;
  peer authentication is intentionally out of scope. Browser-attach now
  accepts only Firefox/Chrome extension origins, requires `hello` before all other
  messages, validates every inbound union with bounded Zod schemas, contains async
  handler failures to the offending socket, reaps stale peers, rate-limits messages,
  and replaces duplicate instance connections deterministically. A native client on
  the reachable local/private network can spoof an extension Origin, so network reach
  to the configured attach listener remains an explicit trust boundary.
- `H-03`: **Resolved** on `2026-07-14` with a single code-level
  `MAX_BODY_SIZE = 16` MiB policy. HTTP readers reject oversized declared or streamed
  bodies with `413`; WebSocket protocols use the same byte limit; gateway clients,
  inline/base64 artifacts, workspace file reads, and decoded deliveries are bounded
  before the relevant allocation or transport step. Inline/base64 remains the product
  model; object-storage/reference delivery is intentionally out of scope.
- `BA-01`: **Resolved** on `2026-07-14` in Chrome attach extension `0.0.2`.
  Manifest V3 tab actions no longer construct injected functions with `new Function`.
  DOM, click, press, fill, wait, and computed-style actions now use a static,
  self-contained `chrome.scripting.executeScript` function plus serialized arguments.
  Execution failures return a correlated `tab_action_result` instead of surfacing as
  `Remote action WS request timed out`. Recording snapshot injection was also made
  closure-free.

## Executive Summary

The project builds cleanly and the existing test suite passes. The two critical
authentication problems found by this review have now been remediated:

1. Telegram WebApp validation accepts an identity from unsigned `initDataUnsafe`
   after validating a different identity in signed raw init data.
2. Gateway HTTP and WebSocket authentication is optional, while the recommended
   deployment examples configure the then-named `GATEWAY_TOKEN` (now
   `GATEWAY_SCOPE_TOKEN`) instead of the separate
   `GATEWAY_AUTH_TOKEN` that actually protects the transport.

H-02 and H-03 are resolved under the documented browser-attach network trust boundary
and the shared 16 MiB body policy. Delivery atomicity/idempotency should follow next.

## Critical Findings

### CR-01 - Signed Telegram identity can be replaced through `initDataUnsafe`

Status: **Resolved** in `d0f497d` (`2026-07-13`).

Files:

- `src/services/features/telegram-mcp/src/app/webapp/auth.ts:344-424`
- `src/services/features/telegram-mcp/src/app/http.ts:869-940`
- `src/services/features/telegram-mcp/gateway-socket.service.ts:1686-1713`
- `src/services/features/telegram-mcp/gateway-socket.service.ts:1760-1800`

`validateTelegramWebAppInitData()` verifies the HMAC over `rawInitData`, but then
returns `user` and `authDate` from the separate client-provided `unsafeInitData`
object. It never parses the signed `user`/`auth_date` values from raw data and never
requires them to match the unsafe object.

Confirmed reproduction with a synthetic bot token:

```text
{"signed_user":111,"accepted_user":999,"official_match":true}
```

A user who owns valid raw init data for Telegram user `111` can therefore submit an
unsafe object for user `999`. The local bootstrap then looks up bindings and launch
state for `999` and can create a WebApp bearer session for that user's console.
Relay validation uses the same function and inherits the same issue.

Recommended fix:

1. Treat signed raw init data as the only identity source.
2. Parse `user`, `auth_date`, `query_id`, and `start_param` from the verified
   `URLSearchParams` values.
3. Remove `buildUserFieldsValidation()` as an alternate protocol unless a separately
   documented, cryptographically correct Telegram protocol requires it.
4. If `initDataUnsafe` remains an input, compare every security-relevant field with
   the signed value and reject any mismatch.
5. Add tests for raw/unsafe user mismatch, auth-date mismatch, expired data, malformed
   signed user JSON, and relay bootstrap validation.
6. Stop logging the raw validation check string, supplied/computed hashes, and the
   first 160 characters of rejected init data at info/warn level
   (`src/app/http.ts:879-893`, `979-985`).

### CR-02 - Documented gateway deployment is unauthenticated by default

Status: **Resolved** (`2026-07-14`).

The remediation requires `GATEWAY_AUTH_TOKEN` for gateway/both startup and for a
configured remote client, makes HTTP authorization fail closed, and rejects missing
or incorrect WS authorization with HTTP `401` before upgrade. Bearer values are
compared through fixed-length SHA-256 digests with `timingSafeEqual`. The env examples,
CLI templates, README files, standalone guides, `TOOLS.md`, and compose guidance now
document the separate transport token. Regression tests cover startup validation,
HTTP health/auth behavior, exact bearer matching, and real WS upgrade rejection and
acceptance. The updated deployment was verified by the operator on `2026-07-14`.

Files:

- `src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayHttpService.ts:353-360`
- `src/services/features/telegram-mcp/gateway-socket.service.ts:3220-3232`
- `.env.example.gateway:32-37`
- `.env.example.client:26-32`
- `config/templates/env.gateway.template:28-33`
- `config/templates/env.client.template:21-27`
- `docs/STANDALONE.md:56-87`
- `docs/tellymcp.gw.conf:61-74`
- `docker-compose.yml:63-71`

Both gateway transports explicitly allow all requests when `GATEWAY_AUTH_TOKEN` is
missing. The documented setup instead required the then-named `GATEWAY_TOKEN` and left
`GATEWAY_AUTH_TOKEN` commented out. These values are not interchangeable:
`GATEWAY_SCOPE_TOKEN` is used for gateway scope/binding, while `GATEWAY_AUTH_TOKEN` supplies
the HTTP/WS `Authorization` header.

The exposed surface includes state pruning, user/client registration, session and
project enumeration, Telegram notification/file routes, live terminal actions, and
gateway WS client registration. For example, unauthenticated
`/gateway/relay/console-message` can submit text plus Enter to a live console and
`/gateway/admin/prune-state` can delete gateway state.

The nginx example publicly proxies all `/api/gateway` routes, and the compose example
publishes the listener on host port `8090`, so loopback binding inside the process is
not a sufficient deployment boundary.

Recommended fix:

1. Require a non-empty `GATEWAY_AUTH_TOKEN` at startup in `gateway` and `both` modes.
2. Permit auth-free operation only behind an explicit development-only flag, with a
   startup warning that names the exposed routes.
3. Generate one strong token and put it in gateway/client templates and standalone
   documentation.
4. Use constant-time token comparison.
5. Add HTTP and WS tests proving missing/wrong tokens are rejected and health remains
   the only intentionally public route.
6. Rotate the token on any deployment created from the current examples.

## High Findings

### H-01 - Direct `ws` dependency has a known memory-exhaustion vulnerability

Status: **Resolved** (`2026-07-14`).

The remediation upgrades `ws` to `8.21.0`, `@modelcontextprotocol/sdk` to `1.29.0`,
`fast-uri` to `3.1.2`, and `hono` to `4.12.25`. All WebSocket protocols now use the
shared 16 MiB body limit. Socket errors caused by rejected payloads are handled
locally. The production dependency audit now reports no high or critical advisories.

Files:

- `package.json`
- `yarn.lock`
- `src/services/features/telegram-mcp/src/shared/lib/bodyLimits.ts`
- `src/services/features/telegram-mcp/gateway-socket.service.ts`
- `src/services/features/telegram-mcp/src/app/http.ts`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts`
- `tests/gatewayWsAuth.test.ts`

Before remediation, `yarn audit --groups dependencies --level high` reported the
direct `ws@8.20.1` dependency as vulnerable to memory exhaustion from tiny
fragments/data chunks. The reported patched version was `>=8.21.0`. This was relevant
because the project exposes gateway, WebApp live, and browser-attach WebSocket servers,
and none configured a small `maxPayload`.

The same audit reported `21` advisories in the production graph: `6 high`,
`14 moderate`, and `1 low`. The other high reports observed in this snapshot are
transitive `fast-uri@3.1.0` and `hono@4.12.16` paths through
`@modelcontextprotocol/sdk`; their actual reachability must be checked after updating
the SDK/lockfile.

Recommended fix:

1. Upgrade direct `ws` to at least `8.21.0` immediately.
2. Refresh `@modelcontextprotocol/sdk` and the lockfile to pull patched `fast-uri`
   (`>=3.1.2`) and `hono` (`>=4.12.25`).
3. Set explicit `maxPayload` values per WS protocol and add fragmented-message load
   tests.

### H-02 - Browser-attach WS trusts any local peer and unvalidated messages

Status: **Resolved under the accepted trusted-network boundary** (`2026-07-14`).

The remediation validates extension Origin during upgrade, requires `hello` as the
first message, strictly validates and bounds all inbound message variants, closes bad
peers with `1008`, contains asynchronous handler failures, rate-limits each peer,
reaps stale heartbeats, and defines duplicate-instance replacement behavior. The
existing 16 MiB WebSocket payload cap remains in force. Regression tests cover Origin
rejection, hello ordering, invalid schemas, async storage failure, duplicate
replacement, stale-heartbeat reaping, and nested/array bounds.

No attach token was added: this bridge is intentionally used across a trusted local or
private network, including browser VMs. This means a native process with network reach
to the listener can spoof an extension Origin. Deployments that do not share that
trust assumption must restrict the listener at the firewall/VPN boundary; adding
optional peer authentication remains future hardening for that deployment model.

The remaining text in this finding records the original pre-remediation state and
recommendation for audit history; it does not describe the current implementation.

Files:

- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts:111-153`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts:394-479`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/types.ts:1-185`

Original finding (pre-remediation): the server had no token, Origin validation,
subprotocol authentication, rate limit, or
`maxPayload`. Any process that can reach the configured port can register an arbitrary
`instance_id`, replace an existing instance, publish selected tabs, request manual
recording, and feed recording events. Loopback reduces remote exposure by default but
does not isolate users/processes on the same host, and the host is configurable.

Inbound data is only `JSON.parse` plus a TypeScript cast. The connection callback
starts `handleMessage()` with `void` and no rejection handler. A malformed but valid
JSON recording/control message can therefore cause an unhandled rejected promise
after filesystem or Redis work, rather than closing only the bad peer.

Original recommended fix:

1. Add a random attach token shared through extension settings and authenticate before
   accepting `hello`.
2. Validate every inbound discriminated union with Zod, including string/array/body
   limits and finite integer tab IDs.
3. Add `.catch()` at the socket boundary, log a redacted protocol error, and close the
   offending socket with `1008`.
4. Configure `maxPayload`, heartbeat reaping, per-peer rate limits, and duplicate
   instance replacement semantics.

#### BA-01 - Chrome MV3 attached-tab actions time out

Status: **Resolved** in Chrome attach extension `0.0.2` (`2026-07-14`).

Chrome routed `dom`, `click`, `press`, and the other generic page actions through
`chrome.scripting.executeScript({ func: new Function(...) })`. Manifest V3 extension
workers prohibit string-to-code evaluation, so function construction failed before an
action result could be sent. Screenshot worked through `captureVisibleTab`, and script
injection worked through a separately declared static function, which explained the
action-specific symptom. Firefox used its Manifest V2 string-code injection path and
was unaffected.

The Chrome extension now passes the static, self-contained
`executeTabActionInPage(action, payload)` function with `args`. The `tab_action`
message boundary catches execution failures and always emits a response using the
original request id. `capturePageSnapshotInTab()` is also self-contained because
Chrome serializes injected functions without their surrounding closure. Regression
coverage executes DOM/click/press in an isolated page context, verifies correlated
error responses, checks snapshot execution, and prevents `new Function` from returning
to the Chrome bundle.

### H-03 - HTTP and artifact paths have no application-level size limits

Status: **Resolved** (`2026-07-14`).

The remediation defines `MAX_BODY_SIZE = 16` in code, with byte and base64-source
limits derived from it. HTTP readers check `Content-Length` and count streamed bytes,
returning `413` on overflow. WebSocket `maxPayload`, browser-attach string validation,
gateway JSON requests, partner-note fields, inline base64 artifacts, workspace file
reads, and target-side base64 decoding all use the same policy. Files that will be
embedded as base64 are rejected before reading at the derived 12 MiB source limit,
then the complete serialized request is checked again against 16 MiB. There is no env
setting because this is a protocol invariant rather than an operational tuning value.

The text below records the original finding and recommendation for audit history.

Files:

- `src/services/features/telegram-mcp/src/app/http.ts:121-136`
- `src/services/features/telegram-mcp/src/features/distributed-gateway/model/gatewayHttpService.ts:416-450`
- `src/services/features/telegram-mcp/src/entities/request/model/schema.ts:624-650`
- `src/services/features/telegram-mcp/src/features/collaboration/model/sendPartnerFileService.ts:99-153`
- `src/services/features/telegram-mcp/gateway-delivery.service.ts:492-529`

Original finding: both JSON readers buffered the complete request before parsing. Partner artifact arrays,
text fields, and `content_base64` have no maximum sizes. `send_partner_file` reads the
complete file, creates another base64 copy, persists/transports it, and decodes another
full copy on the target. A large file or request can consume several times its size in
memory and can also bloat PostgreSQL JSONB, Redis messages, logs, and local storage.

The nginx sample's `client_max_body_size 32m` is only a partial external mitigation;
direct listeners, WebSockets, internal broker calls, and non-nginx deployments remain
unbounded.

Original recommended fix:

1. Implement streaming body readers with a hard byte counter and return `413`.
2. Add schema limits for messages, arrays, filenames, HTML snapshots, and base64.
3. Reject files before reading when `stat.size` exceeds policy.
4. Keep the current inline/base64 product model, but define its supported maximum and
   reject larger artifacts before reading, encoding, persisting, or transporting them.
   Object-storage/reference delivery is out of scope for this product.
5. Keep transport limits in code as protocol invariants unless an operational need for
   env overrides is established. The implemented product policy intentionally uses one
   shared 16 MiB body limit to avoid drift between transports.

### H-04 - Gateway message enqueue is not transactional

File: `src/services/features/telegram-mcp/gateway.service.ts:1946-2069`

`sendPartnerNoteRecord()` independently inserts the message, then each artifact, then
the delivery row. A failure at any later step leaves a committed message and possibly
a subset of artifacts without a queued delivery. A caller retry generates new UUIDs,
so it cannot safely complete or deduplicate the partial operation.

Recommended fix:

1. Wrap message, artifact, and delivery inserts in one DB transaction.
2. Add an idempotency key unique per source request/share.
3. Test failure injection after message insert and after the Nth artifact insert.

### H-05 - Delivery consumption can duplicate notifications or acknowledge dropped work

Files:

- `src/services/features/telegram-mcp/gateway.service.ts:2130-2175`
- `src/services/features/telegram-mcp/gateway-socket.service.ts:2259-2327`
- `src/services/features/telegram-mcp/gateway-socket.service.ts:2745-2776`
- `src/services/features/telegram-mcp/gateway-delivery.service.ts:456-477`
- `src/services/features/telegram-mcp/gateway-delivery.service.ts:585-713`

`pollDeliveriesRecord()` selects `queued` rows but does not claim them. Overlapping
connections/hello handshakes can receive and materialize the same delivery. Local
materialization overwrites the same files/record but still sends Telegram notification
and terminal nudge again because there is no completed-delivery idempotency check.

In the opposite direction, `materializeIncomingDelivery()` logs and returns normally
when the target session is absent. The WS client treats that return as success and
sends `delivery_ack`, permanently marking work delivered even though no xchange record
was created.

Recommended fix:

1. Atomically claim rows (`queued -> processing`) using a transaction and
   `FOR UPDATE SKIP LOCKED`, with lease expiry/retry.
2. Persist a local processed-delivery marker before side effects and make notification
   and nudge idempotent.
3. Throw a retryable error when the target session is temporarily unavailable; do not
   ACK a skipped delivery.
4. Separate permanent invalid-target failure from transient startup/hydration failure.

### H-06 - Workspace confinement is vulnerable to symlink traversal

Files:

- `src/services/features/telegram-mcp/src/shared/integrations/terminal/client.ts:94-126`
- `src/services/features/telegram-mcp/src/shared/integrations/terminal/client.ts:182-203`
- `src/services/features/telegram-mcp/src/shared/integrations/terminal/client.ts:261-267`
- `tests/sendPartnerFileService.test.ts:119-166`

Path checks use `path.resolve`/`path.relative`, which reject lexical `..` traversal but
do not resolve symlinks. A path such as `workspace/link-to-home/.ssh/key` passes the
workspace check when `link-to-home` is a symlink and is then read by `readFile`.
Intermediate symlinks under `.mcp-xchange` can similarly redirect writes outside the
exchange directory.

This weakens the safety boundary used by file-to-Telegram and partner-file operations,
where accidental secret exfiltration matters even if the local agent itself has broad
filesystem access.

Recommended fix:

1. Resolve and compare `realpath()` for the workspace/root and existing read target.
2. For writes, validate the nearest existing parent by real path and use no-follow
   semantics where supported.
3. Reject a symlinked exchange root unless explicitly allowed.
4. Add read/write tests with an in-workspace symlink pointing outside.

## Medium Findings And Optimization Targets

### M-01 - Browser recording events are concurrent and write-amplified

Files:

- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts:125-131`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/firefoxAttachServer.ts:642-680`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/browserRecordingBundle.ts:346-503`
- `src/services/features/telegram-mcp/src/features/browser-attach/model/browserRecordingBundle.ts:558-740`

WS messages start async handlers without a per-recording queue, so stop/disconnect and
multiple network/page events can mutate the same state and files concurrently. Event
arrival order is not guaranteed in timeline artifacts, and events already in flight
can append after `session_stopped`.

Every event also rewrites `session.json` and performs a Redis `SET`. Network events
write request/response/meta JSON before body materialization and then write all three
again. This is the dominant scaling bottleneck for busy/long recordings.

Recommended fix: serialize work per recording ID, batch Redis/session metadata flushes,
write network metadata once, enforce a bounded queue with backpressure, and always
flush on stop/disconnect.

### M-02 - Xchange SQLite opens synchronously and reapplies schema per operation

File: `src/services/features/telegram-mcp/src/shared/integrations/xchange/sqliteRecordStore.ts:164-178`

Every list/get/upsert/mark-read operation creates a new `DatabaseSync`, executes all
`CREATE TABLE/INDEX IF NOT EXISTS` statements, runs one operation, and closes it. These
calls block the Node event loop and add repeated open/schema/prepare overhead.

Recommended fix: use one workspace-scoped store/connection, apply migrations once,
cache prepared statements, configure a busy timeout/WAL as appropriate, and serialize
or move synchronous DB work off the main event loop.

### M-03 - PTY failure and stop paths leak resources/state

File: `src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry.ts:94-194,207-264,825-841`

Shell preparation creates temp directories before `spawn()`. If `spawn()` throws
synchronously, no record is returned and the temp directory cannot be cleaned. On a
normal stop, the record is disposed but remains in the global `sessions` map, so
stopped targets accumulate and `hasPtyTarget()` still reports them as present.

Recommended fix: wrap prepare/spawn in `try/catch/finally`, clean created paths and the
headless terminal on failure, delete stopped records from the map, and test a missing
shell binary plus repeated create/stop cycles.

### M-04 - Compose publishes stateful services with example credentials

File: `docker-compose.yml:1-43`

Redis, PostgreSQL, RabbitMQ, and the RabbitMQ management UI are published on all host
interfaces; PostgreSQL/RabbitMQ use `user/password` examples and Redis has no password.
This is unsafe on a host without a strict firewall and is easy to deploy accidentally
because the file is not clearly separated as development-only.

Recommended fix: remove host port publishing for internal services, or bind explicitly
to `127.0.0.1`; require secrets through environment/secret files; put RabbitMQ behind an
optional profile; label the compose file as development-only if that is its intent.

### M-05 - Remaining browser-attach debt is still present

The following existing findings were re-confirmed and should remain on the backlog:

- `FirefoxAttach*` names and persisted `"firefox-attached"` values still describe
  shared Firefox/Chrome infrastructure incorrectly.
- `FirefoxAttachRegistry.setTabs()` can retain a stale `activeTab` after tab removal.
- attached script-export semantics still need cross-browser contract tests.
- server-side stale-heartbeat reaping remains absent.
- attach/reconnect/recording lifecycle tests are still missing.

See `docs/CODE_REVIEW_browser-attach.md` and
`docs/CODE_REVIEW_browser-attach_FIXES.md` for the earlier detailed analysis.

## Structural Risks

Several core files are large enough that local reasoning and safe review are becoming
difficult:

- `gateway-socket.service.ts`: 3648 lines
- `gateway.service.ts`: 2707 lines
- `browserService.ts`: 2530 lines
- `gatewayHttpService.ts`: 1818 lines
- Chrome/Firefox extension background scripts: 1740/1622 lines

This is not a standalone defect, but it amplifies auth, lifecycle, and duplicated-
policy drift. Split by protocol responsibility after the critical fixes; do not mix a
large refactor into the security patch.

## Missing Tests

Highest-value additions:

1. Gateway enqueue rollback/idempotency and concurrent delivery claim tests.
2. Extend the existing HTTP, WS, message, and artifact size-limit tests to additional
   endpoint-specific edge cases as those endpoints evolve.
3. Browser-attach disconnect, stop, and event ordering tests (schema rejection and
   protocol-boundary coverage now exist).
4. Workspace symlink escape tests.
5. PTY synchronous spawn-failure cleanup tests.

## Verification

Passed in this workspace:

```text
yarn build                 PASS
yarn build:extensions      PASS
yarn lint                  PASS
yarn test                  PASS (27 files, 121 tests)
```

Dependency audit:

```text
yarn audit --groups dependencies --level high
4 vulnerabilities: 4 moderate
```

The audit exits successfully because no high or critical advisories remain.

## Recommended Fix Order

1. CR-01: derive identity only from verified raw Telegram init data. **Resolved.**
2. CR-02: make gateway transport authentication fail closed and update all templates.
   **Resolved.**
3. H-01: upgrade `ws`, refresh vulnerable transitive dependencies, and bound WS
   payloads. **Resolved.**
4. H-02 browser-attach protocol hardening and H-03 HTTP/file input bounds are
   **Resolved** under the documented trust boundary and shared 16 MiB body policy.
5. H-04/H-05: make enqueue and delivery transactional, claimed, and idempotent.
6. H-06: make workspace path containment symlink-safe.
7. M-01/M-02/M-03: serialize and reduce recording I/O, reuse SQLite, fix PTY cleanup.
