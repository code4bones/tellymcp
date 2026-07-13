# Recommended Fixes: Browser-Attach Feature

Companion to `docs/CODE_REVIEW_browser-attach.md` — that file has the findings and *why*; this
file has concrete *how to fix* for each one, ordered by the same priority.

## Status on 2026-07-13

This is no longer a pure backlog. Parts of this fix list have already been applied.

Implemented:
- Fix `1.1`: `startRecording()` now checks `tabId`, not only `instanceId`.
- Fix `1.2`: the reconnect close-handler is now guarded against wiping a newer live socket.
- Fix `1.3`: persisted recordings can now be stopped after restart, and an existing bundle is
  finalized when session cwd is available.
- Fix `1.8`: attached-tab URL fields were relaxed from strict `.url()` validation to plain strings
  where the backend can legitimately return an empty or unresolved URL.

Still pending from this document:
- Fix `1.4`: unify Chrome/Firefox injected-export semantics for bare global assignments.
- Fix `2.1`: rename Firefox-specific shared infra and stop persisting everything under the single
  `"firefox-attached"` backend literal.
- Fix `2.2`: move capture/reconnect policy knobs into the server handshake if we want them
  centrally managed.
- P3/P4 cleanup and efficiency items remain backlog work.

---

## P0 — silent functional breakage

### Fix 1.3 — `stopRecording()` no-op after server restart
`firefoxAttachServer.ts:275-314`

Root cause: the decision to send the `recording_stop` control message is gated on an in-memory
`activeRecordingsById` entry that doesn't survive a restart, instead of on "is the instance
connected and does storage say we're recording."

Recommended change:
- In `stopRecording()`, drop the `activeRecordingsById.get(...)` existence check as the gate for
  sending the control message. Instead: if `existing.status === "recording"` (from
  `maintenanceStore`, the source of truth) **and** the instance is currently connected
  (`socketsByInstanceId.has(instanceId)`), always call `invokeRecordingControl(mode: "stop")`.
- On server startup (`FirefoxAttachServer.start()` / constructor), reconcile
  `activeRecordingsById` from `maintenanceStore`: for every persisted record with
  `status === "recording"`, re-seed an in-memory entry (or a lighter marker) so the existing gate
  stays consistent going forward, rather than removing the map entirely.
- Add a defensive path: if the instance is *not* connected when stop is requested, still mark
  storage stopped (current behavior is correct for that case) but surface that fact to the caller
  (e.g. a `warning` field in the tool response) so the agent knows the extension was not actually
  told to stop.

### Fix 1.2 — WS reconnect race deletes a live registration
`firefoxAttachServer.ts:133-141`

```ts
ws.on("close", () => {
  const current = this.socketsByInstanceId.get(state.instanceId);
  if (current !== state) {
    // a newer connection has already replaced this one — nothing to clean up
    return;
  }
  this.socketsByInstanceId.delete(state.instanceId);
  this.registry.remove(state.instanceId);
  // ...rest of existing cleanup (pending recordings, broadcasts, etc.)
});
```
The same guard should be applied everywhere else in the file that mutates
`socketsByInstanceId`/`registry` from a socket-scoped callback (e.g. `error` handler, if one
exists) — grep for `socketsByInstanceId.delete` and `registry.remove` to catch all call sites.

### Fix 1.1 — `startRecording()` ignores tab identity
`firefoxAttachServer.ts:204-210`

```ts
const existing = this.activeRecordingsById.get(recordingKeyFor(input.instanceId));
if (existing && existing.status === "recording") {
  if (existing.tabId !== input.tabId) {
    throw new Error(
      `Instance ${input.instanceId} is already recording tab ${existing.tabId}; ` +
      `stop that recording before starting one for tab ${input.tabId}.`
    );
  }
  return existing; // idempotent restart-of-same-recording case, unchanged
}
```
Decide product behavior explicitly: either error out (shown above — safest, forces the caller to
stop first) or support concurrent per-tab recordings by keying `activeRecordingsById` on
`(instanceId, tabId)` instead of `instanceId` alone. The latter is a bigger change (also touches
`maintenanceStore` key shape and the recording bundle directory naming) — pick it only if
multi-tab-simultaneous-recording is an actual product requirement.

### Fix 1.4 — Chrome/Firefox `inject_script` export divergence
`packages/chrome-attach-extension/src/background.js:179-198`

Replace Chrome's regex-based `collectInjectExportNames` with the same window-diff approach Firefox
already uses (`background.js:470-479` in the Firefox package):

```js
// before running the injected source
const before = new Set(Object.getOwnPropertyNames(window));
// ...eval/execute the injected source...
const after = Object.getOwnPropertyNames(window);
const exportNames = after.filter((name) => !before.has(name));
```
This makes both extensions capture the same class of globals (declared *and* bare-assigned) and
removes Chrome's now-dead `buildTabActionCode` inject branch inconsistency noted during
verification. Since this touches `chrome-attach-extension/src/background.js`, re-run
`packages/chrome-attach-extension/scripts/build.mjs` and bump the extension version so testers pick
up the fix.

---

## P1 — data correctness

### Fix 1.6 — timestamp UTC regression
`shared/lib/time/localTimestamp.ts`, consumed by `browserService.ts` (~15 sites),
`browserRecordingBundle.ts`, both extensions' recorder scripts.

Two viable directions — pick one, don't mix:

**Option A (recommended for machine-facing fields):** revert `lastUsedAt`/`createdAt`/
`uploadedAt`/event timestamps back to `new Date().toISOString()`. Keep `formatLocalTimestamp`
*only* for human-facing artifacts that were the actual reason it was introduced (e.g. recording
bundle **directory names**, which need to be filesystem-safe and human-readable, not machine-parsed).

**Option B (if local time in the string is actually wanted):** append the real UTC offset:
```ts
function formatLocalTimestamp(date: Date): string {
  const offsetMin = -date.getTimezoneOffset();
  const sign = offsetMin >= 0 ? "+" : "-";
  const offset = `${sign}${padNumber(Math.trunc(Math.abs(offsetMin) / 60))}:${padNumber(Math.abs(offsetMin) % 60)}`;
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(date.getHours())}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(date.getMilliseconds(), 3)}${offset}`;
}
```
Either way, audit every call site added in this diff (`grep -rn formatLocalTimestamp`) and decide
per-site which category (machine field vs. human artifact name) it falls into — don't apply one
answer uniformly without checking.

### Fix 1.8 — attached-tab `url` fields can violate their own output schema
`entities/request/model/schema.ts` (`browserClickOutputSchema` etc.) and
`browserService.ts:1403` (`getNetworkFailures`, the concretely-reachable case)

Cheapest correct fix: loosen the schema, since an attached tab's URL genuinely can be
unknown/empty in edge cases (privileged pages, malformed capture):
```ts
url: z.string() // was z.string().url()
```
Apply to: `browserClickOutputSchema`, `browserFillOutputSchema`, `browserPressOutputSchema`,
`browserWaitForOutputSchema`, `browserReloadOutputSchema`, `browserInjectScriptOutputSchema`,
`browserWaitForUrlOutputSchema.current_url`, `browserNetworkFailuresOutputSchema.failures[].url`.

If callers actually rely on `url` always being a valid absolute URL downstream, the alternative is
to guarantee a non-empty fallback before returning (e.g. `attached.url || "about:blank"`) — but
that hides a real "we don't know the URL" signal, so prefer relaxing the schema and letting callers
handle `""` explicitly.

---

## P2 — architecture / naming (do before more data accumulates)

### Fix 2.1 — rename Firefox-specific-sounding shared infra
`firefoxAttachRegistry.ts` → `browserAttachRegistry.ts`, `firefoxAttachServer.ts` →
`browserAttachServer.ts`, class names `FirefoxAttachRegistry`/`FirefoxAttachServer` →
`BrowserAttachRegistry`/`BrowserAttachServer`.

Suggested sequencing to keep this reviewable:
1. Rename files/classes/constructor field (`browserService.ts:265`,
   `firefoxAttachRegistry: FirefoxAttachHost` → `browserAttachRegistry: BrowserAttachHost`) —
   pure rename, no behavior change.
2. Fix the error string at `browserService.ts:584` to be browser-agnostic
   ("No attached browser tab is selected for this session") or interpolate the actual
   `instance.browser` value.
3. Widen the `backend` field: change the type from the single literal `"firefox-attached"` to
   `"firefox-attached" | "chrome-attached"` in `entities/browser/model/types.ts:85` (and the 3
   sibling literals at 104/114/137/172), and set it from `instance.browser` at each of the 4
   call sites in `browserService.ts` (488, 506, 2297, 2314) instead of hardcoding.
4. This is a schema change for persisted Redis records — existing in-flight records with the old
   literal still deserialize fine (string union is a superset), so no migration needed, but note
   it in the PR description so nobody is surprised by mixed old/new values during rollout.

### Fix 2.2 — move capture-size/reconnect policy server-side
Add `capture_max_bytes` and `reconnect_delay_ms` (or similar) to the `hello_ack` payload
(`firefoxAttachServer.ts:478-489`), and have both extensions read them from the handshake response
with the current hardcoded values as a fallback default if the field is absent (keeps old
extension builds working against a newer server). Lower priority than P0/P1 — only worth doing
before the extensions get more independent release cycles.

---

## P3 — cleanup (safe to batch into a follow-up PR, no behavior change)

These don't fix bugs but reduce the chance of the next change fixing one copy and missing another.

1. **`browserRecordingBundle.ts`**: delete the local `padNumber`/`formatLocalTimestamp` and import
   from `shared/lib/time/localTimestamp.ts` instead (after Fix 1.6 lands, so it imports the
   corrected version).
2. **`firefoxAttachServer.ts:330,579`**: replace ad hoc
   `` `tab-action-${Date.now()}-${Math.random()...}` `` with `createRequestId()` from
   `shared/lib/ids/ids.ts`.
3. **`browserRecordingBundle.ts:119` (`sanitizeSegment`)**: either switch to
   `slugifyFilenamePart` from `shared/integrations/telegram/transportUtils.ts`, or if the extra
   diacritic-stripping behavior is genuinely needed here, extend the shared helper with an option
   flag rather than keeping two divergent implementations.
4. **`browserService.ts`**: extract the repeated
   `resolveSessionDefaults → normalizeSessionIdForAccess → invokeRemote` prologue and the
   `if (attached) {...} else {...}` branch into a shared `runAttachedOrLocal(input, attachedFn,
   localFn)` helper. Do this incrementally (a few methods per PR) given the size of the file.
5. **`ptyRegistry.ts`**: replace `prepareBashLaunch`/`prepareZshLaunch` with one
   `prepareShellLaunch(shellConfig)` driven by a small per-shell table (rc filename, source syntax,
   prompt var).
6. **`firefoxAttachServer.ts`**: extract `invokeTabAction`/`invokeRecordingControl`'s shared
   "register pending map entry → send → await → timeout" logic into one generic
   `sendAndAwait<T>(pendingMap, instanceId, buildMessage, timeoutMs)`.
7. **`entities/browser/model/types.ts`**: drop `bundleRelativePath`/`bundlePath` from
   `BrowserRecordingRecord` and derive them from `bundleDirName` at the point of use instead of
   persisting and re-threading all three through four mapping functions.

---

## P4 — efficiency (worth doing before recommending long/busy recording sessions)

1. **`browserRecordingBundle.ts`**: merge `upsertNetworkRequestArtifact` and
   `materializeRequestBodyArtifact` so `request.json`/`response.json`/`meta.json` are computed once
   body info is known and written exactly once per event, instead of write-then-rewrite.
2. **`browserRecordingBundle.ts`**: throttle `writeSessionJson` — flush on a timer (e.g. every 2s)
   or on status transitions, not on every single `appendEvent` call.
3. **`firefoxAttachServer.ts` (`handleRecordingEvent`)**: debounce/coalesce
   `maintenanceStore.setBrowserRecording` writes (e.g. write at most every N events or every
   T milliseconds, plus always on stop) instead of one Redis `SET` per inbound event.
4. **`browserService.ts:2365`**: before calling `maintenanceStore.setBrowserAttachment`, compare
   the new `title`/`url` against the currently stored record and skip the write if unchanged.
5. **`firefoxAttachServer.ts` (disconnect handler)**: change the sequential
   `for (const state of activeStates) { await ... }` cleanup loop to
   `await Promise.all(activeStates.map(async (state) => { ... }))` since each recording's cleanup
   is independent.
6. **`stateStore.ts` (`clearSession`)**: group the independent Redis `DEL` calls (including the two
   new browser-attachment/recording ones) into a single `Promise.all` instead of sequential awaits.

---

## Not fixing now, but flagged

- **No tests** across this diff (§1.9 in the review). Recommend adding at minimum: a unit test for
  `firefoxAttachRegistry.setTabs()`'s active-tab fallback, a test for `firefoxAttachServer`'s
  close-handler race (mock two sockets for the same instanceId), and an integration-style test for
  the recording start/stop/restart-mid-session sequence — these three cover the highest-severity
  bugs found above and would have caught them before merge.
