# Telegram Human-in-the-Loop MCP Server Spec

## 1. Overview

Build an MCP server that allows Codex or another MCP-capable coding agent to ask the human user a question via Telegram and wait for the answer.

The server should expose a tool named:

```text
ask_user_telegram
```

The tool receives a structured question payload, sends it to a configured Telegram chat, waits for a reply, and returns the reply as the tool result.

This is intended for human clarification during coding tasks, especially for risky or ambiguous decisions.

Example use cases:

- "Can I add a database migration?"
- "Should I preserve the old API response shape?"
- "Is it okay to add this dependency?"
- "Which product behavior should be implemented?"
- "Can I proceed with this potentially risky refactor?"

This MCP server is not intended to replace Codex approval prompts for dangerous commands. It is for clarification and human input.

## 2. Core principles

### 2.1 Explicit context only

The MCP server should not try to infer hidden model context.

The calling agent must provide all relevant context in tool arguments.

Good:

```json
{
  "question": "Can I add a nullable invite_token column?",
  "task": "Add organization invitations",
  "context": "Existing invitation records have no durable token for email acceptance links.",
  "affected_files": ["backend/src/services/invitationService.ts", "db/migrations/"],
  "recommended_option": "Approve additive migration only",
  "fallback_if_timeout": "Do not change database schema"
}
```

Bad:

```json
{
  "question": "Can I do it?"
}
```

### 2.2 Safe by default

If anything is unclear, timeout occurs, or Telegram fails, the server should not encourage risky behavior.

The tool should return structured timeout/failure information so the agent can choose the safest conservative option.

### 2.3 No secret leakage

The server must redact common secrets before sending messages to Telegram.

### 2.4 Minimal MVP

The first version should be local, simple, and reliable.

Use grammY long polling for MVP.
Do not implement raw `getUpdates` polling directly unless grammY cannot support the required behavior.

Do not require a database.

Do not require a hosted webhook.

Do not build a UI.

## 3. Technology

Use the following stack:

```text
Language: TypeScript
Runtime: Node.js
MCP: official MCP SDK
Telegram library: grammY
Formatting: Prettier
Linting: ESLint
Tests: Vitest
Package manager: pnpm preferred, npm acceptable if the project already uses npm
```

### 3.1 TypeScript

Use strict TypeScript.

Requirements:

- Enable `strict` in `tsconfig.json`.
- Avoid `any`.
- Define explicit types for:
  - MCP tool inputs
  - MCP tool outputs
  - Telegram request metadata
  - storage records
  - config object
- Keep runtime validation for external inputs.

### 3.2 Telegram library

Use `grammY` for Telegram integration.

Use grammY for:

- creating the bot
- sending messages
- receiving updates
- long polling
- reading message metadata
- checking `chat.id`
- checking `reply_to_message`
- handling text replies

Do not call Telegram Bot API directly with raw `fetch` unless there is a specific reason.

If raw Telegram API calls are needed, isolate them in one module and explain why.

### 3.3 Code quality tools

Configure:

```text
ESLint
Prettier
Vitest
```

Required scripts:

```json
{
  "scripts": {
    "dev": "tsx src/index.ts",
    "build": "tsc -p tsconfig.json",
    "start": "node dist/index.js",
    "lint": "eslint .",
    "format": "prettier --write .",
    "format:check": "prettier --check .",
    "test": "vitest run",
    "test:watch": "vitest"
  }
}
```

### 3.4 Dependencies

Prefer a small dependency set.

Expected dependencies:

```text
@modelcontextprotocol/sdk
grammy
zod
```

Expected dev dependencies:

```text
typescript
tsx
eslint
prettier
vitest
@types/node
```

Do not add heavy frameworks.

Do not add a database.

Do not add a frontend UI.

Do not add webhook infrastructure for MVP.




## 4. Environment variables

Required:

```env
TELEGRAM_BOT_TOKEN=
TELEGRAM_ALLOWED_CHAT_ID=
REDIS_HOST=localhost
REDIS_PORT=6379
REDIS_DB=1
```

Optional:

```env
TELEGRAM_POLL_INTERVAL_MS=2000
TELEGRAM_DEFAULT_TIMEOUT_SECONDS=900
TELEGRAM_MAX_CONTEXT_CHARS=3000
TELEGRAM_MAX_QUESTION_CHARS=1000
TELEGRAM_STORAGE_PATH=.telegram-human-mcp
```

### 4.1 Environment validation

On startup, validate:

- `TELEGRAM_BOT_TOKEN` exists
- `TELEGRAM_ALLOWED_CHAT_ID` exists
- timeout values are valid positive numbers
- max length values are valid positive numbers

Fail clearly if required config is missing.

## 5. MCP tools

## 5.1 Required tool: `ask_user_telegram`

### Description

Ask the human user a question through Telegram and wait for the reply.

### Input schema

```ts
type AskUserTelegramInput = {
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
};
```

### Validation rules

- `question` is required.
- `question` must not be empty.
- `question` should be truncated or rejected if longer than configured max.
- `context` should be truncated if longer than configured max.
- `affected_files` should be an array of strings if provided.
- `options` should be an array of strings if provided.
- `risk_level` must be one of `low`, `medium`, `high`.
- `timeout_seconds` must be positive if provided.

### Output schema

```ts
type AskUserTelegramOutput = {
  request_id: string;
  answer: string | null;
  timed_out: boolean;
  received_at?: string;
  fallback_used?: string;
};
```

### Expected behavior

1. Generate a unique `request_id`.
2. Build a Telegram message from the input.
3. Redact secrets from the message.
4. Send the message to `TELEGRAM_ALLOWED_CHAT_ID`.
5. Store pending request metadata.
6. Poll Telegram updates.
7. Accept only messages from `TELEGRAM_ALLOWED_CHAT_ID`.
8. Prefer replies to the specific bot message.
9. Resolve the request when a valid reply is received.
10. Return structured output.
11. If timeout occurs, return `timed_out: true`.

### Example input

```json
{
  "task": "Add organization invitations",
  "question": "Can I add a nullable `invite_token` column to `organization_invites`?",
  "context": "The current invite flow creates invitation rows but has no durable token for email acceptance links.",
  "affected_files": [
    "backend/src/services/invitationService.ts",
    "db/migrations/"
  ],
  "options": [
    "Approve additive migration",
    "Do not change DB schema",
    "Use an existing field instead"
  ],
  "recommended_option": "Approve additive migration",
  "risk_level": "high",
  "timeout_seconds": 900,
  "fallback_if_timeout": "Do not change DB schema"
}
```

### Example output with answer

```json
{
  "request_id": "req_20260503_abc123",
  "answer": "Yes, additive migration only. Do not touch existing invite records.",
  "timed_out": false,
  "received_at": "2026-05-03T12:30:00.000Z"
}
```

### Example output with timeout

```json
{
  "request_id": "req_20260503_abc123",
  "answer": null,
  "timed_out": true,
  "fallback_used": "Do not change DB schema"
}
```

## 5.2 Optional tool: `notify_telegram`

### Description

Send a one-way notification to Telegram without waiting for a reply.

Useful for progress updates or completion messages.

### Input schema

```ts
type NotifyTelegramInput = {
  message: string;
  task?: string;
  risk_level?: "low" | "medium" | "high";
};
```

### Output schema

```ts
type NotifyTelegramOutput = {
  sent: boolean;
  message_id?: number;
};
```

This tool is optional for MVP.

## 5.3 Optional tool: `set_session_context`

### Description

Store compact context for a session.

This is useful when the agent wants to ask multiple related questions without repeating the whole context every time.

### Input schema

```ts
type SetSessionContextInput = {
  session_id: string;
  task?: string;
  summary: string;
  files?: string[];
  decisions?: string[];
  risks?: string[];
};
```

### Output schema

```ts
type SetSessionContextOutput = {
  saved: boolean;
  session_id: string;
};
```

This tool is optional. If implemented, keep it simple.

## 5.4 Optional tool: `clear_session_context`

### Description

Clear saved context for a session.

### Input schema

```ts
type ClearSessionContextInput = {
  session_id: string;
};
```

### Output schema

```ts
type ClearSessionContextOutput = {
  cleared: boolean;
  session_id: string;
};
```

This tool is optional.

## 6. Telegram message format

Messages should be readable on mobile.

Format example:

```text
🤖 Codex needs input

Request:
req_20260503_abc123

Task:
Add organization invitations

Risk:
high

Question:
Can I add a nullable `invite_token` column to `organization_invites`?

Context:
The current invite flow creates invitation rows but has no durable token for email acceptance links.

Affected files:
- backend/src/services/invitationService.ts
- db/migrations/

Options:
1. Approve additive migration
2. Do not change DB schema
3. Use an existing field instead

Recommended:
Approve additive migration

Fallback if no answer:
Do not change DB schema

Reply to this message with your answer.
```

## 7. Telegram polling

Use Telegram `getUpdates`.

Implementation details:

- Track latest `update_id`.
- Poll every `TELEGRAM_POLL_INTERVAL_MS`.
- Ignore updates from unknown chats.
- Ignore old updates from before the request was sent when possible.
- Prefer messages that are replies to the bot's question message.
- For MVP, allow one active pending request at a time.
- If another request starts while one is pending, either:
  - reject the new request with a clear error, or
  - queue it.
  
Prefer rejecting or simple queueing for MVP. Do not build a complex scheduler.

## 8. Reply matching

Preferred matching:

```text
Telegram message is from allowed chat
AND message.reply_to_message.message_id === botQuestionMessageId
```

Fallback matching for MVP:

```text
Telegram message is from allowed chat
AND there is exactly one pending request
AND message timestamp is after the question was sent
```

Do not accept messages from other chats.

Do not accept channel posts.

Do not accept group messages unless the allowed chat ID is explicitly that group.

## 9. Storage

Use file-based local storage.

Default path:

```text
.telegram-human-mcp/
```

Suggested files:

```text
.telegram-human-mcp/
  pending.json
  sessions.json
  log.jsonl
```

### 9.1 Pending request record

```ts
type PendingRequest = {
  request_id: string;
  question: string;
  task?: string;
  sent_at: string;
  timeout_at: string;
  telegram_message_id?: number;
  status: "pending" | "answered" | "timed_out" | "failed";
};
```

### 9.2 Session context record

```ts
type SessionContext = {
  session_id: string;
  task?: string;
  summary: string;
  files?: string[];
  decisions?: string[];
  risks?: string[];
  updated_at: string;
};
```

Do not store raw full Codex transcript.

Do not store secrets.

Apply redaction before logging.

## 10. Secret redaction

Before sending to Telegram and before writing logs, redact common secrets.

At minimum, detect and redact:

```text
OpenAI-style keys
GitHub tokens
Bearer tokens
Postgres URLs
Generic DATABASE_URL
JWT-looking tokens
Private key blocks
password=...
api_key=...
secret=...
token=...
```

Replacement examples:

```text
[REDACTED_OPENAI_KEY]
[REDACTED_GITHUB_TOKEN]
Bearer [REDACTED]
postgres://[REDACTED]
[REDACTED_PRIVATE_KEY]
```

Implement redaction in a dedicated utility:

```ts
redactSecrets(input: string): string
```

Add tests for this utility.

## 11. Length limits

Telegram messages have practical length limits.

Implement compacting/truncation.

Suggested limits:

```text
question: 1000 chars
context: 3000 chars
full message: 3900 chars
```

If too long:

- keep question
- keep task
- keep risk
- keep recommended option
- truncate context
- show `[truncated]`

Never split huge logs across many Telegram messages for MVP.

## 12. Error handling

Handle the following:

### Missing config

Return clear startup error.

### Telegram API failure

Return MCP tool error if the question could not be sent.

### Timeout

Return successful structured output with:

```json
{
  "answer": null,
  "timed_out": true
}
```

### Invalid reply

Ignore unrelated messages.

### Multiple pending requests

For MVP, reject or queue. Prefer simple behavior and document it.

### Storage failure

Return clear error. Do not silently ignore.

## 13. Recommended project structure

```text
telegram-human-mcp/
  package.json
  tsconfig.json
  README.md
  .env.example
  src/
    index.ts
    config.ts
    mcpServer.ts
    telegram/
      telegramClient.ts
      polling.ts
      messageFormat.ts
    tools/
      askUserTelegram.ts
      notifyTelegram.ts
      setSessionContext.ts
      clearSessionContext.ts
    storage/
      fileStore.ts
      types.ts
    utils/
      redactSecrets.ts
      ids.ts
      sleep.ts
      truncate.ts
  tests/
    redactSecrets.test.ts
    messageFormat.test.ts
    askUserTelegram.test.ts
    storage.test.ts
```

If implementing optional tools would slow down MVP, implement only:

```text
ask_user_telegram
```

and leave TODO notes for the others.

## 14. README requirements

README must include:

### What this is

Explain that this is an MCP server for asking the human user questions via Telegram.

### Setup

Steps:

1. Create Telegram bot with BotFather.
2. Get bot token.
3. Get chat ID.
4. Create `.env`.
5. Install dependencies.
6. Build project.
7. Run server.
8. Add server to Codex.

### Example `.env`

```env
TELEGRAM_BOT_TOKEN=123456:ABCDEF
TELEGRAM_ALLOWED_CHAT_ID=123456789
TELEGRAM_DEFAULT_TIMEOUT_SECONDS=900
TELEGRAM_POLL_INTERVAL_MS=2000
TELEGRAM_MAX_CONTEXT_CHARS=3000
```

### Example Codex MCP setup

Include a command similar to:

```bash
codex mcp add telegramHuman \
  --env TELEGRAM_BOT_TOKEN="$TELEGRAM_BOT_TOKEN" \
  --env TELEGRAM_ALLOWED_CHAT_ID="$TELEGRAM_ALLOWED_CHAT_ID" \
  -- node /absolute/path/to/telegram-human-mcp/dist/index.js
```

Also mention checking with:

```text
/mcp
```

inside Codex.

### Example project `AGENTS.md` instruction

```md
## Telegram clarification

If you need clarification from the user and the answer is required to continue safely,
use the `ask_user_telegram` MCP tool.

Use it for:
- destructive database changes
- authentication or authorization changes
- production-impacting decisions
- ambiguous product requirements
- dependency additions
- deployment or infrastructure changes

When asking:
- include the task
- include concise context
- include affected files/systems
- include recommended safe default
- include fallback if timeout

Never include:
- secrets
- tokens
- private keys
- raw customer data
- unnecessary logs

If the tool times out:
- choose the safest conservative option
- avoid destructive changes
- document the assumption in the final response
```

## 15. Tests

Write tests for:

### Redaction

- redacts OpenAI-like keys
- redacts GitHub-like tokens
- redacts Bearer tokens
- redacts Postgres URLs
- redacts private key blocks
- does not destroy normal text

### Message formatting

- includes question
- includes task
- includes context
- includes files
- includes options
- includes recommended option
- includes fallback
- truncates long context

### Tool behavior

Mock Telegram client.

Test:

- sends message
- waits for valid reply
- ignores wrong chat
- times out
- returns fallback on timeout

### Storage

- can save pending request
- can mark answered
- can save session context if implemented
- handles missing storage directory

## 16. Security notes

This project must be conservative.

Telegram is not a secure place for secrets.

The tool should never send:

- `.env` contents
- API keys
- database URLs
- private keys
- raw production logs with user data
- customer data
- session cookies
- JWTs
- OAuth tokens

All outgoing Telegram text must pass through redaction.

Only `TELEGRAM_ALLOWED_CHAT_ID` may answer.

## 17. Known limitations for MVP

Document these limitations:

- Long polling only; no webhook.
- One pending question at a time.
- Telegram is used for clarification, not for command approval.
- Does not intercept normal Codex terminal questions automatically.
- Codex must explicitly call the MCP tool.
- Context must be passed explicitly by the agent.
- No database; file-based local storage only.

## 18. Acceptance criteria

The implementation is done when:

1. MCP server starts successfully with valid env vars.
2. `ask_user_telegram` is available as an MCP tool.
3. Calling the tool sends a Telegram message.
4. Replying in Telegram returns the answer to the tool caller.
5. Messages from other chats are ignored.
6. Timeout returns structured timeout result.
7. Secret redaction exists and has tests.
8. README explains setup and Codex connection.
9. `.env.example` exists.
10. Tests pass or failures are clearly documented.

## 19. Suggested implementation order

1. Create project skeleton.
2. Add config loader and env validation.
3. Add redaction utility.
4. Add Telegram client:
   - sendMessage
   - getUpdates
5. Add message formatter.
6. Add file storage.
7. Add MCP server.
8. Add `ask_user_telegram` tool.
9. Add timeout and reply matching.
10. Add tests.
11. Add README and `.env.example`.
12. Run build/test.
13. Document limitations.

## 20. Example manual test

After implementation:

1. Start the MCP server.
2. Trigger tool manually or through Codex.
3. Confirm Telegram receives:

```text
🤖 Codex needs input
```

4. Reply to the Telegram message:

```text
Yes, additive migration only.
```

5. Confirm MCP tool returns:

```json
{
  "answer": "Yes, additive migration only.",
  "timed_out": false
}
```

6. Send a message from another Telegram account/chat and confirm it is ignored.
7. Test timeout with short timeout value.
