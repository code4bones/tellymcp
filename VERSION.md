# TellyMCP Release Notes

Public, user-facing release notes for published versions of `@deadragdoll/tellymcp`.

For detailed engineering history, refactors, and internal development notes, see [CHANGELOG.md](CHANGELOG.md).

## 0.0.46

- Picker Ask/Explain saves the question, selection and optional image as a local
  artifact, then notifies the bound agent through existing terminal input. The
  agent answers in its conversation and returns the same answer to the browser.
- New Mark elements mode in Chrome0.0.11 / Firefox0.0.10: click toggles whole
  containers under a shared UUID. Only selectors and question are sent; the agent
  reads marked DOM live with bounded all-match `browser_dom` requests.
- Picker collapses to a small circle while selecting and uses icon controls in
  its panel and popup. Select again sits at the same upper-right position.
- Telegram Live menu is now Fullscreen | Expand | Default, then Link | Attach,
  then Back. Link sends a private copyable address instead of opening a browser.

Update the gateway and source console for automatic delivery and Marks, restart
the source owner, then reload the extensions. Existing owners keep running their
previous code until restarted. Registry/browser-store publication is separate.

## 0.0.45

### Added

- Several local and remote terminals can attach to one existing shell/agent and
  write simultaneously alongside Live. Each frontend has its own ordered output
  queue; disconnect or slow output affects that frontend only.
- The latest attach or resize, including Live, sets the shared PTY dimensions.
  Differently sized native windows project the same screen without rewrapping;
  smaller windows clip it. Detach leaves the shared size unchanged.
- AI Picker in Chrome0.0.10 / Firefox0.0.9: select an element or region, review
  sanitized DOM and an optional cropped image, then ask the explicitly bound
  agent. MCP tools retrieve selections and return plain-text explanations to the
  tab. No automatic provider invocation or website actions are added.

Concurrent native attach requires updated0.0.45 owners/viewers and an owner
restart. Protocol1 owners remain discoverable and stoppable. The existing
0.0.44 gateway relay supports the terminal transport; Picker MCP tools require
updated0.0.45 gateway and console builds. Browser-store/registry publication is
separate from local builds.

## 0.0.44

### Fixed

- Telegram OAuth token exchange and signing-key retrieval use the configured
  Telegram proxy, allowing the bot's administrator approval to appear on gateways
  with restricted direct egress. Network waits are bounded, and the connector
  authorization-code lifetime starts after approval.
- Missing OAuth administrator guidance points to `/admin` rather than `/auth`.
- SQLite's startup experimental notice is quiet; other warnings remain visible.

### Added

- Linux background sessions with `run --detach`, screen/buffer restoration,
  `sessions`, `attach`, and `stop`. Interactive pickers select sessions, and the
  stop picker refreshes until empty or cancelled.
- Telegram Live has an Attach button beside Open in browser. The owner receives
  a private one-use eight-digit code valid for five minutes for
  `tellymcp attach --code <code> [--gateway <url>]` on another workstation.
- Native local and remote attach share one controller; Live View retains its
  mirrored writable behavior. Detach or connection loss preserves the owner,
  shell and services. Reconnect uses a fresh code without replaying input.

Gateway, session-owner and viewer builds must be updated for remote attach.
Existing owners load the new bridge when restarted; package installation alone
does not replace a running owner's code. Browser extensions keep their own versions.

## 0.0.43

### Fixed

- Normal Unix terminal shutdown no longer prints a `pty fd error ... read EIO` stack trace. Exit status and other PTY error diagnostics are preserved.

## 0.0.42

### Added

- Clients automatically find their shared configuration at `$HOME/.tellymcp/.env`. Explicit `--env`, saved workspace profiles and local `.env` files retain precedence; old markers pointing to `$HOME/.env-client` resolve to the migrated shared profile.
- `tellymcp run --ws 9999` enables the extension WebSocket listener on that port for the current process. Without `--ws`, the env settings apply. The flag can be combined with `-s` and `--env` in any order.
- `tellymcp init client` creates the shared home configuration; an explicit directory still creates a workspace configuration.

## 0.0.41

### Changed

- Client networking uses `TELLYMCP_HTTP_PROXY` and `TELLYMCP_NO_PROXY` for gateway HTTP/WebSocket connections and file uploads. These settings do not replace the standard proxy environment inherited by the shell and agent.
- `tellymcp migrate-env` renames proxy settings in configuration files while preserving explicitly configured values and defaults.

## 0.0.40

### Fixed

- Deployment rollback also runs when a Docker Compose command fails inside the deployment helper function.

## 0.0.39

### Changed

- Gateway releases are built and deployed through GitLab CI on the `telly_savant` shell runner. The gateway, nginx, PostgreSQL, Redis, and RabbitMQ run as a dedicated Docker Compose stack in `/opt/tellymcp`.
- The public gateway address moves to `https://tellymcp.deadragdoll.net/api`. Update client gateway HTTP/WSS URLs and reconnect OAuth integrations using the new domain.

## 0.0.38

### Fixed

- Starting or reconnecting a client after a gateway restart no longer injects a Telegram-task instruction into the console when versions differ. Version warnings remain available in Telegram and local diagnostics.
- Update local clients as well as the gateway to apply this fix: the unwanted console instruction originated in the client handshake handler.

## 0.0.37

### Fixed

- Background console synchronization preserves the selected session, so Live, Browser, Settings, and Storage continue to use the console chosen in the session menu.

## 0.0.36

### Fixed

- The active-session menu groups connections belonging to the same account under one owner button, with all sessions inside. Back returns to that account's session list.

## 0.0.35

### Changed

- Task IDs link directly to the source-provided `display.url` in approval cards and inbox details. Offers without a URL keep a plain-text ID.

## 0.0.34

### Added

- Inbox routes accept separate project name (`route.label`) and slug (`route.slug`) snapshots while preserving the routing key. Project menus show the supplied name, and message cards can show the assigning person through `display.sender`.

## 0.0.33

### Changed

- Inbox message details use native Telegram Rich Markdown for headings, lists, tables, and code while keeping action and Back buttons in the same message.

## 0.0.32

### Fixed

- Inbox Back buttons now return from a message card to its project's messages, and from the message list to the project list.

## 0.0.31

### Fixed

- Opening an inbox project maps it to the selected console automatically.
- Accept reports delivery failures and keeps failed offers available for retry.
- Ownership checks and delivery deduplication protect against stale buttons and repeated Accept actions.

## 0.0.10

### Added

- Telegram UI localization for the bot layer:
  - English and Russian catalogs for user-facing bot screens
  - locale resolution from Telegram profile with persisted user preference
  - `DEBUG_LANGUAGE=en|ru` override for fast testing without changing the Telegram profile

### Changed

- Localization scope is now explicit:
  - Telegram bot UI is localized
  - MCP tools, logs, `TOOLS.md`, and the Live Mini App remain canonical English by design
- Telegram menus, callbacks, project/collaboration screens, startup notices, and operational bot notices now render through a shared translation layer instead of ad hoc inline strings

### Fixed

- Builder startup is more robust:
  - runtime-dependent services now wait for full runtime readiness instead of racing broker registration
  - this avoids `telegram_mcp runtime is not initialized yet` failures during `yarn dev:builder`
- Locale resolution is safe for partial test mocks and startup paths
- Telegram UI text is now consistent across:
  - main menus
  - inbox/session flows
  - project/collab flows
  - live approval prompts
  - terminal and operational bot notices

## 0.0.9

### Added

- Public screenshot docs:
  - full screenshot index in `screenshots/README.md`
  - shorter public gallery in `screenshots/GALLERY.md`
- More explicit Live launch modes from Telegram:
  - `Fullscreen`
  - `Expand`
  - `Default`

### Changed

- README and README-RU now surface screenshot links directly in the top navigation.
- The `Live` Mini App UI is more practical on phones:
  - wrap/unwrap toggle moved into the status bar
  - session name is shown as a compact state badge
  - update timestamp is shorter and less noisy
  - local `Live` screenshots are documented in a clearer flow near the launcher step

### Fixed

- `Live` now reconnects more gracefully after a gateway restart:
  - short `502/503` gaps recover through polling
  - expired in-process WebApp sessions (`401/403`) trigger automatic re-bootstrap
  - reopening the Mini App is no longer required in the normal restart case
- Runtime MCP metadata now reports the actual package version instead of stale hardcoded version data.
- Successful terminal nudges no longer overwrite stale target metadata with non-target values such as `backend:0.0`.
- If the terminal runtime itself is unavailable for a paired session with a saved terminal target, Telegram now receives an operational warning instead of leaving the signal only in backend logs.

## 0.0.8

### Added

- Unified logging model based on `pino`:
  - pretty console output by default
  - optional JSONL file sink for Alloy or other collectors
  - `LOG_FILE_ENABLED=true`
  - `LOG_FILE_PATH=.tellymcp/log.jsonl`
- Better terminal target recovery behavior:
  - when a saved target becomes stale after terminal recreation, TellyMCP now tries to recover the live terminal automatically from stored terminal hints
  - if auto-recovery fails, Telegram sends a clear operational warning instead of leaving the problem only in logs
- Stronger `Share` execution guidance:
  - the current session must do the work itself
  - it must send only the result
  - it must not forward the original task to the target session as a new assignment

### Changed

- Runtime identity and service labels now use `tellymcp` naming consistently instead of older `telegram-human-mcp` tags.
- MCP server metadata now reports the current package version and `tellymcp` service name.
- Logging config is now simpler:
  - one console logging model
  - one optional JSON file sink
  - optional `LogFeed` buffer for UI diagnostics

### Fixed

- Stale terminal target ids no longer require manual user understanding before the service can try to wake the session again.
- Broken terminal nudge targets are now visible to the user in Telegram, not only in backend logs.
- `Share` inbox instructions are now explicit enough to reduce the chance that one agent re-delegates the task back into the collaboration graph.
- `Live` Mini App now survives a normal gateway restart much better:
  - short `502/503` periods recover through polling
  - lost in-process WebApp sessions (`401/403`) trigger automatic re-bootstrap
  - reopening the Mini App is no longer required in the normal restart case

## 0.0.3

### Added

- Standalone CLI workflow:
  - `tellymcp init <client|gateway|both>`
  - `tellymcp run`
  - `tellymcp doctor`
  - `tellymcp mcp --help`
- Standalone and public installation guides:
  - [STANDALONE.md](docs/STANDALONE.md)
  - [STANDALONE-ru.md](docs/STANDALONE-ru.md)
- Browser runtime helper:
  - `tellymcp browser install`
- Public README set for GitHub and npm:
  - [README.md](README.md)
  - [README-ru.md](README-ru.md)
- Human-readable release notes in this file.
- Telegram startup notice:
  - version
  - protocol
  - mode
  - paired sessions
  - MCP/WebApp/Gateway endpoints
- Live text input button:
  - `[txt]`
  - sends literal text to the terminal without pressing `Enter`

### Changed

- Default installation path is now npm-first:
  - `npm install -g @deadragdoll/tellymcp`
- Standalone client mode is documented first, before gateway/both deployment.
- Built-in PTY terminal control is now documented as the default prerequisite for the full experience:
  - Live View
  - nudges
  - direct terminal control from Telegram
- Environment examples were split into dedicated client and gateway variants.
- Package build/publish flow now validates itself before packing/publishing.
- CLI now shows package version directly in banners and startup output.

### Collaboration

- Project collaboration works across local and remote sessions.
- `Collab` now includes:
  - `Broadcast`
  - `History`
  - `Delete`
- `Ask` and `Share` semantics were clarified:
  - `Ask` tells the selected session to do the work and reply back
  - `Share` tells the current session to send something to the selected session

### Live View

- Telegram Mini App Live View supports:
  - fullscreen/expand launch policy
  - bottom toolbar layout
  - `Esc`
  - `Tab`
  - `Ctrl+C`
  - `Backspace`
  - `Up`
  - `Down`
  - `Enter`
- Live approval flow was added for remote project sessions.
- Live toolbar now includes:
  - `/`
  - `↑`
  - `↓`
  - `Enter`
  - `⌫`
  - `[txt]`
  - `Tab`
  - `Esc`
  - `Ctrl+C`
- `Ctrl+C` now asks for confirmation before sending an interrupt to the agent.
- Mobile toolbar layout now wraps cleanly into two rows instead of collapsing into a centered stack.

### Browser

- Browser tools use Playwright Chromium.
- Headless mode is the recommended default for remote and SSH-based environments.
- `doctor` now helps detect missing browser runtime and connectivity issues.

### Compatibility

- Gateway and clients now compare:
  - package version
  - protocol version
  - capabilities
- `TOOLS.md` sync now detects outdated or missing local instructions and asks the session to refresh them.

### Removed

- Legacy Go/HTTP terminal proxy path was removed.
- Direct product path is now the local built-in terminal runtime only.

## Next entry template

Copy this block for the next published version:

```md
## x.y.z

### Added

- ...

### Changed

- ...

### Fixed

- ...

### Removed

- ...
```
