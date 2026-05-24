# TellyMCP Release Notes

Public, user-facing release notes for published versions of `@deadragdoll/tellymcp`.

For detailed engineering history, refactors, and internal development notes, see [CHANGELOG.md](CHANGELOG.md).

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
  - [STANDALONE.md](STANDALONE.md)
  - [STANDALONE-ru.md](STANDALONE-ru.md)
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
