# Analysis: Live Console rendering in the Telegram Mini App (WebApp)

Scope: `src/services/features/telegram-mcp/src/app/webapp/assets.ts` (the embedded client-side
`WEBAPP_APP_JS`, an xterm.js-based terminal renderer) and its server counterpart
`src/services/features/telegram-mcp/src/app/http.ts` (`/api/live/ws`, `/api/view`), plus
`gateway-socket.service.ts` / `gatewayHttpService.ts` for the relay path. "Live console" here is
the Telegram Mini App's live terminal view (xterm.js), not the browser-extension console — one row
in `gateway_live_consoles` = one connected agent/session, per `docs/DECISIONS.md:33`. No code
changed as part of this analysis.

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
   recover short of restarting the Mini App.
2. **Finding 2** (columns never re-fit) — a real, always-reproducible rendering bug (rotate the
   device, or resize the Mini App panel, and columns won't follow), but lower severity since it's
   "wrong wrapping," not "stopped working."
