(() => {
  if (window.__tellyRecorderPageInstalled === true) {
    return;
  }
  window.__tellyRecorderPageInstalled = true;

  const MAX_TEXT_CHARS = 64 * 1024;
  const truncateText = (value) => {
    const text = String(value ?? "");
    return text.length > MAX_TEXT_CHARS ? text.slice(0, MAX_TEXT_CHARS) : text;
  };
  const serializeValue = (value, depth = 0) => {
    if (depth >= 2) return truncateText(value);
    if (value === null || value === undefined) return value;
    if (typeof value === "string") return truncateText(value);
    if (typeof value === "number" || typeof value === "boolean") return value;
    if (value instanceof Error) {
      return {
        name: value.name,
        message: truncateText(value.message),
        stack: truncateText(value.stack || ""),
      };
    }
    if (Array.isArray(value)) {
      return value.slice(0, 20).map((item) => serializeValue(item, depth + 1));
    }
    if (typeof value === "object") {
      const output = {};
      for (const [key, nested] of Object.entries(value).slice(0, 20)) {
        output[key] = serializeValue(nested, depth + 1);
      }
      return output;
    }
    return truncateText(value);
  };
  const emit = (payload) => {
    window.postMessage({ __tellyRecorderPageEvent: true, payload }, "*");
  };
  const headersToArray = (headers) => {
    try {
      return Array.from(headers.entries()).map(([name, value]) => ({ name, value }));
    } catch {
      return [];
    }
  };
  const serializeRequestBody = async (request) => {
    try {
      const text = await request.clone().text();
      if (!text) return { body_text: "" };
      return {
        body_text: truncateText(text),
        body_truncated: text.length > MAX_TEXT_CHARS,
      };
    } catch {
      return {};
    }
  };

  for (const level of ["log", "info", "warn", "error", "debug"]) {
    const original = console[level];
    console[level] = function patchedConsole(...args) {
      try {
        emit({
          kind: "console_event",
          source: "page",
          at: new Date().toISOString(),
          level,
          text: truncateText(
            args
              .map((item) => {
                if (typeof item === "string") return item;
                try {
                  return JSON.stringify(item);
                } catch {
                  return String(item);
                }
              })
              .join(" "),
          ),
          args: args.map((item) => serializeValue(item)),
          url: location.href,
          title: document.title,
        });
      } catch {
        // ignore
      }
      return original.apply(this, args);
    };
  }

  window.addEventListener("error", (event) => {
    emit({
      kind: "console_event",
      source: "page",
      at: new Date().toISOString(),
      level: "error",
      text: truncateText(event.message || "window error"),
      args: [
        {
          filename: event.filename || "",
          lineno: event.lineno || 0,
          colno: event.colno || 0,
        },
      ],
      url: location.href,
      title: document.title,
    });
  });

  window.addEventListener("unhandledrejection", (event) => {
    emit({
      kind: "console_event",
      source: "page",
      at: new Date().toISOString(),
      level: "error",
      text: "Unhandled promise rejection",
      args: [serializeValue(event.reason)],
      url: location.href,
      title: document.title,
    });
  });

  const originalFetch = window.fetch.bind(window);
  window.fetch = async (...args) => {
    const startedAt = new Date().toISOString();
    const request = new Request(...args);
    const requestId = `page-fetch-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
    const body = await serializeRequestBody(request);
    emit({
      kind: "network_request",
      source: "page",
      at: startedAt,
      request_id: requestId,
      url: request.url,
      method: request.method,
      resource_type: "fetch",
      headers: headersToArray(request.headers),
      ...body,
    });

    const response = await originalFetch(...args);
    emit({
      kind: "network_response_complete",
      source: "page",
      at: new Date().toISOString(),
      request_id: requestId,
      url: request.url,
      method: request.method,
      resource_type: "fetch",
      status_code: response.status,
      headers: headersToArray(response.headers),
    });

    try {
      const bodyText = await response.clone().text();
      emit({
        kind: "network_response_body",
        source: "page",
        at: new Date().toISOString(),
        request_id: requestId,
        url: request.url,
        body_text: truncateText(bodyText),
        body_truncated: bodyText.length > MAX_TEXT_CHARS,
      });
    } catch {
      // ignore
    }

    return response;
  };

  const originalOpen = XMLHttpRequest.prototype.open;
  const originalSend = XMLHttpRequest.prototype.send;
  const originalSetHeader = XMLHttpRequest.prototype.setRequestHeader;
  XMLHttpRequest.prototype.open = function patchedOpen(method, url, async, user, password) {
    this.__tellyRecorder = {
      request_id: `page-xhr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      method: String(method || "GET"),
      url: String(url || ""),
      headers: [],
    };
    return originalOpen.call(this, method, url, async, user, password);
  };
  XMLHttpRequest.prototype.setRequestHeader = function patchedSetHeader(name, value) {
    if (this.__tellyRecorder?.headers) {
      this.__tellyRecorder.headers.push({ name: String(name), value: String(value) });
    }
    return originalSetHeader.call(this, name, value);
  };
  XMLHttpRequest.prototype.send = function patchedSend(body) {
    const startedAt = new Date().toISOString();
    const meta = this.__tellyRecorder || {
      request_id: `page-xhr-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`,
      method: "GET",
      url: "",
      headers: [],
    };
    const bodyText =
      typeof body === "string"
        ? body
        : body instanceof URLSearchParams
          ? body.toString()
          : body instanceof FormData
            ? Array.from(body.entries())
                .map(([k, v]) => `${String(k)}=${String(v)}`)
                .join("&")
            : "";
    emit({
      kind: "network_request",
      source: "page",
      at: startedAt,
      request_id: meta.request_id,
      url: meta.url,
      method: meta.method,
      resource_type: "xmlhttprequest",
      headers: meta.headers,
      body_text: truncateText(bodyText),
      body_truncated: bodyText.length > MAX_TEXT_CHARS,
    });

    this.addEventListener(
      "loadend",
      () => {
        const headersRaw = this.getAllResponseHeaders() || "";
        const headers = headersRaw
          .split(/\r?\n/)
          .map((line) => line.trim())
          .filter(Boolean)
          .map((line) => {
            const separatorIndex = line.indexOf(":");
            return separatorIndex <= 0
              ? { name: line, value: "" }
              : {
                  name: line.slice(0, separatorIndex).trim(),
                  value: line.slice(separatorIndex + 1).trim(),
                };
          });
        emit({
          kind: "network_response_complete",
          source: "page",
          at: new Date().toISOString(),
          request_id: meta.request_id,
          url: meta.url,
          method: meta.method,
          resource_type: "xmlhttprequest",
          status_code: this.status,
          headers,
        });
        if (typeof this.responseText === "string") {
          emit({
            kind: "network_response_body",
            source: "page",
            at: new Date().toISOString(),
            request_id: meta.request_id,
            url: meta.url,
            body_text: truncateText(this.responseText),
            body_truncated: this.responseText.length > MAX_TEXT_CHARS,
          });
        }
      },
      { once: true },
    );

    return originalSend.call(this, body);
  };
})();
