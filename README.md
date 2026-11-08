<div align="center">

# TellyMCP

**Control your coding-agent consoles from Telegram and share browser context through MCP.**

[English](./README.md) · [Русский](./README-ru.md) · [Deployment](./docs/STANDALONE.md) · [Release notes](./VERSION.md)

[![npm version](https://img.shields.io/npm/v/@deadragdoll/tellymcp.svg)](https://www.npmjs.com/package/@deadragdoll/tellymcp)
[![Node.js](https://img.shields.io/badge/node-%3E%3D24-339933.svg)](https://nodejs.org/)
[![license](https://img.shields.io/npm/l/@deadragdoll/tellymcp.svg)](./LICENSE)
[![gateway-first](https://img.shields.io/badge/runtime-gateway--first-1f6feb.svg)](#current-runtime-model)

</div>

TellyMCP connects a Telegram bot to the terminals where your agents already work.
Open a live console, send a question, attach another terminal, or select browser
content and ask the agent about it. Agents can also exchange tasks and files
through MCP, with artifacts saved in the owning workspace.

Current source versions: **TellyMCP 0.0.55**, **Chrome extension 0.0.15**,
**Firefox extension 0.0.15**. The npm badge shows the published package version;
to use the current checkout, see [Build from source](#build-from-source).

## What you can do

- **Work from Telegram:** choose a connected console with `/menu`, send messages
  and files, and return answers or screenshots to the same chat.
- **View and use a live terminal:** open the Mini App or copy a browser link.
  Attach another native terminal with a short-lived, single-use code.
- **Share browser context:** select an element, mark several containers, or
  capture a screen region with the Chrome and Firefox extensions.
- **Keep sessions running:** detach and reattach to Linux console owners without
  starting a new shell or agent.
- **Connect MCP agents:** route work between live consoles and return notes,
  images and real files.
- **Automate and record browsers:** use Playwright Chromium or an attached
  browser, inspect DOM, inject helper scripts, and save recording artifacts.
- **Use chat clients:** expose the gateway's MCP endpoint through the optional
  OAuth connector for ChatGPT and Claude.

## Current runtime model

```text
Telegram bot / Mini App       MCP client
           |                     |
           +--------+------------+
                    |
                 Gateway
                    |
          +---------+---------+
          |                   |
    Agent console A     Agent console B
    shell + agent       shell + agent
    browser bridge      browser bridge
    local artifacts     local artifacts
```

One gateway owns the Telegram bot, web app, live console registry and shared
project state. Each client console owns its shell, agent process, browser
connection and local artifacts.

| Component         | Runs on                          | Needs                                              |
| ----------------- | -------------------------------- | -------------------------------------------------- |
| Gateway           | Your server                      | Telegram bot, PostgreSQL, Redis; optional RabbitMQ |
| Console owner     | Each agent machine               | Node.js and the local terminal runtime             |
| Browser extension | Your existing Chrome or Firefox  | Connection to the console's local browser bridge   |
| MCP client        | Your coding agent or chat client | Access to the configured MCP endpoint              |

The bot lists live consoles directly. A console's canonical address is
`client_uuid:local_session_id`; use the value returned by
`list_gateway_sessions` when routing MCP calls.

## Install

Requirements: **Node.js 24 or newer**. On Debian/Ubuntu, install the native PTY
build prerequisites and keep npm lifecycle scripts enabled:

```bash
sudo apt install -y python3 make g++
npm config set ignore-scripts false
npm install -g @deadragdoll/tellymcp --foreground-scripts
```

The terminal runtime uses `node-pty`, which may need to compile its native addon.
If an earlier install left `pty.node` missing, reinstall with lifecycle scripts
enabled. Use `tellymcp doctor --env <file>` to check the setup.

For Playwright browser automation, also run:

```bash
tellymcp browser install
```

Attached Chrome/Firefox tabs use the extension bridge and do not require a
separate Playwright browser installation.

## Quick start

### 1. Configure the gateway

Start Redis and PostgreSQL, then create a gateway workspace:

```bash
mkdir -p ~/telly-gateway
cd ~/telly-gateway
tellymcp configure
```

The command opens a token-protected local setup page. Choose **Gateway**, enter
your bot and infrastructure settings, and validate the connections. Enter the
public URL once; the wizard derives the HTTP, WebSocket, Mini App and webhook
addresses.

Save the downloaded `.env-gateway` in this workspace, then run:

```bash
chmod 600 .env-gateway
tellymcp run --env .env-gateway
```

For a manual template, use `tellymcp init gateway` or
[.env.example.gateway](./.env.example.gateway). The full settings contract is in
[Environment configuration](./docs/ENVIRONMENT.md).

Configure HTTPS for public Mini App, browser Live and webhook access. Reverse
proxy examples are in [the deployment guide](./docs/STANDALONE.md) and
[the Nginx configuration](./docs/tellymcp.gw.conf).

### 2. Start an agent console

On an agent machine:

```bash
mkdir -p ~/agent-a
cd ~/agent-a
tellymcp configure
```

Choose **Client**, enter the gateway connection settings, and save the downloaded
`.env-client` in the workspace. Gateway and client must share
`GATEWAY_AUTH_TOKEN`. `GATEWAY_SCOPE_TOKEN` is an optional data-scope key;
`GATEWAY_USER_UUID` optionally binds the console to a Telegram owner.

```bash
chmod 600 .env-client
tellymcp run --env .env-client --ws 9999 -s "My console"
```

This starts the console and enables the browser-extension listener on port 9999.
The `--ws` flag applies to this launch; it does not rewrite the env file. Without
it, the browser-attach env settings apply.

The workspace marker, `.mcpsession.json`, stores the console identity, label,
profile path and stable gateway client UUID. Later launches can use:

```bash
tellymcp run
```

Clients keep local state and do not need Redis. The shared client profile is
`$HOME/.tellymcp/.env`; `tellymcp init client` creates it. Profile discovery uses
explicit `--env`, then the saved workspace profile, a workspace `.env`, and the
shared profile. See [.env.example.client](./.env.example.client).

### 3. Open the console in Telegram

Open the gateway bot. If a scope token is configured, authorize with
`/auth <GATEWAY_SCOPE_TOKEN>`, then use `/menu` to select the live console.

The selected console receives your messages. Its agent can read structured
xchange records and return text, files or screenshots through the MCP tools.

### Start a managed coding agent

Provider adapters are included for Codex and Claude Code. The corresponding
vendor CLI belongs on the agent machine; the gateway does not need it.

```bash
tellymcp provider list
tellymcp provider status codex
tellymcp provider status claude
tellymcp provider install codex
tellymcp run --env .env-client --agent codex
```

Start the provider locally, then select its running console in Telegram.
Ordinary messages, file captions and file uploads go to that console's terminal
input. There is no separate Agent menu or Telegram delivery-mode selector.
Successful delivery adds a 👍 reaction to your message; errors appear in the chat.
Service commands and replies to explicit confirmation requests keep their own
handlers. TellyMCP prevents a second managed agent from starting in a console
while the first is running.

Keep the TellyMCP MCP connection configured in the agent. Telegram input reaches
the same console TUI used locally, including managed Codex and Claude sessions.
The bundled workflow plugin helps agents follow the reply and artifact delivery
paths:

```bash
tellymcp codex-plugin install
tellymcp codex-plugin status
```

## Live view and terminal attachment

The console's **Live** menu offers:

```text
Fullscreen | Expand | Default
Link       | Attach
           Back
```

- **Fullscreen / Expand / Default** open the terminal Mini App in Telegram.
- **Link** sends a copyable, temporary browser URL to your private chat.
- **Attach** creates a single-use terminal attachment code, valid for five
  minutes.
- **Back** returns to the selected console's menu.

Browser Live keeps the statusbar and hides Telegram-specific toolbar controls.
Browser links use their launch token; Telegram Mini Apps load their bundled
Telegram SDK from the gateway.

To attach a terminal from another workstation, use the command sent by the bot:

```bash
tellymcp attach --code 12345678
tellymcp attach --code 12345678 --gateway https://example.com/api/gateway
```

The code grants access to that session without copying the owner's workspace
marker. Local terminals, remote terminals and Live can share the same PTY.
The latest attachment or resize sets the shared terminal dimensions.

With terminal prompt scanning enabled, numbered terminal choices can appear as
Telegram buttons for digits, Enter and Esc. Configure the
`TERMINAL_PROMPT_SCAN_*` settings in the client profile; see
[Environment configuration](./docs/ENVIRONMENT.md).

### Local sessions on Linux

```bash
tellymcp run --detach
tellymcp sessions
tellymcp sessions --json
tellymcp attach
tellymcp stop
```

Without a handle, `attach` opens a session picker; `stop` opens a repeating
picker. Both accept an explicit session handle. Press **Ctrl+]**, then **d** to
detach from a terminal while leaving its console owner running.

Installing a new package does not replace an existing owner process. Restart
that owner when ready to load updated runtime code.

## Browser extensions and AI Picker

Export the extensions bundled with the installed package:

```bash
tellymcp extension chrome
tellymcp extension firefox
```

The commands create `./tellymcp-chrome-attach` and
`./tellymcp-firefox-attach` directories.

- **Chrome:** open `chrome://extensions`, enable Developer mode and choose
  **Load unpacked**.
- **Firefox development:** open `about:debugging#/runtime/this-firefox`, choose
  **Load Temporary Add-on**, and select the exported `manifest.json`.
- **Firefox regular installation:** use a Mozilla-signed XPI; the source signing
  command is documented [below](#package-the-extensions).

Connect the extension to your console's browser bridge in **Control Panel**.
Open the Picker from the extension popup or with **Alt+Shift+P**.

### Choose what to send

| Mode              | Gesture                                        | What the agent receives                                                |
| ----------------- | ---------------------------------------------- | ---------------------------------------------------------------------- |
| **Element**       | Ctrl+click; Alt+↑/↓ navigates parents/children | A sanitized DOM/text snapshot saved at selection time                  |
| **Mark elements** | Ctrl+click toggles a mark; Enter opens review  | Group selectors and your question; the agent reads the marked DOM live |
| **Region**        | Drag a rectangle                               | The cropped screenshot when Snapshot is enabled; no DOM collection     |

Ordinary clicks and typing work on the page, so you can open a popup before
selecting it. In Marks, Ctrl+click inside an already marked container removes the
whole container's mark. Selecting a parent coalesces its marked descendants.

Element and Region capture a local image at selection time. **Snapshot** toggles
whether that saved image is previewed and included in the request; it is
**off by default**. Re-enabling it uses the same image after the original popup
has closed. Screenshots are captured without masking.

**Region is screenshot-only. Enable Snapshot to send the region's contents.**
Without it, a Region request contains your question and page/rectangle metadata.
Marks sends selectors only and has no Snapshot control.

### Ask the agent

Type your question, then use the single Send button:

| Action        | Answer destination                         |
| ------------- | ------------------------------------------ |
| **Send**      | The agent's console conversation           |
| **Ctrl+Send** | The console conversation and the extension |

Send turns green on hover while Ctrl is held. The source tab attaches
automatically before delivery, so a separate manual tab attachment is unnecessary.

The console saves the question and selected context under
`.mcp-xchange/{date}/picker/{id}/`, including an optional `selection.png`, then
notifies the agent in its existing conversation. An Element request uses the
saved DOM snapshot even if the original node later changes or disappears.
A Marks request uses `browser_dom(all=true)` against the original marked tab.

Browser replies use the exact request and selection IDs from the artifact.
Selection state expires after five minutes; saved artifacts remain available.
Esc or **Forget / close** clears the live selection.

The current Send/Ctrl+Send behavior needs a **0.0.51 or newer console owner** and
the current extension. After updating, restart the owner and reload the extension
and target page. See [Picker implementation and limits](./docs/AI_PICKER_EXTENSION.md#13-карта-реализации-mvp-2026-11-08).

### Automation and recording

Browser tools can use Playwright Chromium or a selected attached tab. They cover
navigation, clicks, form input, DOM inspection, screenshots, helper-script
injection and structured browser recording.

Recordings are saved as `.mcp-xchange/web/...` bundles with HTML, network and
console artifacts. Screenshots can be returned to the human with
`browser_screenshot(send_to_telegram=true)`, to another console with
`send_partner_file`, or to a connected MCP client with `get_file`.

## MCP usage and collaboration

For the gateway-first setup, point your MCP client at the gateway's MCP route,
for example:

```text
https://example.com/api/mcp
```

Print a configuration snippet with:

```bash
tellymcp mcp --url https://example.com/api/mcp
```

The helper prints configuration for you to copy into the MCP client.
Authentication uses `MCP_HTTP_BEARER_TOKEN`, when configured, or the
[OAuth connector](./docs/CHAT_CONNECTOR.md). Interactive `tellymcp run` does not
open a local MCP HTTP listener; the local `127.0.0.1:8787/mcp` endpoint belongs
to separately configured standalone/development runtimes.

Useful tools:

| Purpose                              | Tools                                                                            |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| Find a console and check routing     | `list_gateway_sessions`, `get_runtime_diagnostics`                               |
| Read incoming work                   | `list_xchange_records`, `get_xchange_record`, `mark_xchange_record_read`         |
| Reply to a Telegram user             | `notify_telegram`, `browser_screenshot`                                          |
| Exchange work between agents         | `send_partner_note`, `send_partner_file`                                         |
| Read browser context                 | `browser_dom`, `inspector_get_selection`                                         |
| Control Picker requests              | `inspector_start`, `inspector_highlight`, `inspector_response`, `inspector_stop` |
| Retrieve saved files                 | `get_file_list`, `get_file`                                                      |
| Refresh the workspace tool reference | `refresh_tools_markdown`                                                         |

Agent-to-agent work arrives as structured `partner_note` records. Read the
request, do the work in the target console, return the note or file, then mark
the record read after the required reply succeeds. Picker artifacts specify
whether a browser reply is requested; console-only requests finish after the
answer is written in the agent conversation.

Queued project deliveries in0.0.52 use atomic enqueue, leased claims and
persistent recipient bookkeeping. For a retryable project request, reuse the
same optional `request_id` with `send_partner_note` or `send_partner_file`;
changed content with the same key is rejected. This key applies to the queued
project route; direct live routes reject it. Upgrade both gateway and owners to
load the delivery fixes.

## Webhook mode

The gateway supports polling and webhooks. To use a webhook behind a reverse
proxy with `ROOT_PREFIX=/api`:

```env
TELEGRAM_WEBHOOK_ENABLED=true
TELEGRAM_WEBHOOK_PATH=/telegram/webhook
TELEGRAM_WEBHOOK_PUBLIC_URL=https://example.com/api/telegram/webhook
TELEGRAM_WEBHOOK_SECRET=replace_with_a_private_webhook_secret
```

The gateway registers the webhook on startup and checks the
`x-telegram-bot-api-secret-token` header on incoming updates. Polling is used
when webhook mode is disabled. See [Environment configuration](./docs/ENVIRONMENT.md)
for proxy and transport settings.

## Build from source

The checkout can be ahead of the npm release:

```bash
git clone https://github.com/code4bones/tellymcp.git
cd tellymcp
yarn install --frozen-lockfile
npm pack
npm install -g ./deadragdoll-tellymcp-0.0.55.tgz
```

Use the archive filename printed by `npm pack` for your checkout's version.
The pack lifecycle builds the runtime and both unpacked extension bundles.

Development checks:

```bash
yarn build
yarn build:extensions
yarn lint
yarn test
```

### Package the extensions

From the repository root, build a Chrome ZIP and optionally a CRX:

```bash
node packages/chrome-attach-extension/scripts/zip.mjs
node packages/chrome-attach-extension/scripts/pack.mjs
```

Outputs go to `packages/chrome-attach-extension/webstore-artifacts/` and
`packages/chrome-attach-extension/crx-artifacts/`. CRX packaging uses
`CHROME_BINARY` or `chromium-gost` and reuses `key.pem` to preserve its signing
identity. On the first CRX build, the script creates that local key.

For Firefox, configure `AMO_API_KEY` and `AMO_API_SECRET` in
`packages/firefox-attach-extension/.env`, then run:

```bash
node --env-file=packages/firefox-attach-extension/.env packages/firefox-attach-extension/scripts/sign.mjs
```

The script rebuilds the extension, submits it to Mozilla on the **unlisted**
channel and downloads the signed XPI into
`packages/firefox-attach-extension/web-ext-artifacts/` after approval.

Each extension has its own version. `yarn release:extensions` synchronizes their
versions before packaging/signing; use the separate scripts above when retaining
different Chrome and Firefox versions. Package outputs, signing keys and signing
credentials are local files, excluded from Git.

## Operations and documentation

Check a runtime or migrate an older profile:

```bash
tellymcp doctor --env .env-client
tellymcp migrate-env ./old.env > ./new.env
```

Use `.env-gateway` for gateway diagnostics. See `tellymcp help` for all commands.

| Guide                                                                   | Contents                                               |
| ----------------------------------------------------------------------- | ------------------------------------------------------ |
| [Deployment](./docs/STANDALONE.md) · [Русский](./docs/STANDALONE-ru.md) | Gateway, infrastructure and agent setup                |
| [Environment configuration](./docs/ENVIRONMENT.md)                      | Role-specific settings, auth, profiles and proxies     |
| [Chat connector](./docs/CHAT_CONNECTOR.md)                              | MCP OAuth setup                                        |
| [AI Picker](./docs/AI_PICKER_EXTENSION.md)                              | Selection payloads, delivery and implementation limits |
| [Tool reference](./TOOLS.md)                                            | MCP tool catalog                                       |
| [Development](./docs/DEVELOPMENT.md)                                    | Runtime architecture and development notes             |
| [Release notes](./VERSION.md) · [Changelog](./CHANGELOG.md)             | User-facing changes and engineering history            |
| [Русский README](./README-ru.md)                                        | Russian-language overview                              |

## License

[MIT](./LICENSE).
