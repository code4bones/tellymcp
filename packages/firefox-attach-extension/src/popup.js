const DEFAULT_CONNECTION_STATUS = {
  state: "disconnected",
  text: "Disconnected",
};

const ATTACHED_TAB_KEY = "attach_selected_tab";

function setStatus(state, text) {
  const node = document.getElementById("connection-status");
  if (!node) {
    return;
  }
  node.textContent = text;
  node.style.color =
    state === "connected"
      ? "var(--accent)"
      : state === "connecting"
        ? "var(--warn)"
        : "var(--soft)";
}

function setText(id, text) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = text;
}

async function render() {
  const stored = await browser.storage.local.get({
    attach_connection_status: DEFAULT_CONNECTION_STATUS,
    [ATTACHED_TAB_KEY]: null,
  });
  const status = stored.attach_connection_status ?? DEFAULT_CONNECTION_STATUS;
  setStatus(status.state, status.text || DEFAULT_CONNECTION_STATUS.text);
  setText(
    "session",
    `Session: ${status.session_label || status.session_id || "-"}`,
  );
  setText(
    "attached-tab",
    stored[ATTACHED_TAB_KEY]?.title
      ? `Attached: ${stored[ATTACHED_TAB_KEY].title}`
      : "Attached: -",
  );
}

document.getElementById("open-settings").addEventListener("click", () => {
  void browser.tabs.create({
    url: browser.runtime.getURL("options.html"),
  });
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (changes.attach_connection_status || changes[ATTACHED_TAB_KEY]) {
    void render();
  }
});

void render();
