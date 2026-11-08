import {
  bitmapRect,
  cleanText,
  cleanUrl,
  clipRect,
  MAX_IMAGE_BYTES,
  TTL_MS,
  type Rect,
  type SelectionContext,
} from "./context";

type Message = Record<string, unknown>;
type Tab = { id: number; windowId: number; url?: string; active?: boolean };
type Adapter = {
  tab(id: number): Promise<Tab>;
  active(): Promise<Tab | undefined>;
  inject(id: number): Promise<unknown>;
  message(id: number, message: Message): Promise<Message>;
  capture(windowId: number): Promise<string>;
  selected(): number | null;
  submit?(tabId: number, context: SelectionContext): Promise<Message>;
};
type Entry = {
  context: SelectionContext;
  image?: { png_base64: string; width: number; height: number };
  expires: number;
};

export class InspectorBridge {
  private sessionId = "";
  private connectionId = "";
  private label = "";
  private entries = new Map<number, Entry[]>();
  private active = new Set<number>();
  public constructor(private adapter: Adapter) {}

  public bind(sessionId: string, connectionId: string, label: string): void {
    if (this.sessionId !== sessionId || this.connectionId !== connectionId)
      this.disconnect();
    this.sessionId = sessionId;
    this.connectionId = connectionId;
    this.label = label;
  }
  public disconnect(): void {
    for (const tabId of this.active)
      void this.adapter
        .message(tabId, { type: "picker_control", action: "stop" })
        .catch(() => {});
    this.active.clear();
    this.entries.clear();
    this.sessionId = "";
    this.connectionId = "";
    this.label = "";
  }
  public forgetTab(tabId: number): void {
    this.active.delete(tabId);
    this.entries.delete(tabId);
  }
  public invalidateTab(tabId: number): void {
    const active = this.active.has(tabId);
    this.forgetTab(tabId);
    if (active)
      void this.adapter
        .message(tabId, { type: "picker_control", action: "stop" })
        .catch(() => {});
  }
  public async start(
    tabId: number,
    mode: unknown,
    requestId?: unknown,
  ): Promise<Message> {
    const tab = await this.adapter.tab(tabId);
    if (!tab.url || !/^https?:\/\//.test(tab.url))
      throw new Error("Picker supports ordinary HTTP(S) pages only");
    if (this.active.size >= 8 && !this.active.has(tabId))
      throw new Error("Close another picker first");
    await this.adapter.inject(tabId);
    this.active.add(tabId);
    const request =
      typeof requestId === "string" && requestId.length <= 128
        ? requestId
        : crypto.randomUUID();
    const result = await this.adapter.message(tabId, {
      type: "picker_control",
      action: "start",
      mode:
        mode === "marks" ? "marks" : mode === "region" ? "region" : "element",
      receiver: this.sessionId
        ? `${this.label || this.sessionId} (${this.sessionId})`
        : "Local preview — no connected session",
      request_id: request,
    });
    if (!result.ok) throw new Error("Could not activate picker");
    return {
      ok: true,
      result: {
        request_id: request,
        status: "awaiting_user",
        ttl_seconds: TTL_MS / 1000,
        receiver: this.sessionId || null,
      },
    };
  }
  private prune(tabId: number): Entry[] {
    const entries = (this.entries.get(tabId) || []).filter(
      (e) => e.expires > Date.now(),
    );
    if (entries.length) this.entries.set(tabId, entries);
    else this.entries.delete(tabId);
    return entries;
  }
  public async action(
    tabId: number,
    action: string,
    payload: Message,
  ): Promise<Message> {
    if (
      !this.sessionId ||
      payload.session_id !== this.sessionId ||
      this.adapter.selected() !== tabId
    )
      throw new Error("Inspector is not bound to this session/tab");
    if (action === "inspector_start")
      return this.start(tabId, payload.mode, payload.request_id);
    if (action === "inspector_stop") {
      this.forgetTab(tabId);
      await this.adapter
        .message(tabId, { type: "picker_control", action: "stop" })
        .catch(() => {});
      return { ok: true, result: { status: "stopped" } };
    }
    const entries = this.prune(tabId);
    const candidates = entries.filter(
      (e) =>
        (!payload.selection_id ||
          e.context.selectionId === payload.selection_id) &&
        (!payload.request_id || e.context.requestId === payload.request_id),
    );
    const entry = candidates.at(-1);
    if (action === "inspector_get_selection") {
      return {
        ok: true,
        result: {
          status: entry ? "selected" : "pending",
          ...(entry
            ? {
                context: entry.context,
                ...(payload.include_image === true && entry.image
                  ? { image: entry.image }
                  : {}),
              }
            : {}),
        },
      };
    }
    if (!entry || entry.context.requestId !== payload.request_id)
      throw new Error("Selection/request expired or does not match");
    if (action !== "inspector_response" && action !== "inspector_highlight")
      throw new Error("Unsupported inspector action");
    const result = await this.adapter.message(tabId, {
      type: "picker_control",
      action: action === "inspector_response" ? "response" : "highlight",
      selection_id: entry.context.selectionId,
      request_id: entry.context.requestId,
      explanation:
        typeof payload.explanation === "string"
          ? payload.explanation.slice(0, 16_384)
          : "",
    });
    if (!result.ok)
      throw new Error("Selection is no longer available on the page");
    return {
      ok: true,
      result: {
        status: action === "inspector_response" ? "responded" : "highlighted",
      },
    };
  }
  public async runtime(
    message: Message,
    sender: { tab?: { id?: number }; frameId?: number },
  ): Promise<Message | undefined> {
    if (message.type === "picker_open") {
      // Extension popup only; content scripts cannot activate another tab.
      if (sender.tab)
        throw new Error("Use the extension popup to start a picker");
      const tab = await this.adapter.active();
      if (!tab) throw new Error("No active tab");
      return this.start(tab.id, message.mode);
    }
    if (!String(message.type).startsWith("picker_")) return undefined;
    const tabId = sender.tab?.id;
    if (
      tabId === undefined ||
      (sender.frameId ?? 0) !== 0 ||
      !this.active.has(tabId)
    )
      throw new Error(
        "Picker request is not from an active top-frame selection",
      );
    if (message.type === "picker_closed") {
      this.forgetTab(tabId);
      return { ok: true };
    }
    if (message.type === "picker_forget") {
      this.entries.set(
        tabId,
        this.prune(tabId).filter(
          (e) => e.context.selectionId !== message.selection_id,
        ),
      );
      return { ok: true };
    }
    if (message.type === "picker_capture")
      return { ok: true, image: await this.capture(tabId, message) };
    if (message.type !== "picker_submit")
      throw new Error("Unsupported picker message");
    if (!this.sessionId || this.adapter.selected() !== tabId)
      return {
        ok: false,
        error:
          "Not sent: attach this tab to the connected session in the Control Panel, then retry.",
      };
    if (
      !message.context ||
      new TextEncoder().encode(JSON.stringify(message.context)).byteLength >
        65_536
    )
      throw new Error("Selection context exceeds 64 KiB");
    const context = message.context as SelectionContext;
    const tab = await this.adapter.tab(tabId);
    if (
      context.schemaVersion !== 1 ||
      !context.selectionId ||
      !context.requestId ||
      !["element", "region", "marks"].includes(context.selection?.mode) ||
      context.page?.url !== cleanUrl(tab.url || "")
    )
      throw new Error("Stale or invalid selection");
    if (
      !Number.isFinite(Date.parse(context.timestamp)) ||
      Math.abs(Date.now() - Date.parse(context.timestamp)) > TTL_MS
    )
      throw new Error("Selection expired");
    context.source = {
      sessionId: this.sessionId,
      connectionId: this.connectionId,
      tabId: String(tabId),
    };
    context.question = cleanText(context.question || "", 2000);
    context.page.url = cleanUrl(context.page.url);
    let image: Entry["image"];
    if (message.image) {
      const candidate = message.image as NonNullable<Entry["image"]>;
      if (
        typeof candidate.png_base64 !== "string" ||
        candidate.png_base64.length >
          Math.ceil((MAX_IMAGE_BYTES * 4) / 3) + 4 ||
        !/^[A-Za-z0-9+/]+={0,2}$/.test(candidate.png_base64) ||
        !Number.isInteger(candidate.width) ||
        !Number.isInteger(candidate.height) ||
        candidate.width < 1 ||
        candidate.height < 1 ||
        candidate.width > 1600 ||
        candidate.height > 1600
      )
        throw new Error("Invalid screenshot");
      image = candidate;
      context.screenshot = {
        mimeType: "image/png",
        width: image.width,
        height: image.height,
        attachmentId: context.selectionId,
      };
    } else delete context.screenshot;
    const entries = this.prune(tabId).filter(
      (e) => e.context.selectionId !== context.selectionId,
    );
    entries.push({
      context,
      ...(image ? { image } : {}),
      expires: Date.now() + TTL_MS,
    });
    this.entries.set(tabId, entries.slice(-5));
    setTimeout(() => this.prune(tabId), TTL_MS);
    if (this.adapter.submit) {
      try {
        return await this.adapter.submit(tabId, context);
      } catch {
        return {
          ok: false,
          error:
            "Console delivery was not confirmed. Check the console and retry.",
        };
      }
    }
    return {
      ok: true,
      status: "queued",
      request_id: context.requestId,
      selection_id: context.selectionId,
    };
  }
  private async capture(
    tabId: number,
    message: Message,
  ): Promise<NonNullable<Entry["image"]>> {
    const tab = await this.adapter.tab(tabId);
    const active = await this.adapter.active();
    if (!tab.active || active?.id !== tabId || tab.url !== message.page_url)
      throw new Error("Keep the selected tab active while capturing");
    const viewport = message.viewport as { width: number; height: number };
    const rect = clipRect(
      message.rect as Rect,
      viewport?.width,
      viewport?.height,
    );
    const dataUrl = await this.adapter.capture(tab.windowId);
    const after = await this.adapter.active();
    const refreshed = await this.adapter.tab(tabId);
    if (after?.id !== tabId || refreshed.url !== message.page_url)
      throw new Error("Tab changed during capture");
    const blob = await (await fetch(dataUrl)).blob();
    const bitmap = await createImageBitmap(blob);
    try {
      const crop = bitmapRect(rect, viewport, bitmap);
      const scale = Math.min(1, 1600 / Math.max(crop.width, crop.height));
      const width = Math.max(1, Math.round(crop.width * scale)),
        height = Math.max(1, Math.round(crop.height * scale));
      const canvas = new OffscreenCanvas(width, height);
      const ctx = canvas.getContext("2d")!;
      ctx.drawImage(
        bitmap,
        crop.x,
        crop.y,
        crop.width,
        crop.height,
        0,
        0,
        width,
        height,
      );
      if (!Array.isArray(message.masks) || message.masks.length > 500)
        throw new Error("Invalid redaction masks");
      ctx.fillStyle = "#101827";
      for (const mask of message.masks as Rect[]) {
        if (![mask.x, mask.y, mask.width, mask.height].every(Number.isFinite))
          throw new Error("Invalid redaction mask");
        ctx.fillRect(
          ((mask.x * bitmap.width) / viewport.width - crop.x) * scale,
          ((mask.y * bitmap.height) / viewport.height - crop.y) * scale,
          ((mask.width * bitmap.width) / viewport.width) * scale,
          ((mask.height * bitmap.height) / viewport.height) * scale,
        );
      }
      const image = await canvas.convertToBlob({ type: "image/png" });
      if (image.size > MAX_IMAGE_BYTES)
        throw new Error(
          "Image too large. Select a smaller region or use text only.",
        );
      const bytes = new Uint8Array(await image.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 8192)
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 8192));
      return { png_base64: btoa(binary), width, height };
    } finally {
      bitmap.close();
    }
  }
}

export class PickerDeliveryClient {
  private supported = false;
  private marksSupported = false;
  private readonly pending = new Map<
    string,
    {
      promise: Promise<Message>;
      resolve: (message: Message) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();

  public constructor(private readonly send: (message: Message) => boolean) {}
  public bind(supported: boolean, marksSupported = false): void {
    this.supported = supported;
    this.marksSupported = marksSupported;
  }
  public disconnect(): void {
    this.supported = false;
    this.marksSupported = false;
    for (const [requestId, pending] of this.pending) {
      clearTimeout(pending.timer);
      pending.resolve({
        ok: false,
        request_id: requestId,
        error:
          "Console disconnected before delivery confirmation. Check the console before retrying.",
      });
    }
    this.pending.clear();
  }
  public receive(message: Message): void {
    const pending = this.pending.get(String(message.request_id));
    if (!pending) return;
    clearTimeout(pending.timer);
    this.pending.delete(String(message.request_id));
    pending.resolve(message);
  }
  public submit(tabId: number, context: SelectionContext): Promise<Message> {
    if (
      !this.supported ||
      (context.selection.mode === "marks" && !this.marksSupported)
    )
      return Promise.resolve({
        ok: false,
        error:
          "Automatic delivery needs an updated console. Update TellyMCP and restart the source owner, then retry.",
      });
    const requestId = context.requestId;
    const existing = this.pending.get(requestId);
    if (existing) return existing.promise;
    if (this.pending.size >= 8)
      return Promise.resolve({
        ok: false,
        error: "Too many pending Picker requests.",
      });
    let resolve!: (message: Message) => void;
    const promise = new Promise<Message>((done) => {
      resolve = done;
    });
    const timer = setTimeout(
      () =>
        this.receive({
          request_id: requestId,
          ok: false,
          error:
            "Console delivery confirmation timed out. Check the console before retrying.",
        }),
      35_000,
    );
    this.pending.set(requestId, { promise, resolve, timer });
    try {
      if (
        !this.send({
          type: "picker_submit",
          request_id: requestId,
          selection_id: context.selectionId,
          tab_id: tabId,
        })
      )
        this.receive({
          request_id: requestId,
          ok: false,
          error: "Console is disconnected.",
        });
    } catch {
      this.receive({
        request_id: requestId,
        ok: false,
        error: "Could not send to the console.",
      });
    }
    return promise;
  }
}

(
  globalThis as unknown as {
    tellyInspector: {
      createBridge(adapter: Adapter): InspectorBridge;
      createDelivery(send: (message: Message) => boolean): PickerDeliveryClient;
    };
  }
).tellyInspector = {
  createBridge: (adapter) => new InspectorBridge(adapter),
  createDelivery: (send) => new PickerDeliveryClient(send),
};
