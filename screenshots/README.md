# Screenshots

Public product screenshots for `@deadragdoll/tellymcp`.

They are grouped by the main user flows:

- pairing a session with Telegram
- navigating the session menu
- exporting content and browser screenshots
- cross-session collaboration
- remote `Live` approval and `Live View`

## Pairing

### Agent creates a pairing code

![Agent creates a Telegram pairing code](./pairing_agent_side.png)

The agent collects the current workspace and tmux context, then calls `create_session_pair_code`.

### Telegram confirms the linked session

![Telegram confirms the linked session](./pairing_telegram_side.png)

After `/link <code>`, the bot binds the Telegram user to the session and shows the active session picker.

## Session Menu

### Main session menu

![Main session menu](./session_menu.png)

The main menu exposes the core surfaces:

- `Live`
- `Content`
- `Browser`
- `Local`
- `Collab`
- `Inbox`
- `Storage`
- `Settings`

### Live launcher with launch modes

![Live launcher with launch modes](./menu_livefeed.png)

`Live` opens a compact launcher message with explicit opening modes:

- `Fullscreen`
- `Expand`
- `Default`

### Local Live Mini App

![Local Live Mini App](./livefeed_webapp.png)

After launch, the Telegram Mini App opens the local tmux viewport with compact controls, text input, wrap/unwrap, and `Ctrl+C` confirmation.

## Content And Browser

### Export tmux content as Markdown

![Content export menu](./session_content_menu.png)

The `Content` menu exports the current tmux pane as a Markdown file:

- current visible viewport
- full history
- fixed history windows such as `Last 300` and `Last 1000`

### Downloaded content buffer

![Downloaded visible buffer](./session_content_menu_download_visible_bufer.png)

The exported pane buffer is returned to Telegram as a regular Markdown document.

### Stored browser screenshots

![Stored browser screenshots](./browser_screenshots.png)

The browser menu lists screenshots saved by `browser_*` tools inside `.mcp-xchange`.

### Download or delete a browser screenshot

![Browser screenshot details](./brownser_download_screenshot.png)

A stored screenshot can be returned to Telegram or removed from storage.

## Collaboration

### Collab project list

![Collab project list](./collab_menu.png)

The top-level `Collab` menu shows available projects and collaboration tools.

### Project participants

![Project participants](./collab_project_menu.png)

An opened project shows its participants and lets the user pick a target session.

### Session-pair actions

![Session-pair actions](./collab_partner_menu.png)

For a selected pair of sessions, the UI offers:

- `Ask`
- `Share`
- `Live`

### Ask another agent to produce a result

![Ask flow with screenshot reply](./collab_ask_another_agent_to_make_screenshot.png)

`Ask` routes a task to the selected session and delivers the reply, including attached files such as screenshots.

### Share is executed by the current session

![Share instruction in the current session](./collab_share_api_with_partner.png)

`Share` is not delegated further. The current session prepares the result and sends only the result to the target session.

### Share notice received by the partner

![Share notice received by the partner](./collab_share_notice.png)

The receiving session gets a structured Telegram notice with project, route, summary, and stored note path.

### Partner processes the shared result

![Partner processes the shared result](./collab_partner_got_api_desc_from_agent.png)

The target agent reads the delivered note from its inbox flow and continues locally.

## Live Approval And Remote Live

### Remote Live access request

![Remote Live access request](./collab_livefeed_partner_request.png)

Remote `Live` access requires approval from the target session.

### Approved Live launcher

![Approved Live launcher](./collab_livefeed_partner_request_approved.png)

After approval, the requester receives a fresh launcher with the same opening modes.

### Remote Live over gateway relay

![Remote Live over gateway relay](./remote_collab_partner_livefeed.png)

`Live` also works for remote sessions through the gateway relay path, including inbox-driven collaboration follow-ups.
