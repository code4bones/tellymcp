type RenderWebAppHtmlInput = {
  basePath: string;
  launchMode: "default" | "expand" | "fullscreen";
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
  --success: #4cd964;
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
  left: 0;
  right: 0;
  bottom: calc(42px + env(safe-area-inset-bottom, 0px));
  z-index: 30;
  display: flex;
  justify-content: flex-start;
  flex-wrap: wrap;
  gap: 8px;
  padding: 10px 14px;
  border-top: 1px solid var(--border);
  background: rgba(16, 20, 28, 0.68);
  box-shadow: 0 -18px 40px var(--shadow);
  backdrop-filter: blur(14px);
}

.toolbar-spacer {
  flex: 1 1 auto;
  min-width: 12px;
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

.btn.danger {
  border-color: rgba(255, 116, 116, 0.55);
  background: linear-gradient(180deg, rgba(78, 18, 24, 0.96) 0%, rgba(50, 14, 18, 0.98) 100%);
  color: #ffd7d7;
  box-shadow: inset 0 0 0 1px rgba(255, 116, 116, 0.12);
}

.btn.danger:hover {
  border-color: rgba(255, 116, 116, 0.9);
}

.btn.primary {
  border-color: rgba(87, 193, 255, 0.45);
  background: linear-gradient(180deg, rgba(17, 45, 66, 0.96) 0%, rgba(12, 33, 48, 0.98) 100%);
  color: #d9f3ff;
  box-shadow: inset 0 0 0 1px rgba(87, 193, 255, 0.1);
}

.btn.primary:hover {
  border-color: rgba(87, 193, 255, 0.8);
}

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

.ok {
  color: var(--success);
}

.terminal {
  margin: 0;
  padding: 18px 14px calc(122px + env(safe-area-inset-bottom, 0px)) 14px;
  min-height: 100vh;
  overflow: auto;
  white-space: pre-wrap;
  word-break: break-word;
  font: 13px/1.45 ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
}

.ansi-bold {
  font-weight: 700;
}

.ansi-underline {
  text-decoration: underline;
}

.error {
  color: var(--danger);
}

@media (max-width: 680px) {
  .toolbar {
    bottom: calc(46px + env(safe-area-inset-bottom, 0px));
    gap: 6px;
    padding: 8px 10px;
  }

  .toolbar-spacer {
    flex: 1 1 auto;
    min-width: 12px;
  }

  .btn.compact {
    min-width: 42px;
    padding: 8px 10px;
  }

  .statusbar {
    font-size: 12px;
  }

  .terminal {
    padding: 14px 12px calc(146px + env(safe-area-inset-bottom, 0px)) 12px;
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
  interrupt: document.querySelector("[data-role=interrupt]"),
  type: document.querySelector("[data-role=type]"),
  esc: document.querySelector("[data-role=escape]"),
  tab: document.querySelector("[data-role=tab]"),
  slash: document.querySelector("[data-role=slash]"),
  del: document.querySelector("[data-role=delete]"),
  up: document.querySelector("[data-role=up]"),
  down: document.querySelector("[data-role=down]"),
  enter: document.querySelector("[data-role=enter]"),
  terminal: document.querySelector("[data-role=terminal]"),
};

function setStatus(text, isError = false) {
  const sessionName = elements.session.textContent || "Live View";
  elements.status.textContent = text + " - " + sessionName;
  elements.status.classList.toggle("error", isError);
  elements.status.classList.toggle("ok", !isError);
}

function setUpdated(text) {
  elements.updated.textContent = text;
}

function formatCapturedAt(value) {
  if (!value) {
    return "never";
  }

  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return value;
  }

  return new Intl.DateTimeFormat(undefined, {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  }).format(date);
}

function escapeHtml(text) {
  return text
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

function xtermColor(index) {
  const base = [
    "#000000",
    "#800000",
    "#008000",
    "#808000",
    "#000080",
    "#800080",
    "#008080",
    "#c0c0c0",
    "#808080",
    "#ff0000",
    "#00ff00",
    "#ffff00",
    "#0000ff",
    "#ff00ff",
    "#00ffff",
    "#ffffff",
  ];

  if (index < 16) {
    return base[index];
  }

  if (index >= 16 && index <= 231) {
    const value = index - 16;
    const r = Math.floor(value / 36);
    const g = Math.floor((value % 36) / 6);
    const b = value % 6;
    const steps = [0, 95, 135, 175, 215, 255];
    return "rgb(" + steps[r] + "," + steps[g] + "," + steps[b] + ")";
  }

  if (index >= 232 && index <= 255) {
    const gray = 8 + (index - 232) * 10;
    return "rgb(" + gray + "," + gray + "," + gray + ")";
  }

  return null;
}

function sgrColor(code, bright) {
  const palette = bright
    ? ["#808080", "#ff6b6b", "#51cf66", "#ffd43b", "#4dabf7", "#da77f2", "#22b8cf", "#ffffff"]
    : ["#000000", "#c92a2a", "#2b8a3e", "#e67700", "#1864ab", "#862e9c", "#0b7285", "#ced4da"];
  const index = code % 10;
  return palette[index] || null;
}

function defaultAnsiState() {
  return {
    fg: null,
    bg: null,
    bold: false,
    underline: false,
    inverse: false,
  };
}

function cloneAnsiState(state) {
  return {
    fg: state.fg,
    bg: state.bg,
    bold: state.bold,
    underline: state.underline,
    inverse: state.inverse,
  };
}

function applySgrCodes(state, codes) {
  const next = cloneAnsiState(state);
  const queue = codes.length ? codes.slice() : [0];

  while (queue.length > 0) {
    const code = queue.shift();

    if (code === 0) {
      next.fg = null;
      next.bg = null;
      next.bold = false;
      next.underline = false;
      next.inverse = false;
      continue;
    }

    if (code === 1) {
      next.bold = true;
      continue;
    }

    if (code === 22) {
      next.bold = false;
      continue;
    }

    if (code === 4) {
      next.underline = true;
      continue;
    }

    if (code === 24) {
      next.underline = false;
      continue;
    }

    if (code === 7) {
      next.inverse = true;
      continue;
    }

    if (code === 27) {
      next.inverse = false;
      continue;
    }

    if (code === 39) {
      next.fg = null;
      continue;
    }

    if (code === 49) {
      next.bg = null;
      continue;
    }

    if (code >= 30 && code <= 37) {
      next.fg = sgrColor(code, false);
      continue;
    }

    if (code >= 90 && code <= 97) {
      next.fg = sgrColor(code, true);
      continue;
    }

    if (code >= 40 && code <= 47) {
      next.bg = sgrColor(code, false);
      continue;
    }

    if (code >= 100 && code <= 107) {
      next.bg = sgrColor(code, true);
      continue;
    }

    if (code === 38 || code === 48) {
      const mode = queue.shift();
      if (mode === 5) {
        const colorIndex = queue.shift();
        const color = typeof colorIndex === "number" ? xtermColor(colorIndex) : null;
        if (code === 38) {
          next.fg = color;
        } else {
          next.bg = color;
        }
      } else if (mode === 2) {
        const r = queue.shift();
        const g = queue.shift();
        const b = queue.shift();
        if (
          typeof r === "number" &&
          typeof g === "number" &&
          typeof b === "number"
        ) {
          const color = "rgb(" + r + "," + g + "," + b + ")";
          if (code === 38) {
            next.fg = color;
          } else {
            next.bg = color;
          }
        }
      }
    }
  }

  return next;
}

function ansiStateToStyle(state) {
  const fg = state.inverse ? state.bg : state.fg;
  const bg = state.inverse ? state.fg : state.bg;
  const styles = [];
  if (fg) {
    styles.push("color:" + fg);
  }
  if (bg) {
    styles.push("background:" + bg);
  }
  return styles.join(";");
}

function renderAnsiToHtml(text) {
  const pattern = new RegExp("\\\\x1b\\\\[([0-9;]*)m", "g");
  const parts = [];
  let lastIndex = 0;
  let match = null;
  let state = defaultAnsiState();

  const pushText = (chunk) => {
    if (!chunk) {
      return;
    }
    const escaped = escapeHtml(chunk);
    const classNames = [];
    if (state.bold) {
      classNames.push("ansi-bold");
    }
    if (state.underline) {
      classNames.push("ansi-underline");
    }
    const style = ansiStateToStyle(state);
    if (classNames.length === 0 && !style) {
      parts.push(escaped);
      return;
    }
    const attrs = [];
    if (classNames.length > 0) {
      attrs.push('class="' + classNames.join(" ") + '"');
    }
    if (style) {
      attrs.push('style="' + style + '"');
    }
    parts.push("<span " + attrs.join(" ") + ">" + escaped + "</span>");
  };

  while ((match = pattern.exec(text)) !== null) {
    pushText(text.slice(lastIndex, match.index));
    const codes = match[1]
      ? match[1]
          .split(";")
          .map((value) => Number.parseInt(value, 10))
          .filter((value) => Number.isFinite(value))
      : [0];
    state = applySgrCodes(state, codes);
    lastIndex = pattern.lastIndex;
  }

  pushText(text.slice(lastIndex));
  return parts.join("");
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

async function sendTextInput(text) {
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
      body: JSON.stringify({ action: "text", text }),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(text || "Failed to send text.");
    }

    setStatus("Text sent");
    await refreshVisibleBuffer();
  } finally {
    state.actionBusy = false;
  }
}

function confirmInterrupt() {
  return new Promise((resolve) => {
    if (tg && typeof tg.showConfirm === "function") {
      tg.showConfirm("Send Ctrl+C to the tmux session? This can stop the running agent.", (ok) => {
        resolve(Boolean(ok));
      });
      return;
    }

    resolve(window.confirm("Send Ctrl+C to the tmux session? This can stop the running agent."));
  });
}

async function refreshVisibleBuffer() {
  const payload = await fetchVisibleBuffer();
  elements.terminal.innerHTML = renderAnsiToHtml(payload.content || "");
  setUpdated("Updated: " + formatCapturedAt(payload.captured_at));
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
  elements.interrupt.addEventListener("click", () => {
    confirmInterrupt()
      .then((ok) => {
        if (!ok) {
          return;
        }
        return sendAction("interrupt");
      })
      .catch((error) => setStatus(error.message || String(error), true));
  });

  elements.type.addEventListener("click", () => {
    const value = window.prompt("Send text to tmux without Enter:", "");
    if (value === null || value.length === 0) {
      return;
    }
    sendTextInput(value).catch((error) => setStatus(error.message || String(error), true));
  });

  elements.esc.addEventListener("click", () => {
    sendAction("escape").catch((error) => setStatus(error.message || String(error), true));
  });

  elements.tab.addEventListener("click", () => {
    sendAction("tab").catch((error) => setStatus(error.message || String(error), true));
  });

  elements.slash.addEventListener("click", () => {
    sendAction("slash").catch((error) => setStatus(error.message || String(error), true));
  });

  elements.del.addEventListener("click", () => {
    sendAction("delete").catch((error) => setStatus(error.message || String(error), true));
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

async function applyLaunchMode() {
  tg?.ready?.();

  if (!tg) {
    return;
  }

  const launchMode = config?.launchMode || "default";
  if (launchMode === "fullscreen") {
    if (typeof tg.requestFullscreen === "function") {
      try {
        await tg.requestFullscreen();
        return;
      } catch (_error) {
      }
    }
    tg.expand?.();
    return;
  }

  if (launchMode === "expand") {
    tg.expand?.();
  }
}

async function main() {
  try {
    await applyLaunchMode();
    bindUi();
    setStatus("Authorizing Mini App...");
    const bootstrapPayload = await bootstrap();
    state.token = bootstrapPayload.token;
    state.sessionId = bootstrapPayload.session_id;
    state.pollIntervalMs = bootstrapPayload.poll_interval_ms || state.pollIntervalMs;
    elements.session.textContent =
      bootstrapPayload.session_label || bootstrapPayload.session_id;

    if (!bootstrapPayload.tmux_target) {
      elements.interrupt.disabled = true;
      elements.type.disabled = true;
      elements.esc.disabled = true;
      elements.tab.disabled = true;
      elements.slash.disabled = true;
      elements.del.disabled = true;
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
        <button class="btn compact" data-role="slash" type="button">/</button>
        <button class="btn compact" data-role="up" type="button">↑</button>
        <button class="btn compact" data-role="down" type="button">↓</button>
        <button class="btn compact primary" data-role="enter" type="button">Enter</button>
        <button class="btn compact" data-role="delete" type="button">⌫</button>
        <button class="btn compact" data-role="type" type="button" title="Type text">🔤</button>
        <button class="btn compact" data-role="tab" type="button">Tab</button>
        <button class="btn compact" data-role="escape" type="button">Esc</button>
        <span class="toolbar-spacer" aria-hidden="true"></span>
        <button class="btn compact danger" data-role="interrupt" type="button">Ctrl+C</button>
      </div>
      <pre class="terminal" data-role="terminal">Waiting for tmux buffer…</pre>
      <div class="statusbar">
        <div class="status-left">
          <span data-role="status">Loading… - Live View</span>
          <span class="session-label" data-role="session" hidden>Live View</span>
        </div>
        <div class="status-right">
          <span data-role="updated">Updated: never</span>
        </div>
      </div>
    </div>
    <script>
      window.__TELEGRAM_MCP_WEBAPP__ = ${JSON.stringify({
        basePath: input.basePath,
        launchMode: input.launchMode,
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
