# Code Review: Browser-Attach Feature (Chrome/Firefox extensions + MCP server)

Scope: `git diff HEAD~4..HEAD` at commit `b26470c` — 61 files, ~12k insertions. New feature
letting the MCP server attach to and drive real Chrome/Firefox tabs via a browser extension
connected over WebSocket, plus session recording (network/console/DOM capture) persisted through
a bundle writer and Redis.

Methodology: 8 parallel finder passes (3 correctness angles, reuse, simplification, efficiency,
altitude, conventions) over the diff, followed by an independent verification pass that read the
actual current files for each candidate. Findings below are CONFIRMED unless marked otherwise.
No code was changed as part of this review.

## Status on 2026-07-13

This document is still useful as the original review snapshot, but it is no longer a pure
"current-state" report. Several findings below have already been fixed in follow-up work.

Closed since the original review:
- `startRecording()` now rejects starting a second recording on a different tab within the same
  attached browser instance instead of silently returning the stale record.
- The WebSocket close-handler race that could unregister a newer live reconnect has been fixed.
- `stopRecording()` now sends `recording_stop` based on persisted state and finalizes an existing
  bundle even after an MCP server restart when session cwd is available.
- Firefox no longer injects the recorder globally via manifest `content_scripts`; recorder
  injection is attach/recording-scoped.
- Firefox and Chrome no longer block page `fetch()` completion on response-body capture.
- Attached-tab output schemas no longer require every captured URL field to validate as a full
  absolute URL string.
- User-facing recording errors no longer mention "Firefox" when the backend is browser-agnostic.

Intentionally obsolete / product decision changed:
- Finding `1.6` about UTC timestamps is no longer actionable as written. The project intentionally
  standardized browser-recording artifacts and related metadata on local wall-clock timestamps.

Still open after the latest pass:
- `1.4` Chrome/Firefox injected-export semantics still differ for bare `window.foo = ...`
  assignments.
- `1.5` `activeTab` can remain stale after a tab is closed.
- `2.1` naming still leaks Firefox-specific terms into shared browser-attach infrastructure and
  persisted `backend` values.
- `1.9` / test coverage remains insufficient for attach/reconnect/recording lifecycle paths.

---

## 1. Correctness bugs

### 1.1 `startRecording()` ignores which tab is being recorded — silently returns the wrong session's data
`firefoxAttachServer.ts:204-210`

The dedup check only compares `existing.instanceId !== input.instanceId`, never `tabId`. Since
`browserService.startRecording()` always calls it with whatever tab is *currently attached*, the
sequence "attach tab A → start recording → attach tab B (same browser instance) → start recording
again" returns the **stale tab-A recording record** instead of erroring or starting a fresh one for
tab B. The caller gets a success response but nothing is actually recording tab B.

**Fix direction:** compare `tabId` too, and either start a new recording or return a clear
"already recording a different tab" error.

### 1.2 WebSocket reconnect race can un-register a live connection
`firefoxAttachServer.ts:133-141`

The `close` handler unconditionally deletes `registry`/`socketsByInstanceId` entries for
`state.instanceId` with no check that the map still points at *this* socket. `handleHello`
overwrites the map entry on reconnect. If the old socket's TCP teardown event arrives after the
new socket's `hello`, the delayed `close` handler wipes the freshly-reconnected instance's
registration — subsequent tool calls fail with "instance is not connected" even though the
extension is actually connected. Realistic during a service-worker restart / brief network blip.

**Fix direction:** guard the close handler with `if (this.socketsByInstanceId.get(instanceId) === state)`.

### 1.3 `stopRecording()` can be a no-op after a server restart, leaving the extension recording forever
`firefoxAttachServer.ts:275-314`

The control message that actually tells the extension to stop is only sent when an in-memory
`activeRecordingsById` entry exists. That map is process-local; after an MCP server restart it's
empty even though Redis (`maintenanceStore`) still shows `status: "recording"`. Calling
`browser_recording_stop` then just flips storage to `"stopped"` and broadcasts state — verified in
`background.js` that the `recording_state` broadcast only updates the popup display, it never calls
the extension's actual stop function. The content-script recorder keeps buffering/POSTing events
indefinitely with no way to stop it short of the user manually stopping from the extension UI.

**Fix direction:** on stop, always send the control message to the instance if it's connected,
regardless of in-memory bookkeeping; reconcile `activeRecordingsById` from `maintenanceStore` on
server startup.

### 1.4 `browser_inject_script` behaves differently on Chrome vs Firefox for plain assignments
`packages/chrome-attach-extension/src/background.js:179-198` vs `packages/firefox-attach-extension/src/background.js:470-479`

Chrome exports only globals matched by a regex against `function`/`class`/`var|let|const`
declarations in the injected source. Firefox instead diffs `Object.getOwnPropertyNames(window)`
before/after execution. A script that does `window.myApi = {...}` (no declaration keyword) is
picked up on Firefox but **silently dropped on Chrome** — `injected: true` is still reported, but
`TELLY.myApi` is undefined, breaking any later `browser_dom`/click logic that depends on it.

**Fix direction:** make Chrome use the same window-diff approach as Firefox (or vice versa) so
injection semantics match across browsers.

### 1.5 Stale `activeTab` can point at a closed tab indefinitely
`firefoxAttachRegistry.ts:53-62`

`existing.activeTab = tabs.find(active) ?? existing.activeTab ?? null` falls back to the previous
active tab when no tab in a fresh `list_tabs_result` is marked active. There is no
`tabs.onRemoved`/close handling anywhere in the extension or server, so a closed tab's stale record
persists until a later report happens to include a genuinely active tab.
`browser_attach_active_tab` can then attach to a tab_id that no longer exists.

### 1.6 Timestamps switched from UTC ISO-8601 to unmarked local time — sortability/parsing regression
`browserService.ts` (~15 call sites) via `shared/lib/time/localTimestamp.ts:5-12`

`new Date().toISOString()` (UTC, unambiguous, has a `Z` suffix) was replaced across the diff by
`formatLocalTimestamp()`, which builds a string from local-timezone getters
(`getFullYear/getMonth/getDate/getHours...`) with **no `Z` or offset marker**. The result looks
like ISO-8601 but isn't UTC. This is systemic — `browserRecordingBundle.ts`'s
`normalizeRecordedTimestamp` even takes an already-correct parsed `Date` and re-serializes it
through the same offset-less formatter, and both extensions' recorder scripts follow the same
pattern. Any code (now or in the future) that does `new Date(record.lastUsedAt)` assuming UTC will
be off by the server's UTC offset; around a DST "fall back" the same wall-clock string can even be
produced twice in one hour, making `lastUsedAt` non-monotonic.

**Fix direction:** either keep UTC ISO-8601 for machine-facing fields and only use a local-time
formatter for human-facing filenames/logs, or append the actual UTC offset to
`formatLocalTimestamp`'s output.

### 1.7 Temp directory leak if shell spawn fails synchronously
`ptyRegistry.ts:99-163, 207-265`

`prepareShellLaunch`/`prepareBashLaunch`/`prepareZshLaunch` create a temp dir + rc files via
`fs.mkdtempSync`/`fs.writeFileSync` and store the path in `record.tempPaths` *before* `spawn()`
runs. Cleanup only happens via `pty.onExit` or `stopPtyTarget`, both of which require a live `pty`
handle that only exists after a successful spawn. `ensurePtySession` (the only caller) has no
try/catch. If `spawn()` throws synchronously (e.g. a misconfigured/missing shell binary — plausible
in a container image), the temp directory is orphaned with no reference left to clean it up.
Repeated failed reconnect attempts accumulate `tellymcp-pty-*` directories indefinitely.

### 1.8 Attached-tab output fields can violate their own Zod schema (PLAUSIBLE)
`browserService.ts` lines ~864, 922, 981, 1063, 1115, 1186, 1256, 1403

`click`/`fill`/`press`/`waitFor`/`reload`/`injectScript`/`waitForUrl`/`getNetworkFailures`'s
attached-tab branches build `url`/`current_url` via `result?.url || attached.url || ""` — but the
matching Zod output schemas (`schema.ts`) declare these as `z.string().url()`, which **rejects an
empty string**, and the MCP SDK does validate `structuredContent` against `outputSchema` and throws
on mismatch (confirmed in `@modelcontextprotocol/sdk`). For most of these, current extension code
always populates a non-empty `url`, so it's mostly latent — except `getNetworkFailures`
(`browserService.ts:1403`), where the extension's own `recordNetworkFailure` already coerces
non-string URLs to `""` before it reaches this `.url()`-required field, making that one call site
close to a confirmed, reachable bug (e.g. a failed request whose URL couldn't be resolved). The
others need extension/server version skew or a malformed `tab_action_result` to trigger.

**Fix direction:** relax the schema to `z.string()` for these fields, or guarantee a non-empty
fallback (e.g. `"about:blank"`) before returning.

### 1.9 No tests were added for ~12,000 lines of new functionality
No `.test.ts`/`.spec.ts` files appear anywhere in this diff. The recording pipeline, the WS
protocol between extensions and server, the registry's reconnect/dedup logic, and the Redis state
persistence are all exactly the kind of concurrency/lifecycle-heavy code where the bugs above tend
to hide — worth prioritizing before this ships broadly.

---

## 2. Architecture / naming

### 2.1 "Firefox" naming on code that's actually shared by both browsers
`firefoxAttachRegistry.ts`, `firefoxAttachServer.ts`, `browserService.ts:265,584`, `entities/browser/model/types.ts:85`

`FirefoxAttachRegistry`/`FirefoxAttachServer` are generic dual-browser infra — the registry record
has `browser: "firefox" | "chrome"` and `browserService.ts` never branches on browser type. But the
naming leaks outward: a Chrome-attached session hits the error string *"No attached Firefox tab is
selected..."* (`browserService.ts:584`), and every persisted attachment/recording record is typed
with the literal `backend: "firefox-attached"` regardless of which browser actually produced it
(`types.ts:85` and 4 call sites). This isn't just cosmetic — it actively invites future
contributors to bolt Chrome-specific special cases onto a class whose name signals "Firefox only,"
and the persisted `"firefox-attached"` literal can't currently distinguish which browser produced a
given record without a breaking type change later.

**Suggested fix:** rename to something like `BrowserAttachRegistry`/`BrowserAttachServer`, and make
`backend` a real `"firefox-attached" | "chrome-attached"` union (or a separate `browser` field)
before more data accumulates under the wrong label.

### 2.2 Extension holds product-policy constants that arguably belong server-side
`packages/{chrome,firefox}-attach-extension/src/background.js`

`RECONNECT_DELAY_MS` (fixed 3000ms, no exponential backoff/jitter) and `MAX_CAPTURE_BYTES`
(512KB network-body capture cap) are hardcoded identically in both extension packages. The
`hello_ack` handshake (`firefoxAttachServer.ts:478-489`) doesn't transmit a capture-byte limit, so
these are genuinely duplicated client constants, not server-driven config. Tuning the recording
capture size — a product decision — currently requires shipping and users reinstalling two separate
extension builds. Consider sending policy knobs like this at `hello_ack` time.

---

## 3. Reuse / duplication (all confirmed by reading the actual files)

| # | What's duplicated | Where | Should reuse |
|---|---|---|---|
| 1 | `padNumber`/`formatLocalTimestamp` reimplemented locally | `browserRecordingBundle.ts:130-141` | `shared/lib/time/localTimestamp.ts` (already imported elsewhere in this same diff) |
| 2 | Ad hoc ID generation (`Date.now()+Math.random().toString(36)`) | `firefoxAttachServer.ts:330,579` | `shared/lib/ids/ids.ts`'s `createRequestId()` — weaker collision resistance than the codebase's own scheme |
| 3 | Filename slugification reimplemented with different edge-case behavior | `browserRecordingBundle.ts:119-128` (`sanitizeSegment`) | `shared/integrations/telegram/transportUtils.ts`'s `slugifyFilenamePart` (not byte-identical, but same purpose — worth unifying) |
| 4 | Chrome-only `browser.*` Promise-wrapper boilerplate x10 (storageGet, tabsQuery, tabsUpdate, etc.) | `packages/chrome-attach-extension/src/background.js:49+` | one generic `promisify(fn, ...args)` helper |

Also duplicated but pre-existing convention (not introduced by this diff): every `*Tool.ts` file
redefines an identical `createContent()` helper — this diff adds 9 more copies of a pattern already
repeated ~19 times elsewhere. Worth a shared helper in `shared/api/tool-registry/` at some point,
independent of this PR.

---

## 4. Simplification opportunities (all confirmed)

- **`browserService.ts`** (1167 lines changed): ~15-20 public methods repeat an identical ~10-line
  prologue (`resolveSessionDefaults` → `normalizeSessionIdForAccess` → `invokeRemote` check) and an
  identical `if (attached) { runAttachedTabAction } else { local Playwright path }` branch shape —
  confirmed via grep, the pattern occurs 73 times across 24 methods. A `withResolvedSession` +
  `runAttachedOrLocal(input, attachedFn, localFn)` wrapper would collapse this substantially and
  remove the risk of one of the 20 copies drifting when the dispatch logic changes.
- `listTabs`/`attachActiveTab`/`attachTab` each duplicate the same "resolve instance by id or fall
  back to the single connected instance, else throw" block verbatim (`browserService.ts:335-352,
  397-414, 453-470`).
- `firefoxAttachServer.ts`'s `invokeTabAction` (317-364) and `invokeRecordingControl` (566-622)
  hand-roll the identical "generate request id → register pending map entry with resolve/reject/
  timer → send → await → timeout" pattern against two separate pending maps with structurally
  identical types. One generic `sendAndAwait<T>(pendingMap, instanceId, buildMessage, timeoutMs)`
  would guarantee consistent timeout/error handling instead of requiring both to be kept in sync by
  hand.
- `ptyRegistry.ts`'s `prepareBashLaunch`/`prepareZshLaunch` (94-165) differ only in rc filenames,
  source syntax, and prompt variable name — a small per-shell config table would remove ~50
  duplicated lines and make adding a third shell (e.g. fish) straightforward instead of requiring a
  third copy-paste.
- `browserRecordingBundle.ts`'s `materializeRequestBodyArtifact` (658-697) has two ~20-line blocks
  identical except for `artifact.request` vs `artifact.response`.
- `BrowserRecordingRecord` stores `bundleDirName`, `bundleRelativePath`, and `bundlePath` as three
  separate persisted fields even though the latter two are always derivable from the first
  (`bundleRelativePath = web/${bundleDirName}`, `bundlePath = path.resolve(exchangeRoot,
  bundleRelativePath)`) — redundant state re-threaded through four separate mapping functions.

---

## 5. Efficiency (all confirmed)

- **Double file writes per network event.** `browserRecordingBundle.ts`: `upsertNetworkRequestArtifact`
  (596-610) writes `request.json`/`response.json`/`meta.json` *before* the body is known, then
  `materializeRequestBodyArtifact` (700-714) rewrites all three again once body info is computed —
  every network event does 2x the filesystem writes it needs to, with no streaming rationale
  evident (the first write is simply thrown away).
- **Full `session.json` rewrite on every single event.** `writeSessionJson` is called from
  `appendEvent` unconditionally — a busy recording session re-serializes and rewrites the whole
  session metadata file on every console/network sub-event instead of on a timer or status change.
- **Unthrottled Redis write per recording event.** `firefoxAttachServer.ts`'s `handleRecordingEvent`
  calls `maintenanceStore.setBrowserRecording(state.record)` (a full-record `redis.set`) on every
  inbound `recording_event` message with zero debounce — network capture alone emits ~5 sub-events
  per HTTP request, so a busy page produces hundreds of avoidable Redis round-trips per minute just
  to bump `eventCount`/`lastEventAt`.
- **Unconditional Redis write after every attached-tab action**, even when nothing changed.
  `browserService.ts:2365` writes the attachment record back to Redis after every click/fill/press/etc,
  with no check for whether `title`/`url` actually changed — a scripted 20-step flow against one
  attached tab does 20 avoidable Redis round-trips.
- **Sequential (not parallel) cleanup on instance disconnect.** `firefoxAttachServer.ts`'s disconnect
  handler iterates all active recordings on a browser instance with a sequential `for...of` +
  `await` (fs write + Redis write + broadcast per recording) instead of `Promise.all` — if a user
  had 5 tabs recording simultaneously, disconnect cleanup latency stacks up 5x instead of running
  concurrently.
- `stateStore.ts`'s `clearSession` adds two more sequentially-awaited Redis `DEL` calls to an
  already-long chain of serial awaits instead of grouping independent deletes into `Promise.all`.

None of this is likely urgent at current usage levels, but the recording pipeline in particular
should be revisited before recommending it for long/busy sessions.

---

## Priority if picking a subset to fix first

1. §1.3 (stop-recording no-op after restart) — silent resource/functionality leak, hard to notice.
2. §1.2 (WS close race) — intermittent "instance not connected" errors users will file bugs about.
3. §1.6 (timestamp UTC regression) — silent data-correctness issue, cheap to fix now vs. expensive
   to migrate later once data has accumulated in the wrong format.
4. §1.1 (startRecording tabId) and §1.4 (Chrome/Firefox inject divergence) — both silent-wrong-
   behavior bugs with straightforward fixes.
5. §2.1 (Firefox naming) — not urgent, but the cost of renaming only grows as more data accumulates
   under the `"firefox-attached"` literal.
6. §1.7, §1.9 — leak is a minor edge case; missing tests should probably gate the next iteration of
   this feature rather than this one.
