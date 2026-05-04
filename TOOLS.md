# Tools

This MCP server currently exposes the following tools.

## `create_session_pair_code`

Purpose:

- Create a short-lived Telegram pairing code for a session.

Typical use:

- first-time session linking
- re-linking after `clear_session_pairing`

Input:

- `session_id?`
- `session_label?`
- `expires_in_seconds?`
- `tmux_session_name?`
- `tmux_window_name?`
- `tmux_window_index?`
- `tmux_pane_id?`
- `tmux_pane_index?`

Output:

- `session_id`
- `code`
- `expires_at`
- `status`
- `status_message`
- `telegram_link_hint?`

Behavior:

- if `session_id` is omitted, the server derives it automatically
- if tmux attributes are provided during pairing, they become part of the derived default session identity
- this is the recommended way to distinguish multiple agents working from different tmux sessions, windows, or panes, regardless of project layout
- for multi-agent work, prefer collecting tmux attributes first and passing them directly into this tool, instead of relying on a later `set_tmux_target`
- if tmux attributes are not provided here, the Telegram session can still pair successfully, but tmux nudges, Mini App controls, and other tmux-driven features will remain unavailable until `set_tmux_target` is called later

Required agent practice:

1. If running inside tmux, collect tmux attributes first:

```bash
tmux display-message -p '#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}'
```

2. Pass them directly into `create_session_pair_code`.
3. Use `set_tmux_target` later only as a repair, refresh, or override path.

## `clear_session_pairing`

Purpose:

- Remove the Telegram binding for a session.

Input:

- `session_id?`

Output:

- `cleared`
- `session_id`

## `set_session_context`

Purpose:

- Save compact reusable session context in Redis.

Input:

- `session_id?`
- `session_label?`
- `task?`
- `summary`
- `files?`
- `decisions?`
- `risks?`

Output:

- `saved`
- `session_id`
- `updated_at`
- `has_binding`

## `rename_session`

Purpose:

- Rename the session title/label only.

Rules:

- this changes only the human-readable title
- it does not change `session_id`
- it does not change pairing, tmux target, inbox, or saved context

Input:

- `session_id?`
- `title`

Output:

- `renamed`
- `session_id`
- `session_label`
- `updated_at`

## `set_tmux_target`

Purpose:

- Save the tmux pane target for a session so the long-running service can nudge the agent when new non-reply Telegram messages arrive for that paired session.

Recommended use:

- run this while still at the workstation
- do not treat this as the normal first pairing step
- use it immediately after pairing only if you need to repair, override, or refresh the target
- prefer a pane id such as `%7`

How to obtain tmux attributes:

```bash
tmux display-message -p '#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}'
```

Input:

- `session_id?`
- `tmux_session_name?`
- `tmux_window_name?`
- `tmux_window_index?`
- `tmux_pane_id?`
- `tmux_pane_index?`
- `tmux_target`

Output:

- `session_id`
- `tmux_target`
- `tmux_session_name?`
- `tmux_window_name?`
- `tmux_window_index?`
- `tmux_pane_id?`
- `tmux_pane_index?`
- `status_message`

## `get_tmux_target`

Purpose:

- Check whether a tmux target is configured for the current session and when it was last nudged.

Recommended use:

- setup/debug only
- use this when configuring tmux delivery or diagnosing why nudges do not happen
- do not call this in the normal inbox-processing path after a tmux nudge

Input:

- `session_id?`

Output:

- `session_id`
- `configured`
- `tmux_target?`
- `tmux_session_name?`
- `last_nudge_at?`
- `status_message`

## `get_session_context`

Purpose:

- Read saved session context and Telegram binding status.

Recommended use:

- setup/debug only
- use this while pairing, diagnosing state, or inspecting saved metadata
- do not call this in the normal inbox-processing path after a tmux nudge

Input:

- `session_id?`

Output:

- `session_id`
- `exists`
- `has_binding`
- `status_message`
- `context?`
- `binding?`
- `tmux?`

## `clear_session_context`

Purpose:

- Remove saved session context and Telegram pairing for the session.

Input:

- `session_id?`

Output:

- `cleared`
- `session_id`
- `cleared_pairing`

## `notify_telegram`

Purpose:

- Send a one-way Telegram message without waiting for a reply.

Input:

- `session_id?`
- `message`
- `task?`
- `context?`
- `risk_level?`
- `use_saved_context?`

Output:

- `sent`
- `message_id?`

## `get_telegram_inbox_count`

Purpose:

- Fast inbox check.
- Returns only the number of stored unsolicited Telegram messages.

Recommended use:

- use this for lightweight passive checks
- use this when no tmux nudge path is configured
- after a tmux nudge, prefer calling `get_telegram_inbox` directly instead of spending an extra step on count

Input:

- `session_id?`

Output:

- `session_id`
- `total`

## `get_telegram_inbox`

Purpose:

- Read unsolicited Telegram inbox messages stored for a session.
- Return a bounded batch rather than forcing the agent to pull the whole backlog at once.

Input:

- `session_id?`

Notes:

- the server always uses `TELEGRAM_INBOX_BATCH_SIZE`
- the agent should not try to choose its own batch size

Output:

- `session_id`
- `total`
- `has_more`
- `messages`

Per-message fields:

- `message_id`
- `source = "telegram"`
- `telegram_message_id`
- `telegram_chat_id`
- `telegram_user_id`
- `text`
- `received_at`

Meaning:

- when a task starts from one of these inbox items, treat it as a Telegram-originated task
- use `notify_telegram` for progress updates and `ask_user_telegram` for clarifications during that task

## `delete_telegram_inbox_message`

Purpose:

- Remove a processed inbox message so it is not handled again.

Input:

- `session_id?`
- `message_id`

Output:

- `deleted`
- `session_id`
- `message_id`

## `ask_user_telegram`

Purpose:

- Send a Telegram clarification request and wait for a reply.

Input:

- `question`
- `task?`
- `context?`
- `affected_files?`
- `options?`
- `recommended_option?`
- `risk_level?`
- `timeout_seconds?`
- `fallback_if_timeout?`
- `session_id?`
- `use_saved_context?`

Output:

- `request_id`
- `answer`
- `timed_out`
- `received_at?`
- `fallback_used?`

## Telegram inbox protocol

The inbox may contain new user instructions sent from Telegram.

If a paired session has a configured `tmux_target`, the preferred path is event-driven: Telegram stores the message, the service nudges tmux, and the agent then fetches `get_telegram_inbox`.

If no tmux nudge path exists, use passive inbox checks with `get_telegram_inbox_count`.

## Telegram transition protocol

When the user says they are leaving the workstation and wants to continue through Telegram:

1. If running inside tmux, obtain full tmux attributes:

```bash
tmux display-message -p '#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}'
```

2. Call `create_session_pair_code` with these attributes so the session identity is derived distinctly for this agent.
3. Complete pairing in Telegram.
4. If needed, call `set_tmux_target` only to override or refresh the stored target later.
5. Continue work normally.
6. If the long-running service nudges the tmux pane with `проверь inbox`, treat that as the signal to fetch the next inbox batch.
7. Read actual inbox content only through MCP tools.

The service does not inject Telegram message text into tmux. It only sends the wake-up phrase. Telegram messages remain stored in Redis inbox until the agent explicitly reads and deletes them. Multiple close-together Telegram messages are debounced into a single tmux wake-up.

## Telegram session switching

The Telegram side supports an active-session context per Telegram identity.

Rules:

- ordinary Telegram messages are stored in the inbox of the currently active session
- `/menu` opens a menu with all sessions linked to the current Telegram identity
- selecting a session makes it the new active session
- the main menu also provides a session-switch entry point
- the list contains every distinct `session_id` paired to this Telegram identity, so multi-agent setups depend on deriving different session ids during pairing

If tmux nudging is configured, the preferred behavior is event-driven:

1. Wait for the tmux nudge.
2. Call `get_telegram_inbox`.
3. Process the returned batch one message at a time.
4. Move to the next message only if the current message did not create a blocker, follow-up question, or execution error.
5. If the current message requires clarification or cannot be completed safely, stop batch progression, enter the `ask_user_telegram` branch, and leave the remaining inbox items pending.
6. Call `delete_telegram_inbox_message` only for messages that were actually handled.
7. If `has_more = true` and the current batch finished cleanly, call `get_telegram_inbox` again for the next batch.

Do not add extra diagnostic calls in that path:

- do not call `get_tmux_target` before `get_telegram_inbox`
- do not call `get_session_context` before `get_telegram_inbox`
- do not call `get_telegram_inbox_count` before `get_telegram_inbox` when the wake-up already came from tmux

If no tmux target is configured, use passive inbox checks:

1. Call `get_telegram_inbox_count`.
2. If `total > 0`, call `get_telegram_inbox`.
3. Process messages.
4. Call `delete_telegram_inbox_message` for handled items.
