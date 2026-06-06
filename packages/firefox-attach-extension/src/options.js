const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 9999,
  attach_connection_enabled: true,
};

const DEFAULT_RECORDING_STATUS = {
  active: false,
};

const DEFAULT_CONNECTION_STATUS = {
  state: "disconnected",
  text: "Disconnected",
};

const DEFAULT_INSTANCE_ID = "";
const ATTACHED_TAB_KEY = "attach_selected_tab";
const POPUP_COMMAND_KEY = "attach_popup_command";
const POPUP_COMMAND_RESULT_KEY = "attach_popup_command_result";

function storageGet(defaults) {
  return browser.storage.local.get(defaults);
}

function storageSet(value) {
  return browser.storage.local.set(value);
}

function setStatus(message, isError = false) {
  const status = document.getElementById("status");
  if (!status) {
    return;
  }
  status.textContent = message || "";
  status.style.color = isError ? "var(--danger)" : "var(--accent)";
}

function setConnectionText(state, text) {
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

function setMeta(id, text) {
  const node = document.getElementById(id);
  if (!node) {
    return;
  }
  node.textContent = text;
}

function setAttachedText(attachedTab) {
  const node = document.getElementById("attached-tab");
  if (!node) {
    return;
  }
  node.textContent = attachedTab?.title
    ? `Attached: ${attachedTab.title}`
    : "Attached: -";
}

function setRecordingText(recordingStatus) {
  const node = document.getElementById("recording");
  if (!node) {
    return;
  }
  if (!recordingStatus?.active || !recordingStatus.recording) {
    node.textContent = "Recording: inactive";
    return;
  }
  node.textContent = `Recording: ${recordingStatus.recording.bundle_dir_name}`;
}

function setRecordingTabText(recordingStatus) {
  const node = document.getElementById("recording-tab");
  if (!node) {
    return;
  }
  if (!recordingStatus?.active || !recordingStatus.recording) {
    node.textContent = "Recording tab: -";
    return;
  }
  node.textContent = `Recording tab: ${recordingStatus.recording.tab_title || `Tab ${recordingStatus.recording.tab_id}`}`;
}

function setRecordingScopeText(recordingStatus, currentInstanceId) {
  const node = document.getElementById("recording-scope");
  if (!node) {
    return;
  }
  if (!recordingStatus?.active || !recordingStatus.recording) {
    node.textContent = "";
    node.style.color = "var(--soft)";
    return;
  }
  if (
    currentInstanceId &&
    recordingStatus.recording.instance_id &&
    recordingStatus.recording.instance_id !== currentInstanceId
  ) {
    node.textContent = "Recording is active in another browser instance.";
    node.style.color = "var(--warn)";
    return;
  }
  node.textContent = "Recording belongs to this browser instance.";
  node.style.color = "var(--soft)";
}

function setActionStatus(message, tone = "neutral") {
  const node = document.getElementById("action-status");
  if (!node) {
    return;
  }
  node.textContent = message || "";
  node.style.color =
    tone === "success"
      ? "var(--accent)"
      : tone === "error"
        ? "var(--danger)"
        : "var(--soft)";
}

function updateConnectionButtons(status, enabled) {
  const toggleButton = document.getElementById("connection-toggle-button");
  if (!toggleButton) {
    return;
  }
  const connected = status?.state === "connected";
  const connecting = status?.state === "connecting";
  const shouldDisconnect = enabled !== false && (connected || connecting);
  toggleButton.textContent = shouldDisconnect ? "Disconnect" : "Connect";
  toggleButton.disabled = false;
}

function renderTabs(tabs, attachedTabId, recordingStatus, connected, currentInstanceId) {
  const container = document.getElementById("tabs");
  if (!container) {
    return;
  }
  container.textContent = "";
  const recordingTabId = recordingStatus?.active === true ? recordingStatus.recording?.tab_id : null;

  for (const tab of tabs) {
    const row = document.createElement("div");
    row.className = "tab-row";

    const isAttached = tab.id === attachedTabId;
    const isRecording = tab.id === recordingTabId;
    const isLockedByOtherInstance =
      recordingStatus?.active === true &&
      Boolean(recordingStatus?.recording?.instance_id) &&
      Boolean(currentInstanceId) &&
      recordingStatus.recording.instance_id !== currentInstanceId;

    const button = document.createElement("button");
    button.type = "button";
    button.className = "tab";
    if (isAttached) {
      button.classList.add("active");
    }
    if (tab.active === true) {
      button.classList.add("current");
    }
    if (isRecording) {
      button.classList.add("recording");
    }

    const head = document.createElement("div");
    head.className = "tab-head";

    const title = document.createElement("div");
    title.className = "tab-title";
    title.textContent = tab.title || tab.url || `Tab ${tab.id}`;

    const badges = document.createElement("div");
    badges.className = "tab-badges";

    if (isAttached) {
      const attachedBadge = document.createElement("span");
      attachedBadge.className = "badge attached";
      attachedBadge.textContent = "Attached";
      badges.append(attachedBadge);
    }
    if (isRecording) {
      const recordingBadge = document.createElement("span");
      recordingBadge.className = "badge recording";
      recordingBadge.textContent = "Recording";
      badges.append(recordingBadge);
    }

    const url = document.createElement("div");
    url.className = "tab-url";
    url.textContent = tab.url || "";

    head.append(title, badges);
    button.append(head, url);
    button.addEventListener("click", () => {
      void attachTab(tab.id);
    });

    const recordButton = document.createElement("button");
    recordButton.type = "button";
    recordButton.className = "secondary tab-record-button";
    recordButton.textContent = isRecording ? "Stop" : "Record";
    recordButton.disabled =
      !connected ||
      isLockedByOtherInstance ||
      (recordingStatus?.active === true && !isRecording);
    recordButton.addEventListener("click", (event) => {
      event.stopPropagation();
      if (isLockedByOtherInstance) {
        setActionStatus("Recording is already active in another browser instance.", "error");
        return;
      }
      if (isRecording) {
        void stopRecording();
        return;
      }
      void startRecordingForTab(tab.id);
    });

    row.append(button, recordButton);
    container.append(row);
  }
}

async function requestRecordingStatus() {
  try {
    return await sendPopupCommand("attach_recording_status");
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function refreshRecordingStatus() {
  const result = await requestRecordingStatus();
  if (!result?.ok) {
    setActionStatus(result?.error || "Could not refresh recording status.", "error");
  }
  return result;
}

async function attachTab(tabId, options = {}) {
  const { suppressSuccessStatus = false } = options;
  setActionStatus("Attaching tab...", "neutral");
  let result;
  try {
    result = await sendPopupCommand("attach_tab_selected", {
      tab_id: tabId,
    });
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result?.ok) {
    setActionStatus(result?.error || "Attach failed.", "error");
    return;
  }
  if (!suppressSuccessStatus) {
    setActionStatus(`Attached tab ${result.tab?.tab_id}.`, "success");
  }
  return result;
}

async function startRecording() {
  setActionStatus("Starting recording...", "neutral");
  let result;
  try {
    result = await sendPopupCommand("attach_recording_start");
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result?.ok) {
    setActionStatus(result?.error || "Could not start recording.", "error");
    return;
  }
  setActionStatus(
    result?.recording?.bundle_dir_name
      ? `Recording started: ${result.recording.bundle_dir_name}`
      : "Recording started.",
    "success",
  );
  await refreshRecordingStatus();
}

async function stopRecording() {
  setActionStatus("Stopping recording...", "neutral");
  let result;
  try {
    result = await sendPopupCommand("attach_recording_stop");
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result?.ok) {
    setActionStatus(result?.error || "Could not stop recording.", "error");
    return;
  }
  setActionStatus("Recording stopped.", "success");
  await refreshRecordingStatus();
}

async function startRecordingForTab(tabId) {
  const stored = await storageGet({
    attach_connection_status: DEFAULT_CONNECTION_STATUS,
    attach_recording_status: DEFAULT_RECORDING_STATUS,
    attach_instance_id: DEFAULT_INSTANCE_ID,
  });
  const currentInstanceId = stored.attach_instance_id || stored.attach_connection_status?.instance_id;
  const recordingStatus = stored.attach_recording_status ?? DEFAULT_RECORDING_STATUS;
  if (
    recordingStatus?.active === true &&
    recordingStatus.recording?.instance_id &&
    currentInstanceId &&
    recordingStatus.recording.instance_id !== currentInstanceId
  ) {
    setActionStatus("Recording is already active in another browser instance.", "error");
    return;
  }
  const attachResult = await attachTab(tabId, { suppressSuccessStatus: true });
  if (!attachResult?.ok) {
    return;
  }
  await startRecording();
}

async function injectSelectedFile() {
  const fileInput = document.getElementById("inject-file");
  const namespaceInput = document.getElementById("inject-namespace");
  const file = fileInput?.files?.[0];
  if (!file) {
    setActionStatus("Choose a script file first.", "error");
    return;
  }
  const source = await file.text();
  if (!source.trim()) {
    setActionStatus("Selected script file is empty.", "error");
    return;
  }
  setActionStatus(`Injecting ${file.name}...`, "neutral");
  let result;
  try {
    result = await sendPopupCommand("attach_inject_script", {
      source,
      namespace: namespaceInput?.value?.trim() || "TELLY",
      file_name: file.name,
    });
  } catch (error) {
    result = {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  if (!result?.ok) {
    setActionStatus(result?.error || "Script injection failed.", "error");
    return;
  }
  setActionStatus(`Injected ${file.name}.`, "success");
}

async function setConnectionEnabled(enabled) {
  await storageSet({
    attach_connection_enabled: enabled,
  });
  setActionStatus(enabled ? "Connect requested." : "Disconnected.", "success");
}

function waitForStorageResult(commandId, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      browser.storage.onChanged.removeListener(listener);
      reject(new Error("Request timed out."));
    }, timeoutMs);
    function listener(changes, areaName) {
      if (areaName !== "local" || !changes[POPUP_COMMAND_RESULT_KEY]) {
        return;
      }
      const nextValue = changes[POPUP_COMMAND_RESULT_KEY].newValue;
      if (!nextValue || nextValue.command_id !== commandId) {
        return;
      }
      clearTimeout(timer);
      browser.storage.onChanged.removeListener(listener);
      resolve(nextValue.result);
    }
    browser.storage.onChanged.addListener(listener);
  });
}

async function sendPopupCommand(type, payload = {}, timeoutMs = 15000) {
  const commandId = `options-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  await storageSet({
    [POPUP_COMMAND_KEY]: {
      command_id: commandId,
      type,
      ...payload,
      at: new Date().toISOString(),
    },
  });
  try {
    return await waitForStorageResult(commandId, timeoutMs);
  } finally {
    try {
      await storageSet({
        [POPUP_COMMAND_KEY]: null,
      });
    } catch {
      // ignore
    }
  }
}

async function saveSettings(event) {
  event.preventDefault();
  const host = document.getElementById("host").value.trim() || DEFAULT_SETTINGS.host;
  const portRaw = document.getElementById("port").value.trim();
  const port = Number(portRaw || DEFAULT_SETTINGS.port);

  if (!Number.isInteger(port) || port <= 0 || port > 65535) {
    setStatus("Port must be an integer between 1 and 65535.", true);
    return;
  }

  await storageSet({
    host,
    port,
  });
  setStatus("Settings saved.");
}

async function render() {
  const [stored, tabs] = await Promise.all([
    storageGet({
      ...DEFAULT_SETTINGS,
      attach_connection_status: DEFAULT_CONNECTION_STATUS,
      attach_connection_enabled: true,
      [ATTACHED_TAB_KEY]: null,
      attach_recording_status: DEFAULT_RECORDING_STATUS,
      attach_instance_id: DEFAULT_INSTANCE_ID,
    }),
    browser.tabs.query({ currentWindow: true }),
  ]);

  document.getElementById("host").value = stored.host ?? DEFAULT_SETTINGS.host;
  document.getElementById("port").value = String(stored.port ?? DEFAULT_SETTINGS.port);
  const status = stored.attach_connection_status ?? DEFAULT_CONNECTION_STATUS;
  const recordingStatus = stored.attach_recording_status ?? DEFAULT_RECORDING_STATUS;
  const currentInstanceId = stored.attach_instance_id || status.instance_id;

  setConnectionText(status.state, status.text || DEFAULT_CONNECTION_STATUS.text);
  updateConnectionButtons(status, stored.attach_connection_enabled);
  setMeta("endpoint", `Endpoint: ${stored.host}:${stored.port}`);
  setMeta(
    "session",
    `Session: ${status.session_label || status.session_id || "-"}`,
  );
  setAttachedText(stored[ATTACHED_TAB_KEY]);
  setRecordingText(recordingStatus);
  setRecordingTabText(recordingStatus);
  setRecordingScopeText(recordingStatus, currentInstanceId);
  renderTabs(
    tabs,
    stored[ATTACHED_TAB_KEY]?.tab_id,
    recordingStatus,
    status.state === "connected",
    currentInstanceId,
  );
}

document
  .getElementById("settings-form")
  .addEventListener("submit", (event) => {
    void saveSettings(event);
  });

document.getElementById("connection-toggle-button").addEventListener("click", async () => {
  const stored = await storageGet({
    attach_connection_status: DEFAULT_CONNECTION_STATUS,
    attach_connection_enabled: true,
  });
  const status = stored.attach_connection_status ?? DEFAULT_CONNECTION_STATUS;
  const enabled = stored.attach_connection_enabled;
  const connected = status.state === "connected" || status.state === "connecting";
  await setConnectionEnabled(!(enabled !== false && connected));
});

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }
  if (
    changes.attach_connection_status ||
    changes.attach_instance_id ||
    changes.host ||
    changes.port ||
    changes.attach_connection_enabled ||
    changes.attach_recording_status ||
    changes[ATTACHED_TAB_KEY]
  ) {
    void render();
  }
});

document.getElementById("inject-script-button").addEventListener("click", () => {
  void injectSelectedFile();
});

void render();
void refreshRecordingStatus();
