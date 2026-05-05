# TODO

The core stack is working:

- Telegram pairing and multi-session routing
- inbox + tmux nudge flow
- Mini App live view and limited tmux controls
- tmux host bridge through the Go proxy
- Docker deployment with Redis persistence

Remaining non-blocking work:

- [ ] Add `get_runtime_status` MCP tool for operational visibility.
- [ ] Add deeper runtime diagnostics for queue transitions and stale pending request recovery.
- [ ] Add explicit late-reply handling diagnostics after timeout.
- [ ] Add concurrency verification with multiple MCP clients and reconnect scenarios.
- [ ] Do one final full-stack smoke pass after the last UI and Docker changes.
