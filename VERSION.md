# TellyMCP Release Notes

Public, user-facing release notes for published versions of `@deadragdoll/tellymcp`.

For detailed engineering history, refactors, and internal development notes, see [CHANGELOG.md](CHANGELOG.md).

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
  - sends literal text to tmux without pressing `Enter`

### Changed
- Default installation path is now npm-first:
  - `npm install -g @deadragdoll/tellymcp`
- Standalone client mode is documented first, before gateway/both deployment.
- `tmux` is now documented as a strongly recommended prerequisite for the full experience:
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
- Legacy Go/HTTP tmux proxy path was removed.
- Direct product path is now local `tmux` only.

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
