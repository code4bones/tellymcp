const browser = globalThis.browser ?? globalThis.chrome;

const DEFAULT_CONNECTION_STATUS = {
  state: "disconnected",
  text: "Disconnected",
};

const ATTACHED_TAB_KEY = "attach_selected_tab";

function storageGet(defaults) {
  return new Promise((resolve, reject) => {
    browser.storage.local.get(defaults, (result) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result);
    });
  });
}

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
  const stored = await storageGet({
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
