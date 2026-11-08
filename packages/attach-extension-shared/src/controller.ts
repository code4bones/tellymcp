import {
  cleanText,
  extractElement,
  selectionContext,
  sensitive,
  TTL_MS,
  type Rect,
  type SelectionContext,
} from "./context";

type Message = Record<string, unknown>;
type Runtime = {
  id: string;
  sendMessage(
    message: Message,
    callback?: (response: Message) => void,
  ): Promise<Message> | void;
  lastError?: { message: string };
  onMessage: {
    addListener(
      listener: (
        message: Message,
        sender: { id?: string },
        reply: (response: Message) => void,
      ) => boolean | undefined,
    ): void;
  };
};
const scope = globalThis as unknown as {
  browser?: { runtime: Runtime };
  chrome?: { runtime: Runtime };
  __tellyPickerInstalled?: boolean;
};
const runtime = (scope.browser ?? scope.chrome)!.runtime;
function send(message: Message): Promise<Message> {
  if (scope.browser) return runtime.sendMessage(message) as Promise<Message>;
  return new Promise((resolve, reject) =>
    runtime.sendMessage(message, (response) =>
      runtime.lastError
        ? reject(new Error(runtime.lastError.message))
        : resolve(response),
    ),
  );
}

class Picker {
  private host?: HTMLElement;
  private shadow?: ShadowRoot;
  private outline?: HTMLElement;
  private panel?: HTMLElement;
  private status?: HTMLElement;
  private shield?: HTMLElement;
  private abort?: AbortController;
  private expiry?: ReturnType<typeof setTimeout>;
  private frame = 0;
  private target?: Element;
  private children: Element[] = [];
  private drag?: { x: number; y: number };
  private context?: SelectionContext;
  private image?: { png_base64: string; width: number; height: number };
  private mode: "element" | "region" = "element";
  private picking = false;
  private pageKey = "";
  private generation = 0;
  private suppressUntil = 0;
  private requestId = "";
  private submitted = false;
  private receiver = "Local preview — connect a session to send";

  public stop(notify = true): void {
    if (notify && this.host)
      void send({ type: "picker_closed" }).catch(() => {});
    this.generation++;
    this.abort?.abort();
    if (this.expiry) clearTimeout(this.expiry);
    cancelAnimationFrame(this.frame);
    this.host?.remove();
    this.host = undefined;
    this.target = undefined;
    this.context = undefined;
    this.image = undefined;
    this.picking = false;
    this.drag = undefined;
    this.suppressUntil = 0;
    this.children = [];
  }

  public start(
    mode: "element" | "region",
    receiver: string,
    requestId?: string,
  ): void {
    this.stop(false);
    this.mode = mode;
    this.requestId = requestId || crypto.randomUUID();
    this.submitted = false;
    this.receiver = receiver;
    this.pageKey = this.currentPageKey();
    this.host = document.createElement("div");
    this.host.id = "telly-inspector-overlay";
    this.host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{color-scheme:dark}*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;padding:7px 10px;border:1px solid #64748b;border-radius:6px;background:#24334c;color:white}button:hover{background:#334966}textarea{width:100%;min-height:60px;background:#101827;color:#fff;border:1px solid #64748b;padding:8px}pre{white-space:pre-wrap;overflow:auto;max-height:150px;font-size:11px}img{max-width:100%;max-height:180px;object-fit:contain}p{margin:8px 0}.panel{position:fixed;right:16px;top:16px;width:340px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;background:#142036;color:#eef3ff;border:1px solid #4c6a9b;border-radius:10px;box-shadow:0 10px 30px #0008;padding:14px;font:13px/1.45 system-ui;pointer-events:auto}.row{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}.outline{position:fixed;border:2px solid #62b6ff;background:#62b6ff18;pointer-events:none}.shield{position:fixed;inset:0;pointer-events:auto;cursor:crosshair}.muted{font-size:12px;color:#b7c7e4}`;
    this.shadow.append(style);
    this.shield = document.createElement("div");
    this.shield.className = "shield";
    this.outline = document.createElement("div");
    this.outline.className = "outline";
    this.panel = document.createElement("section");
    this.panel.className = "panel";
    this.panel.setAttribute("aria-label", "TellyMCP AI Picker");
    this.shadow.append(this.shield, this.outline, this.panel);
    document.documentElement.append(this.host);
    this.abort = new AbortController();
    const opts = { capture: true, signal: this.abort.signal };
    for (const name of [
      "pointerdown",
      "pointerup",
      "click",
      "dblclick",
      "contextmenu",
    ] as const)
      window.addEventListener(name, this.pointer, opts);
    window.addEventListener("pointermove", this.move, opts);
    window.addEventListener("keydown", this.key, opts);
    window.addEventListener("keyup", this.key, opts);
    window.addEventListener("keypress", this.key, opts);
    window.addEventListener("scroll", this.changed, opts);
    window.addEventListener("resize", this.changed, opts);
    window.addEventListener("pagehide", () => this.stop(), {
      signal: this.abort.signal,
    });
    this.expiry = setTimeout(() => this.stop(), TTL_MS);
    this.picking = true;
    this.renderPicker(requestId);
  }

  private currentPageKey(): string {
    return `${location.href}|${scrollX}|${scrollY}|${innerWidth}|${innerHeight}|${devicePixelRatio}`;
  }
  private own(event: Event): boolean {
    if (!this.panel || !this.shadow) return false;
    if (event.composedPath().includes(this.panel)) return true;
    // At window capture, events from a closed shadow root are retargeted to
    // its host. Hit-test our own root instead of relying on composedPath alone.
    if (event instanceof MouseEvent)
      return this.panel.contains(
        this.shadow.elementFromPoint(event.clientX, event.clientY),
      );
    return this.panel.contains(this.shadow.activeElement);
  }
  private suppress(event: Event): void {
    event.preventDefault();
    event.stopImmediatePropagation();
  }
  private text(text: string, className?: string): HTMLElement {
    const node = document.createElement("p");
    node.textContent = text;
    if (className) node.className = className;
    this.panel!.append(node);
    return node;
  }
  private button(
    label: string,
    action: () => void | Promise<void>,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.textContent = label;
    button.addEventListener("click", () => {
      void Promise.resolve()
        .then(action)
        .catch(() => {
          if (this.status)
            this.status.textContent =
              "Could not complete request. Check the connection and retry.";
        });
    });
    this.panel!.append(button);
    return button;
  }
  private renderPicker(requestId?: string): void {
    this.panel!.replaceChildren();
    this.text(
      `TellyMCP · ${this.mode === "region" ? "Region" : "Element"} Picker`,
    );
    this.text(`Receiver: ${this.receiver}`, "muted");
    this.text(
      "Click to select · Alt+↑ parent · Alt+↓ child · Enter confirm · Esc close",
      "muted",
    );
    if (requestId)
      this.text(
        "An agent requested selection. Nothing is sent until you approve.",
        "muted",
      );
    this.status = this.text(
      this.mode === "region"
        ? "Drag a rectangle over the visible page."
        : "Point at an element.",
    );
    this.button("Cancel", () => this.stop());
  }
  private hit(x: number, y: number): Element | undefined {
    this.host!.style.visibility = "hidden";
    try {
      let element = document.elementFromPoint(x, y);
      for (let depth = 0; element?.shadowRoot && depth < 10; depth++) {
        const child = element.shadowRoot.elementFromPoint(x, y);
        if (!child || child === element) break;
        element = child;
      }
      return element || undefined;
    } finally {
      this.host!.style.visibility = "visible";
    }
  }
  private draw(rect: Rect): void {
    this.outline!.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px;display:block`;
  }
  private drawTarget(): void {
    if (this.target?.isConnected) {
      this.draw(this.target.getBoundingClientRect());
      if (this.status)
        this.status.textContent = [
          this.target,
          this.target.parentElement,
          this.target.parentElement?.parentElement,
        ]
          .filter(Boolean)
          .map((e) => e!.tagName.toLowerCase())
          .join(" ‹ ");
    }
  }
  private move = (event: PointerEvent): void => {
    if (!this.picking || this.own(event)) return;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (!this.picking) return;
      if (this.mode === "element") {
        this.target = this.hit(event.clientX, event.clientY);
        this.children = [];
        this.drawTarget();
      } else if (this.drag) this.draw(this.dragRect(event));
    });
  };
  private dragRect(event: PointerEvent): Rect {
    const start = this.drag!;
    return {
      x: Math.min(start.x, event.clientX),
      y: Math.min(start.y, event.clientY),
      width: Math.abs(event.clientX - start.x),
      height: Math.abs(event.clientY - start.y),
    };
  }
  private pointer = (event: MouseEvent): void => {
    if (!this.own(event) && performance.now() < this.suppressUntil) {
      this.suppress(event);
      return;
    }
    if (!this.picking || this.own(event)) return;
    this.suppress(event);
    if (event.button !== 0) return;
    if (this.mode === "region") {
      if (event.type === "pointerdown")
        this.drag = { x: event.clientX, y: event.clientY };
      if (event.type === "pointerup" && this.drag) {
        const rect = this.dragRect(event as PointerEvent);
        this.drag = undefined;
        if (rect.width >= 3 && rect.height >= 3) this.choose(rect);
      }
    } else if (event.type === "click") {
      this.target ??= this.hit(event.clientX, event.clientY);
      if (this.target) this.choose(this.target.getBoundingClientRect());
    }
  };
  private key = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.suppress(event);
      this.stop();
      return;
    }
    if (!this.picking || this.own(event)) return;
    // Do not let typing activate a page action while selection owns interaction.
    this.suppress(event);
    if (event.type !== "keydown") return;
    if (event.altKey && event.key === "ArrowUp" && this.target?.parentElement) {
      this.children.push(this.target);
      this.target = this.target.parentElement;
      this.drawTarget();
    }
    if (event.altKey && event.key === "ArrowDown" && this.children.length) {
      this.target = this.children.pop();
      this.drawTarget();
    }
    if (event.key === "Enter" && this.target)
      this.choose(this.target.getBoundingClientRect());
  };
  private changed = (): void => {
    if (this.picking) {
      cancelAnimationFrame(this.frame);
      this.frame = requestAnimationFrame(() => this.drawTarget());
    } else if (
      this.context &&
      this.currentPageKey() !== this.pageKey &&
      this.status
    ) {
      this.status.textContent =
        "Page moved or changed. Select again before sending.";
      this.image = undefined;
    }
  };
  private choose(rect: Rect): void {
    this.context = selectionContext(
      this.mode,
      rect,
      this.mode === "element" ? this.target : undefined,
    );
    this.context.requestId = this.requestId;
    this.suppressUntil = performance.now() + 500;
    this.pageKey = this.currentPageKey();
    this.picking = false;
    this.shield!.style.display = "none";
    this.draw(rect);
    this.renderPreview();
  }
  private valid(): boolean {
    return Boolean(
      this.context &&
      this.currentPageKey() === this.pageKey &&
      (this.mode !== "element" ||
        (this.target?.isConnected &&
          JSON.stringify(extractElement(this.target)) ===
            JSON.stringify(this.context.selection.element))),
    );
  }
  private renderPreview(): void {
    this.panel!.replaceChildren();
    this.text("Review selection before sending");
    this.text(`Receiver: ${this.receiver}`, "muted");
    const preview = document.createElement("pre");
    preview.textContent = JSON.stringify(this.context, null, 2);
    this.panel!.append(preview);
    this.text(
      "Page text is untrusted. Check for private information. Form values and common secrets are excluded. Images are optional.",
      "muted",
    );
    const question = document.createElement("textarea");
    question.placeholder = "Ask about this selection…";
    question.maxLength = 2000;
    this.panel!.append(question);
    this.status = this.text(
      "Kept locally until you send. The bound agent must read inspector_get_selection.",
    );
    this.button("Capture preview", () => this.capture());
    this.button("Text only", () => {
      this.image = undefined;
      this.context!.screenshot = undefined;
      this.panel!.querySelector("img")?.remove();
      this.status!.textContent = "Image removed.";
    });
    this.button("Explain", () =>
      this.submit(
        question.value || "Explain this selection using only observed content.",
      ),
    );
    this.button("Ask", () => this.submit(question.value));
    this.button("Copy context", async () => {
      await navigator.clipboard.writeText(
        JSON.stringify(this.context, null, 2),
      );
      this.status!.textContent = "Context copied.";
    });
    this.button("Select again", () => this.start(this.mode, this.receiver));
    this.button("Forget / close", async () => {
      await send({
        type: "picker_forget",
        selection_id: this.context!.selectionId,
      });
      this.stop();
    });
  }
  private async capture(): Promise<void> {
    if (!this.valid()) throw new Error("Stale selection");
    if (visualViewport && visualViewport.scale !== 1) {
      this.status!.textContent =
        "Pinch zoom is not supported for capture. Reset zoom or use text only.";
      return;
    }
    const generation = this.generation;
    const masks: Rect[] = [];
    const elements: Element[] = [];
    const roots: Node[] = [document.body || document.documentElement];
    while (roots.length && elements.length <= 10_000) {
      const walker = document.createTreeWalker(
        roots.pop()!,
        NodeFilter.SHOW_ELEMENT,
      );
      for (
        let node = walker.nextNode();
        node && elements.length <= 10_000;
        node = walker.nextNode()
      ) {
        const element = node as Element;
        elements.push(element);
        if (element.shadowRoot) roots.push(element.shadowRoot);
      }
    }
    if (elements.length > 10_000) {
      this.status!.textContent =
        "Page too large for automatic image redaction. Use text only.";
      return;
    }
    for (const element of elements) {
      if (element === this.host) continue;
      const text =
        element.children.length === 0 ? element.textContent || "" : "";
      if (
        element.matches("iframe,frame") ||
        (element.tagName.includes("-") && !element.shadowRoot) ||
        sensitive(element) ||
        (text &&
          cleanText(text, new TextEncoder().encode(text).byteLength) !==
            text.replace(/\s+/g, " ").trim())
      ) {
        const r = element.getBoundingClientRect();
        if (r.width && r.height)
          masks.push({ x: r.x, y: r.y, width: r.width, height: r.height });
      }
    }
    if (masks.length > 500) {
      this.status!.textContent = "Too many private regions. Use text only.";
      return;
    }
    this.host!.style.visibility = "hidden";
    try {
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      if (generation !== this.generation || !this.valid()) return;
      const response = await send({
        type: "picker_capture",
        rect: this.context!.selection.rect,
        viewport: this.context!.page.viewport,
        masks,
        page_url: location.href,
      });
      if (generation !== this.generation || !this.valid()) return;
      if (!response.ok) {
        this.status!.textContent = String(
          response.error ||
            "Capture unavailable. Select a smaller region or use text only.",
        );
        return;
      }
      this.image = response.image as typeof this.image;
      const img = document.createElement("img");
      img.alt = "Selection screenshot preview — review before sending";
      img.src = "data:image/png;base64," + this.image!.png_base64;
      this.panel!.querySelector("img")?.remove();
      this.panel!.append(img);
      this.status!.textContent =
        "Review the image. Use Text only to omit it. Select a smaller region to exclude private areas.";
    } finally {
      if (generation === this.generation && this.host)
        this.host.style.visibility = "visible";
    }
  }
  private async submit(question: string): Promise<void> {
    if (!this.valid()) {
      this.status!.textContent = "Selection is stale. Select again.";
      return;
    }
    const generation = this.generation;
    if (
      this.target &&
      this.mode === "element" &&
      JSON.stringify(extractElement(this.target)) !==
        JSON.stringify(this.context!.selection.element)
    ) {
      this.status!.textContent = "Element changed since preview. Select again.";
      return;
    }
    if (this.submitted) this.context!.requestId = crypto.randomUUID();
    this.context!.question = cleanText(question, 2000);
    const result = await send({
      type: "picker_submit",
      context: this.context,
      image: this.image,
    });
    if (generation !== this.generation) return;
    this.submitted = result.ok === true;
    this.status!.textContent = result.ok
      ? "Queued for the bound agent. It must read inspector_get_selection; keep this tab open for its response."
      : String(
          result.error || "Not sent. Connect this tab to a session and retry.",
        );
  }
  public command(message: Message): Message {
    if (message.action === "start") {
      this.start(
        message.mode === "region" ? "region" : "element",
        String(message.receiver || "Local preview"),
        String(message.request_id || ""),
      );
      return { ok: true };
    }
    if (message.action === "stop") {
      this.stop();
      return { ok: true };
    }
    if (
      !this.context ||
      message.selection_id !== this.context.selectionId ||
      message.request_id !== this.context.requestId ||
      !this.valid()
    )
      return { ok: false, error: "Selection is stale or missing" };
    if (message.action === "highlight") {
      this.draw(this.context.selection.rect);
      return { ok: true };
    }
    if (message.action === "response") {
      this.text("Agent response");
      const response = document.createElement("pre");
      response.textContent = String(message.explanation || "").slice(0, 16_384);
      this.panel!.append(response);
      this.status!.textContent =
        "Response received. Ask a follow-up using the same selection.";
      return { ok: true };
    }
    return { ok: false, error: "Unsupported inspector action" };
  }
}

if (!scope.__tellyPickerInstalled) {
  scope.__tellyPickerInstalled = true;
  const picker = new Picker();
  runtime.onMessage.addListener((message, sender, reply) => {
    if (sender.id !== runtime.id || message.type !== "picker_control")
      return undefined;
    try {
      reply(picker.command(message));
    } catch {
      reply({ ok: false, error: "Picker could not start on this page" });
    }
    return false;
  });
}
