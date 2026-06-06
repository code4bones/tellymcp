# Firefox Attach MCP Plan

## Goal

Add a second browser backend for `telegram_mcp` that attaches to an already running user Firefox instance through a local extension, without changing the existing Playwright browser backend.

This backend is for cases where automation must continue inside the user's real browser session, tabs, cookies, login state, and active page context.

## Non-Goals

- do not replace the current Playwright browser tools
- do not merge Firefox attach logic into the existing Playwright runtime
- do not introduce marker-navigation logic for browser actions
- do not build Chrome support in the first pass
- do not try to reach full parity with all current browser diagnostics in v1

## Product Model

We keep two browser backends:

1. `playwright`
   - current isolated automation backend
   - opens and owns its own browser context

2. `firefox-attached`
   - new backend
   - talks to a user-installed Firefox extension
   - attaches to existing tabs/windows/session state

The high-level browser tools stay conceptually the same, but attached-browser workflows require an explicit attach step first.

## User Experience

Expected flow:

1. developer installs Firefox extension
2. developer configures host / port once
3. `tellymcp` sees one or more attached Firefox instances
4. agent lists available tabs or attaches to the active tab
5. existing browser tools work against that attached tab

V1 explicit tools:

- `browser_list_attached_instances`
- `browser_list_tabs`
- `browser_attach_active_tab`
- `browser_attach_tab`
- `browser_detach_tab`

Then reuse existing tools on the attached tab:

- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_wait_for_url`
- `browser_dom`
- `browser_computed_style`
- `browser_screenshot`

V1 does not require `browser_open` for attached Firefox mode.

## Trust / Security Model

This mode is explicitly trusted and developer-installed.

If the user installs and enables the extension, the extension may have full browser access:

- tabs
- windows
- history
- bookmarks
- cookies if later required
- web request visibility if later required

Connection model:

- local WebSocket only
- default endpoint:
  - `ws://127.0.0.1:9999/browser-attach/ws`
- explicit instance handshake

Required env for `telegram_mcp`:

- `BROWSER_ATTACH_ENABLED=true|false`
- `BROWSER_ATTACH_WS_HOST=127.0.0.1`
- `BROWSER_ATTACH_WS_PORT=9999`

Extension options:

- host
- port

## Why Not Reuse FoxMCP Whole

`foxmcp` is a useful reference, but we should not adopt it wholesale.

Reasons:

- it is a separate product with its own Python MCP server/runtime
- its scope is broader than what we need for the first pass
- we need a thin backend integrated into our existing Node/Moleculer/TellyMCP architecture
- we want our own tool model and session routing semantics

What we may borrow:

- extension/server split
- WebSocket handshake ideas
- tab/session data model ideas

## Architecture

### 1. New backend layer

Introduce a browser backend abstraction:

- `BrowserBackend`
- `PlaywrightBrowserBackend`
- `FirefoxAttachedBrowserBackend`

`BrowserService` should become orchestration over backends, not one concrete backend.

### 2. Firefox attach transport

New local service inside `telegram_mcp`:

- WebSocket server for browser extension clients
- registry of connected Firefox instances
- registry of tabs per instance
- active attachment per MCP session

Suggested internal modules:

- `firefoxAttachServer.ts`
- `firefoxAttachRegistry.ts`
- `firefoxAttachBackend.ts`
- `firefoxAttachTypes.ts`

### 3. Session binding model

Per MCP session we store attached-browser state:

- backend kind: `firefox-attached`
- instance id
- tab id
- attached at
- last seen title/url

This should live alongside existing browser session state, not replace it.

### 4. Firefox extension

Extension responsibilities:

- connect to local WS server
- identify browser instance and profile
- list windows/tabs
- report active tab changes
- inject content script when needed
- execute DOM actions in attached tab
- capture screenshot of tab

Extension split:

- background script
- content script
- options page

### 5. Data flow

#### Handshake

Extension -> server:

```json
{
  "type": "hello",
  "extension_version": "0.1.0",
  "browser": "firefox",
  "instance_id": "firefox-profile-default",
  "profile_name": "default-release"
}
```

Server -> extension:

```json
{
  "type": "hello_ack",
  "ok": true,
  "instance_id": "firefox-profile-default",
  "capabilities": [
    "tabs",
    "dom",
    "click",
    "fill",
    "press",
    "screenshot"
  ]
}
```

#### Tab listing

Server requests tabs:

```json
{
  "type": "list_tabs",
  "request_id": "..."
}
```

Extension replies:

```json
{
  "type": "list_tabs_result",
  "request_id": "...",
  "tabs": [
    {
      "tab_id": 17,
      "window_id": 3,
      "active": true,
      "title": "Example",
      "url": "https://example.com/"
    }
  ]
}
```

#### Tab action

Server requests action:

```json
{
  "type": "tab_action",
  "request_id": "...",
  "tab_id": 17,
  "action": "click",
  "selector": "#save"
}
```

Extension returns:

```json
{
  "type": "tab_action_result",
  "request_id": "...",
  "ok": true
}
```

## Tool Plan

### New tools

#### `browser_list_attached_instances`

Purpose:

- list connected Firefox browser instances known to the attach server

Output:

- `instances[]`
  - `instance_id`
  - `profile_name?`
  - `browser`
  - `connected`
  - `capabilities[]`

#### `browser_list_tabs`

Purpose:

- list tabs from one attached Firefox instance

Input:

- `instance_id?`
  - optional if only one instance is connected

Output:

- `tabs[]`
  - `tab_id`
  - `window_id`
  - `active`
  - `title`
  - `url`

#### `browser_attach_active_tab`

Purpose:

- bind current MCP session to the active tab of a Firefox instance

Input:

- `session_id?`
- `instance_id?`

Output:

- `session_id`
- `backend`
- `instance_id`
- `tab_id`
- `url`
- `title`

#### `browser_attach_tab`

Purpose:

- bind current MCP session to a specific Firefox tab

Input:

- `session_id?`
- `instance_id?`
- `tab_id`

Output:

- same shape as `browser_attach_active_tab`

#### `browser_detach_tab`

Purpose:

- clear attached Firefox tab binding for current MCP session

### Existing tools to support over attached backend

V1:

- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_wait_for_url`
- `browser_dom`
- `browser_computed_style`
- `browser_screenshot`

Deferred:

- `browser_console`
- `browser_errors`
- `browser_network_failures`

## Storage / State

Need a lightweight persistent store for attached browser session binding.

Suggested fields per MCP session:

- `browser_backend`
- `browser_instance_id`
- `browser_tab_id`
- `browser_window_id?`
- `browser_attached_at`
- `browser_last_url?`
- `browser_last_title?`

This can live in session context/state, but should not pollute project identity files more than necessary.

## Implementation Phases

### Phase 1. Protocol and backend abstraction

- add browser backend abstraction
- keep Playwright backend unchanged behind the interface
- define Firefox attach WS protocol types

Exit criteria:

- code builds with backend abstraction in place
- no behavior change for Playwright

### Phase 2. Local attach server

- add WS server in `telegram_mcp`
- add attach instance registry
- support hello/heartbeat/disconnect

Exit criteria:

- connected Firefox instance visible locally
- instance lifecycle is stable

### Phase 3. Firefox extension MVP

- background script
- options page
- WS connect/reconnect
- tab listing
- active tab reporting

Exit criteria:

- `browser_list_attached_instances`
- `browser_list_tabs`

### Phase 4. Attach tools

- implement:
  - `browser_attach_active_tab`
  - `browser_attach_tab`
  - `browser_detach_tab`

Exit criteria:

- current MCP session can bind/unbind to real Firefox tabs

### Phase 5. Reuse current browser tools on attached tabs

- implement attached backend support for:
  - click
  - fill
  - press
  - wait_for
  - wait_for_url
  - dom
  - computed_style
  - screenshot

Exit criteria:

- end-to-end attached-tab workflow works without Playwright

### Phase 6. Documentation and operational polish

- env examples
- TOOLS.md
- README
- install instructions for extension

## Open Decisions To Confirm Before Implementation

1. Firefox only in v1?
   - proposed answer: yes

2. Full browser permissions?
   - proposed answer: yes, because this is a trusted developer-installed mode

3. Default WS port?
   - proposed answer: `9999`

4. Token required?
   - proposed answer: yes

5. First-pass tool scope?
   - proposed answer:
     - attach/list/detach
     - click/fill/press/wait/dom/style/screenshot
     - no console/errors/network in v1

## Recommendation

Proceed with implementation using a custom Firefox attach layer inside `telegram_mcp`, using FoxMCP only as an external technical reference, not as a vendored dependency or embedded server.

## Web Recording Mode

### Goal

Add a structured recording mode for attached Firefox sessions that captures:

- page HTML snapshots
- network requests and responses
- request/response headers
- cookies visible at request time
- `console.*` output
- a session-level timeline that lets the agent correlate page, network, and console events

This is not a screen recording feature and not a screenshot bundle. It is a structured browser-forensics bundle for debugging and analysis.

### Product Model

The developer or agent should be able to say:

- start browser recording
- stop browser recording
- inspect/analyze the resulting bundle

The browser extension and `tellymcp` transport should do the actual capture work.
The agent should mostly:

- enable recording
- disable recording
- inspect the generated bundle

### Recommended Bundle Layout

Do not rely only on separate folders with unrelated files.

Recommended output:

```text
.mcp-xchange/web/{tab_title_slug}-{timestamp}/
  session.json
  timeline.ndjson
  pages/
    {page_id}/
      snapshot-0001.html
      snapshot-0002.html
      meta.ndjson
  network/
    requests.ndjson
    bodies/
      {request_id}-request.bin
      {request_id}-response.bin
  console/
    events.ndjson
```

Rules:

- one recording session always writes into its own dedicated bundle directory
- do not mix files from different recordings into one shared `web/` folder subtree
- the directory name should be human-readable and based on the selected tab title:
  - `web/{tab_title_slug}-{timestamp}`
- `recording_uuid` still exists, but as internal bundle identity stored in metadata, not as the primary folder name
- if the same slug/timestamp path already exists, append a deterministic suffix such as `-2` or `-3` instead of exposing the UUID in the main folder name

### Why This Layout

`session.json`:

- high-level metadata
- recording UUID
- bundle directory name
- console/session identity
- browser instance ID
- selected tab ID
- selected tab title/name
- start/stop timestamps
- counts
- top-level indexes

`timeline.ndjson`:

- append-only chronological stream
- each line references one event
- lets the agent reconstruct "what happened first" without scanning multiple folders manually

`pages/`:

- full HTML snapshots at meaningful boundaries
- not every DOM mutation
- snapshots on:
  - recording start
  - navigation complete
  - explicit agent-triggered snapshot
  - recording stop

`network/requests.ndjson`:

- one JSON object per request lifecycle
- includes:
  - request id
  - page id
  - tab id
  - method
  - url
  - request headers
  - response headers
  - status
  - timestamp(s)
  - cookies snapshot
  - optional body refs

`console/events.ndjson`:

- one event per `console.*`
- level
- text
- serialized arguments when possible
- page id
- timestamp

### Why NDJSON Instead of Only JSON Arrays

NDJSON is better here because:

- append-only writes are simple
- large captures do not require rewriting one huge JSON file
- the agent can stream or grep the data
- partial captures remain valid

### `session.json` Shape

Suggested shape:

```json
{
  "recording_uuid": "uuid",
  "bundle_dirname": "wb-automation-2026-06-06T14-22-10-531Z",
  "session_id": "Left",
  "session_label": "Left",
  "backend": "firefox-attached",
  "browser": "firefox",
  "instance_id": "firefox-...",
  "tab_id": 29,
  "tab_title": "WB Automation",
  "started_at": "2026-06-05T12:00:00.000Z",
  "stopped_at": null,
  "status": "recording",
  "paths": {
    "timeline": "timeline.ndjson",
    "network": "network/requests.ndjson",
    "console": "console/events.ndjson"
  },
  "pages": [
    {
      "page_id": "page-1",
      "tab_id": 29,
      "tab_title": "WB Automation",
      "url": "https://example.com/",
      "title": "Example"
    }
  ],
  "stats": {
    "page_snapshots": 0,
    "network_requests": 0,
    "console_events": 0
  }
}
```

### Better Than Separate `pages/ network/ console/` Alone

The user's original split is good, but not sufficient by itself.

The critical addition is:

- `session.json`
- `timeline.ndjson`

Without a timeline, the agent has to infer ordering from file timestamps and separate logs.

### Recording Scope

V1 should capture:

- currently selected attached tab
- current tab title/name at recording start and on navigation/title changes
- same-tab navigations
- console events from the page context
- request/response metadata through Firefox extension APIs
- HTML snapshots through injected page script

V1 does not need:

- websocket frame capture
- video
- pixel diffs
- cross-browser support
- every DOM mutation

### Proposed Tools

Add explicit tools instead of overloading existing browser tools:

- `browser_recording_start`
- `browser_recording_stop`
- `browser_recording_status`

Optional later:

- `browser_recording_snapshot`
- `browser_recording_list`

### Tool Behavior

`browser_recording_start`

- requires attached Firefox tab
- creates recording directory
- starts capture in extension
- returns recording UUID and output path

`browser_recording_stop`

- flushes pending events
- finalizes `session.json`
- returns counts and output path

`browser_recording_status`

- whether recording is active for this MCP session
- current recording UUID
- selected tab
- counters so far

### State Model

This should not live only in the extension.

We need two layers of state:

1. extension runtime state
   - current capture on/off
   - request listeners
   - in-memory page snapshot/session state

2. `tellymcp` persisted state
   - recording UUID
   - session -> recording mapping
   - bundle output path
   - counters
   - status

### Extension Responsibilities

The Firefox extension should:

- observe requests via `webRequest`
- read cookies through `cookies` API when request metadata is recorded
- inject script for HTML snapshot and console interception
- send events to `tellymcp` in near-real-time

### Additional Firefox Permissions Needed

V1 recording mode will require at least:

- `webRequest`
- `cookies`
- `tabs`
- `activeTab`
- `storage`
- `<all_urls>`

Potentially later:

- `webNavigation`

### Event Protocol Direction

We should add a dedicated family of WS messages, separate from tab action:

- `recording_start`
- `recording_stop`
- `recording_status`
- `recording_event`

`recording_event` should carry typed payloads:

- `page_snapshot`
- `network_request`
- `network_response`
- `console_event`
- `navigation`

### Implementation Guidance

Do not make the agent itself responsible for correlating low-level events live.

The correct boundary is:

- extension captures
- `tellymcp` writes structured bundle
- agent later reads and analyzes the bundle

### Suggested Implementation Order

1. add recording start/stop/status state to `tellymcp`
2. add extension protocol for recording lifecycle
3. capture console events
4. capture request/response metadata
5. capture HTML snapshots
6. write `session.json` + `timeline.ndjson`
7. expose recording tools in MCP

### Recommendation

Implement this as a structured forensic bundle, not as an ad hoc folder of unrelated logs.

The minimum useful output is:

- `session.json`
- `timeline.ndjson`
- `pages/`
- `network/requests.ndjson`
- `console/events.ndjson`

And the bundle metadata should always include:

- `bundle_dirname`
- `tab_id`
- `tab_title`
- page-level URL/title linkage

This is easier for both humans and agents to inspect, summarize, and diff.
