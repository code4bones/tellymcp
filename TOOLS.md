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

Output:

- `session_id`
- `code`
- `expires_at`
- `status`
- `status_message`
- `telegram_link_hint?`

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

## `set_human_channel_mode`

Purpose:

- Explicitly switch the session between `direct` and `telegram` human interaction modes.

Recommended use:

- switch to `telegram` before leaving the workstation
- switch back to `direct` when working face-to-face with the agent again
- use this tool as the explicit trigger that enables or disables proactive Telegram inbox polling behavior for the agent

Input:

- `session_id?`
- `mode`

Output:

- `session_id`
- `human_channel_mode`
- `telegram_polling_enabled`
- `tmux_target_configured`
- `tmux_nudge_enabled`
- `status_message`
- `agent_instruction`

Behavior:

- `mode: "telegram"` means Telegram becomes the preferred asynchronous human channel for this session
- if a tmux target is configured and tmux nudging is enabled in the service config, the long-running service will debounce new non-reply Telegram messages and then nudge that tmux pane once for the batch
- the nudge is only a wake-up signal; message contents still stay in the MCP inbox tools
- `mode: "direct"` means the agent should stop proactive Telegram-first behavior and return to direct interaction

## `get_human_channel_mode`

Purpose:

- Quickly check which human interaction mode is currently active for the session.

Recommended use:

- call this at the start of a task to decide whether proactive Telegram inbox polling is expected
- use this instead of `get_session_context` when only the mode matters

Input:

- `session_id?`

Output:

- `session_id`
- `has_binding`
- `human_channel_mode`
- `telegram_polling_enabled`
- `tmux_target_configured`
- `tmux_nudge_enabled`
- `status_message`
- `agent_instruction`

Behavior:

- `mode: "telegram"` means the agent should treat Telegram as the asynchronous human channel for this session
- `mode: "direct"` means the agent should stop proactive Telegram inbox polling and assume direct interaction again

## `set_tmux_target`

Purpose:

- Save the tmux pane target for a session so the long-running service can nudge the agent when new non-reply Telegram messages arrive in Telegram mode.

Recommended use:

- run this while still at the workstation
- use it before or immediately after switching to `set_human_channel_mode = telegram`
- prefer a pane id such as `%7`

How to obtain tmux attributes:

```bash
tmux display-message -p '#{session_name} #{pane_id}'
```

Input:

- `session_id?`
- `tmux_session_name?`
- `tmux_target`

Output:

- `session_id`
- `tmux_target`
- `tmux_session_name?`
- `status_message`

## `get_tmux_target`

Purpose:

- Check whether a tmux target is configured for the current session and when it was last nudged.

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

Input:

- `session_id?`

Output:

- `session_id`
- `exists`
- `has_binding`
- `human_channel_mode`
- `telegram_polling_enabled`
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

Only enable proactive inbox polling after calling `set_human_channel_mode` with `mode: "telegram"`.

## Telegram transition protocol

When the user says they are leaving the workstation and wants to continue through Telegram:

1. Ensure the session is paired.
2. If running inside tmux, obtain tmux attributes:

```bash
tmux display-message -p '#{session_name} #{pane_id}'
```

3. Call `set_tmux_target` with the returned values.
4. Call `set_human_channel_mode` with `mode: "telegram"`.
5. Continue work normally.
6. If the long-running service nudges the tmux pane with `проверь inbox`, treat that as the signal to fetch the next inbox batch.
7. Read actual inbox content only through MCP tools.

The service does not inject Telegram message text into tmux. It only sends the wake-up phrase. Telegram messages remain stored in Redis inbox until the agent explicitly reads and deletes them. Multiple close-together Telegram messages are debounced into a single tmux wake-up.

Check the inbox at these checkpoints:

1. Before starting a non-trivial task.
2. After creating an implementation plan.
3. Before making risky changes.
4. Before running long commands.
5. Before final response.
6. After any failed test/build command.
7. Between major phases of a fullstack task:
   - after investigation
   - after backend changes
   - after database changes
   - after frontend changes
   - before final verification
8. If Telegram mode is active and no tmux target is configured, periodically poll inbox count about every 30 seconds.

Do not poll the inbox in a tight loop.

Recommended polling order:

1. Call `get_telegram_inbox_count`.
2. If `total > 0`, call `get_telegram_inbox`.
3. Process messages.
4. Call `delete_telegram_inbox_message` for handled items.

If tmux nudging is configured, the preferred behavior is event-driven:

1. Wait for the tmux nudge.
2. Call `get_telegram_inbox`.
3. Process the returned batch one message at a time.
4. Move to the next message only if the current message did not create a blocker, follow-up question, or execution error.
5. If the current message requires clarification or cannot be completed safely, stop batch progression, enter the `ask_user_telegram` branch, and leave the remaining inbox items pending.
6. Call `delete_telegram_inbox_message` only for messages that were actually handled.
7. If `has_more = true` and the current batch finished cleanly, call `get_telegram_inbox` again for the next batch.
