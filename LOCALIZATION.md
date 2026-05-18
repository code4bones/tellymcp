# Localization Plan

This file is the working plan for adding localization to TellyMCP.

It defines:

- what we localize
- what we do not localize
- how translation keys should be named
- where translations should come from
- how rollout should happen

The goal is to make user-facing Telegram and WebApp UI localizable without weakening the agent contract or creating multiple sources of truth for instructions.

## Current Status

Implemented:

- `i18next` runtime with bundled `en` / `ru` resources
- user-scoped locale storage in Redis
- locale resolution:
  1. stored user preference
  2. Telegram `language_code`
  3. fallback `en`
- first Telegram UI slice localized:
  - sessions menu
  - main menu
  - inbox
  - content
  - browser
  - screenshots
  - storage
  - settings
  - local / link / partner
  - top-level collab entry screens

Not yet fully localized:

- all `Collab` deep flows
- long operational notices
- startup notices
- Mini App `Live`
- CLI output

## Goals

- Add clean `ru` / `en` localization for user-facing product surfaces.
- Keep one canonical language for agent instructions and MCP semantics.
- Avoid ad hoc string literals scattered through `transport.ts` and related UI code.
- Support runtime loading of translations, not only hardcoded bundled strings.
- Keep fallback behavior predictable when translations are missing.

## Non-goals

- Do not localize `TOOLS.md`.
- Do not localize MCP tool names.
- Do not localize MCP tool descriptions for now.
- Do not localize internal logs by default.
- Do not localize protocol fields, storage keys, or wire contracts.

## Canonical Language Split

Use this split consistently:

- Human-facing Telegram UI: localizable
- Human-facing Mini App UI: localizable
- Human-facing CLI help: can be localized later
- Agent instructions: canonical English
- MCP contracts and structured payloads: canonical English
- Internal logs and diagnostics: canonical English by default

Rationale:

- agents need one stable instruction language
- humans need native-language UI
- mixed-language operational messages create confusion fast

## User-facing Surfaces To Localize

Phase 1:

- Telegram menus
- Telegram notices
- Telegram operational warnings
- `Collab` texts
- `Live approval` texts
- `Storage` texts
- `Browser` texts
- `Inbox` texts
- startup notices

Phase 2:

- Mini App `Live` labels and short statuses
- `doctor` human-readable output
- `postinstall` output

Phase 3:

- optional localized CLI help

## Translation Runtime

Preferred runtime:

- `i18next`

Preferred loading model:

- runtime-loaded JSON resources
- served by backend HTTP
- optional local fallback resources

Recommended shape:

- primary source: gateway or local backend HTTP endpoint
- fallback source: bundled `en` and `ru` resources

This gives:

- dynamic copy updates
- central management
- safe fallback when backend resources fail

## Locale Resolution

Resolution priority:

1. explicit user preference stored by TellyMCP
2. Telegram `user.language_code`
3. fallback `en`

Rules:

- do not guess from chat text
- do not derive locale from bot token or host
- locale should be stable per Telegram user unless explicitly changed

## Suggested Resource Layout

Use JSON resources grouped by namespace.

Example:

```text
locales/
  en/
    common.json
    menu.json
    collab.json
    inbox.json
    live.json
    storage.json
    browser.json
    notices.json
    errors.json
  ru/
    common.json
    menu.json
    collab.json
    inbox.json
    live.json
    storage.json
    browser.json
    notices.json
    errors.json
```

If backend-loaded:

```text
/i18n/en/common.json
/i18n/en/menu.json
/i18n/ru/common.json
...
```

## Key Naming Rules

Use stable semantic keys, not English sentences as keys.

Good:

- `menu.session.title`
- `menu.session.inbox_count`
- `collab.project.members_title`
- `collab.partner.ask_route`
- `live.approval.request_title`
- `notices.tmux_unavailable.title`
- `errors.webapp.bootstrap_failed`

Bad:

- `session linked`
- `click here`
- `showLiveViewLauncherText`

Rules:

- lowercase
- dot-separated hierarchy
- no spaces
- no punctuation in keys
- no language-specific wording in key names

## Interpolation Rules

Use interpolation for dynamic values only.

Examples:

- `menu.session.title`: `Session: {{sessionLabel}}`
- `collab.project.members_title`: `Members of {{projectName}}`
- `live.approval.route`: `Session: {{source}} -> {{target}}`
- `notices.tmux_invalid.target`: `Saved tmux target is no longer valid: {{target}}`

Rules:

- interpolate labels, names, counts, timestamps, routes
- keep full sentence structure inside translation resources
- do not concatenate translated sentence fragments in code

Bad:

```ts
"Session: " + sessionLabel
```

Good:

```ts
t("menu.session.title", { sessionLabel })
```

## Plurals And Counts

Do not hand-roll plural logic in strings.

Use i18next plural support for:

- inbox counts
- project counts
- screenshot counts
- file counts

This matters especially for Russian.

## Time And Date Formatting

Do not bake locale-specific date strings into translations.

Use:

- translation for surrounding label
- runtime locale-aware formatter for date/time value

Example:

- translation: `Updated`
- formatted value: locale-sensitive `12:31:08`

For compact `Live` UI, time-only values may stay language-neutral.

## Fallback Policy

Required fallback:

- missing locale -> `en`
- missing namespace -> bundled fallback
- missing key -> key name in development, safe English fallback in production if possible

Operational rule:

- missing translation must not break bot flows
- untranslated key is acceptable temporarily
- broken menu flow is not

## Storage Model For User Locale

Add user locale preference in a user-scoped store.

Minimum fields:

- `telegram_user_id`
- `locale`
- `updated_at`

This preference should override `Telegram language_code`.

## HTTP Resource Delivery

Recommended endpoint family:

- `GET /i18n/:lng/:ns.json`

Examples:

- `/i18n/en/common.json`
- `/i18n/ru/menu.json`

Optional later:

- ETag / cache headers
- hash-based versioning
- gateway-served canonical resources

## What Must Stay In English

Keep these canonical:

- `TOOLS.md`
- MCP tool descriptions
- system-level agent instructions
- protocol names
- structured JSON fields
- delivery kinds
- version handshake reasons

Reason:

- these are not just UI
- they are part of the operational contract with agents and services

## Initial Namespace Map

Start with:

- `common`
  - shared labels like back, refresh, delete, session, project
- `menu`
  - session menu and top-level bot menus
- `collab`
  - project lists, partner menu, ask/share/live approval
- `inbox`
  - inbox labels, summaries, empty states
- `storage`
  - file listing, delete/get prompts
- `browser`
  - screenshot menu and browser-related labels
- `live`
  - Mini App button/status labels
- `notices`
  - startup, delivery, operational warnings
- `errors`
  - human-readable failure messages

## Rollout Strategy

### Step 1

Introduce localization infrastructure only:

- `i18next`
- locale resolver
- `t()` helper
- `ru` and `en` resource loading

No broad text migration yet.

### Step 2

Migrate top-level Telegram menus:

- session menu
- collab menu
- content/browser/storage headers

These are the highest-visibility strings.

### Step 3

Migrate operational notices:

- startup notices
- tmux warnings
- delivery notices
- live approval texts

### Step 4

Migrate Mini App labels:

- `Live`
- `Wrap`
- `Unwrap`
- short status labels

### Step 5

Add explicit user language switching in Telegram UI.

Suggested menu entry later:

- `Settings -> Language -> English / Русский`

## Migration Rules

When replacing old strings:

- move full sentence to translation file
- do not keep partial text assembly in code
- keep old English as fallback resource, not inline literal

Every migration PR should:

- move a coherent UI surface
- not mix token naming styles
- not introduce second translation helper

## Testing Requirements

Minimum tests for localization layer:

- locale resolution priority
- fallback to `en`
- interpolation rendering
- missing key behavior
- Telegram user with `ru` gets Russian UI
- Telegram user with unknown locale gets English UI

UI regression tests to add as strings move:

- session menu text snapshot
- collab partner menu text snapshot
- live approval notice text snapshot
- tmux unavailable notice text snapshot

## Open Questions

- Should translations be stored only on gateway, or also bundled on every client?
- Should `doctor` and CLI stay English-only for now?
- Should `Live` Mini App use the same runtime i18n backend as Telegram UI, or bundled resources first?
- Do we want a manual `/language` command before moving language control into Settings?

## First Execution Plan

Do these in order:

1. Add `i18next` runtime and a thin translation adapter.
2. Add locale resolution from Telegram user and stored preference.
3. Introduce `en` and `ru` resource files with `common`, `menu`, `collab`, and `notices`.
4. Migrate the top-level session menu.
5. Migrate `Collab` menus and approval notices.
6. Migrate tmux operational warnings.
7. Add user-visible language switch in Settings.

## Definition Of Done

Localization for the first milestone is done when:

- a Russian Telegram user sees Russian bot UI
- an English Telegram user sees English bot UI
- top-level menus are no longer hardcoded in `transport.ts`
- operational notices are localized
- `TOOLS.md` and MCP agent instructions remain canonical English
- missing translations degrade safely
