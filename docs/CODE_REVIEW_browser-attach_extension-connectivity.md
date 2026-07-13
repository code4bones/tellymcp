# Deep Dive: Firefox fetch-interception breakage & Chrome backend-sink drop

Follow-up to `docs/CODE_REVIEW_browser-attach.md` and
`docs/CODE_REVIEW_browser-attach_FIXES.md`, requested to specifically root-cause two live
symptoms:

- **Firefox:** other, unrelated pages break after the extension is installed/running.
- **Chrome:** the extension's connection to the MCP backend ("sink") appears to die.

Both are confirmed by reading the actual extension code (not just the diff) — no code changed as
part of this analysis.

## Status on 2026-07-13

The root causes documented below were correct and have now been fixed in code:

- Firefox no longer ships a manifest-level global `content_scripts` recorder injection. The
  recorder is injected on demand for the attached/recorded tab only.
- Firefox and Chrome no longer await `response.clone().text()` before returning the page's real
  `fetch()` response to application code.
- Chrome now uses an `alarms` keepalive backstop so the MV3 service worker can reconnect after
  suspension without depending solely on incidental browser traffic.

Remaining follow-up, still optional:
- Server-side stale-heartbeat reaping is still a separate hardening task and is not covered by the
  extension-side reconnect fix.

## Follow-up on 2026-07-14: Chrome MV3 tab-action timeouts

Resolved in Chrome attach extension `0.0.2`.

The generic Chrome tab-action path used
`chrome.scripting.executeScript({ func: new Function(...) })`. Manifest V3 blocks
string-to-code evaluation in the extension service worker, so DOM, click, press, fill,
wait, and computed-style requests threw before sending `tab_action_result`. Screenshot
and script injection used separate, static API paths and therefore continued to work.

The action executor is now a static, self-contained function passed with serializable
`args`. The WS message boundary converts execution exceptions into correlated error
responses, and recording snapshot injection no longer refers to a helper from a lost
closure. Regression tests cover DOM/click/press execution, error responses, snapshot
capture, and the absence of `new Function` from the Chrome source and built bundle.

Server-side stale-heartbeat reaping mentioned above was also implemented on
`2026-07-14` as part of the browser-attach protocol-hardening pass.

---

## 1. Firefox: global, unconditional `fetch` interception hangs unrelated pages

### Root cause chain

1. **`packages/firefox-attach-extension/src/manifest.json:36-47`** registers a *static* content
   script:
   ```json
   "content_scripts": [{
     "matches": ["<all_urls>"],
     "js": ["recorder-content.js"],
     "run_at": "document_start",
     "all_frames": true
   }]
   ```
   This runs on **every page, every frame, every tab** the moment it starts loading — regardless
   of whether TellyMCP has ever attached to that tab, and regardless of whether a recording is
   active. There is no per-tab or per-recording gating anywhere in the manifest or the script
   itself.

2. **`recorder-content.js:57-60`** unconditionally injects `recorder-page.js` as a `<script>` tag
   into the page's own (MAIN-world) execution context — again, no check for "is this tab attached"
   or "is recording active."

3. **`recorder-page.js:168-215`** unconditionally replaces `window.fetch` for that page:
   ```js
   const originalFetch = window.fetch.bind(window);
   window.fetch = async (...args) => {
     const request = new Request(...args);
     ...
     const response = await originalFetch(...args);
     emit({ kind: "network_response_complete", ... });      // (A)
     try {
       const bodyText = await response.clone().text();      // (B) <-- blocks here
       emit({ kind: "network_response_body", ... });
     } catch { /* ignore */ }
     return response;                                        // (C) <-- only reached after (B)
   };
   ```

### The actual breakage mechanism

Line **(C)** — the `return response` that resolves the page's `fetch()` promise — is only reached
**after** `await response.clone().text()` at **(B)** finishes. `.text()` doesn't resolve until the
response body stream is fully consumed and closed.

For a normal small JSON API response this adds a few ms of harmless latency. But for anything using
a **long-lived or streaming response** — Server-Sent Events over `fetch`, chunked/streamed AI chat
responses, GraphQL subscriptions-over-fetch, long-polling, resumable/progressive downloads — the
underlying HTTP response body never "completes" in the short term (or takes a very long time). That
means:

> **The page's own `await fetch(...)` call never resolves**, because the extension's wrapper is
> silently waiting on `.clone().text()` to finish reading a stream that may run for minutes or
> indefinitely, before it will hand the `Response` back to the caller.

This reproduces as exactly the reported symptom: unrelated pages (any site using streaming fetch —
which is common on modern chat/dashboard/live-data UIs) appear frozen or hung, because their fetch
calls silently never return. It's not "the page crashes" — it's "the page's own network calls stop
completing," which looks like the page "breaking" or "not loading."

### Secondary issues in the same wrapper

- `const request = new Request(...args)` at line 171 reconstructs the request from the original
  arguments. Per the Fetch spec, constructing a `Request` with a streaming (`ReadableStream`) body
  requires an explicit `duplex: "half"` option; if the original call didn't need to pass it through
  a second construction, or the caller's `RequestInit` isn't fully preserved by
  `new Request(...args)`, this reconstruction can throw synchronously — meaning some fetch calls
  that worked before the extension was installed **throw immediately** after, with no fallback to
  original behavior.
- `serializeRequestBody` (line 80-91) calls `request.clone().text()` on **every** request
  regardless of size — a large file upload gets fully buffered into memory just to check whether
  it's worth emitting, wasting memory/CPU on every tab, all the time.
- The same class of interception applies to `XMLHttpRequest.prototype.open/send/setRequestHeader`
  (lines 217-310). This one does *not* block request resolution (the `send` override still calls
  `originalSend.call(this, body)` synchronously and captures the response via a non-blocking
  `loadend` listener), so it's a much smaller correctness risk than the `fetch` override — but it's
  still installed globally and unconditionally, adding overhead and PII capture exposure
  (headers/body text of literally every XHR on every site) to tabs that were never attached.
- `console.*` patching (lines 93-134) and the `error`/`unhandledrejection` listeners (136-166) are
  comparatively low-risk (they don't change control flow), but they too run unconditionally on
  every page — worth gating for the same reason (privacy/perf), just not urgent for correctness.

### Why this matters architecturally

This is the same instrumentation Chrome injects *on demand* — see §2 below, Chrome only loads
`recorder-content.js` into a specific `tabId` via `scripting.executeScript` when actually needed
(`background.js:940-945`, `injectRecorderContent(tabId)`). Firefox's manifest-level
`content_scripts` entry bypasses that gating entirely and is the single root cause of "other pages
break." **Firefox already has the on-demand primitive available** (`browser.tabs.executeScript` in
MV2, or `browser.scripting.executeScript` — supported in Firefox since v102) — this isn't a
platform limitation, it's a manifest/wiring choice that diverges from what the Chrome extension
already does correctly.

### Recommended fix

1. **Remove the static `content_scripts` entry from `manifest.json`.** Keep `recorder-page.js` (and
   `recorder-content.js`, if still needed as a relay) listed only in `web_accessible_resources`.
2. **Inject `recorder-content.js` on demand**, mirroring Chrome's `injectRecorderContent(tabId)`:
   call `browser.tabs.executeScript(tabId, { file: "recorder-content.js", allFrames: true, runAt: "document_start" })`
   (or the `browser.scripting` equivalent) only when a recording actually starts for that tab, and
   only for that tab's frames.
3. **Fix the `fetch` wrapper's blocking bug independent of the injection-scope fix** (defense in
   depth — even a properly-scoped recorded tab shouldn't have its own streaming fetches hang):
   don't `await` the body read before returning the response. Return the real `response` to the
   caller immediately after `originalFetch` resolves, and do the body capture (clone + read) in a
   detached (non-awaited) promise chain:
   ```js
   const response = await originalFetch(...args);
   emit({ kind: "network_response_complete", ... });
   void (async () => {
     try {
       const bodyText = await response.clone().text();
       emit({ kind: "network_response_body", ... });
     } catch { /* ignore */ }
   })();
   return response; // returned immediately, not gated on body capture
   ```
   This alone would have prevented the "other pages hang" symptom even with the current
   all-pages injection scope, and it removes the `new Request(...args)` reconstruction as a
   source of thrown errors on the critical path if that's wrapped too.
4. On re-attach/detach or recording stop, explicitly `browser.tabs.removeCSS`/undo isn't available
   for JS injection, but since (2) makes injection recording-scoped, the exposure window is now
   bounded to "while a recording is active on that specific tab" instead of "always, everywhere."

---

## 2. Chrome: MV3 service-worker suspension silently kills the backend WebSocket

### Root cause chain

1. **`manifest.json:18-19`**: `"background": { "service_worker": "background.js" }` — Manifest V3
   uses a **non-persistent** service worker. Chrome terminates it after roughly 30 seconds without
   a *qualifying* pending event (a plain in-process timer callback does not count as one).

2. **`background.js:16-17,881-891`**: the only liveness mechanism is a JS-level heartbeat:
   ```js
   const HEARTBEAT_INTERVAL_MS = 15000;
   function startHeartbeat() {
     if (heartbeatTimer) clearInterval(heartbeatTimer);
     heartbeatTimer = setInterval(() => {
       sendJson({ type: "heartbeat", sent_at: formatLocalTimestamp(new Date()) });
     }, HEARTBEAT_INTERVAL_MS);
   }
   ```
   `setInterval`/`setTimeout` timers are pure in-memory JS state. They are **not** preserved across
   service-worker termination — when Chrome kills the worker, `heartbeatTimer`, `reconnectTimer`,
   and the `socket` variable itself are simply gone. There is nothing left to fire the next
   heartbeat or notice the socket died.

3. **No `chrome.alarms` usage anywhere**, and the manifest doesn't even request the `"alarms"`
   permission (confirmed: `grep -n "alarms" manifest.json` returns nothing). `chrome.alarms` is
   the only Chrome-documented mechanism for **surviving** service-worker suspension with a
   periodic wakeup — everything else in this file (the heartbeat interval, the reconnect
   `setTimeout` at `scheduleReconnect()`, line 860-868) is exactly the anti-pattern Chrome's own
   MV3 migration docs warn will silently stop working.

4. **`background.js:1407-1418`**: the only place the code explicitly acknowledges the
   service-worker lifecycle problem:
   ```js
   port.onMessage.addListener(() => {
     // keep the service worker alive while the control panel is open
   });
   ```
   This keeps the worker alive only while the **popup or options page is open** — i.e. exactly the
   case that matters least, since the extension's entire purpose is unattended background
   automation with no UI open. There is no equivalent for the common case (no UI open, browser
   otherwise idle).

5. **Partial, incidental mitigation:** `browser.webRequest.onCompleted`/`onErrorOccurred` (and
   similar) listeners are registered synchronously at the top level of `background.js`, matching
   `<all_urls>`. MV3 wakes a suspended service worker to deliver events to listeners that were
   registered this way, so *if* network traffic happens in *any* open tab, the worker gets
   resurrected and `connect()` (called unconditionally at module top level, line 1714) re-runs,
   re-establishing the WebSocket. This is why the connection isn't permanently dead — but it means
   reconnection is opportunistic and can take anywhere from 0 seconds (busy tab) to indefinitely
   long (browser idle / all tabs static / machine asleep) rather than the intended 15s heartbeat /
   3s reconnect cadence the code implies.

### Net effect ("the sink dies")

Whenever the browser (across *all* open tabs, not just the attached one) goes ~30 seconds without
network activity that fires a `webRequest` listener, Chrome tears down the service worker. That
destroys the WebSocket, the heartbeat timer, and the reconnect timer in one shot, with **no
guaranteed wakeup** to notice and recover — the extension only comes back opportunistically, on the
next incidental browser event. From the MCP server's side, this can look like the instance just
stopped responding to heartbeats/hello and eventually is treated as disconnected (or, worse, hits
the stale-close race documented as Fix 1.2 in `CODE_REVIEW_browser-attach_FIXES.md`, if the socket
teardown on the Chrome side doesn't send a clean WS close frame promptly).

### Recommended fix

1. **Add `"alarms"` to `manifest.json` permissions.**
2. **Replace the `setInterval` heartbeat with `chrome.alarms`:**
   ```js
   chrome.alarms.create("telly-heartbeat", { periodInMinutes: 0.25 }); // ~15s, alarms min is 30s in practice for periodInMinutes on some Chrome versions — see note below
   chrome.alarms.onAlarm.addListener((alarm) => {
     if (alarm.name !== "telly-heartbeat") return;
     if (!socket || socket.readyState !== WebSocket.OPEN) {
       void connect(); // also handles the reconnect-after-suspension case
       return;
     }
     sendJson({ type: "heartbeat", sent_at: formatLocalTimestamp(new Date()) });
   });
   ```
   Note: Chrome clamps `chrome.alarms` to a **minimum period of ~30 seconds** in packed/production
   extensions (1 minute prior to Chrome 120, 30s from Chrome 120+). A 15s in-process heartbeat
   cadence is not achievable via alarms alone — but that's fine, because the alarm's real job here
   isn't the heartbeat cadence itself, it's **waking the worker so `connect()`/reconnect logic can
   run at all**. Once woken, the existing `setInterval`-based heartbeat can resume for the
   in-memory lifetime of that worker instance; the alarm is the backstop that guarantees the worker
   gets a chance to notice a dead socket and reconnect at least every ~30s even during total browser
   idle.
3. **Replace `scheduleReconnect()`'s `setTimeout` with the same alarm**, or explicitly re-arm a
   short-lived alarm for the reconnect delay — a bare `setTimeout` scheduled from a callback that
   itself might get suspended is the same anti-pattern as the heartbeat.
4. **On the server side**, treat "no heartbeat received in N seconds" as equivalent to a clean
   disconnect (close the registry entry, mark the instance offline) rather than assuming a missing
   heartbeat means nothing — this bounds how long the server keeps believing a suspended-worker
   instance is alive, independent of whatever the extension-side fix achieves.
5. Lower-effort partial mitigation if `alarms` can't be adopted immediately: don't rely on
   `webRequest` listeners as the *only* wakeup path — nothing else needed since (2)/(3) subsume
   this, but worth noting the `<all_urls>` webRequest registration is doing double duty today
   (network capture *and* accidental SW keepalive) and that coupling should be called out in code
   comments once alarms are added, so a future refactor of the network-capture logic doesn't
   accidentally remove the extension's only current keepalive path before `alarms` lands.

---

## Priority

1. **Firefox fetch-wrapper hang (§1, fix 3)** — this is the one-line-shaped fix (stop awaiting body
   capture before returning the response) that removes the actual page-hanging behavior fastest,
   independent of the bigger injection-scope rework.
2. **Firefox injection scope (§1, fixes 1-2)** — larger change (touches manifest + background.js
   wiring to call `executeScript` on recording start, mirroring Chrome), but is the real fix for
   "why does this touch pages that were never attached at all."
3. **Chrome `chrome.alarms` keepalive (§2)** — without it, the extension's core promise ("stays
   connected in the background") doesn't hold under Chrome's actual MV3 lifecycle; this is not an
   edge case, it will trigger on any normal idle browsing session.
