# Tools

Version: `2026-05-18.1`

Gateway/client runtime compatibility:

- `TOOLS.md` hash sync and runtime version handshake are separate checks.
- The authoritative freshness check for `TOOLS.md` is the content hash, not this human-readable `Version:` line.
- Treat this `Version:` line only as a quick visual marker for humans and logs.
- `TOOLS.md` sync tells the agent to refresh instructions.
- `ws hello/hello_ack` checks `package_version`, `protocol_version`, and `capabilities`.
- If protocol major versions differ, gateway transport is blocked until the older side is upgraded.
- If you receive a system inbox message about gateway/client version mismatch, treat it as operational priority before continuing collaboration or live-relay work.

This MCP server currently exposes the following tools.

Browser tools:

- `browser_open`
- `browser_reload`
- `browser_click`
- `browser_fill`
- `browser_press`
- `browser_wait_for`
- `browser_wait_for_url`
- `browser_console`
- `browser_errors`
- `browser_network_failures`
- `browser_clear_logs`
- `browser_dom`
- `browser_computed_style`
- `browser_screenshot`
- `browser_close`

Browser runtime rule:

- Browser tools use Playwright Chromium.
- If browser tools fail because the Playwright browser runtime is missing, install it with `tellymcp browser install`.
- Do not stop at the installation error itself. Install the browser runtime first, then retry the browser tool.

Collaboration tools:

- `send_partner_note`
- `send_partner_file`

Utility tools:

- `refresh_tools_markdown`

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
- `.mcp-xchange` is the active local exchange workspace for files, screenshots, notes, and handoffs
- one directory now maps to one logical session by default
- the service stores that logical identity in `.mcpsession.json` inside the workspace
- tmux attributes are runtime metadata only and no longer change `session_id`
- if tmux attributes are not provided here, the Telegram session can still pair successfully, but tmux nudges, Mini App controls, and other tmux-driven features will remain unavailable until `set_tmux_target` is called later

Required agent practice:

This is mandatory for the agent:

- when the user asks to register, link, pair, or connect the current agent/session to Telegram, do not call `create_session_pair_code` immediately from memory
- first determine the correct workspace `cwd`
- if tmux is available, collect the current tmux attributes too
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

Do not skip `cwd`. It is now the anchor for the stable session marker.

After `create_session_pair_code` succeeds:

- treat the returned `session_id` as the canonical session identity for this agent
- remember it in the current task context
- pass it explicitly to later session-scoped tools
- do not rely on implicit session defaults unless you also know that `cwd` is already correct for this exact agent workspace

Why this matters:

- many MCP tools resolve `session_id` from explicit input first
- if it is omitted, the server may derive it from `cwd`
- if the agent did not pass the correct `cwd`, or the MCP client does not preserve it, a later tool call can hit the wrong session

Mandatory rule:

- after pairing, prefer:
  - `session_id: "<returned value>"`
- for tools like:
  - `ask_user_telegram`
  - `notify_telegram`
  - `get_telegram_inbox_count`
  - `get_telegram_inbox`
  - `delete_telegram_inbox_message`
  - browser/session-context tools
- do not assume Telegram "active session" in the bot menu affects MCP tool defaults.

If you skip `cwd`:

- the service may create or reuse the wrong `.mcpsession.json`
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
- do not treat this as the source of session identity
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

## `refresh_tools_markdown`

Purpose:

- Download the canonical `TOOLS.md` from the configured gateway.
- Overwrite the local `TOOLS.md` so the agent can refresh instructions without manual copying.

Input:

- `save_locally?`

Output:

- `source`
- `saved`
- `bytes`
- `path?`

Behavior:

- if `GATEWAY_PUBLIC_URL` is configured, the tool fetches `GET /api/gateway/tools-md`
- if no gateway is configured, the tool falls back to the local file
- on the gateway node, the local `TOOLS.md` is the canonical source and should always be kept current
- after successful refresh, treat the local `TOOLS.md` as updated state for this session and re-read it before continuing

## `clear_session_context`

Purpose:

- Remove saved session context and Telegram pairing for the session.

Input:

- `session_id?`

Output:

- `cleared`
- `session_id`
- `cleared_pairing`

## `send_partner_note`

Purpose:

- Send a structured collaboration note to another session.
- Write a note file into the partner workspace under `.mcp-xchange/shares/`.
- Append a line to the partner `.mcp-xchange/SHARED_INDEX.md`.
- Optionally copy listed artifacts from the current workspace into the partner `.mcp-xchange/shares/files/<share_id>/`.
- Create an inbox message for the partner agent and trigger the normal tmux nudge path.

Input:

- `session_id?`
- `target_session_id?`
- `project_uuid?`
- `kind`
  - `share`
  - `question`
  - `reply`
  - `request`
  - `handoff`
- `summary`
- `message`
- `expected_reply?`
- `requires_reply?`
- `in_reply_to?`
- `artifacts?`

Output:

- `session_id`
- `partner_session_id`
- `kind`
- `share_id`
- `note_path`
- `share_index_path`
- `copied_artifacts`
- `inbox_message_id`
- `requires_reply`

Required agent practice:

- use this tool whenever the current session is linked to a partner and you need to communicate project-relevant information
- prefer structured note kinds over ad-hoc Telegram chat wording
- if the user asks things like:
  - "ask backend what APIs it has"
  - "tell frontend what changed"
  - "send the error to your teammate"
  - "tell the other agent what's new"
  then the correct path is `send_partner_note`

How to find the partner correctly:

- never guess the target session from labels, menu text, or memory
- there are two valid targeting modes:
  - local linked mode:
    - call `get_session_context`
    - use `context.linked_session_id`
  - project / collab mode:
    - use the explicit `target_session_id` that came from the project note, Telegram prompt, or task context
    - if available, also pass `project_uuid`
- for project replies, do not fall back to `linked_session_id`
- if `target_session_id` is explicitly known, it has priority over any linked partner
- if neither `target_session_id` nor `linked_session_id` is available:
  - do not retry blindly
  - tell the user the target session is unknown
  - ask them to relink locally or reopen the project target flow in Telegram

Minimal safe sequence:

1. Call `get_session_context`.
2. Resolve the target:
   - prefer explicit `target_session_id` for project/collab work
   - otherwise use `linked_session_id` for local partner work
3. Decide the correct note kind: `question`, `reply`, `share`, `request`, or `handoff`.
4. Call `send_partner_note`.

File transfer rule:

- if the requested result is an existing local file, send the actual file as an artifact
- prefer `send_partner_file` for this
- if you must stay on `send_partner_note`, use `artifact_refs`
- do not treat a sentence like "I am sending sample.txt" as completed delivery
- mentioning a filename in `message` is not enough; the receiver must get the real artifact

Minimal expectation for file delivery:

- include the normal text fields:
  - `summary`
  - `message`
- and also attach the file in `artifact_refs`
- if you can read the file locally, prefer embedding it immediately instead of asking the receiver to reconstruct it from text

Reply rule for project asks:

- when a collaboration note or `.mcp-xchange/shares/*.md` note contains:
  - `Reply message_uuid: ...`
  - `Reply target_session_id: ...`
  - `Reply project_uuid: ...`
  or a `Reply Params` section with the same data
- then reply with those exact values
- if `in_reply_to` is available, prefer `Reply message_uuid`
- if only the note `share_id` is available, gateway now also accepts that value in `in_reply_to`
- do not use `linked_session_id` for that reply
- if the note contains an `Action Required` section, treat it as mandatory execution guidance, not as optional commentary
- do not stop after local analysis when `Action Required` says to reply
- when `Reply Params` are present, prefer an explicit `send_partner_note(...)` call with those exact values

Mandatory completion rule:

- if a partner note says `requires_reply: true`, or contains `Reply Params`, or contains `Action Required` telling you to reply:
  - your task is not complete after local analysis
  - your task is not complete after writing an explanation into chat
  - your task is complete only after `send_partner_note(...)` succeeds
- if `send_partner_note(...)` fails:
  - treat that as an active blocker
  - report the failure
  - retry only with corrected routing parameters
  - do not pretend the reply was sent
- never replace a required reply with:
  - a local summary
  - a chat-only explanation
  - "I prepared the answer"
  - "I am ready to answer"

Execution order for required replies:

1. Read the partner note and extract `Reply Params`.
2. Do the requested inspection or work locally.
3. Call `send_partner_note(...)` with the explicit routing params.
4. Only after the tool succeeds, say that the reply was sent.

## `send_partner_file`

Purpose:

- Send a real existing local workspace file to another session.
- Wrap the normal partner note flow and attach the file artifact automatically.

Input:

- `session_id?`
- `target_session_id?`
- `project_uuid?`
- `cwd?`
- `file_path`
- `kind?`
- `summary?`
- `message?`
- `expected_reply?`
- `requires_reply?`
- `in_reply_to?`

Rules:

- use this when you already have a real file like `sample.txt`, `report.pdf`, `page.png`, `dump.log`
- prefer this over trying to hand-build `artifact_refs`
- `file_path` must point to a real file inside the current session workspace
- do not replace this with a plain note that only mentions the filename

Minimal file-delivery rule:

1. Confirm the file exists in the local workspace.
2. Call `send_partner_file(...)`.
3. Only after the tool succeeds, say that the file was sent.

Routing priority:

1. explicit `Reply target_session_id`
2. explicit `target_session_id` from the current project/task context
3. local `linked_session_id`

For project/collab traffic, step 3 is fallback only when no explicit target exists.

Canonical example for a project reply:

```json
{
  "session_id": "backend",
  "in_reply_to": "29587d1e-2aaf-4663-a87c-a51581176cb4",
  "target_session_id": "9df1ad2e-88d4-4b01-b706-72d60f79f7cb",
  "project_uuid": "42a8ff66-....",
  "kind": "reply",
  "summary": "Описание REST API",
  "message": "Подготовил краткое описание REST API и основных endpoints."
}
```

How the receiving agent must react:

- partner collaboration wake-ups are not ordinary Telegram inbox wake-ups
- if the tmux nudge says things like:
  - `прочитай SHARED_INDEX.md`
  - `partner note`
  - `partner notes`
  then do not start with `get_telegram_inbox`
- instead:
  1. open `.mcp-xchange/SHARED_INDEX.md`
  2. find the newest partner note
  3. open that note file
  4. read any copied artifacts referenced there
- only use `get_telegram_inbox` for the normal Telegram human-message path
- do not confuse partner collaboration notes with human Telegram inbox traffic

What to do after reading the note:

- do not stop at summarizing the note back to the user
- choose behavior from `kind`
- if the note requires a reply, do the work and send the reply before declaring completion

Required behavior by note kind:

- `question`
  - answer the partner's question
  - if needed, inspect your workspace first
  - then send a `reply`
- `reply`
  - use the answer in your current work
  - continue execution
- `share`
  - update your assumptions/context
  - continue execution if the update affects your task
- `request`
  - treat it as an actionable task from the partner
  - start doing the requested work unless it is clearly impossible or blocked
  - when done, respond with `reply` or `handoff`
- `handoff`
  - treat it as material to consume and continue from
  - if the handoff asks for a concrete follow-up, start that work

Default rule:

- if the partner note contains a concrete ask, task, or follow-up, begin executing it
- do not merely report "I read the note" unless the user explicitly asked only for inspection
- if the note requires a reply, do not stop at "I prepared the answer"
- send the actual `reply` through `send_partner_note`

Recommended mapping:

- `question`
  - ask for API summaries
  - ask "what's new?"
  - ask for error details
- `reply`
  - answer a previous `question`
  - set `in_reply_to`
- `share`
  - communicate what changed without asking for action
- `request`
  - ask the partner to do or verify something
- `handoff`
  - transfer a result, contract, artifact, or completion note

Note contract:

- the service writes one note per message to:
  - `.mcp-xchange/shares/<share_id>.md`
- the partner index is append-only:
  - `.mcp-xchange/SHARED_INDEX.md`
- artifacts are copied into:
  - `.mcp-xchange/shares/files/<share_id>/...`

What the source agent should include:

- `summary`
  - one-line high-signal description
- `message`
  - the actual explanation, question, request, or handoff content
- `expected_reply`
  - when you need a concrete answer back
- `artifacts`
  - paths to files from the current workspace that should be copied to the partner

Artifact rule:

- do not attach raw source files to partner notes
- this includes files such as:
  - `.ts`, `.tsx`, `.js`, `.jsx`
  - `.go`, `.py`, `.java`, `.rs`, `.php`
  - `.html`, `.css`, `.scss`, `.vue`, `.svelte`
  - shell scripts and similar source-like files
- instead send:
  - API summaries
  - endpoint signatures
  - OpenAPI/spec files
  - sample payloads
  - logs
  - screenshots
  - Markdown notes

If a source file seems necessary, summarize the relevant contract in the note instead of copying the full implementation file.

What to communicate:

- API summaries and endpoint changes
- what changed since the last handoff
- current errors and how to reproduce them
- payload examples and specs
- relevant git context from the current workspace
  - changed files
  - branch-specific behavior
  - important diffs or migration notes

If you mention git changes:

- summarize them in `message`
- attach the concrete files only when the partner really needs them
- do not assume the partner can infer your branch state without the note

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

- Browser tools require Playwright Chromium browser binaries.
- If the runtime is missing, run `tellymcp browser install`, then retry `browser_open`.

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
- `message_kind`
  - `human`
  - `system`
- `telegram_message_id`
- `telegram_chat_id`
- `telegram_user_id`
- `text`
- `attachments?`
- `received_at`

Meaning:

- when a task starts from one of these inbox items, treat it as a Telegram-originated task
- use `notify_telegram` for progress updates and `ask_user_telegram` for clarifications during that task
- if `message_kind = "system"`:
  - treat it as an operational instruction from the service
  - do not reinterpret it as a normal user request
  - if it contains `Action Required`, follow that operational flow first
  - for example, a `TOOLS.md updated` system message means:
    1. call `refresh_tools_markdown`
    2. re-read the local `TOOLS.md`
    3. apply the updated rules before continuing
  - do not answer this kind of message with a normal human-facing reply unless the instruction explicitly says to notify the user
- process the batch one message at a time
- move to the next inbox item only if the current one did not create a blocker
- if the current message leads to a clarification wait or another blocking condition, stop batch processing there and leave the remaining inbox items pending
- if `attachments` is present, those are local paths inside `.mcp-xchange` that the agent can read from the workspace
- those paths are ordinary local workspace paths inside `.mcp-xchange`
- file upload itself is now the handoff action when the user is inside a target context
- there is no separate Telegram `Files` menu anymore
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
- `ai_tag?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`

Output:

- `session_id`
- `clicked`
- `ai_tag?`
- `selector?`
- `text?`
- `url`
- `title?`

## `browser_fill`

Purpose:

- fill an input or textarea in the current session page

Input:

- `session_id?`
- `ai_tag?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`
- `value`

Output:

- `session_id`
- `filled`
- `ai_tag?`
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
- `ai_tag?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`
- `key`

Output:

- `session_id`
- `pressed`
- `key`
- `ai_tag?`
- `selector?`
- `text?`
- `url`
- `title?`

## `browser_wait_for`

Purpose:

- wait until an element in the current session page reaches a requested state

Input:

- `session_id?`
- `ai_tag?`
- `selector?`
- `text?`
- `exact?`
- `timeout_ms?`
- `state?`

Output:

- `session_id`
- `waited`
- `state`
- `ai_tag?`
- `selector?`
- `text?`
- `url`
- `title?`

Browser target rules for `browser_click`, `browser_fill`, `browser_press`, `browser_wait_for`:

- prefer `ai_tag` first when the frontend provides it
- supported markup:
  - `data-drive-tag="save-button"`
  - `ai-tag="save-button"`
- recommended usage is an attribute with a value, not a bare presence-only attribute
- prefer `selector` when you have a stable target:
  - `#id`
  - `.class`
  - `button[type="submit"]`
  - `div[data-testid="save"]`
- use `text` only when there is no reliable selector
- do not mix ambiguous hashed CSS classes with fuzzy text guessing when a stable selector exists

## `browser_wait_for_url`

Purpose:

- wait until the current session page navigates to an exact URL or to a URL containing a fragment

Input:

- `session_id?`
- `url?`
- `url_contains?`
- `timeout_ms?`

Output:

- `session_id`
- `waited`
- `matched`
- `url?`
- `url_contains?`
- `current_url`
- `title?`

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

## `browser_clear_logs`

Purpose:

- clear accumulated browser console, runtime error, and network failure buffers for the current session

Input:

- `session_id?`

Output:

- `session_id`
- `cleared`
- `console_messages_cleared`
- `page_errors_cleared`
- `network_failures_cleared`

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
- session menu uses:
  - `Live | Content | Browser`
  - `Local | Collab`
  - `Inbox | Storage | Settings`
  - `Back`
- default logical session identity comes from `.mcpsession.json` in the workspace
- changing tmux session/window/pane does not change `session_id`
- `Browser -> Screenshots` lists screenshots created by `browser_screenshot`
- `Storage` browses `.mcp-xchange` for the active session and can send stored notes/files back into Telegram
- `Settings` contains `Info`, `Rename`, `Unpair`, `Back`
- `Link` creates a mutual partner relationship between two sessions visible to the same Telegram identity
- `Local` is the Telegram UI wrapper over same-bot partner collaboration
- `Collab` is the project-based multi-machine collaboration flow
- inside `Collab -> Project -> Member`, action semantics differ:
  - first row is `Ask | Share`
  - second row is `Live`
  - `Ask` sends a task to the selected member session
  - expected reply route is `member -> current session`
  - `Share` creates a task for the current session
  - expected send route is `current session -> member`
  - `Live` first sends an approval request to the selected member session
  - after approval, the requester receives a fresh `Open Live View` button in Telegram
- partner-note prompt format is:
  - first line = summary
  - optional blank line
  - remaining text = full message body
- if an old project-member menu message becomes stale, clicking it deletes that outdated Telegram message
- partner-note wake-up means:
  - read `.mcp-xchange/SHARED_INDEX.md`
  - then read the newest partner note
  - not `get_telegram_inbox`

Distributed mode scaffold:

- `DISTRIBUTED_MODE=client|gateway|both`
- `/gateway/healthz` is available when mode is `gateway` or `both`
- `/gateway/partner-note` is available when mode is `gateway` or `both`
- if `GATEWAY_PUBLIC_URL` is configured, `send_partner_note` and Telegram `Collab` delivery use the gateway HTTP surface for note creation
- in `DISTRIBUTED_MODE=both`, same-bot local delivery should still go through the gateway path transparently
- gateway/client online transport now uses `ws`
- optional gateway-side `RabbitMQ` fanout can be enabled through `RMQ_*`
- `TOOLS.md` sync is hash-based:
  - client sends `session_tools` in `ws hello`
  - gateway compares them with canonical gateway `TOOLS.md`
  - mismatch produces `tools_event`
  - client also self-checks after `hello_ack`
- once linked, agents should use `.mcp-xchange/SHARED_INDEX.md` plus separate files in `.mcp-xchange/shares/` for collaboration
- recommended collaboration note kinds are:
  - `share`
  - `question`
  - `reply`
  - `request`
  - `handoff`
- useful collaboration content includes API summaries, what changed, current errors, sample payloads, and relevant git changes from the agent workspace
- `Tools` contains `Broadcast` and `Prune all`
- `Collab -> Tools` contains:
  - `Broadcast`
  - `History`
  - `Delete`
- `History` sends a markdown export of the last 5 Collab events for the current active session

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

## Presence model

Current truth:

- gateway can know whether a client node is online through active `ws`
- gateway also stores `gateway_clients.last_seen_at`
- this is not the same thing as a live coding-agent heartbeat inside each session

Rule:

- do not claim that a session agent is definitely `offline` unless a dedicated agent heartbeat exists
- today the honest distinction is:
  - client node `online/offline`
  - session bound/unbound
  - tmux target configured/not configured

If no tmux target is configured, use passive inbox checks:

1. Call `get_telegram_inbox_count`.
2. If `total > 0`, call `get_telegram_inbox`.
3. Process messages.
4. Call `delete_telegram_inbox_message` for handled items.
