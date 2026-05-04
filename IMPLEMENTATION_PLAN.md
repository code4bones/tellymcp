# Implementation Plan

## Goal

Build a production-oriented local MCP server in TypeScript that exposes `ask_user_telegram`, sends a redacted clarification request to a configured Telegram chat, waits for a reply, and returns a structured result with safe timeout handling.

The architecture must allow future expansion:

- new MCP tools
- new human communication transports
- configurable request handling strategy
- session-to-user authorization and binding

## Confirmed Decisions

Based on the latest clarifications, the implementation should follow these rules:

- session data is stored in Redis
- the first implementation is incremental, but the codebase must be prepared for adding more tools
- request conflict behavior is configurable through `.env`
- tests are out of scope for the current phase
- the project should follow FSD-style structure
- Telegram must be implemented as a pluggable transport backend behind a stable communication interface
- Telegram user/chat must be explicitly bound to an MCP session through a pairing flow

## Scope For Current Phase

### Implement now

- project skeleton
- strict TypeScript setup
- MCP server bootstrap
- base tool registration mechanism
- `create_session_pair_code`
- `ask_user_telegram`
- pairing/auth flow for Telegram session binding
- Redis session storage
- configurable pending-request mode: `queue` or `reject`
- pluggable transport contract
- Telegram transport implementation
- README and `.env.example`

### Defer for later

- `notify_telegram`
- `set_session_context`
- `clear_session_context`
- tests
- extra transports beyond Telegram

## Updated Requirement Interpretation

### Storage

Use Redis for session-oriented state.

This should include at minimum:

- Telegram pairing state
- saved session context
- active pending request metadata
- queue state if `MODE=queue`

Local file logging may still be used if needed, but Redis is now the primary state backend.

### Request conflict mode

Add env var:

```env
MODE=queue
```

Allowed values:

- `queue`
- `reject`

Behavior:

- `reject`: if one request is active, a new tool call fails with a clear MCP error
- `queue`: a new request is queued and processed after the active request completes

### Tool growth

The code should not be hardwired around a single tool file. Even if only one tool is implemented now, registration and execution should have a shared base shape so additional tools can be added without refactoring the server entrypoint.

### Transport growth

Telegram must not leak into the tool orchestration layer. The tool layer should depend on a generic transport interface, with Telegram as one adapter.

### Authorization and session binding

Do not use a global allowed chat ID.

Use explicit binding:

- MCP session requests a short-lived pairing code
- user sends the pairing code to the Telegram bot
- server validates the code and binds the Telegram principal to the target session
- future questions for that session are routed only to the bound Telegram principal

## Architecture Direction

### Core design principles

- keep modules explicit and typed
- separate MCP concerns from transport concerns
- separate business flow from storage implementation
- define interfaces first where extension is expected
- avoid abstraction where only one implementation is certain, except for tools and transport where expansion is already planned

## Proposed FSD-Inspired Structure

```text
src/
  app/
    index.ts
    config/
      env.ts
    providers/
      mcp/
        server.ts
      redis/
        client.ts
  shared/
    lib/
      redact-secrets/
        redactSecrets.ts
      truncate/
        truncate.ts
      ids/
        ids.ts
      logger/
        logger.ts
    types/
      common.ts
  entities/
    request/
      model/
        types.ts
        schema.ts
    session/
      model/
        types.ts
    auth/
      model/
        types.ts
  features/
    ask-user/
      model/
        askUserTelegram.ts
        queueMode.ts
      lib/
        messageComposer.ts
    pair-session/
      model/
        generatePairCode.ts
        confirmPairing.ts
  processes/
    human-approval/
      model/
        orchestrator.ts
        pendingResolver.ts
  shared/api/
    tool-registry/
      registry.ts
      types.ts
    transport/
      contract.ts
    storage/
      contract.ts
  shared/integrations/
    telegram/
      transport.ts
      messageFormat.ts
      updateMatcher.ts
    redis/
      sessionStore.ts
```

Notes:

- this is FSD-inspired, adapted for a backend MCP service
- `features/` contains user-facing behavior slices such as `ask-user`
- `processes/` coordinates multi-step flows between tool, transport, and storage
- `shared/api/transport` and `shared/api/storage` define stable contracts

## Main Interfaces

### 1. Tool contract

Create a common interface for MCP tool modules:

```ts
type ToolModule = {
  name: string;
  description: string;
  inputSchema: unknown;
  register(server: unknown): void;
};
```

The exact MCP SDK types will be used in code, but the structure should support:

- one module per tool
- centralized registration
- isolated validation and execution logic

### 2. Human transport contract

Telegram should implement a generic transport interface:

```ts
type HumanTransportRequest = {
  requestId: string;
  sessionId?: string;
  recipient?: {
    telegramUserId?: number;
    telegramChatId?: number;
  };
  task?: string;
  question: string;
  context?: string;
  affectedFiles?: string[];
  options?: string[];
  recommendedOption?: string;
  riskLevel?: "low" | "medium" | "high";
  fallbackIfTimeout?: string;
};

type HumanTransportReply = {
  requestId: string;
  answer: string;
  receivedAt: string;
};

interface HumanTransport {
  sendRequest(input: HumanTransportRequest): Promise<{ externalMessageId?: string | number }>;
  waitForReply(requestId: string, timeoutSeconds: number): Promise<HumanTransportReply | null>;
}
```

Telegram transport will be the first implementation.

Future transports should be able to plug in without changing tool code.

### 3. Storage contract

Create a shared storage interface so Redis details do not leak into the feature/process layer:

```ts
interface SessionStore {
  getSession(sessionId: string): Promise<SessionContext | null>;
  setSession(session: SessionContext): Promise<void>;
  clearSession(sessionId: string): Promise<void>;
}

interface SessionBindingStore {
  createPairCode(record: PairCodeRecord): Promise<void>;
  consumePairCode(code: string): Promise<PairCodeRecord | null>;
  getBinding(sessionId: string): Promise<SessionBinding | null>;
  setBinding(binding: SessionBinding): Promise<void>;
  clearBinding(sessionId: string): Promise<void>;
}

interface PendingRequestStore {
  getActive(): Promise<PendingRequest | null>;
  createPending(request: PendingRequest): Promise<void>;
  resolvePending(requestId: string, result: PendingResolution): Promise<void>;
  enqueue(request: PendingRequest): Promise<void>;
  dequeueNext(): Promise<PendingRequest | null>;
}
```

For this phase, both interfaces will be backed by Redis.

## Data Model Plan

### Ask tool input

Keep the agreed tool input:

```ts
{
  question: string;
  task?: string;
  context?: string;
  affected_files?: string[];
  options?: string[];
  recommended_option?: string;
  risk_level?: "low" | "medium" | "high";
  timeout_seconds?: number;
  fallback_if_timeout?: string;
  session_id?: string;
  use_saved_context?: boolean;
}
```

Implementation note for this architecture:

- `session_id` is treated as required for `ask_user_telegram`, even though the original draft schema marked it optional
- without `session_id`, explicit user/session binding is impossible

### Pairing tool input

Add a separate MCP tool for binding a session:

```ts
{
  session_id: string;
  session_label?: string;
  expires_in_seconds?: number;
}
```

### Pairing tool output

```ts
{
  session_id: string;
  code: string;
  expires_at: string;
  telegram_link_hint?: string;
}
```

### Ask tool output

```ts
{
  answer: string | null;
  timed_out: boolean;
  request_id: string;
  received_at?: string;
  fallback_used?: string;
}
```

### Redis records

Proposed keys:

- `telegram-mcp:session:{sessionId}`
- `telegram-mcp:binding:{sessionId}`
- `telegram-mcp:pair-code:{code}`
- `telegram-mcp:pending:active`
- `telegram-mcp:pending:queue`
- `telegram-mcp:request:{requestId}`

Suggested record groups:

- session-to-telegram binding
- short-lived pairing code
- session context
- active request
- queued requests
- request audit metadata

### Authorization records

Proposed shapes:

```ts
type PairCodeRecord = {
  code: string;
  sessionId: string;
  createdAt: string;
  expiresAt: string;
};

type SessionBinding = {
  sessionId: string;
  telegramChatId: number;
  telegramUserId: number;
  linkedAt: string;
};
```

## Execution Flow

### Boot flow

1. Load and validate env vars.
2. Initialize Redis client.
3. Initialize Telegram transport.
4. Initialize MCP server.
5. Register tool modules through a central registry.
6. Start stdio server.

### Pairing flow

1. MCP caller invokes `create_session_pair_code`.
2. Server generates a short code and stores it in Redis with TTL.
3. Server returns the code and optional Telegram deep-link hint.
4. User sends the code to the Telegram bot.
5. Preferred entrypoint is `/start <code>`.
6. Fallback entrypoint is `/link <code>`.
7. Bot validates the code.
8. Bot stores `sessionId -> {telegramChatId, telegramUserId}` binding.
9. Bot acknowledges successful pairing.
10. Future tool requests for that `session_id` use the stored binding.

### `create_session_pair_code` flow

1. Validate tool input.
2. Generate a short-lived one-time code.
3. Store code in Redis with TTL.
4. Return code and expiry metadata.

### `ask_user_telegram` flow

1. Validate tool input.
2. Require `session_id`.
3. Resolve target binding by `session_id`.
4. If session binding is missing, return a clear MCP error instructing the caller to use `create_session_pair_code`.
5. Load session context if `use_saved_context` is true.
6. Merge input context with stored session context if present.
7. Redact sensitive data before transport and logging.
8. Create request ID.
9. Check request mode from `MODE`.
10. If another request is active:
11. In `reject` mode, return a clear tool error.
12. In `queue` mode, persist the request in queue and wait until it becomes active.
13. Send formatted request through the transport interface.
14. Persist active request metadata in Redis.
15. Wait for reply until timeout.
16. On reply, resolve request and return structured output.
17. On timeout, return structured timeout result and apply fallback metadata.
18. If queue mode is enabled, promote the next request after completion.

### Telegram reply matching flow

1. Prefer replies to the exact bot message.
2. Verify that `chat.id` and `from.id` match the active session binding.
3. Fallback to next valid message only when one active request exists.
4. Ignore unrelated chats, channel posts, and stale updates.

## Module Implementation Plan

### 1. App/bootstrap

Create:

- `src/app/index.ts`
- `src/app/config/env.ts`
- `src/app/providers/mcp/server.ts`
- `src/app/providers/redis/client.ts`

Responsibilities:

- env loading
- config validation
- Redis connection
- MCP server startup
- transport command registration for pairing

### 2. Shared contracts and utilities

Create:

- transport contract
- storage contract
- ID generation utility
- truncation utility
- secret redaction utility
- logger utility

This layer must stay framework-light and reusable.

### 3. Entities

Create explicit models for:

- request
- session
- auth binding

Responsibilities:

- types
- schemas
- storage-safe record shapes

### 4. Feature: ask-user

Create the first tool-specific slice:

- input validation
- context assembly
- message composition payload
- tool output mapping

Create the pairing slice:

- pairing code generation
- binding confirmation
- pairing tool output mapping

### 5. Process: human-approval orchestration

Central orchestration should live outside the Telegram adapter.

Responsibilities:

- active request management
- queue or reject decision
- timeout flow
- resolution flow
- state transitions
- session binding checks before delivery

### 6. Telegram integration

Create a single Telegram adapter implementing `HumanTransport`.

Responsibilities:

- bot initialization via `grammy`
- message sending
- polling
- `/start <code>` handling
- `/link <code>` handling
- reply matching
- transport-level error normalization

### 7. Redis integration

Create Redis-backed implementations for:

- session store
- binding store
- pending request store

Important:

- keep key naming explicit
- avoid hidden magic serialization
- store only compact structured data
- never persist secrets unredacted

## Dependency Plan

### Runtime

- `@modelcontextprotocol/sdk`
- `grammy`
- `zod`
- `redis`

### Dev

- `typescript`
- `tsx`
- `eslint`
- `prettier`
- `@types/node`

### Excluded for current phase

- `vitest`

Reason:

- tests are explicitly deferred for now

## Environment Variables

### Required

```env
TELEGRAM_BOT_TOKEN=
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=1
MODE=queue
PAIR_CODE_TTL_SECONDS=600
TELEGRAM_BOT_USERNAME=
```

### Optional

```env
REDIS_USERNAME=
REDIS_PASSWORD=
TELEGRAM_POLL_INTERVAL_MS=2000
TELEGRAM_DEFAULT_TIMEOUT_SECONDS=900
TELEGRAM_MAX_CONTEXT_CHARS=3000
TELEGRAM_MAX_QUESTION_CHARS=1000
TELEGRAM_MAX_MESSAGE_CHARS=3900
TELEGRAM_REQUIRE_ALLOWED_CHAT=true
```

### Validation rules

- `MODE` must be `queue` or `reject`
- pairing TTL must be a positive integer
- Redis numeric values must parse correctly
- timeout and length limits must be positive integers

## Documentation Plan

Create or update:

- `README.md`
- `.env.example`

README must include:

- what the server does
- why transport is pluggable
- how Telegram transport works
- how pairing works
- Redis setup requirements
- how to create the bot
- how to link a Telegram user to a session with a one-time code
- how to use `/start <code>` and `/link <code>`
- how to run the server
- how to connect it to Codex
- what `MODE=queue|reject` changes
- known current limitations

## Known Limitations For This Phase

- Telegram is the only implemented transport
- optional MCP tools are not implemented yet
- tests are intentionally omitted in the current iteration
- one transport backend only, though the contract is prepared for more
- operational behavior depends on Redis availability
- session usage requires explicit pairing before the first question

## Risks and Mitigations

### Redis dependency adds operational coupling

Risk:

- the server cannot function without Redis

Mitigation:

- validate connection at startup
- fail fast with a clear error
- keep Redis usage minimal and explicit

### Queue mode can complicate reply ownership

Risk:

- a delayed reply may target a previous request

Mitigation:

- active request is always singular
- queued requests are not sent until they become active
- reply matching always uses the current active Telegram message ID first

### Pairing code theft or reuse

Risk:

- anyone who gets the code could try to bind a session

Mitigation:

- short TTL
- one-time consume semantics
- bind code to a specific session
- acknowledge binding with visible session label only, not sensitive context

### Over-abstraction too early

Risk:

- FSD and pluggable transport can turn into ceremony

Mitigation:

- keep interfaces narrow
- build exactly one implementation per contract now
- avoid extra factories or DI frameworks

### Secret leakage

Risk:

- user context may contain tokens or credentials

Mitigation:

- mandatory redaction before send, log, and persistence
- keep stored payloads compact

## Execution Order

1. Restructure the project around the FSD-inspired layout.
2. Update `package.json` and add TypeScript, ESLint, Prettier configs.
3. Implement env loading and validation, including `MODE`.
4. Add Redis provider and storage contracts.
5. Add request/session/auth entities and schemas.
6. Add shared redaction and truncation utilities.
7. Add transport contract.
8. Implement pairing code generation and binding storage.
9. Implement Telegram transport adapter with `/start <code>` and `/link <code>` handling.
10. Implement `create_session_pair_code` and tool registration.
11. Implement human-approval orchestration process.
12. Implement `ask_user_telegram` feature and tool registration.
13. Add `README.md` and `.env.example`.
14. Run lint and build.

## Acceptance Checklist

- server starts with valid env vars and Redis connectivity
- MCP exposes `create_session_pair_code`
- MCP exposes `ask_user_telegram`
- Telegram transport is isolated behind a generic interface
- session can be linked to Telegram through a one-time code
- session state is persisted in Redis
- `MODE=queue|reject` changes behavior as configured
- tool sends a Telegram message
- reply from the bound Telegram principal resolves the request
- timeout returns structured output
- secrets are redacted before sending and persistence
- documentation explains setup and integration

## Remaining Assumptions

These assumptions are now baked into the plan unless you want them changed:

- Redis stores both session context and pending-request coordination state
- Redis also stores one-time pairing codes and session bindings
- queue mode is FIFO
- queued requests are not sent to Telegram until they become active
- Telegram remains the only transport implemented in the first pass
- tests will be skipped entirely for the current iteration
- `session_id` is mandatory for user-targeted interactions
