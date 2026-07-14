# DECISIONS

Accepted product, architecture, runtime, UX, and operational decisions for `telegram_mcp`.

This file is a living source of truth.

Rules:

- keep only accepted decisions here
- keep open ideas and experiments in `docs/TODO.md`
- when a decision changes, update this file instead of layering contradictory docs on top

Last updated: `2026-07-14`

## Core Architecture

### D-001 — Gateway-first is the only primary runtime model

Status: accepted

- one gateway process owns the Telegram bot, WebApp, project state, and live console registry
- agent consoles connect to the gateway; users do not pair directly to individual sessions
- the old pairing-first model is retired and must not come back as the default UX

### D-002 — Live presence is DB-backed and separate from durable identity

Status: accepted

- `gateway_live_consoles` is the canonical live-presence source
- `gateway_sessions` is the durable console identity layer
- project binding lives in dedicated relation tables and must not be merged back into session identity
- live state must not be reconstructed from ad hoc in-memory merges when DB state exists

### D-003 — One live console equals one routable target

Status: accepted

- every running console is its own routable destination
- canonical composite session id is `client_uuid:local_session_id`
- session labels are mutable display names, not routing keys

### D-004 — Structured xchange records are the canonical async transport

Status: accepted

- human Telegram work is stored and processed through structured xchange records
- agent-to-agent work is also stored and processed through structured xchange records
- `partner_note` and related flows must not fall back to legacy inbox semantics

### D-005 — Explicit errors are preferred over hidden fallbacks

Status: accepted

- do not guess routes, bindings, or live targets
- do not hide missing gateway bindings behind retries or silent fallback behavior
- old functionality should be removed instead of being silently emulated

## Runtime And Persistence

### D-006 — Built-in PTY fully replaces tmux

Status: accepted

- terminal runtime is PTY-backed
- old tmux-specific runtime assumptions are retired
- no tmux fallback should be added back
- schema and runtime naming should continue moving away from old tmux-era terms

### D-007 — `.mcpsession.json` is the only workspace session marker

Status: accepted

- `.mcpsession.json` is the canonical workspace-level startup marker
- it stores local session identity, label, env path, and tools-hash state
- `.tellymcpsession.json` is retired and must not be reintroduced

### D-008 — `TOOLS.md` and the Codex plugin are separate layers

Status: accepted

- `TOOLS.md` is the dynamic gateway capability/instruction layer
- the bundled Codex plugin is the static workflow/skills layer
- the two must stay separate and must not be merged into one mutable local file source

## Telegram UX

### D-009 — Back navigation always returns to the previous screen

Status: accepted

- back actions must return to the immediate previous screen
- do not jump to the root menu when a narrower previous context exists
- this rule applies especially to `username list -> session list -> session menu`

### D-010 — Session list UI stays neutral and minimal

Status: accepted

- do not show `Current active: ...` in the session-list header
- do not highlight a session with a checkbox just because it was recently selected
- session-list title should show the client name; secondary metadata may show `Last worker` and `Updated`
- outside a concrete session context, sending free-form messages is disabled; broadcast is the only exception

### D-011 — Storage UX is `.mcp-xchange`-based and gateway-compatible

Status: accepted

- storage and file sharing must reflect structured `.mcp-xchange` state
- gateway mode must not depend on legacy direct terminal-FS assumptions that require write access in arbitrary workspace paths
- shared files are expected to surface through the structured storage/share paths

## Browser Model

### D-012 — Browser automation has two separate backends

Status: accepted

- Playwright is the backend for owned isolated browser sessions
- browser attach is a separate backend for already running user Firefox/Chrome tabs
- do not overload one backend with assumptions from the other
- attached-tab tooling should reach practical parity with Playwright where possible

### D-013 — Browser attach is implemented via standalone local extensions

Status: accepted

- Firefox and Chrome attach are separate local extension packages
- they connect to the agent/backend over a local configurable WebSocket endpoint
- once the user installs and enables the extension, full browser data access is allowed by design

### D-014 — Extension state is backend-owned; control UI is HTML, not popup-driven

Status: accepted

- the backend/agent is the source of truth for connection, selected tab, and recording state
- extension UI should round-trip through that backend-owned state instead of inventing local truth
- the primary control surface is a full HTML control panel; popup-only UX is not trusted for critical flows

### D-015 — The attached tab becomes the browser target for the session

Status: accepted

- after a tab is attached for a session, browser tools should operate on that tab by default
- this includes DOM reads, actions, screenshot, reload, console/errors/network buffers, inject, and recording flows
- detaching returns the session to the non-attached browser path

### D-016 — Injected helper scripts live under `window.TELLY`

Status: accepted

- helper script injection supports both inline source and file-based source
- the canonical namespace is `window.TELLY`
- injected helpers are meant to expose durable page-side utilities for later agent calls

### D-017 — Browser recordings are stored as structured bundles in `.mcp-xchange/web`

Status: accepted

- recording bundle root is `.mcp-xchange/web/<tab-title>-<timestamp>/`
- bundle layout includes at least `pages/`, `network/`, `console/`, `session.json`, and `timeline.ndjson`
- network payloads should be materialized as separate per-request artifacts rather than forcing the agent to grep one giant file
- binary bodies should live as separate files near request metadata

### D-018 — Recording timestamps use local wall-clock time everywhere

Status: accepted

- browser recording folder names use local time
- browser recording metadata such as `session.json` and timeline/index events also use local time
- do not mix UTC naming in one layer and local timestamps in another

### D-019 — Only one active attached-browser recording is allowed per session

Status: accepted

- concurrent recordings from different attached browsers for the same session are not supported
- control panels should show that another browser instance owns the active recording
- UI should lock or explain the blocked state rather than pretending that recording started

## Prompt Detection And Terminal Nudges

### D-020 — Prompt scanning runs on the gateway side and is event-driven

Status: accepted

- scanner runs on the gateway, not in Telegram UI state
- it captures relay console buffer tails through gateway live routes
- lifecycle is event-driven:
  - gateway boot arms the scanner
  - client `hello` activates tracking
  - last disconnect pauses scanning
- prompt scanning must not depend on the user manually opening `/menu`

### D-021 — Blocker detection uses a simple numbered-menu heuristic

Status: accepted

- detection is based on the normalized tail of the terminal buffer
- primary signal is a contiguous numbered menu block near the end of the buffer
- secondary signal is nearby action-hint language such as `press`, `input`, `choose`, `enter`, `esc`, `yes`, `no`
- the detector scans the end of the buffer, not arbitrary earlier screen regions

### D-022 — Blocker actions stay simple: digits, Enter, Esc

Status: accepted

- Telegram blocker notices may expose direct actions only when confidently detected
- supported actions are intentionally limited to digits `1..N`, `Enter`, and `Esc`
- callbacks send exactly the corresponding terminal input
- do not add marker navigation or alternative hotkey parsing unless the simple model proves insufficient

### D-023 — Prompt notifications debounce by stable detection state, with debug-level observability

Status: accepted

- repeated notifications must be suppressed while the same prompt state persists
- logs for prompt-scan internals and idle/missing-live capture cases belong at `debug`, not noisy `warn`
- notification excerpts should show the detected menu block plus a small amount of context above it

## Packaging And Operations

### D-024 — The npm package ships browser-extension exporters and the Codex plugin installer

Status: accepted

- `tellymcp extension firefox` and `tellymcp extension chrome` are supported distribution commands
- `tellymcp codex-plugin install` is the supported Codex integration path
- these commands should stay stable and documented

### D-025 — Gateway supports both polling and webhook; webhook is first-class

Status: accepted

- webhook mode is a supported primary deployment mode
- the webhook route lives in the standalone HTTP layer under the configured root prefix
- docs and deployment samples must keep webhook setup current

### D-026 — Onebot deploy restarts the existing PM2 `telly` instance

Status: accepted

- current deploy behavior for onebot is restart-in-place of the existing `telly` PM2 app
- do not create duplicate PM2 apps for the same gateway role

## Documentation Governance

### D-027 — Behavior changes require doc updates in the same pass

Status: accepted

- when runtime behavior changes, update:
  - `README.md`
  - `README-ru.md`
  - env examples/templates
  - `TOOLS.md`
  - `docs/DEVELOPMENT.md`
  - `docs/IMPLEMENTATION_PLAN.md`, when the architecture direction or invariants changed
  - this `DECISIONS.md`, if the change affects architecture, product behavior, or workflow rules

### D-028 — Chat connectors use an OAuth facade alongside existing MCP auth

Status: accepted

- the public chat-host connection URL is the concrete Streamable HTTP endpoint,
  for example `https://drd.undoo.ru/api/mcp`
- the OAuth issuer and default audience remain the gateway base URL, for example
  `https://drd.undoo.ru/api`
- protected-resource discovery may expose `/api/mcp` as the more specific MCP
  resource without changing the configured base audience
- RFC 8414 path-insertion discovery ending in `/api` is expected when the issuer
  itself has the `/api` path
- OAuth JWT bearer auth coexists with `MCP_HTTP_BEARER_TOKEN`; existing internal
  clients must not be forced to migrate
- configured client id/secret and redirect allowlists are static operator-owned
  values; dynamic client registration is not part of this implementation

### D-029 — MCP chat clients retrieve console-owned files through synchronous gateway relay

Status: accepted

- `get_file_list` is the canonical discovery tool for TellyMCP-managed files and returns paths accepted by `get_file`
- `get_file` is the canonical MCP tool for returning actual workspace file content as `{type, data, mimetype, filename, size_bytes, expires_at?}`
- the gateway routes the request to the selected live console by canonical `session_id = client_uuid:local_session_id`
- `type = "url"` is the default; the client streams the file into bounded temporary gateway storage under `.tellymcp/tmp/file-links` and `data` contains a short-lived HTTPS link
- `type = "image"` is the explicit inline-preview mode; structured output is `{type: "image", data: downloadUrl, ...}` while the top-level MCP content contains the native image block
- `type = "text"` returns an exact UTF-8 workspace file directly as native MCP text and applies source-code MIME overrides
- `type = "base64"` is the explicit raw-data and compatibility fallback; the complete JSON is emitted as regular MCP text, without a native image, because some hosts replace native tool images with `[image]` or omit structured output from model context
- callers may pass an exact `file_path`, including one returned by `browser_screenshot`
- callers that do not know an existing managed file path should use `get_file_list` first
- arbitrary project paths are intentionally not enumerated by `get_file_list`; callers must already know the exact path
- sensitive filenames, extensions, and directories are rejected on the client before file reads and uploads; path confinement is still verified after realpath resolution
- `selector = "latest_screenshot"` resolves the newest screenshot from existing per-session file metadata when the human does not know its generated path
- file access must stay within the selected session workspace after symlink resolution and remain subject to body-size limits
- temporary gateway files expire after 10 minutes and download links allow a small bounded number of GET requests
- client-provided temporary filenames are untrusted and sanitized to a safe basename before storage and `Content-Disposition`; control and filesystem-reserved characters are replaced

## Deferred Or Not Yet Accepted

These are intentionally not accepted yet and should not be treated as source of truth:

- moving part of the gateway DB logic into DB functions/views/triggers
- renaming the remaining shared browser-attach `firefox-*` code and persisted `"firefox-attached"` literals
- any return to pairing-first, inbox-first, or tmux-first models
