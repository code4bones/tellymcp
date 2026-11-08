import {
  cleanText,
  selectionContext,
  sensitive,
  TTL_MS,
  type Rect,
  type SelectionContext,
} from "./context";
import { pickerIcon, type PickerAction } from "./icons";
import { MarkingSession } from "./marks";

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
  private ancestorNavigation = false;
  private drag?: { x: number; y: number };
  private context?: SelectionContext;
  private image?: { png_base64: string; width: number; height: number };
  private mode: "element" | "region" | "marks" = "element";
  private marks?: MarkingSession;
  private marksLayer?: HTMLElement;
  private picking = false;
  private pageKey = "";
  private generation = 0;
  private suppressUntil = 0;
  private requestId = "";
  private submitted = false;
  private submitting = false;
  private lastSubmission = "";
  private receiver = "Local preview — connect a session to send";

  public stop(notify = true): void {
    if (notify && this.host)
      void send({ type: "picker_closed" }).catch(() => {});
    this.generation++;
    this.abort?.abort();
    if (this.expiry) clearTimeout(this.expiry);
    cancelAnimationFrame(this.frame);
    this.marks?.clear();
    this.marks = undefined;
    this.marksLayer = undefined;
    this.host?.remove();
    this.host = undefined;
    this.target = undefined;
    this.context = undefined;
    this.image = undefined;
    this.picking = false;
    this.drag = undefined;
    this.suppressUntil = 0;
    this.children = [];
    this.ancestorNavigation = false;
  }

  public start(
    mode: "element" | "region" | "marks",
    receiver: string,
    requestId?: string,
  ): void {
    this.stop(false);
    this.mode = mode;
    this.marks = mode === "marks" ? new MarkingSession() : undefined;
    this.requestId = requestId || crypto.randomUUID();
    this.submitted = false;
    this.submitting = false;
    this.lastSubmission = "";
    this.receiver = receiver;
    this.pageKey = this.currentPageKey();
    this.host = document.createElement("div");
    this.host.id = "telly-inspector-overlay";
    this.host.style.cssText =
      "all:initial;position:fixed;inset:0;z-index:2147483647;pointer-events:none;";
    this.shadow = this.host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent = `:host{color-scheme:dark}*{box-sizing:border-box}button,input,textarea{font:inherit}button{cursor:pointer;padding:7px 10px;border:1px solid #64748b;border-radius:6px;background:#24334c;color:white}button:hover{background:#334966}textarea{width:100%;min-height:60px;background:#101827;color:#fff;border:1px solid #64748b;padding:8px}pre{white-space:pre-wrap;overflow:auto;max-height:150px;font-size:11px}img{max-width:100%;max-height:180px;object-fit:contain}p{margin:8px 0}.panel{position:fixed;right:16px;top:16px;width:340px;max-width:calc(100vw - 32px);max-height:calc(100vh - 32px);overflow:auto;background:#142036;color:#eef3ff;border:1px solid #4c6a9b;border-radius:10px;box-shadow:0 10px 30px #0008;padding:14px;font:13px/1.45 system-ui;pointer-events:auto}.row{display:flex;gap:7px;flex-wrap:wrap;margin:8px 0}.outline{position:fixed;border:2px solid #62b6ff;background:#62b6ff18;pointer-events:none}.shield{position:fixed;inset:0;pointer-events:auto;cursor:crosshair}.muted{font-size:12px;color:#b7c7e4}`;
    style.textContent += `.panel.compact{width:44px;height:44px;padding:0;border-radius:50%;overflow:hidden}.panel.compact button{width:100%;height:100%;padding:0;border:0;border-radius:50%;font-size:26px;line-height:1}.panel button:focus-visible{outline:2px solid #62b6ff;outline-offset:-3px}`;
    style.textContent += `.panel .reselect{position:fixed;right:16px;top:16px;width:44px;height:44px;padding:0;border-radius:50%;font-size:26px;line-height:1}.preview-title{margin:0 44px 12px 0;min-height:30px}`;
    style.textContent += `button{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;padding:8px;flex-shrink:0}button svg{display:block;width:18px;height:18px;pointer-events:none}.compact button svg,.reselect svg{width:22px;height:22px}`;
    style.textContent += `.mark{position:fixed;border:2px solid #71d08d;background:#71d08d18;pointer-events:none}.mark span{position:absolute;top:0;left:0;background:#17482a;color:white;padding:1px 5px;font:12px system-ui}.badge{position:absolute;right:0;bottom:0;min-width:16px;border-radius:8px;background:#17482a;color:white;font:11px/16px system-ui}.mark-list{padding-left:24px;max-height:180px;overflow:auto}.mark-list li{margin:4px 0}.mark-list button{width:28px;height:28px;margin-left:8px}`;
    this.shadow.append(style);
    this.shield = document.createElement("div");
    this.shield.className = "shield";
    this.outline = document.createElement("div");
    this.outline.className = "outline";
    this.panel = document.createElement("section");
    this.panel.className = "panel";
    this.panel.setAttribute("aria-label", "TellyMCP AI Picker");
    this.marksLayer = document.createElement("div");
    this.shadow.append(this.shield, this.marksLayer, this.outline, this.panel);
    document.documentElement.append(this.host);
    this.abort = new AbortController();
    // Keep focus notifications inside the Picker. Page modal focus traps see
    // the closed shadow host as an outside element and otherwise steal focus
    // back from our question field. Preserve the browser's default focus action.
    for (const name of ["focusin", "focusout"] as const)
      this.shadow.addEventListener(name, (event) => event.stopPropagation(), {
        signal: this.abort.signal,
      });
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
    if (this.mode === "marks") return location.href;
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
    label: PickerAction,
    action: () => void | Promise<void>,
    parent?: HTMLElement,
  ): HTMLButtonElement {
    const button = document.createElement("button");
    button.type = "button";
    button.title = label;
    button.setAttribute("aria-label", label);
    button.append(pickerIcon(label));
    button.addEventListener("click", () => {
      void Promise.resolve()
        .then(action)
        .catch(() => {
          if (this.status)
            this.status.textContent =
              "Could not complete request. Check the connection and retry.";
        });
    });
    (parent ?? this.panel!).append(button);
    return button;
  }
  private toolbar(): HTMLElement {
    const row = document.createElement("div");
    row.className = "row";
    row.setAttribute("role", "group");
    row.setAttribute("aria-label", "Picker actions");
    this.panel!.append(row);
    return row;
  }
  private renderPicker(requestId?: string, expanded = false): void {
    this.panel!.replaceChildren();
    this.panel!.classList.toggle("compact", !expanded);
    this.status = undefined;
    if (!expanded) {
      const toggle = this.button("Show picker controls", () =>
        this.renderPicker(requestId, true),
      );
      toggle.title = `${this.mode === "region" ? "Drag to select a region" : "Point and click to select an element"} · Esc close · Click for controls`;
      if (this.marks) {
        const badge = document.createElement("span");
        badge.className = "badge";
        badge.textContent = String(this.marks.items.length);
        badge.setAttribute("aria-hidden", "true");
        toggle.append(badge);
        toggle.title = `${this.marks.items.length} marked · Click elements to toggle · Enter review · Esc close`;
      }
      return;
    }
    this.text(
      `TellyMCP · ${this.mode === "marks" ? "Marks" : this.mode === "region" ? "Region" : "Element"} Picker`,
    );
    this.text(`Receiver: ${this.receiver}`, "muted");
    this.text(
      this.marks
        ? "Click to toggle · Click inside a mark to remove it · Enter review · Esc close"
        : "Click to select · Alt+↑ parent · Alt+↓ child · Enter confirm · Esc close",
      "muted",
    );
    if (requestId)
      this.text(
        "An agent requested selection. Nothing is sent until you approve.",
        "muted",
      );
    this.status = this.text(
      this.marks
        ? `${this.marks.items.length} elements marked.`
        : this.mode === "region"
          ? "Drag a rectangle over the visible page."
          : "Point at an element.",
    );
    const controls = this.toolbar();
    if (this.marks) {
      this.markList();
      this.button("Review marked elements", () => this.reviewMarks(), controls);
      this.button(
        "Clear marks",
        () => {
          this.marks!.clear();
          this.drawMarks();
          this.renderPicker(requestId, true);
        },
        controls,
      );
    }
    this.button("Collapse", () => this.renderPicker(requestId), controls);
    this.button("Cancel", () => this.stop(), controls);
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
  private drawMarks(): void {
    this.marksLayer?.replaceChildren();
    for (const mark of this.marks?.items ?? []) {
      if (!mark.element.isConnected) continue;
      const rect = mark.element.getBoundingClientRect();
      const box = document.createElement("div");
      box.className = "mark";
      box.style.cssText = `left:${rect.x}px;top:${rect.y}px;width:${rect.width}px;height:${rect.height}px`;
      const label = document.createElement("span");
      label.textContent = String(mark.id);
      box.append(label);
      this.marksLayer!.append(box);
    }
  }
  private markList(): void {
    const list = document.createElement("ol");
    list.className = "mark-list";
    for (const mark of this.marks!.items) {
      const row = document.createElement("li");
      const label = document.createElement("span");
      label.textContent = `${mark.id} · ${mark.element.tagName.toLowerCase()}`;
      row.append(label);
      const remove = this.button(
        "Remove mark",
        () => {
          this.marks!.remove(mark.element);
          this.drawMarks();
          this.renderPicker(undefined, true);
        },
        row,
      );
      remove.setAttribute("aria-label", `Remove marked element ${mark.id}`);
      list.append(row);
    }
    this.panel!.append(list);
  }
  private toggleMark(): void {
    if (!this.target || !this.marks) return;
    try {
      this.marks.toggle(this.target);
    } catch (error) {
      this.renderPicker(undefined, true);
      this.status!.textContent =
        error instanceof Error ? error.message : "Could not mark element.";
      return;
    }
    this.drawMarks();
    this.renderPicker();
  }
  private reviewMarks(): void {
    if (!this.marks?.valid) {
      this.renderPicker(undefined, true);
      this.status!.textContent =
        "Mark at least one element. Remove or reselect marks that changed.";
      return;
    }
    this.choose({ x: 0, y: 0, width: innerWidth, height: innerHeight });
  }
  private resumeMarks(): void {
    if (this.context)
      void send({
        type: "picker_forget",
        selection_id: this.context.selectionId,
      }).catch(() => {});
    this.generation++;
    this.submitting = false;
    this.context = undefined;
    this.requestId = crypto.randomUUID();
    this.submitted = false;
    this.lastSubmission = "";
    this.picking = true;
    this.shield!.style.display = "block";
    this.outline!.style.display = "none";
    this.renderPicker();
  }
  private move = (event: PointerEvent): void => {
    if (!this.picking || this.own(event)) return;
    this.ancestorNavigation = false;
    cancelAnimationFrame(this.frame);
    this.frame = requestAnimationFrame(() => {
      if (!this.picking) return;
      if (this.mode !== "region") {
        this.target = this.hit(event.clientX, event.clientY);
        if (this.target && this.marks)
          this.target = this.marks.containing(this.target) ?? this.target;
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
    if (this.marks && !this.picking && !this.own(event)) {
      this.suppress(event);
      if (
        event.type === "click" &&
        event.button === 0 &&
        performance.now() >= this.suppressUntil
      ) {
        const element = this.hit(event.clientX, event.clientY);
        const marked = element && this.marks.containing(element);
        if (marked) {
          this.resumeMarks();
          this.target = marked;
          this.toggleMark();
        }
      }
      return;
    }
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
      if (!this.ancestorNavigation)
        this.target = this.hit(event.clientX, event.clientY);
      if (this.marks) this.toggleMark();
      else if (this.target) this.choose(this.target.getBoundingClientRect());
    }
  };
  private key = (event: KeyboardEvent): void => {
    if (event.key === "Escape") {
      this.suppress(event);
      this.stop();
      return;
    }
    if (!this.picking || this.own(event)) {
      if (this.marks && !this.own(event)) this.suppress(event);
      return;
    }
    // Do not let typing activate a page action while selection owns interaction.
    this.suppress(event);
    if (event.type !== "keydown") return;
    if (event.altKey && event.key === "ArrowUp" && this.target?.parentElement) {
      this.children.push(this.target);
      this.target = this.target.parentElement;
      this.ancestorNavigation = true;
      this.drawTarget();
    }
    if (event.altKey && event.key === "ArrowDown" && this.children.length) {
      this.target = this.children.pop();
      this.ancestorNavigation = true;
      this.drawTarget();
    }
    if (event.key === "Enter") {
      if (this.marks) this.reviewMarks();
      else if (this.target) this.choose(this.target.getBoundingClientRect());
    }
  };
  private changed = (): void => {
    this.drawMarks();
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
    if (this.marks) {
      this.context.selection.marks = {
        groupId: this.marks.id,
        selector: this.marks.selector,
        itemIds: this.marks.items.map((mark) => mark.id),
      };
      this.context.redaction.warnings = [
        "Selector-only request: no selected DOM, text or screenshot is included. Read marked elements live via browser_dom.",
      ];
    }
    this.suppressUntil = performance.now() + 500;
    this.pageKey = this.currentPageKey();
    this.picking = false;
    this.shield!.style.display = this.marks ? "block" : "none";
    if (this.marks) this.outline!.style.display = "none";
    else this.draw(rect);
    this.renderPreview();
  }
  private valid(): boolean {
    return Boolean(
      this.context &&
      this.currentPageKey() === this.pageKey &&
      (this.mode !== "marks" || this.marks?.valid),
    );
  }
  private renderPreview(): void {
    this.panel!.classList.remove("compact");
    this.panel!.replaceChildren();
    this.text("Review selection before sending", "preview-title");
    const reselect = this.button("Select again", () =>
      this.marks ? this.resumeMarks() : this.start(this.mode, this.receiver),
    );
    reselect.className = "reselect";
    this.text(`Receiver: ${this.receiver}`, "muted");
    const question = document.createElement("textarea");
    question.placeholder = "Ask about this selection…";
    question.maxLength = 2000;
    this.panel!.append(question);
    this.status = this.text("Ready to send to the bound agent.");
    const actions = this.toolbar();
    if (!this.marks)
      this.button("Capture preview", () => this.capture(), actions);
    if (!this.marks)
      this.button(
        "Text only",
        () => {
          this.image = undefined;
          this.context!.screenshot = undefined;
          this.panel!.querySelector("img")?.remove();
          this.status!.textContent = "Image removed.";
        },
        actions,
      );
    this.button("Send", () => this.submit(question.value), actions);
    this.button(
      "Copy context",
      async () => {
        await navigator.clipboard.writeText(
          JSON.stringify(this.context, null, 2),
        );
        this.status!.textContent = "Context copied.";
      },
      actions,
    );
    this.button(
      "Forget / close",
      async () => {
        await send({
          type: "picker_forget",
          selection_id: this.context!.selectionId,
        });
        this.stop();
      },
      actions,
    );
  }
  private async capture(): Promise<void> {
    if (!this.valid()) throw new Error("Stale selection");
    if (this.mode === "element" && !this.target?.isConnected) {
      this.status!.textContent =
        "The original element is gone. Its text snapshot is saved; select again to capture an image.";
      return;
    }
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
    if (this.submitting) return;
    if (!this.valid()) {
      this.status!.textContent = "Selection is stale. Select again.";
      return;
    }
    const generation = this.generation;
    const cleanedQuestion = cleanText(question, 2000);
    const submission = JSON.stringify([
      cleanedQuestion,
      this.image?.png_base64,
    ]);
    if (
      this.submitted ||
      (this.lastSubmission && this.lastSubmission !== submission)
    )
      this.context!.requestId = crypto.randomUUID();
    this.lastSubmission = submission;
    this.context!.question = cleanedQuestion;
    this.submitting = true;
    this.status!.textContent = "Sending to the bound agent…";
    try {
      const result = await send({
        type: "picker_submit",
        context: this.context,
        image: this.image,
      });
      if (generation !== this.generation) return;
      this.submitted = result.ok === true;
      this.status!.textContent = result.ok
        ? result.notified === true
          ? "Saved and sent to the bound agent. Keep this tab open for its response."
          : "Queued for the bound agent. Keep this tab open for its response."
        : String(
            result.error ||
              "Not sent. Connect this tab to a session and retry.",
          );
    } finally {
      if (generation === this.generation) this.submitting = false;
    }
  }
  public command(message: Message): Message {
    if (message.action === "start") {
      this.start(
        message.mode === "marks"
          ? "marks"
          : message.mode === "region"
            ? "region"
            : "element",
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
      if (this.mode === "element" && !this.target?.isConnected)
        return {
          ok: false,
          error: "The original element is no longer on the page",
        };
      if (this.marks) this.drawMarks();
      else this.draw(this.context.selection.rect);
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
