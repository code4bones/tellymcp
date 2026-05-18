# TellyMCP Gallery

A compact, public-facing gallery for GitHub, npm, and release posts.

## Pair A Real Agent Session

![Agent creates a Telegram pairing code](./pairing_agent_side.png)

Pairing starts from the agent side: the session creates a short-lived Telegram code using the current workspace and tmux context.

![Telegram confirms the linked session](./pairing_telegram_side.png)

The bot links the session and turns it into a mobile-reachable control surface.

## Control A Session From Telegram

![Main session menu](./session_menu.png)

Each paired session gets a structured Telegram menu with `Live`, `Content`, `Browser`, `Inbox`, `Storage`, and `Collab`.

![Live Mini App](./livefeed_webapp.png)

`Live` opens a Telegram Mini App over tmux: viewport, text input, wrap/unwrap, and safe control actions.

## Export Real Work Artifacts

![Downloaded visible buffer](./session_content_menu_download_visible_bufer.png)

Pane history can be exported as Markdown and sent back to Telegram as a real file.

![Browser screenshot details](./brownser_download_screenshot.png)

Browser screenshots are stored in `.mcp-xchange` and can be downloaded or cleaned up from Telegram.

## Collaborate Across Sessions

![Session-pair actions](./collab_partner_menu.png)

Inside a project, each session pair can `Ask`, `Share`, or request `Live`.

![Ask flow with screenshot reply](./collab_ask_another_agent_to_make_screenshot.png)

`Ask` routes work to another session and returns the result, including screenshots and files.

![Share notice received by the partner](./collab_share_notice.png)

`Share` delivers structured updates and artifacts through the receiving session inbox, not as raw chat noise.

## Remote Live Needs Approval

![Remote Live access request](./collab_livefeed_partner_request.png)

Remote `Live` access requires explicit approval from the target session.

![Approved Live launcher](./collab_livefeed_partner_request_approved.png)

After approval, the requester gets a fresh `Live` launcher with explicit opening modes.

## Cross-Machine Live Relay

![Remote Live over gateway relay](./remote_collab_partner_livefeed.png)

TellyMCP can relay `Live` and collaboration flows through a gateway, across bots and across machines.
