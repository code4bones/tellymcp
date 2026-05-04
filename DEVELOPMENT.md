# Development Guide

This document is for maintainers and coding agents working on this repository.

It explains:

- how the current system is structured
- which runtime behaviors are intentional
- where to add new tools
- how to add or replace a human transport
- which invariants should not be broken during further development

## Project intent

This repository implements a local MCP server that lets a coding agent communicate with a human through Telegram.

There are two human interaction patterns:

1. synchronous clarification:
   - the agent calls `ask_user_telegram`
   - the server sends a Telegram message
   - the human replies
   - the reply returns as the tool result

2. asynchronous guidance:
   - the human sends an ordinary Telegram message
   - the server stores it in the per-session inbox
   - if `tmux_target` exists, the server nudges the agent through `tmux`
   - the agent reads the inbox batch through MCP tools

## High-level architecture

The code follows a backend-oriented FSD style.

Main layers:

- `src/app`
  - bootstrapping
  - config loading
  - Redis client setup
  - MCP HTTP or stdio entrypoints

- `src/entities`
  - shared domain types and schemas
  - request, session, auth, inbox models

- `src/features`
  - tool-facing use cases
  - each tool or closely related tool set lives here

- `src/processes`
  - multi-step orchestration
  - currently the main example is human approval flow

- `src/shared`
  - storage contracts
  - transport contracts
  - integrations
  - logger, ids, redaction, project identity

## Current runtime entrypoints

- [src/app/http.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/app/http.ts)
  - long-running MCP Streamable HTTP service
  - recommended runtime for development and actual use

- [src/app/stdio.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/app/stdio.ts)
  - legacy stdio mode
  - still useful for local debugging and compatibility

Shared runtime assembly lives in:

- [src/app/bootstrap/runtime.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/app/bootstrap/runtime.ts)

## Core runtime components

### Config

- [src/app/config/env.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/app/config/env.ts)

Responsibilities:

- parse `.env`
- validate all runtime settings
- expose typed `AppConfig`

Rule:

- operational defaults belong here, not in agent behavior

Examples:

- `TELEGRAM_INBOX_BATCH_SIZE`
- `TMUX_NUDGE_DEBOUNCE_SECONDS`
- `TMUX_NUDGE_COOLDOWN_SECONDS`

### State store

- [src/shared/integrations/redis/stateStore.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/integrations/redis/stateStore.ts)
- [src/shared/api/storage/contract.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/api/storage/contract.ts)

Responsibilities:

- session metadata
- session binding
- pair codes
- pending request state
- unsolicited inbox messages
- Telegram menu payload records

Rule:

- business logic should depend on storage contracts, not Redis commands directly

### Telegram transport

- [src/shared/integrations/telegram/transport.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/integrations/telegram/transport.ts)
- [src/shared/integrations/telegram/messageFormat.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/integrations/telegram/messageFormat.ts)
- [src/shared/api/transport/contract.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/api/transport/contract.ts)

Responsibilities:

- Telegram polling
- pairing commands
- inline menus
- sending request messages
- sending notifications
- matching replies to active requests
- storing unsolicited messages in inbox
- event-driven `tmux` nudge for AFK mode

Rule:

- MCP-facing tool logic should not talk to Telegram APIs directly
- all Telegram specifics should stay inside the transport or Telegram integration helpers

### Tool registration

- [src/app/providers/mcp/server.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/app/providers/mcp/server.ts)
- [src/shared/api/tool-registry/registry.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/api/tool-registry/registry.ts)
- [src/shared/api/tool-registry/types.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/api/tool-registry/types.ts)

Responsibilities:

- construct `McpServer`
- register feature tools

Rule:

- new tools should be registered through `runtime.ts`, not hidden in bootstrap glue

## Important domain flows

### Pairing flow

Files:

- [src/features/pair-session/model/generatePairCode.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/pair-session/model/generatePairCode.ts)
- [src/features/pair-session/model/createSessionPairCodeTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/pair-session/model/createSessionPairCodeTool.ts)
- [src/features/pair-session/model/clearSessionPairingTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/pair-session/model/clearSessionPairingTool.ts)

Flow:

1. tool creates one-time code in Redis
2. human sends `/start CODE` or `/link CODE`
3. Telegram transport consumes the code
4. server writes session binding
5. session becomes eligible for ask/notify/inbox flow

Invariant:

- authorization is based on binding `session_id -> telegram_chat_id + telegram_user_id`
- do not reintroduce global chat allowlists as the primary auth model

### Synchronous ask flow

Files:

- [src/processes/human-approval/model/orchestrator.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/processes/human-approval/model/orchestrator.ts)
- [src/features/ask-user/model/askUserTelegram.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/ask-user/model/askUserTelegram.ts)

Flow:

1. validate and enrich request
2. load session binding
3. send Telegram question through transport
4. create active waiter
5. resolve on reply or timeout
6. return MCP tool result

Invariant:

- only the matching bound Telegram user/chat may answer
- timeouts return structured results, not infrastructure failures

### Unsolicited inbox flow

Files:

- [src/features/inbox/model/inboxService.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/inbox/model/inboxService.ts)
- [src/features/inbox/model/getTelegramInboxTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/inbox/model/getTelegramInboxTool.ts)
- [src/features/inbox/model/getTelegramInboxCountTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/inbox/model/getTelegramInboxCountTool.ts)
- [src/features/inbox/model/deleteTelegramInboxMessageTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/inbox/model/deleteTelegramInboxMessageTool.ts)

Flow:

1. human sends ordinary Telegram message
2. if it is not a pairing command and not a matched reply, it is stored in inbox
3. if the session has `tmux_target`, the server schedules one debounced nudge
4. agent wakes up and reads a batch through `get_telegram_inbox`
5. agent deletes only messages that were actually handled

Invariant:

- inbox messages are source-of-truth for async human input
- `tmux` receives only a wake-up phrase, never the actual human message body
- batch size is server policy from `.env`, not agent policy
- do not reintroduce session-wide channel-mode flags as the runtime gate for inbox delivery

### tmux AFK flow

Files:

- [src/features/session-context/model/setTmuxTargetTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/session-context/model/setTmuxTargetTool.ts)
- [src/features/session-context/model/getTmuxTargetTool.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/features/session-context/model/getTmuxTargetTool.ts)
- [src/shared/integrations/telegram/transport.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/integrations/telegram/transport.ts)

Flow:

1. Codex runs inside tmux
2. agent or user captures full tmux attributes and ideally passes them into `create_session_pair_code`
3. pairing stores a distinct session identity and, when available, the pane target
4. `set_tmux_target` remains available as an explicit refresh or override path
5. paired session has a configured `tmuxTarget`
6. new non-reply Telegram messages get debounced
7. transport pastes `TMUX_NUDGE_MESSAGE` into pane and presses Enter
8. agent reads inbox batch

Invariant:

- nudging is event-driven, not background polling
- multiple close-together messages should coalesce into one wake-up
- multi-agent separation depends on distinct `session_id` values; when `session_id` is omitted, tmux attributes are the preferred way to derive unique defaults

## Session model

Session state is stored in:

- [src/entities/session/model/types.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/entities/session/model/types.ts)

Current session fields include:

- label/task/summary/files/decisions/risks
- `tmuxSessionName`
- `tmuxWindowName`
- `tmuxWindowIndex`
- `tmuxPaneId`
- `tmuxPaneIndex`
- `tmuxTarget`
- `lastTmuxNudgeAt`

Rule:

- if you add new session-level behavior, add the field here first
- then update:
  - request schema if exposed through a tool
  - `SessionContextService`
  - storage serialization through `RedisStateStore`
  - docs in `TOOLS.md` if user-visible

## How to add a new MCP tool

Recommended recipe:

1. define or extend domain types
   - usually in `src/entities/.../model/types.ts`

2. add input/output Zod schema
   - `src/entities/request/model/schema.ts`

3. implement feature/service logic
   - place it under `src/features/<feature>/model/...`

4. add the MCP tool wrapper
   - implement `ToolModule`
   - register title, description, input schema, output schema

5. wire it in runtime
   - update [src/app/bootstrap/runtime.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/app/bootstrap/runtime.ts)

6. document it
   - update [TOOLS.md](/home/code4bones/Devs/coding/mcp/telegram_mcp/TOOLS.md)
   - update `README.md` if it changes user workflow

7. verify
   - `npm run format:check`
   - `npm run build`
   - `npm run lint`

Rule:

- keep transport-agnostic business logic in services
- keep MCP-specific wrapping in tool classes

## How to add a new transport

Current transport interface:

- [src/shared/api/transport/contract.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/api/transport/contract.ts)

Recommended recipe:

1. implement a new transport under `src/shared/integrations/<transport>/`
2. keep its API-specific message formatting there too
3. satisfy `HumanTransport`
4. make runtime instantiate that transport
5. keep orchestration logic unchanged if possible

Rule:

- do not leak Telegram-only concepts into orchestrator logic unless the feature is truly Telegram-specific
- if a behavior is generic, model it in contracts first

Examples:

- `ask_user_telegram` naming is currently Telegram-specific
- the underlying orchestration and request lifecycle are still transport-like and reusable

## How to evolve inbox behavior safely

Current policy:

- server-side batch size from `TELEGRAM_INBOX_BATCH_SIZE`
- `get_telegram_inbox` returns `messages + total + has_more`
- agent processes one message at a time
- agent must not advance to the next message if current one caused:
  - a blocker
  - an execution error
  - a follow-up question via `ask_user_telegram`

Rule:

- only delete inbox items that were actually handled
- leave unhandled items pending

If you change inbox behavior, update:

- [TOOLS.md](/home/code4bones/Devs/coding/mcp/telegram_mcp/TOOLS.md)
- the session mode instructions
- any tmux wake-up assumptions

## Logging and observability

Logger:

- [src/shared/lib/logger/logger.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/lib/logger/logger.ts)

Current logging principles:

- log lifecycle transitions
- log request IDs and session IDs
- log inbox captures, nudge scheduling, cooldown skips, and actual nudges
- do not log secrets
- redact user-facing or transport text where needed

When adding new runtime behavior, add logs for:

- start
- success
- skip reason
- failure path

This matters because the server is long-running and operational debugging is important.

## Security rules that should not be weakened

Do not break these assumptions:

- no raw secret forwarding to Telegram
- no arbitrary Telegram users may answer a session
- no human message text should be pushed into tmux
- no hardcoded secrets
- no silent waiting forever
- no unbounded output batching without chunking

Relevant helpers:

- [src/shared/lib/redact-secrets/redactSecrets.ts](/home/code4bones/Devs/coding/mcp/telegram_mcp/src/shared/lib/redact-secrets/redactSecrets.ts)

## Recommended development workflow

1. run:
   - `npm run dev:service`

2. for each change, verify:
   - `npm run format:check`
   - `npm run build`
   - `npm run lint`

3. if behavior is user-visible, update:
   - `TOOLS.md`
   - `README.md`

4. if behavior changes agent expectations, update:
   - `TOOLS.md`
   - any relevant `AGENTS.md` instructions in the consumer project

## Where to look first when debugging

If Telegram messages do not arrive:

- `src/shared/integrations/telegram/transport.ts`
- proxy settings in `.env`
- bot startup logs

If pairing fails:

- pair code creation flow
- `/start CODE` parsing in Telegram transport
- binding writes in Redis

If async inbox does not wake the agent:

- `tmuxTarget`
- `TMUX_NUDGE_ENABLED`
- debounce/cooldown settings
- `tmux` command availability in runtime

If tool output is wrong:

- request schema
- feature service
- tool wrapper registration

## Short checklist before merging further changes

- does the change belong in config, service logic, transport, or tool wrapper
- does it alter the human workflow described in `TOOLS.md`
- does it require a new session field
- does it need new logs
- does it preserve redaction and auth assumptions
- does it preserve transport/message size safety
