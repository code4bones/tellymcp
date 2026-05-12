# Tools

This MCP server currently exposes the following tools.

Browser tools:

- `browser_open`
- `browser_reload`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_console`
- `browser_errors`
- `browser_network_failures`
- `browser_dom`
- `browser_computed_style`
- `browser_screenshot`
- `browser_close`

## `create_session_pair_code`

Purpose:

- Create a short-lived Telegram pairing code for a session.

Typical use:

- first-time session linking
- re-linking after `clear_session_pairing`
- any request like "register me in Telegram", "link this session to Telegram", "pair this agent", or similar

Input:

- `session_id?`
- `session_label?`
- `cwd?`
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

- generated pairing codes are short numeric 3-digit one-time codes
- if `session_id` is omitted, the server derives it automatically
- if `cwd` is provided, the server uses it as the agent workspace root for default session identity and for `.mcp-xchange` file downloads
- if tmux attributes are provided during pairing, they become part of the derived default session identity
- this is the recommended way to distinguish multiple agents working from different tmux sessions, windows, or panes, regardless of project layout
- for multi-agent work, prefer collecting tmux attributes first and passing them directly into this tool, instead of relying on a later `set_tmux_target`
- if tmux attributes are not provided here, the Telegram session can still pair successfully, but tmux nudges, Mini App controls, and other tmux-driven features will remain unavailable until `set_tmux_target` is called later

Required agent practice:

This is mandatory for the agent:

- when the user asks to register, link, pair, or connect the current agent/session to Telegram, do not call `create_session_pair_code` immediately from memory
- first collect the current agent attributes
- then call `create_session_pair_code` with them

Required order:

1. Determine the agent workspace `cwd`.
2. If running inside tmux, collect tmux attributes:

```bash
tmux display-message -p '#{session_name} #{window_name} #{window_index} #{pane_id} #{pane_index}'
```

3. Call `create_session_pair_code` and pass:
   - `cwd`
   - tmux attributes when available
4. Use `set_tmux_target` later only as a repair, refresh, or override path.

Do not skip attribute collection just because pairing itself can succeed without them.

If you skip `cwd`:

- the derived session identity may be less specific than intended
- Telegram file exchange into `.mcp-xchange` may not know the correct agent workspace

If you skip tmux attributes:

- pairing may still succeed
- but tmux nudges and Mini App controls may not work until repaired later

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
- `attachments?`
- `received_at`

Meaning:

- when a task starts from one of these inbox items, treat it as a Telegram-originated task
- use `notify_telegram` for progress updates and `ask_user_telegram` for clarifications during that task
- process the batch one message at a time
- move to the next inbox item only if the current one did not create a blocker
- if the current message leads to a clarification wait or another blocking condition, stop batch processing there and leave the remaining inbox items pending
- if `attachments` is present, those are local paths inside `.mcp-xchange` that the agent can read from the workspace
- file upload by itself does not create an inbox message anymore; the user may upload a file first and later use the Telegram `Files` menu to explicitly pass it to the agent
- `Files` is for Telegram-uploaded files only
- browser screenshots created by `browser_screenshot` are tracked separately and appear under Telegram `Browser -> Screenshots`

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

## `browser_open`

Purpose:

- open or reuse a Playwright tab for the current session
- keep browser state isolated per `session_id`

Input:

- `session_id?`
- `url`
- `wait_until?`
- `reset_context?`

Output:

- `session_id`
- `opened`
- `created_context`
- `url`
- `title?`

Notes:

- each session gets its own isolated browser context and page
- call this first before reading console, DOM, styles, or screenshots
- `url` may be an absolute URL, or a relative path when `BROWSER_ADDRESS` is configured

## `browser_console`

Purpose:

- read recent console output from the session browser tab

Input:

- `session_id?`
- `limit?`

Output:

- `session_id`
- `total`
- `messages`

## `browser_reload`

Purpose:

- reload the current session browser page after code changes or state drift

Input:

- `session_id?`
- `wait_until?`

Output:

- `session_id`
- `reloaded`
- `url`
- `title?`

## `browser_click`

Purpose:

- click an element in the current session page

Input:

- `session_id?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`

Output:

- `session_id`
- `clicked`
- `selector?`
- `text?`
- `url`
- `title?`

## `browser_fill`

Purpose:

- fill an input or textarea in the current session page

Input:

- `session_id?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`
- `value`

Output:

- `session_id`
- `filled`
- `selector?`
- `text?`
- `value_length`
- `url`
- `title?`

## `browser_press`

Purpose:

- send a key press to the page or a targeted element

Input:

- `session_id?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`
- `key`

Output:

- `session_id`
- `pressed`
- `key`
- `selector?`
- `text?`
- `url`
- `title?`

## `browser_wait_for`

Purpose:

- wait until an element in the current session page reaches a requested state

Input:

- `session_id?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`
- `state?`

Output:

- `session_id`
- `waited`
- `state`
- `selector?`
- `text?`
- `url`
- `title?`

Browser target rules for `browser_click`, `browser_fill`, `browser_press`, `browser_wait_for`:

- prefer `selector` when you have a stable target:
  - `#id`
  - `.class`
  - `button[type="submit"]`
  - `div[data-testid="save"]`
- use `text` only when there is no reliable selector
- do not mix ambiguous hashed CSS classes with fuzzy text guessing when a stable selector exists

## `browser_errors`

Purpose:

- read recent page runtime errors from the session browser tab

Input:

- `session_id?`
- `limit?`

Output:

- `session_id`
- `total`
- `errors`

## `browser_network_failures`

Purpose:

- read recent failed or HTTP-error requests from the session browser tab

Input:

- `session_id?`
- `limit?`

Output:

- `session_id`
- `total`
- `failures`

## `browser_dom`

Purpose:

- inspect a DOM element in the session browser tab

Input:

- `session_id?`
- `selector?`
- `include_html?`
- `include_text?`

Output:

- `session_id`
- `selector`
- `found`
- `url?`
- `title?`
- `outer_html?`
- `text_content?`
- `visible?`
- `attributes?`

## `browser_computed_style`

Purpose:

- inspect computed styles and box metrics for a DOM element in the session browser tab

Input:

- `session_id?`
- `selector`
- `properties?`

Output:

- `session_id`
- `selector`
- `found`
- `url?`
- `title?`
- `visible?`
- `styles?`
- `box?`

## `browser_screenshot`

Purpose:

- capture a screenshot from the session browser tab

Input:

- `session_id?`
- `selector?`
- `full_page?`
- `file_name?`
- `send_to_telegram?`
- `caption?`

Output:

- `session_id`
- `file_path`
- `workspace_dir`
- `exchange_dir`
- `telegram_message_id?`
- `url?`
- `title?`

Notes:

- screenshots are written into `.mcp-xchange`
- they are tracked separately from Telegram-uploaded files
- they appear under Telegram `Browser -> Screenshots`
- if `send_to_telegram=true`, the saved screenshot is also sent into the bound Telegram chat for that session

## `browser_close`

Purpose:

- close the isolated browser context for the current session

Input:

- `session_id?`

Output:

- `session_id`
- `closed`

## Operational notes

Telegram UI summary:

- `/menu` is the only top-level Telegram command for session navigation
- root menu shows one session button per row
- root menu also shows tmux bridge status
- session menu uses `Live`, `Content`, `Browser`, `Files`, `Inbox`, `Info`, `Rename`, `Unpair`, `Refresh`, `Back`
- `Files` lists Telegram-uploaded files only
- `Browser -> Screenshots` lists screenshots created by `browser_screenshot`
- `Tools` contains `Broadcast` and `Prune all`

Current remaining operational gaps are tracked in [docs/TODO.md](/home/code4bones/Devs/coding/mcp/telegram_mcp/docs/TODO.md).

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
