(() => {
  if (window.__tellyRecorderContentInstalled === true) {
    return;
  }
  window.__tellyRecorderContentInstalled = true;

  function emit(payload) {
    try {
      browser.runtime.sendMessage({
        type: "telly_recording_page_event",
        event: payload,
      });
    } catch {
      // ignore
    }
  }

  function snapshot(reason) {
    if (window.top !== window) {
      return;
    }
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
  if (window.top === window) {
    window.addEventListener("load", () => {
      snapshot("window-load");
    });
  }
})();
