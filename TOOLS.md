# Tools

Version: `2026-05-22.1`

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

- `list_gateway_sessions`
- `list_xchange_records`
- `get_xchange_record`
- `mark_xchange_record_read`
- `send_partner_note`
- `send_partner_file`

Utility tools:

- `refresh_tools_markdown`

## Console model

Gateway-first runtime model:

- agents register themselves on the gateway automatically through `GATEWAY_TOKEN`
- Telegram no longer links sessions with pair codes
- `/menu` in the gateway bot shows available remote consoles directly
- one running agent console is one logical session/console target

Required agent practice:

- when the user asks to contact another agent, inspect consoles through `list_gateway_sessions`
- when the user asks to work with Telegram-linked human interaction, use the current console `session_id` explicitly
- in gateway mode, `session_id` means the live console id from `-s`
- do not use workspace-derived ids like `project-abc12345` for gateway routing
- do not use `cwd` to route to a console through the gateway
- if you need a `session_id` and do not know it yet, call `list_gateway_sessions` and use canonical `session_id` from the matching live console
- do not ask the user for the live console id when it can be resolved from `list_gateway_sessions`
- assume gateway is the only user-facing control plane
- do not mention pair codes, `/link`, admin menus, or session pairing unless the user is explicitly asking about legacy behavior

Preferred order for cross-console work:

1. Call `list_gateway_sessions`.
2. Choose the correct target by `session_label`, `node_id`, `client_label`, or canonical `session_id`.
3. Use:
   - `send_partner_note`
   - `send_partner_file`
   - browser tools
   with explicit `session_id` for the current console or explicit target routing fields for another console.

## `set_session_context`

Purpose:

- Save compact reusable console context.

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
  Legacy field name. Read it as: whether this console currently has an active Telegram route through the gateway.

## `rename_session`

Purpose:

- Rename only the human-readable console title/label.

Rules:

- this changes only the human-readable title
- it does not change `session_id`
- it does not change routing or saved context

Input:

- `session_id?`
- `title`

Output:

- `renamed`
- `session_id`
- `session_label`
- `updated_at`

## `get_session_context`

Purpose:

- Read saved console context and routing status.

Recommended use:

- setup/debug only
- use this while diagnosing state or inspecting saved metadata
- do not call this in the normal inbox-processing path unless you are diagnosing state

Input:

- `session_id?`

Output:

- `session_id`
- `exists`
- `has_binding`
  Legacy field name. Read it as: whether this console is currently reachable from Telegram through the gateway.
- `status_message`
- `context?`
- `binding?`
  Legacy field name. If present, this is the current Telegram route metadata for the console.
- `tmux?`
  Legacy field name. Read it as terminal runtime metadata for the console.

## `refresh_tools_markdown`

Purpose:

- Download the canonical `TOOLS.md` from the configured gateway.
- Return the canonical instructions in a hash-based form so the agent can refresh without mandatory local file writes.

Input:

- `session_id`
- `known_hash?`

Output:

- `source`
- `session_id?`
- `current_hash`
- `changed`
- `content?`
- `bytes`

Behavior:

- if `GATEWAY_PUBLIC_URL` is configured, the tool fetches `GET /api/gateway/tools-md`
- if no gateway is configured, the tool falls back to the installed package copy
- the canonical source is the installed gateway package copy, not an arbitrary current working directory
- in gateway mode, routing to the target console is done only by explicit canonical `session_id = client_uuid:local_session_id`
- `cwd` is workspace metadata for the target console after routing succeeds; it is not a routing key
- if the live console id is not already known, call `list_gateway_sessions` first and use `session_id`
- prefer hash-based refresh:
  - pass `known_hash` from the last applied TOOLS state
  - if `changed=false`, keep current instructions
  - if `changed=true`, read and apply returned `content`
- there is no local file-save mode in the normal flow
- do not create or rely on workspace `TOOLS.md` copies

## `clear_session_context`

Purpose:

- Remove saved session context and related per-session state for the console.

Input:

- `session_id?`

Output:

- `cleared`
- `session_id`
- `cleared_pairing`
  Compatibility field name. Treat it as legacy cleanup metadata, not as an instruction to use pairing.

## `send_partner_note`

## `list_gateway_sessions`

Purpose:

- List all consoles currently known to the configured gateway.
- Merge:
  - connected consoles from gateway WS presence
  - registered project consoles from the gateway database
- Use this before direct cross-console communication outside one collab project.
- Use this to resolve the authoritative live console id for other gateway-routed tools.

Input:

- `client_uuid?`
- `connected_only?`

Output:

- `total`
- `sessions[]`
  - `session_id`
  - `local_session_id`
  - `client_uuid`
  - `local_session_id`
  - `session_label?`
  - `client_label?`
  - `telegram_username?`
  - `telegram_display_name?`
  - `bot_username?`
  - `node_id?`
  - `package_version?`
  - `project_uuids?`
  - `project_names?`
  - `connected`
  - `registered`

Rules:

- use this when the user asks to contact a session that is not the current linked partner and not necessarily part of the current collab project
- for direct gateway-wide routing, resolve the target from this list and then call:
  - `send_partner_note`
  - or `send_partner_file`
- in that direct mode, pass:
  - `target_client_uuid`
  - `target_local_session_id`
- do not invent `target_session_id` for direct gateway-wide routing
- prefer connected sessions for direct gateway-wide messaging
- if a session is not connected, do not assume direct delivery will succeed

## `list_xchange_records`

Purpose:

- List structured `.mcp-xchange` records from the local sqlite store for the current session.
- Use this as the first lookup path for partner notes, local handoffs, unread collaboration items, and follow-up work.

Input:

- `session_id?`
- `status?`
  - `new`
  - `read`
  - `archived`
- `category?`
  - `partner_note`
  - `local_handoff`
- `direction?`
  - `incoming`
  - `outgoing`
  - `local`
- `limit?`

Output:

- `session_id`
- `total`
- `records`

Each record includes:

- `record_id`
- `category`
- `direction`
- `status`
- `kind?`
- `summary`
- `action_desc`
- `tools`
- `attachments`
- `source_*` and `target_*` routing fields when available
- `project_uuid?`
- `project_name?`
- `requires_reply?`
- `expected_reply?`
- `in_reply_to?`
- `created_at`
- `updated_at`
- `read_at?`

Rules:

- use this first when the session is nudged for partner collaboration or local handoff work
- prefer `status = "new"` for fresh work
- after selecting the relevant record, call `get_xchange_record`

## `get_xchange_record`

Purpose:

- Read one structured `.mcp-xchange` record in full.
- This gives the canonical `body_text`, `action_desc`, `tools`, attachments, and routing metadata for the next step.

Input:

- `session_id?`
- `record_id`

Output:

- `session_id`
- `record`

Rules:

- after `list_xchange_records`, call this on the chosen `record_id`
- trust `action_desc` and `tools` over old markdown-index habits
- use `body_text` as the structured note content; only open the note file directly if you need the raw markdown artifact

## `mark_xchange_record_read`

Purpose:

- Mark a structured `.mcp-xchange` record as read after consuming it.

Input:

- `session_id?`
- `record_id`

Output:

- `session_id`
- `record_id`
- `updated`

Rules:

- do this after you have consumed `body_text`, attachments, and next-step instructions
- do not mark a record read before you have actually processed it

## `send_partner_note`

Purpose:

- Send a structured collaboration note to another session.
- Write a note file into the partner workspace under `.mcp-xchange/shares/`.
- Create a structured xchange record in the partner sqlite store.
- Optionally copy listed artifacts from the current workspace into the partner `.mcp-xchange/shares/files/<share_id>/`.
- Create an inbox/xchange wake-up for the partner agent through the normal gateway delivery path.

Input:

- `session_id?`
- `target_session_id?`
- `target_client_uuid?`
- `target_local_session_id?`
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
- `xchange_record_id`
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
- there are three valid targeting modes:
  - local linked mode:
    - call `get_session_context`
    - use `context.linked_session_id`
  - project / collab mode:
    - use the explicit `target_session_id` that came from the project note, Telegram prompt, or task context
    - if available, also pass `project_uuid`
  - direct gateway-wide mode:
    - call `list_gateway_sessions`
    - resolve the exact target from the returned `client_uuid` + `local_session_id`
    - pass them as:
      - `target_client_uuid`
      - `target_local_session_id`
- for project replies, do not fall back to `linked_session_id`
- if `target_session_id` is explicitly known, it has priority over any linked partner
- if `target_client_uuid` + `target_local_session_id` are explicitly known, they define direct gateway-wide routing and have priority over linked partner memory
- if neither `target_session_id` nor `linked_session_id` is available:
  - do not retry blindly
  - tell the user the target session is unknown
  - ask them to relink locally or reopen the project target flow in Telegram

Minimal safe sequence:

1. Call `get_session_context`.
2. Resolve the target:
   - prefer explicit `target_session_id` for project/collab work
   - for gateway-wide direct work, use explicit `target_client_uuid` + `target_local_session_id`
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
  - `Reply target_client_uuid: ...`
  - `Reply target_local_session_id: ...`
  or a `Reply Params` section with the same data
- then reply with those exact values
- if `in_reply_to` is available, prefer `Reply message_uuid`
- if only the note `share_id` is available, gateway now also accepts that value in `in_reply_to`
- do not use `linked_session_id` for that reply
- if direct reply params contain `target_client_uuid` + `target_local_session_id`, do not replace them with `target_session_id`
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
- `target_client_uuid?`
- `target_local_session_id?`
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
2. explicit `Reply target_client_uuid` + `Reply target_local_session_id`
3. explicit `target_session_id` from the current project/task context
4. explicit `target_client_uuid` + `target_local_session_id` from `list_gateway_sessions`
5. local `linked_session_id`

For project/collab traffic, step 5 is fallback only when no explicit target exists.

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

- wake-ups now point to the unified `.mcp-xchange` flow
- if the wake-up says things like:
  - `проверь xchange records`
  - `telegram_message`
  - `partner_note`
  then do not start with an inbox-specific tool
- instead:
  1. call `list_xchange_records`
  2. identify the newest relevant record by category:
     - `telegram_message` if the sender is a human from Telegram
     - `partner_note` if the sender is another agent
  3. call `get_xchange_record`
  4. read `body_text`, `action_desc`, `tools`, and any attachments
- reply according to the record category:
  - `telegram_message` -> answer with `notify_telegram`
  - `partner_note` -> answer with `send_partner_note`

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
- the structured source of truth is the local sqlite xchange store:
  - `.mcp-xchange/xchange.sqlite3`
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

- `/menu` is the only top-level Telegram command for console navigation
- root menu shows one console button per row
- root menu reflects terminal bridge status for available consoles
- console menu uses:
  - `Live | Content | Browser`
  - `Collab`
  - `Storage | Settings`
  - `Back`
- default logical console identity comes from `.mcpsession.json` in the workspace or explicit `-s`
- terminal runtime metadata does not change `session_id`
- `Browser -> Screenshots` lists screenshots created by `browser_screenshot`
- `Storage` browses `.mcp-xchange` for the active console and can send stored notes/files back into Telegram
- `Settings` contains `Info`, `Rename`, `Unpair`, `Back`
- project/collab work is the only supported user-facing collaboration path in Telegram UI
- `Collab` is the project-based multi-machine collaboration flow
- inside `Collab -> Project -> Member`, action semantics differ:
  - first row is `Ask | Share`
  - second row is `Live`
  - `Ask` sends a task to the selected member console
  - expected reply route is `member -> current console`
  - `Share` creates a task for the current console
  - expected send route is `current console -> member`
  - `Live` first sends an approval request to the selected member console
  - after approval, the requester receives a fresh `Open Live View` button in Telegram
- partner-note prompt format is:
  - first line = summary
  - optional blank line
  - remaining text = full message body
- if an old project-member menu message becomes stale, clicking it deletes that outdated Telegram message
- partner-note wake-up means:
  - call `list_xchange_records`
  - then call `get_xchange_record`
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
- agents should use `list_xchange_records` / `get_xchange_record` plus separate files in `.mcp-xchange/shares/` for collaboration
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
- `History` sends a markdown export of the last 5 Collab events for the current active console

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

## Telegram human-message protocol

Human Telegram messages are now stored as structured `telegram_message` records in `.mcp-xchange`.

Preferred behavior is event-driven:

1. The human sends a message through the gateway bot.
2. The gateway routes the message to the active console as a `telegram_message` record.
3. The running agent checks `.mcp-xchange` through MCP tools.
4. Read actual content through `list_xchange_records` and `get_xchange_record`.

## Telegram console switching

The Telegram side supports an active-console context per Telegram identity.

Rules:

- ordinary Telegram messages are stored as `telegram_message` records for the currently active console
- `/menu` opens a menu with all consoles visible to the current Telegram identity inside the current gateway scope
- selecting a console makes it the new active console
- the main menu also provides a console-switch entry point
- the list reflects currently available gateway-known consoles, not a local pairing catalog

1. Wait for the wake-up or decide to poll explicitly.
2. Call `list_xchange_records`.
3. Select the newest relevant `telegram_message` record with `status = new`.
4. Call `get_xchange_record`.
5. Process the returned record.
6. If the message was handled, call `mark_xchange_record_read`.

Do not add extra diagnostic calls in that path:

- do not call `get_session_context` before `list_xchange_records`
- do not invent a separate inbox polling pass when the wake-up already arrived

## Presence model

Current truth:

- gateway can know whether a client node is online through active `ws`
- gateway also stores `gateway_clients.last_seen_at`
- this is not the same thing as a live coding-agent heartbeat inside each console

Rule:

- do not claim that a console agent is definitely `offline` unless a dedicated agent heartbeat exists
- today the honest distinction is:
  - client node `online/offline`
  - console visible/not visible
  - current console context present/absent

If no wake-up has arrived, use passive record checks:

1. Call `list_xchange_records`.
2. If there is a new `telegram_message` record, call `get_xchange_record`.
3. Process the message.
4. Call `mark_xchange_record_read` for handled items.
