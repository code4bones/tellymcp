# AGENTS.md

## Project role

You are implementing a production-quality MCP server.

The server allows Codex or another AI coding agent to ask the human user questions through Telegram, wait for the user's answer, and return that answer to the agent as a tool result.

Act like a senior developer:
- be careful with security
- keep the implementation small and maintainable
- avoid unnecessary abstractions
- avoid unnecessary dependencies
- prefer explicit, typed code
- handle errors and timeouts
- never leak secrets
- document assumptions

## Main project goal

Build a local MCP server with Telegram integration.

The core tool is:

```text
ask_user_telegram
```

It should:

1. Receive a question from Codex.
2. Receive compact context for the question.
3. Send a well-formatted message to a configured Telegram chat.
4. Wait for a reply from the allowed user/chat.
5. Return the answer to Codex.
6. Timeout safely if there is no answer.

## Important behavior

The MCP server must not try to infer hidden Codex context.

The agent calling the tool must provide all relevant context explicitly in tool arguments.

Do not rely on:
- terminal output parsing
- Codex internal thread history
- raw transcript cache
- implicit memory

Prefer explicit structured context.

## Inbox handling rules for agents using this MCP

Telegram inbox messages are stored server-side and are not pushed into the agent body automatically.

Preferred path:

- if the session has a configured `tmux_target`, the service nudges the agent through tmux when a new ordinary Telegram message arrives
- after that nudge, call `get_telegram_inbox` directly
- process the returned batch one message at a time
- call `delete_telegram_inbox_message` only for messages that were actually handled

Passive fallback:

- if no `tmux_target` exists, use `get_telegram_inbox_count` for lightweight checks
- call `get_telegram_inbox` only if the count is greater than zero

Do not rely on a blocking wait tool for inbox handling in the main agent session.

## Pairing rules for agents

If the agent runs inside `tmux`, pairing should include tmux attributes immediately.

Correct pairing flow:

1. Run:
```bash
tmux display-message -p '#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}'
```
2. Call `create_session_pair_code` and pass these tmux fields.
3. Complete Telegram linking with `/start CODE`.

Why this matters:

- pairing without tmux attributes creates a valid Telegram binding
- but `tmux_target` remains unset
- then inbox nudges and Mini App control cannot work for that session

Use `set_tmux_target` only if:

- tmux target was missed during pairing
- tmux pane changed later
- stored target must be refreshed or overridden

## Required tools

Implement at least:

```text
ask_user_telegram
```

Optional if easy and useful:

```text
notify_telegram
set_session_context
clear_session_context
```

But do not overbuild. The MVP must work reliably first.

## Telegram safety rules

Never send secrets or sensitive raw data to Telegram.

Before sending text to Telegram, redact common secrets:

- API keys
- Bearer tokens
- GitHub tokens
- OpenAI keys
- database URLs
- private keys
- passwords
- session cookies

Only accept Telegram answers from the Telegram chat/user currently bound to the session.

Ignore updates from unbound Telegram users or chats for request resolution.

Use timeouts. Never wait forever.

## Environment variables

Use environment variables for configuration.

Required:

```env
TELEGRAM_BOT_TOKEN=
```

Optional:

```env
TELEGRAM_POLL_INTERVAL_MS=2000
TELEGRAM_DEFAULT_TIMEOUT_SECONDS=900
TELEGRAM_MAX_CONTEXT_CHARS=3000
TELEGRAM_MAX_QUESTION_CHARS=1000
TELEGRAM_MAX_MESSAGE_CHARS=3900
TELEGRAM_MENU_PAYLOAD_TTL_SECONDS=86400
```

Never hardcode secrets.

Never commit `.env`.

Provide `.env.example`.

## Implementation rules

Use TypeScript unless the repository clearly uses another language.

Prefer Node.js with the official MCP SDK if available in the project setup.

Use Redis-backed storage for pending requests, session context, Telegram inbox state, and menu payload buffers.

Do not require a web server for MVP.

Use Telegram long polling via `getUpdates` for MVP.

Webhook support can be added later, but is not required.

## Technical stack and code quality

Use the following stack:

```text
Language: TypeScript
Runtime: Node.js
MCP: official MCP SDK
Telegram library: grammY
Formatting: Prettier
Linting: ESLint
Tests: Vitest ( only if requested )
Package manager: pnpm preferred, yarn acceptable if the project already uses it
```

Code quality requirements:

- Use strict TypeScript.
- Avoid `any` unless absolutely necessary.
- Prefer explicit types for public functions, tool inputs, tool outputs, and Telegram payloads.
- Configure ESLint and Prettier.
- Add scripts for linting, formatting, testing, building, and development.
- Keep code formatted consistently.
- Do not disable lint rules without a clear reason.
- Do not add unnecessary dependencies.
- Prefer small modules with clear responsibilities.

Required `package.json` scripts:

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

Use grammY for Telegram Bot API integration.

Do not implement raw Telegram HTTP polling unless grammY cannot reasonably support the needed behavior.

Use grammY for:

- sending messages
- receiving updates
- filtering by bound Telegram chat/user
- handling replies
- long polling

Do not implement webhook support for MVP.

For session store use @grammyjs/storage-redis, conneciton params in .env REDIS_XXX vars


## Tool design

The main tool input should support:

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

The main tool output should support:

```ts
{
  answer: string | null;
  timed_out: boolean;
  request_id: string;
  received_at?: string;
  fallback_used?: string;
}
```

## Telegram message format

Send clear messages.

Include:

1. Project/session if available.
2. Task if available.
3. Risk level if available.
4. Question.
5. Compact context.
6. Affected files.
7. Options if provided.
8. Recommended option if provided.
9. Fallback if timeout.

The message should be readable on mobile.

## Reply matching

Prefer accepting replies to the bot's question message.

If reply metadata is unavailable, accept the next message from the bound Telegram chat/user while a request is pending.

Prevent cross-request confusion:
- each request must have a unique request ID
- store pending request metadata
- only resolve the matching active request
- handle multiple pending requests conservatively

For MVP, it is acceptable to process one pending request at a time.

## Timeout behavior

If the user does not answer before timeout:

- return `timed_out: true`
- return `answer: null`
- include `fallback_used` if provided
- do not throw unless there is a real infrastructure error

The calling agent should choose the safest conservative option.

## Error handling

Handle:

- missing environment variables
- invalid Telegram token
- invalid or missing Telegram session binding
- Telegram API errors
- network errors
- timeout
- invalid tool arguments
- message too long
- storage read/write errors

Return useful MCP tool errors where appropriate.

## Logging

Log locally:

- request ID
- timestamp
- whether message was sent
- whether answer was received
- whether timeout happened
- Telegram API errors

Do not log secrets.

Do not log full sensitive context after redaction unless necessary.

## Testing

Add tests for:

- input validation
- secret redaction
- Telegram message formatting
- timeout behavior
- Telegram binding filtering
- session context merging if implemented

Mock Telegram API calls.

Do not require real Telegram credentials for unit tests.

## Documentation

Create or update:

```text
README.md
.env.example
```

README should explain:

- what the MCP server does
- how to create a Telegram bot
- how to get chat ID
- required env vars
- how to build
- how to run
- how to connect to Codex
- example `codex mcp add ...`
- example `AGENTS.md` instruction for projects using this MCP

## Final response format

When finished, respond with:

1. Summary.
2. Files created/changed.
3. How to run.
4. How to connect to Codex.
5. Verification performed.
6. Known limitations.
7. Security notes.

Do not claim tests passed unless they were actually run.

## Forbidden without explicit approval

Do not:

- implement Telegram webhook unless needed
- add a database
- add a frontend UI
- store raw full Codex transcripts
- send secrets to Telegram
- accept messages from arbitrary Telegram users
- make destructive file operations
- publish package
- deploy anything
