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

## Invariants

Do not regress these:

1. one live console is one routable target
2. live presence must not be reconstructed from ad hoc memory merges when DB state exists
3. project membership must not be conflated with live presence
4. `partner_note` work must not fall back to legacy inbox semantics
5. browser screenshot tasks should prefer browser tools over shell Playwright
6. `.mcpsession.json` is the workspace-level startup marker
7. `.tellysession.json` is the per-console tools-state marker

## Active Roadmap

### Documentation

- keep all GitHub/npm docs aligned with the current gateway-first model
- remove stale pairing/inbox/local-linking instructions
- keep samples/templates trimmed to actually used env keys

### Terminal Naming Cleanup

- progressively rename user-facing `tmux` wording to `terminal` or `console`
- keep runtime compatibility while schema and payload names are migrated

### Browser Reliability

- keep browser routing relay-aware
- prefer direct gateway-mediated screenshot delivery for human-facing tasks
- keep screenshot/file storage metadata complete

### Collaboration Reliability

- keep project-scoped routing strict
- avoid fallback routing that hides missing bindings
- prefer explicit errors over hidden retries or guessed targets

### Packaging

- keep `tellymcp run`, `serve-stdio`, `doctor`, `browser install`, and `codex-plugin install` documented and stable
- keep bundled plugin installation idempotent

## Explicitly Retired Plans

The following older plan items are retired and should not be resurrected as the main model:

- Telegram pairing codes as the normal onboarding flow
- inbox-first async human handling
- local linked-session collaboration as a primary UX layer
- session routing derived from pairing state instead of live gateway registry
