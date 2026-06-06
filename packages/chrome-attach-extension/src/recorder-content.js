(() => {
  const browser = globalThis.browser ?? globalThis.chrome;

  function sendRuntimeMessage(message) {
    return new Promise((resolve, reject) => {
      browser.runtime.sendMessage(message, (response) => {
        const error = browser.runtime?.lastError;
        if (error) {
          reject(new Error(error.message));
          return;
        }
        resolve(response);
      });
    });
  }

  if (window.__tellyRecorderContentInstalled === true) {
    return;
  }
  window.__tellyRecorderContentInstalled = true;

  function emit(payload) {
    void sendRuntimeMessage({
      type: "telly_recording_page_event",
      event: payload,
    }).catch(() => {});
  }

  function snapshot(reason) {
    emit({
      kind: "page_snapshot",
      source: "content",
      reason,
      at: new Date().toISOString(),
      url: location.href,
      title: document.title,
      ready_state: document.readyState,
      html: document.documentElement?.outerHTML || "",
    });
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window) {
      return;
    }
    if (!event.data || event.data.__tellyRecorderPageEvent !== true) {
      return;
    }
    emit(event.data.payload);
  });

  const injection = document.createElement("script");
  injection.src = browser.runtime.getURL("recorder-page.js");
  injection.async = false;
  (document.documentElement || document.head || document.body).appendChild(injection);
  injection.addEventListener(
    "load",
    () => {
      injection.remove();
    },
    { once: true },
  );
  injection.addEventListener(
    "error",
    () => {
      emit({
        kind: "console_event",
        source: "content",
        level: "error",
        text: "Failed to load recorder-page.js",
        url: location.href,
        title: document.title,
      });
      injection.remove();
    },
    { once: true },
  );

  snapshot("recording-script-installed");
  window.addEventListener("load", () => {
    snapshot("window-load");
  });
})();
