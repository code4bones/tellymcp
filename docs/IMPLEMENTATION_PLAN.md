# Implementation Plan

This file is no longer a greenfield build plan.

The project has already moved to the gateway-first model. This document now tracks the current architecture direction that future work must preserve.

## Stable Decisions

- gateway is the user-facing control plane
- live console presence is DB-backed through `gateway_live_consoles`
- project participation is separate from live presence
- cross-console work uses structured xchange records
- browser workflows are Playwright-based
- `TOOLS.md` is refreshed online by hash
- Codex plugin skills are a separate static layer
- chat connectors use an OAuth facade alongside the existing static MCP bearer
- a chat host connects to the concrete `/api/mcp` endpoint; `/api` remains the
  OAuth issuer/audience base
- chat-host file reads use `get_file`; text mode returns exact UTF-8 project files, URL mode creates a bounded short-lived gateway copy, and base64 remains an explicit fallback
- Redis is gateway-only; clients use process-local transient state and persist
  only stable gateway identity in `.mcpsession.json`

## Invariants

Do not regress these:

1. one live console is one routable target
2. live presence must not be reconstructed from ad hoc memory merges when DB state exists
3. project membership must not be conflated with live presence
4. `partner_note` work must not fall back to legacy inbox semantics
5. browser screenshot tasks should prefer browser tools over shell Playwright
6. `.mcpsession.json` is the workspace-level startup marker
7. `.mcpsession.json` also stores per-console tools hash state
8. gateway-routed file reads must use canonical session ids and remain confined to the selected console workspace
9. client startup, configuration, diagnostics, and migration must not require or
   silently reconnect to Redis

## Active Roadmap

### Documentation

- keep all GitHub/npm docs aligned with the current gateway-first model
- remove stale pairing/inbox/local-linking instructions
- keep samples/templates trimmed to actually used env keys
- keep `docs/ENVIRONMENT.md`, runtime validation, and production role files on one env contract

### Browser Reliability

- keep browser routing relay-aware
- prefer direct gateway-mediated screenshot delivery for human-facing tasks
- keep screenshot/file storage metadata complete

### Collaboration Reliability

- keep project-scoped routing strict
- avoid fallback routing that hides missing bindings
- prefer explicit errors over hidden retries or guessed targets

### Packaging

- keep `tellymcp run`, `doctor`, `browser install`, and `codex-plugin install` documented and stable
- keep bundled plugin installation idempotent

### Chat Connector Continuity

- preserve dual MCP authentication: internal static bearer and OAuth JWT
- keep base-resource and MCP-resource discovery distinct
- keep RFC 8414 path-insertion routes available for an issuer under `/api`
- treat refresh tokens, bounded access-token expiry, and finer per-tool scopes
  as explicit future work rather than silently changing the working flow

## Explicitly Retired Plans

The following older plan items are retired and should not be resurrected as the main model:

- Telegram pairing codes as the normal onboarding flow
- inbox-first async human handling
- local linked-session collaboration as a primary UX layer
- session routing derived from pairing state instead of live gateway registry
