# Fix plan: Firefox global fetch-hang + Chrome MV3 service-worker suspension

Companion to `docs/CODE_REVIEW_browser-attach_extension-connectivity.md` — that doc has the
root-cause analysis; this is the concrete, sequenced implementation plan.

## Status on 2026-07-13

This plan has been executed.

Implemented:
- Firefox static `content_scripts` recorder injection was removed.
- Firefox and Chrome fetch wrappers now capture response bodies asynchronously and return the real
  `Response` immediately.
- Chrome MV3 now requests `alarms` permission and registers a keepalive alarm that reconnects the
  backend socket after service-worker suspension.

Still intentionally out of scope here:
- Server-side stale-heartbeat reaping remains follow-up hardening, not part of this extension pass.

## Context

A code review root-caused two live symptoms in the browser-attach extensions
(`packages/firefox-attach-extension`, `packages/chrome-attach-extension`), both confirmed by
reading the current code:

1. **Firefox breaks unrelated pages.** `manifest.json` statically injects `recorder-content.js`
   into *every* page/frame in the browser (`content_scripts` on `<all_urls>`, all frames,
   `document_start`) regardless of whether TellyMCP ever attached to that tab. That script
   monkey-patches `window.fetch` globally, and the wrapper doesn't return the `Response` to the
   calling page until it has fully read the response body via `.clone().text()`. For any site using
   a streaming/long-lived fetch (SSE, chat-streaming, long-polling, chunked transfer), the body
   never "completes" quickly, so the page's own `fetch()` call hangs — that's the observed
   breakage.
2. **Chrome silently loses its connection to the backend.** The MV3 service worker
   (`background.js`) is non-persistent; Chrome tears it down after ~30s without a qualifying
   event. The extension's only liveness mechanism is a `setInterval` heartbeat and a `setTimeout`
   reconnect — both pure in-memory JS state that is destroyed along with the socket when the
   worker is killed. No `chrome.alarms` (Chrome's actual supported mechanism for surviving
   suspension) is used, and the manifest doesn't even request the `alarms` permission. The
   extension only reconnects opportunistically, whenever some unrelated `webRequest` event happens
   to wake the worker — which is why the "sink" to the backend appears to die during normal idle
   browsing.

Goal: fix both with the smallest, lowest-risk change that addresses the confirmed root cause — no
unrelated refactors.

Key fact that shapes the plan: **Firefox already has a fully working, correctly-scoped on-demand
injection path** (`injectRecorderContent(tabId)` in `firefox-attach-extension/src/background.js`,
using `browser.tabs.executeScript`), wired into every relevant flow (attach, recording start,
navigation-complete for the attached tab, manual tab selection). It's functionally identical to
what Chrome's extension already does successfully (Chrome has no static `content_scripts` entry at
all). The static manifest entry is a redundant leftover, not a missing feature — the fix for the
"runs on every page" half of Bug 1 is to delete it, not to write new injection logic.

Also confirmed while planning: **Chrome's `recorder-page.js` has the identical fetch-hang pattern**
(`await response.clone().text()` before `return response`, lines 163-178) as Firefox's. Chrome's
blast radius is much smaller today (only injected into attached/recording tabs, never every page),
but a user attaching to a tab that itself uses streaming fetch (e.g. attaching to a chat app) would
hit the same hang there. Fixing it costs nothing extra beyond applying the identical change twice,
so it's included in scope.

---

## Bug 1 — Firefox: remove over-broad injection + un-block the fetch wrapper (also apply the fetch fix to Chrome)

### 1.1 — `packages/firefox-attach-extension/src/manifest.json`: delete the static `content_scripts` block

Remove the entire `"content_scripts": [...]` array (currently lines 36-47, the block with
`"matches": ["<all_urls>"]`, `"js": ["recorder-content.js"]`, `"run_at": "document_start"`,
`"all_frames": true`). No other manifest keys need to change — `"permissions"` already has
`<all_urls>` (used by the on-demand `browser.tabs.executeScript` path too), and
`"web_accessible_resources": ["recorder-page.js"]` is unrelated to how `recorder-content.js` gets
injected.

This is the root-cause fix: after this change, `recorder-content.js`/`recorder-page.js` (and thus
the fetch/XHR/console patching) only load into a tab when TellyMCP explicitly attaches to it or
starts recording on it — via the existing `injectRecorderContent(tabId)` calls already present in
`background.js` (attach flow, recording start, navigation-complete-while-attached, manual tab
selection). No new injection code is needed; this is a pure deletion.

### 1.2 — `packages/firefox-attach-extension/src/recorder-page.js`: stop the fetch wrapper from blocking on body capture

In the `window.fetch` override (lines 168-215), the response-body read is currently awaited before
`return response`:
```js
const response = await originalFetch(...args);
emit({ kind: "network_response_complete", ... });
try {
  const bodyText = await response.clone().text();   // blocks here
  emit({ kind: "network_response_body", ... });
} catch { /* ignore */ }
return response;                                      // only reached after the above
```
Change it so `response` is returned to the caller immediately after `network_response_complete` is
emitted, and the body capture runs as a detached (not-awaited) promise chain:
```js
const response = await originalFetch(...args);
emit({ kind: "network_response_complete", ... });

try {
  void response
    .clone()
    .text()
    .then((bodyText) => {
      emit({ kind: "network_response_body", ..., body_text: truncateText(bodyText), body_truncated: bodyText.length > MAX_TEXT_CHARS });
    })
    .catch(() => {});
} catch {
  // response.clone() can itself throw synchronously — keep this in a sync try/catch
}

return response;
```
Note `response.clone()` can throw synchronously (not just the async `.text()`), so it still needs a
synchronous `try`/`catch` around the call — just without an `await` inside it. The request-body
serialization and the `network_request`/`network_response_complete` emits stay exactly as they are
today (unaffected — they don't cause the hang). No change needed to the XHR wrapper; it already
uses a non-blocking `loadend` listener.

### 1.3 — `packages/chrome-attach-extension/src/recorder-page.js`: apply the identical fix

Same transformation as 1.2, same line shape (lines 132-179 in this file — `window.fetch = async
(...) => {...}`, response-body await at line 164, `return response` at line 178). Keep the two
files' fetch wrappers structurally in sync since they're near-duplicates already.

### Sequencing
1. Apply 1.1 (Firefox manifest) — verify scope fix alone first (see Verification).
2. Apply 1.2 (Firefox recorder-page.js).
3. Apply 1.3 (Chrome recorder-page.js) — independent of 1.1/1.2, can be done any time.

### Known, acceptable behavior change (not a regression to chase)
`get_logs`/`clear_logs` on a tab that was **never** attached/recorded will now return empty
buffers instead of passively-collected history, because buffering only starts once
`injectRecorderContent` actually runs for that tab. This is the intended effect of scoping
injection down from "every page" to "tabs TellyMCP actually cares about." If any current MCP tool
caller assumes `get_logs` works pre-attach, that's a separate, pre-existing contract question — not
something to special-case here.

---

## Bug 2 — Chrome: add a `chrome.alarms` backstop so the service worker reliably reconnects after suspension

### 2.1 — `packages/chrome-attach-extension/src/manifest.json`: add the `alarms` permission

Add `"alarms"` to the `"permissions"` array (alongside the existing `tabs`, `activeTab`,
`storage`, `cookies`, `webNavigation`, `webRequest`, `scripting`).

### 2.2 — `packages/chrome-attach-extension/src/background.js`: register a periodic alarm as a reconnect backstop

Add near the existing timing constants (`RECONNECT_DELAY_MS`, `HEARTBEAT_INTERVAL_MS`, ~line 16-18):
```js
const KEEPALIVE_ALARM_NAME = "telly-keepalive";
const KEEPALIVE_ALARM_PERIOD_MINUTES = 0.5; // ~30s — Chrome's practical minimum period for packed/production extensions
```

Register the listener and create the alarm **unconditionally at module top level** (same pattern as
the existing top-level `webRequest.onCompleted`/`onErrorOccurred` listeners and the top-level
`void connect();` call) — MV3 requires alarm listeners to be registered synchronously at initial
script evaluation for Chrome to correctly redeliver a fired alarm to a woken worker. Place this
right after the existing `browser.webRequest.onErrorOccurred.addListener(...)` block, before the
existing top-level init calls (`hydrateAttachedTabSelection`/`computeInstanceId`/`connect`):

```js
browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME) return;
  if (manualDisconnect) return;
  const isConnectingOrOpen =
    Boolean(socket) &&
    (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING);
  if (!isConnectingOrOpen) {
    void connect();
  }
});

browser.alarms.create(KEEPALIVE_ALARM_NAME, { periodInMinutes: KEEPALIVE_ALARM_PERIOD_MINUTES });
```

Design notes:
- **Guards against duplicate sockets**: `connect()` unconditionally does `socket = new
  WebSocket(wsUrl)` with no existing guard. Treating `CONNECTING` the same as `OPEN` in the alarm
  handler (i.e., "leave it alone if a connection attempt is already in flight") prevents the alarm
  from racing the existing `scheduleReconnect()` `setTimeout` path and creating a second socket /
  duplicate `hello` handshake.
- **Respects manual disconnect**: reuses the existing `manualDisconnect` module flag so a user who
  explicitly turned off the connection isn't force-reconnected by the alarm.
- **`browser.alarms.create` is idempotent** — safe to call unconditionally on every worker
  (re)start; it just resets the same named alarm, no duplicates, no throw.
- `scheduleReconnect()`'s existing `setTimeout` and `startHeartbeat()`'s existing `setInterval` are
  left untouched — they remain the fast in-process path while the worker is alive. The alarm is
  purely the reliability backstop guaranteeing the worker gets woken at least every ~30s even
  through total suspension, per the request to keep this minimal.

### Not in scope (explicitly deferred)
Server-side stale-heartbeat reaping in `firefoxAttachServer.ts` — the `"heartbeat"` case today just
touches the registry with no dead-connection timeout logic. Worth a follow-up if abrupt
(non-clean-close) worker teardown turns out to leave stale registry entries in practice, but it's
optional hardening, not required to fix the core "sink dies" symptom, and out of scope here.

---

## Critical files
- `packages/firefox-attach-extension/src/manifest.json` — delete `content_scripts` block (1.1)
- `packages/firefox-attach-extension/src/recorder-page.js` — un-block fetch wrapper (1.2)
- `packages/chrome-attach-extension/src/recorder-page.js` — same fetch fix (1.3)
- `packages/chrome-attach-extension/src/manifest.json` — add `alarms` permission (2.1)
- `packages/chrome-attach-extension/src/background.js` — alarm registration (2.2)
- Reference only, no changes needed: `packages/firefox-attach-extension/src/background.js`
  (`injectRecorderContent` and its call sites already cover all injection needs post-1.1)

## Verification

**Bug 1 (Firefox):**
1. Load unpacked at `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
   `packages/firefox-attach-extension/src/manifest.json`.
2. Open a fresh, never-attached tab; in its devtools console, `typeof
   window.__tellyRecorderContentInstalled` must be `"undefined"` (regression test for the scope
   fix — before the fix this was always `true`).
3. Attach that tab from the extension popup; re-check — now `true`, and
   `window.__tellyRecorderPageInstalled === true`.
4. Start a recording, interact with the page, confirm console/network events still arrive normally
   (basic functionality preserved).
5. On the attached/recording tab, from its own console:
   ```js
   const t0 = performance.now();
   const r = await fetch("https://sse.dev/test"); // or any long-lived/chunked endpoint
   console.log("resolved after", performance.now() - t0, "ms", r.status);
   ```
   Must resolve quickly (as soon as headers arrive), not hang. Confirm a `network_response_body`
   event still eventually shows up once the stream completes (detached capture didn't silently
   break).
6. Repeat step 5's console snippet on an unpacked Chrome load of
   `packages/chrome-attach-extension/src` (attach a tab there too) to confirm 1.3's fix.

**Bug 2 (Chrome):**
1. Load unpacked at `chrome://extensions` (Developer mode → Load unpacked →
   `packages/chrome-attach-extension/src`).
2. Open the extension's service worker DevTools ("service worker" link on its card) and run
   `chrome.alarms.getAll(a => console.log(a))` — confirm `"telly-keepalive"` is present.
3. With the backend running and the popup showing "Connected: ...", close the service worker
   DevTools panel (an open inspector prevents suspension), then either wait ~60-90s idle (minimal
   other tab activity, to avoid incidental `webRequest`-triggered wakeups masking the test) or use
   `chrome://inspect/#service-workers` to manually terminate the worker to force suspension
   deterministically.
4. Reopen the popup/service-worker inspector; connection should show "Connected: ..." again within
   about one alarm period + connect time, not only whenever some unrelated tab happens to make a
   network request. Cross-check the backend logs show a fresh `hello`/`hello_ack` for the same
   `instance_id`.
5. Repeat 2-3 suspend/resume cycles; confirm the server/registry shows only one active connection
   per instance (validates the `CONNECTING`-state guard prevents duplicate sockets).
6. In the popup, disable the connection; wait through an alarm period (~30s+); confirm it stays
   disconnected (validates the `manualDisconnect` guard). Re-enable, confirm normal reconnect.
