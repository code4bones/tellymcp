const browser = globalThis.browser ?? globalThis.chrome;

const DEFAULT_SETTINGS = {
  host: "127.0.0.1",
  port: 9999,
};

const CONNECTION_STATUS_KEY = "attach_connection_status";
const INSTANCE_ID_KEY = "attach_instance_id";
const ATTACHED_TAB_KEY = "attach_selected_tab";
const CONNECTION_ENABLED_KEY = "attach_connection_enabled";
const RECORDING_STATUS_KEY = "attach_recording_status";
const POPUP_COMMAND_KEY = "attach_popup_command";
const POPUP_COMMAND_RESULT_KEY = "attach_popup_command_result";
const CONTROL_PANEL_PORT_NAME = "telly-control-panel";
const RECONNECT_DELAY_MS = 3000;
const HEARTBEAT_INTERVAL_MS = 15000;
const KEEPALIVE_ALARM_NAME = "telly-keepalive";
const KEEPALIVE_ALARM_PERIOD_MINUTES = 0.5;
const MAX_CAPTURE_BYTES = 512 * 1024;
const MAX_BUFFERED_LOG_ENTRIES = 200;

let socket = null;
let reconnectTimer = null;
let heartbeatTimer = null;
let instanceId = null;
let attachedTabId = null;
let manualDisconnect = false;
const pendingManualRecordingRequests = new Map();
const controlPanelPorts = new Set();

const activeRecordingsById = new Map();
const activeRecordingIdByTabId = new Map();
const consoleMessagesByTabId = new Map();
const pageErrorsByTabId = new Map();
const networkFailuresByTabId = new Map();

function padNumber(value, length = 2) {
  return String(value).padStart(length, "0");
}

function formatLocalTimestamp(date = new Date()) {
  return `${date.getFullYear()}-${padNumber(date.getMonth() + 1)}-${padNumber(date.getDate())}T${padNumber(
    date.getHours(),
  )}:${padNumber(date.getMinutes())}:${padNumber(date.getSeconds())}.${padNumber(
    date.getMilliseconds(),
    3,
  )}`;
}

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

function storageSet(value) {
  return new Promise((resolve, reject) => {
    browser.storage.local.set(value, () => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function tabsQuery(queryInfo) {
  return new Promise((resolve, reject) => {
    browser.tabs.query(queryInfo, (tabs) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tabs || []);
    });
  });
}

function tabsGet(tabId) {
  return new Promise((resolve, reject) => {
    browser.tabs.get(tabId, (tab) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function tabsUpdate(tabId, updateProperties) {
  return new Promise((resolve, reject) => {
    browser.tabs.update(tabId, updateProperties, (tab) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(tab);
    });
  });
}

function windowsUpdate(windowId, updateInfo) {
  return new Promise((resolve, reject) => {
    browser.windows.update(windowId, updateInfo, (window) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(window);
    });
  });
}

function tabsRemove(tabId) {
  return new Promise((resolve, reject) => {
    browser.tabs.remove(tabId, () => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve();
    });
  });
}

function cookiesGetAll(details) {
  return new Promise((resolve, reject) => {
    browser.cookies.getAll(details, (cookies) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(cookies || []);
    });
  });
}

function captureVisibleTab(windowId, options) {
  return new Promise((resolve, reject) => {
    browser.tabs.captureVisibleTab(windowId, options, (dataUrl) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(dataUrl);
    });
  });
}

function scriptingExecuteScript(options) {
  return new Promise((resolve, reject) => {
    browser.scripting.executeScript(options, (result) => {
      const error = browser.runtime?.lastError;
      if (error) {
        reject(new Error(error.message));
        return;
      }
      resolve(result || []);
    });
  });
}

function collectInjectExportNames(source) {
  const names = new Set();
  const patterns = [
    /\basync\s+function\s+([A-Za-z_$][\w$]*)\s*\(/gu,
    /\bfunction\s+([A-Za-z_$][\w$]*)\s*\(/gu,
    /\bclass\s+([A-Za-z_$][\w$]*)\s*(?:\{|extends\b)/gu,
    /\b(?:var|let|const)\s+([A-Za-z_$][\w$]*)\s*=/gu,
  ];

  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) {
      const name = match[1];
      if (name && name !== "TELLY") {
        names.add(name);
      }
    }
  }

  return [...names];
}

function runInjectedMainWorldScript(namespace, source, exportNames) {
  try {
    window[namespace] = window[namespace] || {};
    const wrapped = "window[" + JSON.stringify(namespace) + "]=window[" + JSON.stringify(namespace) + "]||{};var TELLY=window[" + JSON.stringify(namespace) + "];\n"
      + String(source || "");

    const script = document.createElement("script");
    script.textContent = wrapped;
    (document.documentElement || document.head || document.body).appendChild(script);
    script.remove();

    for (const name of Array.isArray(exportNames) ? exportNames : []) {
      if (!name || !(name in window)) {
        continue;
      }
      try {
        window[namespace][name] = window[name];
      } catch {
        // ignore unassignable globals
      }
    }

    return {
      ok: true,
      result: {
        namespace,
        bytes: String(source || "").length,
        url: location.href,
        title: document.title,
      },
    };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
    };
  }
}

async function getSettings() {
  return await storageGet({
    ...DEFAULT_SETTINGS,
    [CONNECTION_ENABLED_KEY]: true,
  });
}

async function setConnectionStatus(status) {
  await storageSet({
    [CONNECTION_STATUS_KEY]: status,
  });
}

async function setLocalInstanceId(value) {
  await storageSet({
    [INSTANCE_ID_KEY]: value,
  });
}

async function setAttachedTab(tab) {
  attachedTabId =
    tab && Number.isInteger(tab.tab_id)
      ? Number(tab.tab_id)
      : null;
  await storageSet({
    [ATTACHED_TAB_KEY]: tab,
  });
}

async function setRecordingStatus(status) {
  await storageSet({
    [RECORDING_STATUS_KEY]: status,
  });
}

async function hydrateAttachedTabSelection() {
  const stored = await storageGet({ [ATTACHED_TAB_KEY]: null });
  const tab = stored[ATTACHED_TAB_KEY];
  attachedTabId =
    tab && Number.isInteger(tab.tab_id)
      ? Number(tab.tab_id)
      : null;
}

function buildWebSocketUrl(settings) {
  return `ws://${settings.host}:${settings.port}/browser-attach/ws`;
}

async function computeInstanceId() {
  if (instanceId) {
    return instanceId;
  }
  const runtimeId = browser.runtime.id || "chrome";
  instanceId = `chrome-${runtimeId}`;
  await setLocalInstanceId(instanceId);
  return instanceId;
}

async function listTabs() {
  const tabs = await tabsQuery({});
  return tabs.map((tab) => ({
    tab_id: tab.id,
    window_id: tab.windowId,
    active: tab.active === true,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status || "",
  }));
}

async function getActiveTab() {
  const tabs = await tabsQuery({ active: true, currentWindow: true });
  const tab = tabs[0];
  if (!tab || typeof tab.id !== "number") {
    return null;
  }
  return {
    tab_id: tab.id,
    window_id: tab.windowId,
    active: tab.active === true,
    title: tab.title || "",
    url: tab.url || "",
    status: tab.status || "",
  };
}

async function ensureTabIsActive(tabId) {
  let tab;
  try {
    tab = await tabsGet(tabId);
  } catch {
    throw new Error("Tab not found.");
  }
  await tabsUpdate(tabId, { active: true });
  await windowsUpdate(tab.windowId, { focused: true });
  return await tabsGet(tabId);
}

function trimBufferedEntries(entries) {
  if (entries.length <= MAX_BUFFERED_LOG_ENTRIES) {
    return entries;
  }
  return entries.slice(entries.length - MAX_BUFFERED_LOG_ENTRIES);
}

function appendBufferedEntry(store, tabId, entry) {
  if (!Number.isInteger(tabId) || tabId < 0 || !entry || typeof entry !== "object") {
    return;
  }
  const existing = store.get(tabId) || [];
  existing.push(entry);
  store.set(tabId, trimBufferedEntries(existing));
}

function extractErrorStack(args) {
  if (!Array.isArray(args)) {
    return "";
  }
  for (const arg of args) {
    if (!arg || typeof arg !== "object") {
      continue;
    }
    if (typeof arg.stack === "string" && arg.stack.trim()) {
      return arg.stack;
    }
  }
  return "";
}

function extractConsoleLocation(event) {
  if (!event || typeof event !== "object" || !Array.isArray(event.args)) {
    return "";
  }
  for (const arg of event.args) {
    if (!arg || typeof arg !== "object") {
      continue;
    }
    if (typeof arg.filename === "string" && arg.filename.trim()) {
      const line = Number.isFinite(arg.lineno) ? Number(arg.lineno) : 0;
      const column = Number.isFinite(arg.colno) ? Number(arg.colno) : 0;
      return `${arg.filename}:${line}:${column}`;
    }
  }
  return "";
}

function recordPageEventForBuffers(tabId, event) {
  if (!Number.isInteger(tabId) || tabId < 0 || !event || typeof event !== "object") {
    return;
  }
  if (event.kind !== "console_event") {
    return;
  }

  const timestamp =
    typeof event.at === "string" && event.at.trim()
      ? event.at
      : formatLocalTimestamp(new Date());
  const text = typeof event.text === "string" ? event.text : "";
  const location = extractConsoleLocation(event);

  appendBufferedEntry(consoleMessagesByTabId, tabId, {
    type:
      typeof event.level === "string" && event.level.trim()
        ? event.level
        : "log",
    text,
    ...(location ? { location } : {}),
    timestamp,
  });

  if (event.level === "error" || event.level === "assert") {
    const stack = extractErrorStack(event.args);
    appendBufferedEntry(pageErrorsByTabId, tabId, {
      message: text || "Console error",
      ...(stack ? { stack } : {}),
      timestamp,
    });
  }
}

function recordNetworkFailure(tabId, event) {
  if (!Number.isInteger(tabId) || tabId < 0 || !event || typeof event !== "object") {
    return;
  }
  appendBufferedEntry(networkFailuresByTabId, tabId, {
    url: typeof event.url === "string" ? event.url : "",
    method:
      typeof event.method === "string" && event.method.trim()
        ? event.method
        : "GET",
    ...(typeof event.status === "number" ? { status: event.status } : {}),
    ...(typeof event.error_text === "string" ? { error_text: event.error_text } : {}),
    ...(typeof event.resource_type === "string"
      ? { resource_type: event.resource_type }
      : {}),
    timestamp:
      typeof event.timestamp === "string" && event.timestamp.trim()
        ? event.timestamp
        : formatLocalTimestamp(new Date()),
  });
}

function getBufferedLogSnapshot(tabId, limit) {
  const normalize = (value) =>
    Number.isInteger(value) && value > 0 ? Number(value) : undefined;
  const sliceEntries = (entries) => {
    const normalizedLimit = normalize(limit);
    return normalizedLimit ? entries.slice(-normalizedLimit) : entries;
  };

  const consoleMessages = consoleMessagesByTabId.get(tabId) || [];
  const pageErrors = pageErrorsByTabId.get(tabId) || [];
  const networkFailures = networkFailuresByTabId.get(tabId) || [];

  return {
    console_messages: sliceEntries(consoleMessages),
    console_total: consoleMessages.length,
    page_errors: sliceEntries(pageErrors),
    page_error_total: pageErrors.length,
    network_failures: sliceEntries(networkFailures),
    network_failure_total: networkFailures.length,
  };
}

function clearBufferedLogs(tabId) {
  const consoleMessages = consoleMessagesByTabId.get(tabId) || [];
  const pageErrors = pageErrorsByTabId.get(tabId) || [];
  const networkFailures = networkFailuresByTabId.get(tabId) || [];
  consoleMessagesByTabId.delete(tabId);
  pageErrorsByTabId.delete(tabId);
  networkFailuresByTabId.delete(tabId);
  return {
    console_messages_cleared: consoleMessages.length,
    page_errors_cleared: pageErrors.length,
    network_failures_cleared: networkFailures.length,
  };
}

function buildTabActionCode(action, payload) {
  const serializedAction = JSON.stringify(action);
  const serializedPayload = JSON.stringify(payload || {});

  return `(async () => {
    const action = ${serializedAction};
    const payload = ${serializedPayload};
    const normalize = (value) => typeof value === "string" ? value.trim() : "";
    const timeoutMs = Number.isInteger(payload.timeout_ms) ? payload.timeout_ms : 30000;
    const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
    const byText = (text, exact) => {
      const needle = normalize(text);
      if (!needle) return null;
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      while (walker.nextNode()) {
        const element = walker.currentNode;
        const textContent = normalize(element.textContent || "");
        if (!textContent) continue;
        if ((exact && textContent === needle) || (!exact && textContent.includes(needle))) {
          return element;
        }
      }
      return null;
    };
    const isVisible = (element) => {
      if (!element) return false;
      const computed = window.getComputedStyle(element);
      return computed.display !== "none" && computed.visibility !== "hidden" && computed.opacity !== "0";
    };
    const resolveTarget = () => {
      const aiTag = normalize(payload.ai_tag);
      if (aiTag) {
        return document.querySelector('[data-drive-tag="' + aiTag.replace(/"/g, '\\"') + '"], [ai-tag="' + aiTag.replace(/"/g, '\\"') + '"]');
      }
      const selector = normalize(payload.selector);
      if (selector) {
        return document.querySelector(selector);
      }
      const text = normalize(payload.text);
      if (text) {
        return byText(text, payload.exact === true);
      }
      return document.body;
    };
    const target = resolveTarget();
    if (action !== "screenshot" && action !== "inject_script" && !target) {
      return { ok: false, error: "Target element was not found." };
    }
    if (target && typeof target.scrollIntoView === "function") {
      target.scrollIntoView({ block: "center", inline: "center" });
    }
    if (action === "dom") {
      const attributes = target
        ? Object.fromEntries(Array.from(target.attributes || []).map((attr) => [attr.name, attr.value]))
        : {};
      return {
        ok: true,
        result: {
          found: Boolean(target),
          outer_html: payload.include_html === false ? undefined : target.outerHTML,
          text_content: payload.include_text === false ? undefined : (target.textContent || "").trim(),
          visible: target ? isVisible(target) : false,
          attributes,
          url: location.href,
          title: document.title,
        },
      };
    }
    if (action === "computed_style") {
      if (!target) {
        return {
          ok: true,
          result: {
            found: false,
            url: location.href,
            title: document.title,
          },
        };
      }
      const requestedProperties = Array.isArray(payload.properties) && payload.properties.length
        ? payload.properties.map((item) => String(item))
        : ["display","position","visibility","opacity","color","background-color","font-size","z-index","overflow"];
      const computed = window.getComputedStyle(target);
      const rect = target.getBoundingClientRect();
      const styles = Object.fromEntries(
        requestedProperties.map((property) => [property, computed.getPropertyValue(property)]),
      );
      return {
        ok: true,
        result: {
          found: true,
          visible: isVisible(target),
          styles,
          box: {
            x: rect.x,
            y: rect.y,
            width: rect.width,
            height: rect.height,
          },
          url: location.href,
          title: document.title,
        },
      };
    }
    if (action === "click") {
      target.click();
      return {
        ok: true,
        result: {
          url: location.href,
          title: document.title,
        },
      };
    }
    if (action === "wait_for") {
      const waitState = normalize(payload.state) || "visible";
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        const current = resolveTarget();
        const visible = current ? isVisible(current) : false;
        if (
          (waitState === "attached" && current) ||
          (waitState === "detached" && !current) ||
          (waitState === "visible" && current && visible) ||
          (waitState === "hidden" && (!current || !visible))
        ) {
          return {
            ok: true,
            result: {
              url: location.href,
              title: document.title,
            },
          };
        }
        await sleep(100);
      }
      return {
        ok: false,
        error: "Timed out waiting for the requested element state.",
      };
    }
    if (action === "wait_for_url") {
      const exactUrl = normalize(payload.url);
      const containsUrl = normalize(payload.url_contains);
      const startedAt = Date.now();
      while (Date.now() - startedAt <= timeoutMs) {
        const currentUrl = String(location.href || "");
        if ((exactUrl && currentUrl === exactUrl) || (containsUrl && currentUrl.includes(containsUrl))) {
          return {
            ok: true,
            result: {
              url: currentUrl,
              title: document.title,
            },
          };
        }
        await sleep(100);
      }
      return {
        ok: false,
        error: "Timed out waiting for the requested URL.",
      };
    }
    if (action === "reload") {
      location.reload();
      return {
        ok: true,
        result: {
          url: location.href,
          title: document.title,
        },
      };
    }
    if (action === "fill") {
      target.focus();
      target.value = payload.value || "";
      target.dispatchEvent(new Event("input", { bubbles: true }));
      target.dispatchEvent(new Event("change", { bubbles: true }));
      return {
        ok: true,
        result: {
          url: location.href,
          title: document.title,
        },
      };
    }
    if (action === "inject_script") {
      const namespace = normalize(payload.namespace) || "TELLY";
      const source = String(payload.source || "");
      if (!source) {
        return { ok: false, error: "Script source is required." };
      }
      const wrapped = "const __tellyNamespace=" + JSON.stringify(namespace)
        + ";window[__tellyNamespace]=window[__tellyNamespace]||{};var TELLY=window[__tellyNamespace];const __tellyBeforeKeys=new Set(Object.getOwnPropertyNames(window));\\n"
        + source
        + "\\nfor(const __tellyKey of Object.getOwnPropertyNames(window)){if(__tellyBeforeKeys.has(__tellyKey)){continue;}if(__tellyKey===__tellyNamespace){continue;}try{window[__tellyNamespace][__tellyKey]=window[__tellyKey];}catch{}}";
      const script = document.createElement("script");
      script.textContent = wrapped;
      (document.documentElement || document.head || document.body).appendChild(script);
      script.remove();
      return {
        ok: true,
        result: {
          namespace,
          bytes: source.length,
          url: location.href,
          title: document.title,
        },
      };
    }
    if (action === "press") {
      const key = String(payload.key || "");
      if (target && typeof target.focus === "function") {
        target.focus();
      }
      const eventInit = { key, bubbles: true, cancelable: true };
      const keyboardTarget = document.activeElement || target || document.body;
      keyboardTarget.dispatchEvent(new KeyboardEvent("keydown", eventInit));
      keyboardTarget.dispatchEvent(new KeyboardEvent("keypress", eventInit));
      keyboardTarget.dispatchEvent(new KeyboardEvent("keyup", eventInit));
      return {
        ok: true,
        result: {
          url: location.href,
          title: document.title,
        },
      };
    }
    return { ok: false, error: "Unsupported tab action." };
  })();`;
}

async function runTabAction(tabId, action, payload) {
  const activeTab = await ensureTabIsActive(tabId);

  if (action === "attach") {
    const record = {
      tab_id: activeTab.id,
      window_id: activeTab.windowId,
      active: activeTab.active === true,
      title: activeTab.title || "",
      url: activeTab.url || "",
      status: activeTab.status || "",
    };
    await setAttachedTab(record);
    try {
      await injectRecorderContent(tabId);
    } catch {
      // ignore
    }
    return {
      ok: true,
      result: {
        url: record.url,
        title: record.title,
      },
    };
  }

  if (action === "detach") {
    await setAttachedTab(null);
    return {
      ok: true,
      result: {
        url: activeTab.url || "",
        title: activeTab.title || "",
      },
    };
  }

  if (action === "close") {
    if (attachedTabId === tabId) {
      await setAttachedTab(null);
    }
    await tabsRemove(tabId);
    return {
      ok: true,
      result: {
        url: activeTab.url || "",
        title: activeTab.title || "",
      },
    };
  }

  if (action === "get_logs") {
    return {
      ok: true,
      result: getBufferedLogSnapshot(
        tabId,
        Number.isInteger(payload?.limit) ? Number(payload.limit) : undefined,
      ),
    };
  }

  if (action === "clear_logs") {
    return {
      ok: true,
      result: clearBufferedLogs(tabId),
    };
  }

  if (action === "screenshot") {
    await new Promise((resolve) => setTimeout(resolve, 180));
    const refreshedTab = await tabsGet(tabId).catch(() => activeTab);
    const dataUrl = await captureVisibleTab(activeTab.windowId, {
      format: "png",
    });
    return {
      ok: true,
      result: {
        png_base64: String(dataUrl).replace(/^data:image\/png;base64,/, ""),
        url: refreshedTab.url || "",
        title: refreshedTab.title || "",
      },
    };
  }

  if (action === "inject_script") {
    const namespace =
      typeof payload?.namespace === "string" && payload.namespace.trim()
        ? payload.namespace.trim()
        : "TELLY";
    const source = String(payload?.source || "");
    if (!source) {
      return {
        ok: false,
        error: "Script source is required.",
      };
    }

    const execution = await scriptingExecuteScript({
      target: { tabId },
      world: "MAIN",
      func: runInjectedMainWorldScript,
      args: [namespace, source, collectInjectExportNames(source)],
    });
    const result = execution[0]?.result;

    if (!result || result.ok !== true) {
      return {
        ok: false,
        error: result?.error || "Tab action did not return a successful result.",
      };
    }

    return result;
  }

  const execution = await scriptingExecuteScript({
    target: { tabId },
    func: new Function(`return ${buildTabActionCode(action, payload)}`),
  });
  const result = execution[0]?.result;

  if (!result || result.ok !== true) {
    return {
      ok: false,
      error: result?.error || "Tab action did not return a successful result.",
    };
  }

  return result;
}

function sendJson(payload) {
  if (!socket || socket.readyState !== WebSocket.OPEN) {
    return;
  }
  socket.send(JSON.stringify(payload));
}

function isSocketOpenOrConnecting() {
  return Boolean(
    socket &&
      (socket.readyState === WebSocket.OPEN ||
        socket.readyState === WebSocket.CONNECTING),
  );
}

function clearTimers() {
  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
}

function scheduleReconnect() {
  if (manualDisconnect) {
    return;
  }
  clearTimers();
  reconnectTimer = setTimeout(() => {
    void connect();
  }, RECONNECT_DELAY_MS);
}

async function waitForSocketReady(timeoutMs = 2500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (socket && socket.readyState === WebSocket.OPEN) {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return Boolean(socket && socket.readyState === WebSocket.OPEN);
}

function startHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
  }
  heartbeatTimer = setInterval(() => {
    sendJson({
      type: "heartbeat",
      sent_at: formatLocalTimestamp(new Date()),
    });
  }, HEARTBEAT_INTERVAL_MS);
}

async function sendHello() {
  sendJson({
    type: "hello",
    extension_version: browser.runtime.getManifest().version,
    browser: "chrome",
    instance_id: await computeInstanceId(),
    profile_name: "default",
  });
}

function bytesToBase64(bytes) {
  let binary = "";
  const chunkSize = 0x8000;
  for (let index = 0; index < bytes.length; index += chunkSize) {
    const slice = bytes.subarray(index, index + chunkSize);
    binary += String.fromCharCode(...slice);
  }
  return btoa(binary);
}

function headersToArray(headers) {
  return (headers || []).map((header) => ({
    name: String(header.name || ""),
    value: String(header.value || ""),
  }));
}

function getRecordingByTabId(tabId) {
  const recordingId = activeRecordingIdByTabId.get(tabId);
  return recordingId ? activeRecordingsById.get(recordingId) || null : null;
}

function sendRecordingEvent(recordingId, tabId, event) {
  if (!recordingId || !Number.isInteger(tabId)) {
    return;
  }
  sendJson({
    type: "recording_event",
    recording_id: recordingId,
    tab_id: tabId,
    event: {
      ...event,
      at: event.at || formatLocalTimestamp(new Date()),
    },
  });
}

async function injectRecorderContent(tabId) {
  await scriptingExecuteScript({
    target: { tabId },
    files: ["recorder-content.js"],
  });
}

async function captureTabSnapshot(tabId, reason) {
  const execution = await scriptingExecuteScript({
    target: { tabId },
    func: (recordingReason) => ({
      kind: "page_snapshot",
      source: "background",
      reason: recordingReason,
      at: formatLocalTimestamp(new Date()),
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      html: document.documentElement ? document.documentElement.outerHTML : ""
    }),
    args: [reason],
  });
  const result = execution[0]?.result;
  return result || null;
}

async function emitCookiesSnapshot(recordingId, tabId, tabUrl, tabTitle) {
  if (!tabUrl || !/^https?:\/\//iu.test(tabUrl)) {
    return;
  }
  try {
    const cookies = await cookiesGetAll({ url: tabUrl });
    sendRecordingEvent(recordingId, tabId, {
      kind: "cookies_snapshot",
      source: "browser",
      url: tabUrl,
      tab_title: tabTitle || "",
      cookies: cookies.map((cookie) => ({
        name: cookie.name,
        value: cookie.value,
        domain: cookie.domain,
        path: cookie.path,
        secure: cookie.secure,
        http_only: cookie.httpOnly,
        same_site: cookie.sameSite,
        store_id: cookie.storeId,
      })),
    });
  } catch {
    // ignore
  }
}

async function startRecording(message) {
  const attached = (await storageGet({ [ATTACHED_TAB_KEY]: null }))[ATTACHED_TAB_KEY];
  const tabId = Number(message.tab_id);
  if (!attached || attached.tab_id !== tabId) {
    return {
      ok: false,
      active: false,
      error: "Selected attached tab does not match the requested recording tab.",
    };
  }

  const browserTab = await tabsGet(tabId);
  activeRecordingsById.set(message.recording_id, {
    recordingId: message.recording_id,
    tabId,
    tabTitle: browserTab.title || "",
    tabUrl: browserTab.url || "",
    startedAt: formatLocalTimestamp(new Date()),
  });
  activeRecordingIdByTabId.set(tabId, message.recording_id);

  await injectRecorderContent(tabId);
  const snapshot = await captureTabSnapshot(tabId, "recording-start");
  if (snapshot) {
    sendRecordingEvent(message.recording_id, tabId, snapshot);
  }
  await emitCookiesSnapshot(
    message.recording_id,
    tabId,
    browserTab.url || "",
    browserTab.title || "",
  );

  return {
    ok: true,
    active: true,
  };
}

async function stopRecording(message) {
  activeRecordingsById.delete(message.recording_id);
  activeRecordingIdByTabId.delete(message.tab_id);
  await setRecordingStatus({
    active: false,
  });
  return {
    ok: true,
    active: false,
  };
}

async function handleAttachTabSelectedCommand(tabId) {
  if (!Number.isInteger(tabId) || tabId < 0) {
    return {
      ok: false,
      error: "Invalid tab_id.",
    };
  }

  let browserTab;
  try {
    browserTab = await tabsGet(tabId);
  } catch {
    return {
      ok: false,
      error: "Tab not found.",
    };
  }

  const ready = await waitForSocketReady();
  if (!ready) {
    return {
      ok: false,
      error: "Extension is not connected to TellyMCP.",
    };
  }

  const record = {
    tab_id: tabId,
    window_id: browserTab.windowId,
    active: browserTab.active === true,
    title: browserTab.title || "",
    url: browserTab.url || "",
    status: browserTab.status || "",
  };

  sendJson({
    type: "attach_tab_selected",
    tab: record,
  });
  await setAttachedTab(record);
  try {
    await injectRecorderContent(tabId);
  } catch {
    // ignore recorder bootstrap errors for manual attach
  }

  return {
    ok: true,
    tab: record,
  };
}

async function handlePopupCommand(command) {
  if (!command || typeof command !== "object") {
    return {
      ok: false,
      error: "Invalid popup command.",
    };
  }

  if (command.type === "attach_tab_selected") {
    return await handleAttachTabSelectedCommand(Number(command.tab_id));
  }
  if (command.type === "attach_recording_start") {
    const stored = await storageGet({ [ATTACHED_TAB_KEY]: null });
    const tab = stored[ATTACHED_TAB_KEY];
    if (!tab) {
      return {
        ok: false,
        active: false,
        error: "Select a tab first.",
      };
    }
    return await sendManualRecordingRequest("recording_manual_start", { tab });
  }
  if (command.type === "attach_recording_stop") {
    return await sendManualRecordingRequest("recording_manual_stop");
  }
  if (command.type === "attach_recording_status") {
    return await sendManualRecordingRequest("recording_manual_status");
  }
  if (command.type === "attach_inject_script") {
    const stored = await storageGet({ [ATTACHED_TAB_KEY]: null });
    const tab = stored[ATTACHED_TAB_KEY];
    if (!tab) {
      return {
        ok: false,
        error: "Select a tab first.",
      };
    }
    const source = String(command.source || "");
    if (!source.trim()) {
      return {
        ok: false,
        error: "Script source is empty.",
      };
    }
    return await runTabAction(tab.tab_id, "inject_script", {
      namespace: typeof command.namespace === "string" ? command.namespace : "TELLY",
      source,
    });
  }

  return {
    ok: false,
    error: `Unsupported popup command: ${String(command.type || "")}`,
  };
}

async function sendManualRecordingRequest(type, payload = {}) {
  const ready = await waitForSocketReady();
  if (!ready) {
    return {
      ok: false,
      active: false,
      error: "Extension is not connected to TellyMCP.",
    };
  }

  const requestId = `manual-recording-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
  const result = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingManualRecordingRequests.delete(requestId);
      reject(new Error("Recording request timed out."));
    }, 15000);
    pendingManualRecordingRequests.set(requestId, { resolve, reject, timer });
    sendJson({
      type,
      request_id: requestId,
      ...payload,
    });
  }).catch((error) => ({
    ok: false,
    active: false,
    error: error instanceof Error ? error.message : String(error),
  }));

  if (result && typeof result === "object" && result.recording) {
    await setRecordingStatus(result);
  } else if (result && typeof result === "object" && result.active === false) {
    await setRecordingStatus({ active: false });
  }

  return result;
}

async function handleMessage(rawData) {
  const message =
    typeof rawData === "string"
      ? JSON.parse(rawData)
      : JSON.parse(String(rawData));

  switch (message.type) {
    case "hello_ack":
      await setConnectionStatus({
        state: "connected",
        text: `Connected: ${message.session_label || message.session_id || message.instance_id}`,
        instance_id: message.instance_id,
        ...(message.session_id ? { session_id: message.session_id } : {}),
        ...(message.session_label ? { session_label: message.session_label } : {}),
      });
      startHeartbeat();
      return;
    case "list_tabs": {
      sendJson({
        type: "list_tabs_result",
        request_id: message.request_id,
        tabs: await listTabs(),
      });
      return;
    }
    case "get_active_tab": {
      sendJson({
        type: "get_active_tab_result",
        request_id: message.request_id,
        tab: await getActiveTab(),
      });
      return;
    }
    case "tab_action": {
      const result = await runTabAction(
        message.tab_id,
        message.action,
        message.payload || {},
      );
      sendJson({
        type: "tab_action_result",
        request_id: message.request_id,
        ok: result.ok === true,
        ...(result.result ? { result: result.result } : {}),
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }
    case "recording_start": {
      const result = await startRecording(message);
      sendJson({
        type: "recording_control_result",
        request_id: message.request_id,
        ok: result.ok === true,
        active: result.active === true,
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }
    case "recording_stop": {
      const result = await stopRecording(message);
      sendJson({
        type: "recording_control_result",
        request_id: message.request_id,
        ok: result.ok === true,
        active: result.active === true,
        ...(result.error ? { error: result.error } : {}),
      });
      return;
    }
    case "recording_manual_result": {
      const pending = pendingManualRecordingRequests.get(message.request_id);
      if (!pending) {
        return;
      }
      clearTimeout(pending.timer);
      pendingManualRecordingRequests.delete(message.request_id);
      pending.resolve(message);
      return;
    }
    case "recording_state":
      await setRecordingStatus({
        active: message.active === true,
        ...(message.recording ? { recording: message.recording } : {}),
      });
      return;
    default:
      return;
  }
}

async function connect() {
  const settings = await getSettings();
  manualDisconnect = settings[CONNECTION_ENABLED_KEY] === false;
  if (manualDisconnect) {
    clearTimers();
    await setConnectionStatus({
      state: "disconnected",
      text: "Disconnected: manual",
    });
    return;
  }
  if (isSocketOpenOrConnecting()) {
    return;
  }
  clearTimers();
  await setConnectionStatus({
    state: "connecting",
    text: `Connecting: ${settings.host}:${settings.port}`,
  });
  const wsUrl = buildWebSocketUrl(settings);
  socket = new WebSocket(wsUrl);

  socket.addEventListener("open", () => {
    void sendHello();
  });

  socket.addEventListener("message", (event) => {
    void handleMessage(event.data);
  });

  socket.addEventListener("close", () => {
    socket = null;
    if (manualDisconnect) {
      void setConnectionStatus({
        state: "disconnected",
        text: "Disconnected: manual",
      });
      return;
    }
    void setConnectionStatus({
      state: "disconnected",
      text: `Disconnected: reconnecting in ${Math.floor(RECONNECT_DELAY_MS / 1000)}s`,
    });
    scheduleReconnect();
  });

  socket.addEventListener("error", () => {
    void setConnectionStatus({
      state: "disconnected",
      text: "Disconnected: WebSocket error",
    });
    if (socket) {
      socket.close();
    }
  });
}

browser.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== "local") {
    return;
  }

  if (changes[CONNECTION_ENABLED_KEY] !== undefined) {
    const nextEnabled = changes[CONNECTION_ENABLED_KEY].newValue !== false;
    manualDisconnect = !nextEnabled;
    if (nextEnabled) {
      if (socket) {
        socket.close();
      } else {
        void connect();
      }
    } else {
      clearTimers();
      if (socket) {
        socket.close();
      } else {
        void setConnectionStatus({
          state: "disconnected",
          text: "Disconnected: manual",
        });
      }
    }
    return;
  }

  if (changes[POPUP_COMMAND_KEY] !== undefined) {
    const command = changes[POPUP_COMMAND_KEY].newValue;
    if (!command) {
      return;
    }
    void handlePopupCommand(command)
      .then((result) =>
        storageSet({
          [POPUP_COMMAND_RESULT_KEY]: {
            command_id: command.command_id,
            result,
            at: formatLocalTimestamp(new Date()),
          },
        }),
      )
      .catch((error) =>
        storageSet({
          [POPUP_COMMAND_RESULT_KEY]: {
            command_id: command.command_id,
            result: {
              ok: false,
              error: error instanceof Error ? error.message : String(error),
            },
            at: formatLocalTimestamp(new Date()),
          },
        }),
      );
    return;
  }

  if (
    changes.host === undefined &&
    changes.port === undefined
  ) {
    return;
  }

  if (socket) {
    socket.close();
  } else if (!manualDisconnect) {
    void connect();
  }
});

browser.runtime.onConnect.addListener((port) => {
  if (port.name !== CONTROL_PANEL_PORT_NAME) {
    return;
  }
  controlPanelPorts.add(port);
  port.onDisconnect.addListener(() => {
    controlPanelPorts.delete(port);
  });
  port.onMessage.addListener(() => {
    // keep the service worker alive while the control panel is open
  });
});

browser.tabs.onActivated.addListener(async () => {
  const tab = await getActiveTab();
  if (!tab) {
    return;
  }
  sendJson({
    type: "active_tab_changed",
    tab,
  });
});

browser.tabs.onUpdated.addListener(async (tabId, changeInfo, tab) => {
  if (
    typeof tabId !== "number" ||
    (changeInfo.title === undefined &&
      changeInfo.url === undefined &&
      changeInfo.status === undefined)
  ) {
    return;
  }

  sendJson({
    type: "tab_updated",
    tab: {
      tab_id: tabId,
      window_id: tab.windowId,
      active: tab.active === true,
      title: tab.title || "",
      url: tab.url || "",
      status: changeInfo.status || tab.status || "",
    },
  });

  const recording = getRecordingByTabId(tabId);
  const shouldTrackTab = recording || attachedTabId === tabId;
  if (!shouldTrackTab) {
    return;
  }

  if (recording) {
    sendRecordingEvent(recording.recordingId, tabId, {
      kind: "navigation",
      source: "browser",
      status: changeInfo.status || tab.status || "",
      url: tab.url || "",
      title: tab.title || "",
    });
  }

  if (changeInfo.status === "complete") {
    try {
      await injectRecorderContent(tabId);
      if (recording) {
        const snapshot = await captureTabSnapshot(tabId, "tab-updated-complete");
        if (snapshot) {
          sendRecordingEvent(recording.recordingId, tabId, snapshot);
        }
      }
    } catch {
      // ignore
    }
    if (recording) {
      await emitCookiesSnapshot(
        recording.recordingId,
        tabId,
        tab.url || "",
        tab.title || "",
      );
    }
  }
});

async function handleRuntimeMessage(message, sender) {
  if (!message || typeof message !== "object") {
    return undefined;
  }

  if (message.type === "attach_tab_selected") {
    return await handleAttachTabSelectedCommand(Number(message.tab_id));
  }

  if (message.type === "attach_connection_set_enabled") {
    return (async () => {
      const enabled = message.enabled === true;
      await storageSet({
        [CONNECTION_ENABLED_KEY]: enabled,
      });
      return { ok: true, enabled };
    })();
  }

  if (message.type === "attach_recording_start") {
    return await handlePopupCommand({ type: "attach_recording_start" });
  }

  if (message.type === "attach_recording_stop") {
    return await handlePopupCommand({ type: "attach_recording_stop" });
  }

  if (message.type === "attach_recording_status") {
    return await handlePopupCommand({ type: "attach_recording_status" });
  }

  if (message.type === "attach_inject_script") {
    return await handlePopupCommand({
      type: "attach_inject_script",
      source: message.source,
      namespace: message.namespace,
    });
  }

  if (message.type === "telly_recording_page_event") {
    const tabId = sender?.tab?.id;
    if (!Number.isInteger(tabId)) {
      return undefined;
    }
    recordPageEventForBuffers(tabId, message.event || {});
    const recording = getRecordingByTabId(tabId);
    if (!recording) {
      return { ok: true };
    }
    sendRecordingEvent(recording.recordingId, tabId, message.event || {});
    return { ok: true };
  }

  return undefined;
}

browser.runtime.onMessage.addListener((message, sender, sendResponse) => {
  void handleRuntimeMessage(message, sender)
    .then((result) => {
      sendResponse(result);
    })
    .catch((error) => {
      sendResponse({
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  return true;
});

browser.webRequest.onBeforeRequest.addListener(
  (details) => {
    const recording = getRecordingByTabId(details.tabId);
    if (!recording) {
      return;
    }

    let bodyText = "";
    let bodyBase64 = "";
    if (details.requestBody?.formData) {
      bodyText = Object.entries(details.requestBody.formData)
        .map(([name, values]) =>
          values.map((value) => `${name}=${String(value)}`).join("&"),
        )
        .join("&");
    } else if (Array.isArray(details.requestBody?.raw)) {
      const chunks = details.requestBody.raw
        .map((item) => item.bytes)
        .filter(Boolean)
        .map((buffer) => new Uint8Array(buffer));
      if (chunks.length > 0) {
        const total = chunks.reduce((sum, chunk) => sum + chunk.length, 0);
        const merged = new Uint8Array(total);
        let offset = 0;
        for (const chunk of chunks) {
          merged.set(chunk, offset);
          offset += chunk.length;
        }
        bodyBase64 = bytesToBase64(merged.subarray(0, MAX_CAPTURE_BYTES));
      }
    }

    sendRecordingEvent(recording.recordingId, details.tabId, {
      kind: "network_request",
      source: "browser",
      request_id: details.requestId,
      url: details.url,
      method: details.method,
      resource_type: details.type,
      ...(bodyText ? { body_text: bodyText.slice(0, MAX_CAPTURE_BYTES) } : {}),
      ...(bodyBase64 ? { body_base64: bodyBase64 } : {}),
    });
  },
  { urls: ["<all_urls>"] },
  ["requestBody"],
);

browser.webRequest.onBeforeSendHeaders.addListener(
  (details) => {
    const recording = getRecordingByTabId(details.tabId);
    if (!recording) {
      return;
    }
    sendRecordingEvent(recording.recordingId, details.tabId, {
      kind: "network_request_headers",
      source: "browser",
      request_id: details.requestId,
      url: details.url,
      method: details.method,
      resource_type: details.type,
      headers: headersToArray(details.requestHeaders),
    });
  },
  { urls: ["<all_urls>"] },
  ["requestHeaders"],
);

browser.webRequest.onHeadersReceived.addListener(
  (details) => {
    const recording = getRecordingByTabId(details.tabId);
    if (!recording) {
      return;
    }

    sendRecordingEvent(recording.recordingId, details.tabId, {
      kind: "network_response_headers",
      source: "browser",
      request_id: details.requestId,
      url: details.url,
      method: details.method,
      resource_type: details.type,
      status_code: details.statusCode,
      headers: headersToArray(details.responseHeaders),
    });
  },
  { urls: ["<all_urls>"] },
  ["responseHeaders"],
);

browser.webRequest.onCompleted.addListener(
  (details) => {
    if (
      Number.isInteger(details.tabId) &&
      details.tabId >= 0 &&
      typeof details.statusCode === "number" &&
      details.statusCode >= 400
    ) {
      recordNetworkFailure(details.tabId, {
        url: details.url,
        method: details.method,
        status: details.statusCode,
        resource_type: details.type,
        timestamp: formatLocalTimestamp(new Date()),
      });
    }
    const recording = getRecordingByTabId(details.tabId);
    if (!recording) {
      return;
    }
    sendRecordingEvent(recording.recordingId, details.tabId, {
      kind: "network_response_complete",
      source: "browser",
      request_id: details.requestId,
      url: details.url,
      method: details.method,
      resource_type: details.type,
      status_code: details.statusCode,
    });
  },
  { urls: ["<all_urls>"] },
);

browser.webRequest.onErrorOccurred.addListener(
  (details) => {
    if (Number.isInteger(details.tabId) && details.tabId >= 0) {
      recordNetworkFailure(details.tabId, {
        url: details.url,
        method: details.method,
        error_text: details.error,
        resource_type: details.type,
        timestamp: formatLocalTimestamp(new Date()),
      });
    }
    const recording = getRecordingByTabId(details.tabId);
    if (!recording) {
      return;
    }
    sendRecordingEvent(recording.recordingId, details.tabId, {
      kind: "network_error",
      source: "browser",
      request_id: details.requestId,
      url: details.url,
      method: details.method,
      resource_type: details.type,
      error: details.error,
    });
  },
  { urls: ["<all_urls>"] },
);

browser.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name !== KEEPALIVE_ALARM_NAME || manualDisconnect) {
    return;
  }
  if (!isSocketOpenOrConnecting()) {
    void connect();
  }
});

browser.alarms.create(KEEPALIVE_ALARM_NAME, {
  periodInMinutes: KEEPALIVE_ALARM_PERIOD_MINUTES,
});

void hydrateAttachedTabSelection();
void computeInstanceId();
void connect();
