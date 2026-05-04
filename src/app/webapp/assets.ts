type RenderWebAppHtmlInput = {
  basePath: string;
};

export const WEBAPP_STYLES_CSS = `
:root {
  color-scheme: dark;
  --bg: #0f1115;
  --panel: rgba(18, 22, 30, 0.82);
  --panel-2: #202431;
  --text: #edf1f7;
  --muted: #98a2b3;
  --accent: #57c1ff;
  --danger: #ff7474;
  --border: #2b3242;
  --shadow: rgba(0, 0, 0, 0.28);
  font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
}

* { box-sizing: border-box; }

html, body {
  margin: 0;
  min-height: 100%;
  background: linear-gradient(180deg, #121620 0%, #0d1017 100%);
  color: var(--text);
}

body {
  padding: 0;
}

.app {
  min-height: 100vh;
}

.toolbar {
  position: fixed;
  top: 12px;
  right: 12px;
  z-index: 30;
  display: flex;
  gap: 8px;
  padding: 8px;
  border: 1px solid var(--border);
  border-radius: 14px;
  background: var(--panel);
  box-shadow: 0 18px 40px var(--shadow);
  backdrop-filter: blur(14px);
}

.btn {
  appearance: none;
  border: 1px solid var(--border);
  background: var(--panel-2);
  color: var(--text);
  border-radius: 12px;
  padding: 10px 14px;
  font: inherit;
  cursor: pointer;
}

.btn.compact {
  min-width: 46px;
  padding: 9px 12px;
  text-align: center;
}

.btn:hover { border-color: var(--accent); }
.btn:disabled { cursor: not-allowed; opacity: 0.55; }
.btn.danger:hover { border-color: var(--danger); }

.statusbar {
  position: fixed;
  left: 0;
  right: 0;
  bottom: 0;
  z-index: 25;
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  justify-content: space-between;
  gap: 8px 16px;
  padding: 10px 14px calc(10px + env(safe-area-inset-bottom, 0px));
  color: var(--muted);
  font-size: 13px;
  background: rgba(14, 17, 24, 0.94);
  border-top: 1px solid var(--border);
  backdrop-filter: blur(16px);
}

.status-left,
.status-right {
  display: flex;
  flex-wrap: wrap;
  align-items: center;
  gap: 8px 16px;
}

.session-label {
  color: var(--text);
  font-weight: 600;
}

.terminal {
  margin: 0;
  padding: 18px 14px calc(66px + env(safe-area-inset-bottom, 0px)) 14px;
  min-height: 100vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.error {
  color: var(--danger);
}

@media (max-width: 680px) {
  .toolbar {
    top: auto;
    right: 10px;
    bottom: calc(54px + env(safe-area-inset-bottom, 0px));
    gap: 6px;
    padding: 7px;
  }

  .btn.compact {
    min-width: 42px;
    padding: 8px 10px;
  }

  .statusbar {
    font-size: 12px;
  }

  .terminal {
    padding: 14px 12px calc(112px + env(safe-area-inset-bottom, 0px)) 12px;
  }
}
`;

export const WEBAPP_APP_JS = `
const tg = window.Telegram?.WebApp;
const config = window.__TELEGRAM_MCP_WEBAPP__;

const state = {
  token: null,
  sessionId: null,
  timer: null,
  actionBusy: false,
  pollIntervalMs: 2000,
};

const elements = {
  session: document.querySelector("[data-role=session]"),
  status: document.querySelector("[data-role=status]"),
  updated: document.querySelector("[data-role=updated]"),
  refresh: document.querySelector("[data-role=refresh]"),
  slash: document.querySelector("[data-role=slash]"),
  up: document.querySelector("[data-role=up]"),
  down: document.querySelector("[data-role=down]"),
  enter: document.querySelector("[data-role=enter]"),
  terminal: document.querySelector("[data-role=terminal]"),
};

function setStatus(text, isError = false) {
  elements.status.textContent = text;
  elements.status.classList.toggle("error", isError);
}

function setUpdated(text) {
  elements.updated.textContent = text;
}

function trimTrailingSlashes(value) {
  let current = value;
  while (current.endsWith("/") && current.length > 1) {
    current = current.slice(0, -1);
  }
  return current;
}

function getRequestedSessionId() {
  const url = new URL(window.location.href);
  const fromQuery = url.searchParams.get("session");
  if (fromQuery) {
    return fromQuery;
  }

  const fromHash = new URLSearchParams(url.hash.replace(/^#/, "")).get("session");
  if (fromHash) {
    return fromHash;
  }

  const pathname = trimTrailingSlashes(url.pathname);
  const basePath = trimTrailingSlashes(config.basePath);
  if (pathname.startsWith(basePath + "/live/")) {
    const suffix = pathname.slice((basePath + "/live/").length).trim();
    if (suffix) {
      return decodeURIComponent(suffix);
    }
  }

  return null;
}

function getInitData() {
  return tg?.initData || "";
}

function getInitDataUnsafe() {
  return tg?.initDataUnsafe || null;
}

async function bootstrap() {
  const sessionId = getRequestedSessionId();
  const initData = getInitData();
  const initDataUnsafe = getInitDataUnsafe();

  if (!initDataUnsafe || !initData || !initData.includes("hash=")) {
    throw new Error("Open this page inside Telegram Mini App.");
  }

  const payload = { initDataRaw: initData, initDataUnsafe };
  if (sessionId) {
    payload.sessionId = sessionId;
  }

  const response = await fetch(config.basePath + "/api/bootstrap", {
    method: "POST",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "WebApp bootstrap failed.");
  }

  return response.json();
}

async function fetchVisibleBuffer() {
  const response = await fetch(config.basePath + "/api/view", {
    method: "GET",
    headers: {
      authorization: "Bearer " + state.token,
    },
  });

  if (!response.ok) {
    const text = await response.text();
    throw new Error(text || "Failed to fetch visible buffer.");
  }

  return response.json();
}

async function sendAction(action) {
  if (state.actionBusy || !state.token) {
    return;
  }

  state.actionBusy = true;
  try {
    const response = await fetch(config.basePath + "/api/action", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer " + state.token,
      },
      body: JSON.stringify({ action }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Failed to send action.");
    }

    await refreshVisibleBuffer();
  } finally {
    state.actionBusy = false;
  }
}

async function refreshVisibleBuffer() {
  const payload = await fetchVisibleBuffer();
  elements.terminal.textContent = payload.content || "";
  setUpdated("Updated: " + payload.captured_at);
}

function stopPolling() {
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
}

function startPolling() {
  stopPolling();
  state.timer = setTimeout(async () => {
    try {
      await refreshVisibleBuffer();
    } catch (error) {
      setStatus(error.message || String(error), true);
    } finally {
      startPolling();
    }
  }, state.pollIntervalMs);
}

function bindUi() {
  elements.refresh.addEventListener("click", () => {
    refreshVisibleBuffer().catch((error) => {
      setStatus(error.message || String(error), true);
    });
  });

  elements.slash.addEventListener("click", () => {
    sendAction("slash").catch((error) => setStatus(error.message || String(error), true));
  });

  elements.up.addEventListener("click", () => {
    sendAction("up").catch((error) => setStatus(error.message || String(error), true));
  });

  elements.down.addEventListener("click", () => {
    sendAction("down").catch((error) => setStatus(error.message || String(error), true));
  });

  elements.enter.addEventListener("click", () => {
    sendAction("enter").catch((error) => setStatus(error.message || String(error), true));
  });
}

async function main() {
  try {
    tg?.ready();
    tg?.expand();
    bindUi();
    setStatus("Authorizing Mini App...");
    const bootstrapPayload = await bootstrap();
    state.token = bootstrapPayload.token;
    state.sessionId = bootstrapPayload.session_id;
    state.pollIntervalMs = bootstrapPayload.poll_interval_ms || state.pollIntervalMs;
    elements.session.textContent =
      bootstrapPayload.session_label || bootstrapPayload.session_id;

    if (!bootstrapPayload.tmux_target) {
      elements.slash.disabled = true;
      elements.up.disabled = true;
      elements.down.disabled = true;
      elements.enter.disabled = true;
      setStatus("No tmux target", true);
    }

    await refreshVisibleBuffer();
    if (bootstrapPayload.tmux_target) {
      setStatus("Connected");
    }
    startPolling();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    setStatus(message, true);
    elements.terminal.textContent = message;
  }
}

main();
`;

export function renderWebAppHtml(input: RenderWebAppHtmlInput): string {
  return `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta
      name="viewport"
      content="width=device-width, initial-scale=1, maximum-scale=1, viewport-fit=cover"
    />
    <title>Telegram MCP Live View</title>
    <script src="https://telegram.org/js/telegram-web-app.js"></script>
    <link rel="stylesheet" href="${input.basePath}/styles.css" />
  </head>
  <body>
    <div class="app">
      <div class="toolbar">
        <button class="btn compact" data-role="refresh" type="button">⟳</button>
        <button class="btn compact" data-role="slash" type="button">/</button>
        <button class="btn compact" data-role="up" type="button">↑</button>
        <button class="btn compact" data-role="down" type="button">↓</button>
        <button class="btn compact" data-role="enter" type="button">↵</button>
      </div>
      <pre class="terminal" data-role="terminal">Waiting for tmux buffer…</pre>
      <div class="statusbar">
        <div class="status-left">
          <span class="session-label" data-role="session">Live View</span>
          <span data-role="status">Loading…</span>
        </div>
        <div class="status-right">
          <span data-role="updated">Updated: never</span>
        </div>
      </div>
    </div>
    <script>
      window.__TELEGRAM_MCP_WEBAPP__ = ${JSON.stringify({
        basePath: input.basePath,
      })};
    </script>
    <script>
      (() => {
        const source = ${JSON.stringify(WEBAPP_APP_JS)};
        (0, eval)(source);
      })();
    </script>
  </body>
</html>`;
}
