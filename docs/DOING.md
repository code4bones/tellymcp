# DOING

Work actively being implemented on the current branch. Keep this list short and
move each item to `DONE.md` in the same commit that completes it.

## Managed Agent Providers

- connect Codex app-server command/file approval requests to the existing
  Telegram approval UI and send the matching JSON-RPC decision back to the
  originating request
  - started: `2026-08-21`
  - branch: `feat/telegram-agent-chat-continuation`
  - current behavior: approval requests fail closed until the callback route is
    implemented
