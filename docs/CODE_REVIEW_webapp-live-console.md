# Analysis and resolution: Live Console rendering in the Telegram Mini App (WebApp)

Scope: `src/services/features/telegram-mcp/src/app/webapp/assets.ts` (the embedded client-side
`WEBAPP_APP_JS`, an xterm.js-based terminal renderer) and its server counterpart
`src/services/features/telegram-mcp/src/app/http.ts` (`/api/live/ws`), plus
`gateway-socket.service.ts` / `gatewayHttpService.ts` for the relay path. "Live console" here is
the Telegram Mini App's live terminal view (xterm.js), not the browser-extension console — one row
in `gateway_live_consoles` = one connected agent/session, per `docs/DECISIONS.md:33`.

## Resolution (implemented 2026-07-14)

All three findings are resolved. The final design deliberately keeps the live console on a single
streaming transport instead of retaining polling as a degraded mode:

- The Mini App reconnects `/api/live/ws` after initial connection failures and later disconnects.
  Retries use exponential backoff from 1 second up to a 30-second cap, are deduplicated, and reset
  after a usable `snapshot` arrives. Events from superseded sockets cannot mutate current state.
- Client polling was removed completely: there is no poll timer, `/api/view` fetch, poll-mode
  status, bootstrap `poll_interval_ms`, `WEBAPP_POLL_INTERVAL_MS`, or WebApp `/api/view` route.
  While disconnected, the UI reports that the live stream is reconnecting.
- Terminal fitting now uses the official `@xterm/addon-fit@0.10.0`, matched to
  `@xterm/xterm@5.5.0`. The client no longer reaches into xterm's private `_core` render service.
  Both columns and rows follow the real container dimensions through `ResizeObserver` and window
  resize events.
- Full snapshots are reset and written directly at the fitted viewport size. The competing
  payload-size/line-count heuristic and `fittedRows` cache were removed, eliminating the periodic
  resize fight described in Finding 3.
- Fitted `{cols, rows}` are sent to the PTY over the live socket. Relay sessions forward the same
  resize message to the remote console, where the dimensions are validated, bounded, and applied
  to the local PTY.
- Normal VT/ANSI rendering remains xterm.js-owned. The small manual HTML renderer remains only as
  an emergency fallback when xterm or its fit addon cannot initialize.

Verification added in `tests/webappAssets.test.ts` and `tests/gatewayLiveResize.test.ts` covers
addon embedding, fitted resize messages, full-snapshot sizing, reconnect behavior, and relayed PTY
resize. At implementation time, TypeScript build, ESLint, and the complete Vitest suite passed
(`27` test files, `121` tests).

The findings below are retained as the pre-fix investigation record; their line references and
polling descriptions refer to the old implementation.

---

## Finding 1 (primary suspect): the live WebSocket never reconnects — a single drop permanently downgrades to slow polling

`assets.ts:1051-1119` (`connectLiveSocket`) and `assets.ts:1239-1258` (`main`).

`connectLiveSocket()` is called **exactly once**, from `main()`, at page load:
```js
try {
  await connectLiveSocket();
} catch (_error) {
  await refreshVisibleBuffer();
  startPolling();
}
```
If the initial connection attempt fails, it falls back to polling — fine. But look at what happens
once a live connection *has* succeeded and later drops:
```js
socket.addEventListener("close", () => {
  state.liveSocketConnected = false;
  if (state.liveSocket === socket) {
    state.liveSocket = null;
  }
  setLiveModeStatus("poll");
  startPolling();
});
```
The `close` handler falls back to `startPolling()` and **never calls `connectLiveSocket()` again**.
There is no retry loop, no backoff, no periodic "try to re-upgrade to streaming" check anywhere in
the file — `connectLiveSocket` has exactly one caller. Once the live socket closes for *any* reason
— a server restart, a transient network blip, the gateway relay hiccuping, or (very plausible on
Telegram's mobile clients) the WebView being backgrounded/suspended and its sockets torn down when
the app resumes — the session is **permanently** downgraded to 2-second HTTP polling for the rest
of that page load, with no way back to live streaming short of the user manually closing and
reopening the Mini App.

This matters more than it might look because of how polling renders (see `renderTerminalPayload`,
`assets.ts:524-562`): every poll tick does `terminal.reset()` + `terminal.resize()` +
`terminal.write(full snapshot)` — a full clear-and-redraw of the visible pane from a freshly
captured buffer, not an incremental append. That's inherent to how `/api/view` works (it returns a
fresh "visible buffer" capture, not a delta), and is a reasonable design for the *fallback* path —
but it means once you're stuck in perma-poll mode, the console is visibly choppier (redraws every
2s, loses true scrollback beyond what's currently visible on the PTY, subject to signature-dedup
skips), which is a very plausible match for "something's off with the live console" as an
experience, especially anytime after the session has been open for a while or the phone/Telegram
app was backgrounded once.

**Fix direction:** in the `close` handler, instead of only falling back to polling, schedule a
retry of `connectLiveSocket()` (e.g. a backoff similar to the browser-extension reconnect pattern
already used elsewhere in this codebase — a few seconds initial delay, capped backoff) and only
keep using the poll fallback *while* that retry is pending / repeatedly failing. Polling should be
the degraded state while trying to recover, not a terminal one.

---

## Finding 2: terminal column count is never re-fit to the actual container width

`assets.ts:387-438` (`getTerminalCellHeight`, `fitTerminalRows`) and `assets.ts:499-522`
(`estimateTerminalSizeFromPayload`).

There is no `@xterm/addon-fit` dependency anywhere in the repo (confirmed: no `addon-fit` in
`package.json` or anywhere under `src/`) — this webapp hand-rolls its own terminal-fit logic
instead of using xterm.js's standard fit addon, which normally measures **both** rows and columns
from the container's actual pixel dimensions divided by the measured cell size.

The hand-rolled version only does the rows half:
```js
function fitTerminalRows(notifyServer = true) {
  ...
  const nextRows = Math.max(5, Math.floor(elements.terminal.clientHeight / cellHeight));
  ...
  const currentCols = typeof terminal.cols === "number" && terminal.cols > 0 ? terminal.cols : 80;
  terminal.resize(currentCols, nextRows);   // <-- cols is just whatever it already was
  ...
}
```
`currentCols` is never recomputed from the container's actual *width* — it just reuses whatever
`terminal.cols` already happens to be. This function is wired to both `ResizeObserver` (on the
terminal element) and `window.resize`, so **rows** do stay in sync with container size changes, but
**columns never do**, regardless of how many times the container is resized.

Columns are only ever set from `estimateTerminalSizeFromPayload`, and only when a `snapshot`
payload arrives (`assets.ts:524-562`, `renderTerminalPayload`, live socket connect or first poll):
```js
const baseCols = Number.isFinite(payload.cols) && payload.cols > 0 ? payload.cols : 40;
const cols = Math.max(baseCols, Math.min(240, Number.isFinite(payload.cols) && payload.cols > 0
  ? payload.cols
  : lines.reduce((max, line) => Math.max(max, line.replace(/\\u001b\\[[0-9;]*m/g, "").length), 0) || 80));
```
- When the server-side payload includes a real `cols` (confirmed present for the **local**,
  non-relayed live socket and poll paths — `http.ts:520-544` and `http.ts:1044-1067` both call
  `getTerminalWindowSize`/`getPtyWindowSize` and spread the real PTY size into the payload), this
  resolves to the actual PTY column count at the moment of that one snapshot — correct at that
  instant, but still frozen from then on (see below).
- `LiveRelayViewResult.cols`/`.rows` (`gatewayHttpService.ts:87-95`) are typed **optional**,
  meaning the relay path (remote-client-via-gateway sessions, i.e. `relay~...` session ids from
  `webapp/relay.ts`) is not guaranteed to carry real terminal dimensions through — worth confirming
  directly against the remote-side responder before ruling this out as a contributing factor for
  relayed sessions specifically.
- When `payload.cols` is genuinely absent, the code falls back to counting visible characters per
  line after stripping only SGR color codes (`\x1b[...m`) — it does **not** strip other common CSI
  sequences (cursor movement, clear-line, etc.), so leftover escape bytes can inflate the estimated
  column count. This is a secondary bug inside the fallback heuristic itself, on top of the primary
  issue that the heuristic exists at all where a real width-based measurement should be used.

Net effect either way: after the very first snapshot sets an initial `cols` value (real or
guessed), **nothing in the client ever re-measures columns against the actual on-screen container
width again** — not on window resize, not on ResizeObserver firing, not on Telegram Mini App
viewport changes (device rotation, `tg.expand()`/`requestFullscreen()` completing asynchronously,
virtual keyboard opening/closing). Only rows track the container; columns are stuck. This produces
exactly the kind of "something's off" symptom a user would notice without being able to pinpoint
it precisely: text wrapping at the wrong point, the "Wrap"/"Unwrap" toggle behaving inconsistently
relative to the visible panel width, or horizontal overflow/clipping after rotating the device or
after Telegram resizes the Mini App's viewport post-launch.

**Fix direction:** compute columns the same way rows are computed — from the container's actual
pixel width divided by the measured cell width (`terminal._core._renderService.dimensions.css.cell`
already exposes `.width` alongside the `.height` this code already reads for rows), and call
`terminal.resize(nextCols, nextRows)` with both freshly measured on every `fitTerminalRows()`
invocation, not just rows. This also fixes the `resize` message sent to the server
(`{type: "resize", cols: currentCols, rows: nextRows}`, `assets.ts:434-436`), which today reports a
stale/estimated `cols` back to the PTY, meaning the actual shell/agent process's own line-wrapping
(which depends on the real terminal width via `SIGWINCH`) can already disagree with what's
displayed, independent of any client-side rendering bug in the browser.

---

## Finding 3: poll-mode render mechanics itself — wrong row count computed every tick, and a stale-cache bug that stops it from self-correcting

This is the direct answer to "is the render mechanism itself okay, or is the lag just inherent to
the webapp." **It is not inherent — poll-mode rendering has a real, reproducible mechanics bug on
top of Findings 1 and 2**, and it's the most likely source of a *periodic* (roughly every
`pollIntervalMs` = 2000ms by default, `env.ts:129`) visible stutter/jump, as opposed to a one-off
issue.

### 3a — poll-mode row count is computed from captured buffer size, not real viewport rows, even though the real value is available

`estimateTerminalSizeFromPayload` (`assets.ts:499-522`):
```js
const useViewportRows =
  options.preferViewportRows === true &&
  Number.isFinite(payload.rows) && payload.rows > 0;
const rows = useViewportRows
  ? Math.max(2, Math.min(120, payload.rows))                       // real PTY rows
  : Math.max(2, Math.min(400, lines.length || payload.rows || 24)); // captured-buffer line count
```
`preferViewportRows` is only passed as `true` for the live-socket **snapshot** message
(`connectLiveSocket`, `assets.ts:1082-1085`) — every **poll** call
(`refreshVisibleBuffer` → `renderTerminalPayload(payload)`, `assets.ts:1134-1139`, no options
passed) falls into the `else` branch and sizes the terminal to `lines.length` — the number of
newline-split lines in the just-captured buffer text — **not** the real PTY row count, even though
`payload.rows` is present in that same payload (`/api/view` always spreads in
`getTerminalWindowSize`'s result, `http.ts:1044-1067`). Since `"".split("\\n")` already has
`length === 1`, `lines.length` is essentially never falsy, so the `payload.rows` fallback in that
`||` chain is dead code in practice — the real row count is available but never used here.

`WEBAPP_VISIBLE_SCREENS` defaults to `2` (`env.ts:128`), meaning `/api/view` typically captures
**about two screens' worth of lines** (current view + one screen of scrollback context) for exactly
this reason — to give the poll fallback some context. But that means `lines.length` in a poll
payload is routinely close to **2x** the real number of viewport rows. Every poll tick therefore
resizes the terminal to roughly double the row count it should have.

### 3b — that wrong resize isn't corrected, because it bypasses the fit-cache that would normally fix it

`renderTerminalPayload` calls `terminal.resize(size.cols, size.rows)` directly
(`assets.ts:551`) and then schedules a corrective `fitTerminalRows(false)` on the next tick
(`assets.ts:558-560`, `window.setTimeout(..., 0)`). That correction should bring rows back to the
real viewport-fitting value — except `fitTerminalRows` guards itself with:
```js
if (state.fittedRows === nextRows) {
  return;   // "nothing changed, skip the resize"
}
```
`nextRows` here is recomputed purely from `elements.terminal.clientHeight / cellHeight` — the
container's actual size, which hasn't changed. `state.fittedRows` still holds whatever the *last
successful `fitTerminalRows` call* set it to (the correct value from before). Because
`renderTerminalPayload`'s own `terminal.resize()` call never touches `state.fittedRows`, the cache
has no idea the terminal's row count was just changed out from under it — so this guard compares
"the same real container height as always" against "the same cached value as always," concludes
nothing changed, and **skips the correction** even though `terminal.rows` was just set to roughly
2x the correct value moments earlier.

### Net effect

Every poll tick (default every 2s, and — per Finding 1 — this becomes the *permanent* mode after
any single live-socket drop): the terminal is resized to a wrong (typically ~2x too tall) row
count, and the self-correcting fit logic silently no-ops because its cache thinks the container
never changed. Combined with the full `terminal.reset()` immediately before it (discarding the
prior render state) and `write()` afterward (parsing/repainting the whole captured buffer), this is
a real, code-verifiable "the terminal jumps/resizes every couple of seconds" mechanism — not
something inherent to running inside a Telegram Mini App WebView. It is specifically a poll-mode
bug, so it's invisible while the live WebSocket is genuinely connected and streaming (where updates
come from incremental `data` messages with no reset/resize at all) — which is also why Finding 1
(silently getting stuck in poll mode after any drop) makes this so much more noticeable in
practice than the code's happy path would suggest.

**Fix direction:**
- In the poll branch, prefer `payload.rows` (already present) over the captured-line-count
  heuristic for terminal sizing — same as the `preferViewportRows` branch already does for the live
  snapshot case; there's no real reason poll-mode sizing should behave differently once a real
  row count is available in both payloads.
- Route `renderTerminalPayload`'s resize through the same code path that updates
  `state.fittedRows` (or update `state.fittedRows` directly alongside its `terminal.resize()` call)
  so the two resize call sites can't desync — right now there are effectively two independent
  "what size should the terminal be" answers (`estimateTerminalSizeFromPayload`'s guess and
  `fitTerminalRows`'s real measurement) that don't share state and can silently fight each other.

---

## Lower-confidence / worth a quick look, not fully chased down

- **Relay-path terminal size**: the local live-socket and poll endpoints both confirmed-populate
  real `cols`/`rows` from `getTerminalWindowSize`. The remote-relay path
  (`gatewayHttpService.ts::requestLiveRelayView`, backing `relay~...` session ids) types `cols`/
  `rows` as optional and this analysis didn't trace all the way into the remote client's own
  responder for `requestType: "view"`/`"stream_subscribe"` to confirm whether it's actually always
  populated in practice. If it isn't, relayed sessions hit the character-length heuristic (and thus
  Finding 2) even on their very first snapshot, not just on subsequent resizes.
- **Telegram viewport events**: there's no explicit listener for Telegram's `viewportChanged` event
  or `window.visualViewport`'s `resize` event — only a generic `window.resize` and a
  `ResizeObserver` on the terminal element. Since the layout uses `height: 100dvh` on `.app`
  (`assets.ts` CSS, dynamic viewport units), the `ResizeObserver` on the terminal element should
  catch most Telegram-driven viewport changes indirectly (as long as `100dvh` itself updates
  correctly across the target WebViews), so this is likely fine in practice — flagged only because
  it wasn't verified against real Telegram client behavior (iOS/Android/Desktop are known to be
  inconsistent here) and ties directly into Finding 2 once columns are made width-aware too.

## Priority
1. **Finding 1** (no live-socket reconnect) — the more severe issue: a single transient drop
   silently and permanently degrades the whole session's experience, with no user-visible way to
   recover short of restarting the Mini App, and directly amplifies Finding 3 by making poll mode
   "sticky."
2. **Finding 3** (poll-mode row-count/cache bug) — the direct explanation for periodic visual
   "lag": every poll tick (2s default) resizes the terminal to roughly 2x the correct row count and
   the self-correction logic silently no-ops. Reproducible on demand by forcing poll mode (e.g.
   disable/re-enable network briefly to drop the live socket, given Finding 1).
3. **Finding 2** (columns never re-fit) — a real, always-reproducible rendering bug (rotate the
   device, or resize the Mini App panel, and columns won't follow), but lower severity since it's
   "wrong wrapping," not "stopped working."

All three compound: Finding 1 makes poll mode sticky, poll mode is where Finding 3's row-count bug
lives, and Finding 2's frozen columns apply in both modes. Fixing Finding 1 alone would make the
other two far less noticeable in practice (poll mode would become rare again), but Findings 2 and 3
are real bugs in their own right and worth fixing regardless.
