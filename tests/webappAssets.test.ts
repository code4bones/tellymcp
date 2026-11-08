import vm from "node:vm";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  WEBAPP_APP_JS,
  renderWebAppHtml,
} from "../src/services/features/telegram-mcp/src/app/webapp/assets";

type Listener = {
  callback: (event: Record<string, unknown>) => void;
  once: boolean;
};

type WebAppTestState = {
  token: string | null;
  liveSocket: FakeWebSocket | null;
  liveSocketConnected: boolean;
  liveReconnectTimer: ReturnType<typeof setTimeout> | null;
  xterm: { cols: number; rows: number } | null;
  xtermFitAddon: { fit: () => void } | null;
};

class FakeWebSocket {
  public static readonly OPEN = 1;
  public static readonly instances: FakeWebSocket[] = [];

  public readyState = 0;
  public readonly sent: string[] = [];
  private readonly listeners = new Map<string, Listener[]>();

  public constructor(public readonly url: string) {
    FakeWebSocket.instances.push(this);
  }

  public addEventListener(
    type: string,
    callback: (event: Record<string, unknown>) => void,
    options?: { once?: boolean },
  ): void {
    const listeners = this.listeners.get(type) ?? [];
    listeners.push({ callback, once: options?.once === true });
    this.listeners.set(type, listeners);
  }

  public send(payload: string): void {
    this.sent.push(payload);
  }

  public close(): void {
    this.readyState = 3;
    this.emit("close");
  }

  public open(): void {
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  public listenerCount(type: string): number {
    return this.listeners.get(type)?.length ?? 0;
  }

  private emit(type: string, event: Record<string, unknown> = {}): void {
    const listeners = [...(this.listeners.get(type) ?? [])];
    this.listeners.set(
      type,
      listeners.filter((listener) => !listener.once),
    );
    for (const listener of listeners) {
      listener.callback(event);
    }
  }
}

function createElement() {
  return {
    textContent: "",
    innerHTML: "",
    hidden: false,
    disabled: false,
    classList: { add: vi.fn(), toggle: vi.fn() },
    addEventListener: vi.fn(),
    setAttribute: vi.fn(),
  };
}

function createWebAppHarness(
  href = "https://example.test/telegram-mcp/webapp",
) {
  const elements = new Map<string, ReturnType<typeof createElement>>();
  const script = {
    src: "",
    async: false,
    onload: null,
    onerror: null,
    remove: vi.fn(),
  };
  const appendChild = vi.fn();
  const windowObject = {
    __TELEGRAM_MCP_WEBAPP__: {
      basePath: "/telegram-mcp/webapp",
      liveWsPath: "/telegram-mcp/webapp/api/live/ws",
    },
    location: { href },
    addEventListener: vi.fn(),
    setTimeout,
    localStorage: { getItem: vi.fn(), setItem: vi.fn() },
  };
  const source = WEBAPP_APP_JS.replace(
    /\nmain\(\);\n$/u,
    `\nglobalThis.__webAppTestHooks = {
      state,
      initializeTelegram,
      bootstrap,
      fitTerminal,
      renderTerminalPayload,
      connectLiveSocket,
      scheduleLiveReconnect,
    };\n`,
  );
  const context = vm.createContext({
    URL,
    URLSearchParams,
    WebSocket: FakeWebSocket,
    clearTimeout,
    console,
    document: {
      createElement: () => script,
      head: { appendChild },
      querySelector(selector: string) {
        const existing = elements.get(selector);
        if (existing) {
          return existing;
        }
        const element = createElement();
        elements.set(selector, element);
        return element;
      },
    },
    fetch: vi.fn(),
    setTimeout,
    window: windowObject,
  });
  vm.runInContext(source, context);

  const hooks = (
    context as unknown as {
      __webAppTestHooks: {
        state: WebAppTestState;
        initializeTelegram: () => Promise<void>;
        bootstrap: () => Promise<unknown>;
        fitTerminal: (notifyServer?: boolean) => void;
        renderTerminalPayload: (
          payload: Record<string, unknown>,
          options?: Record<string, unknown>,
        ) => void;
        connectLiveSocket: () => Promise<void>;
      };
    }
  ).__webAppTestHooks;
  return { ...hooks, script, appendChild, context };
}

afterEach(() => {
  FakeWebSocket.instances.length = 0;
  vi.useRealTimers();
});

describe("Telegram WebApp live console assets", () => {
  it.each(["?token=browser-token", "#token=browser-token"])(
    "bootstraps a browser link without requesting the Telegram SDK (%s)",
    async (suffix) => {
      const hooks = createWebAppHarness(
        "https://example.test/telegram-mcp/webapp" + suffix,
      );
      const fetch = vi
        .fn()
        .mockResolvedValue({
          ok: true,
          json: async () => ({ token: "session-token" }),
        });
      hooks.context.fetch = fetch;
      await hooks.initializeTelegram();
      await hooks.bootstrap();
      expect(hooks.appendChild).not.toHaveBeenCalled();
      expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
        directToken: "browser-token",
      });
    },
  );

  it("loads the SDK before Mini App authentication", async () => {
    const hooks = createWebAppHarness();
    const loading = hooks.initializeTelegram();
    expect(hooks.appendChild).toHaveBeenCalledWith(hooks.script);
    const initData = "auth_date=123&hash=fixture";
    hooks.context.window.Telegram = {
      WebApp: { initData, initDataUnsafe: { user: { id: 42 } } },
    };
    const fetch = vi
      .fn()
      .mockResolvedValue({
        ok: true,
        json: async () => ({ token: "session-token" }),
      });
    hooks.context.fetch = fetch;
    (hooks.script.onload as unknown as () => void)();
    await loading;
    await hooks.bootstrap();
    expect(JSON.parse(fetch.mock.calls[0][1].body)).toEqual({
      initDataRaw: initData,
      initDataUnsafe: { user: { id: 42 } },
    });
  });

  it("reports a bounded SDK timeout instead of waiting indefinitely", async () => {
    vi.useFakeTimers();
    const hooks = createWebAppHarness();
    const result = expect(hooks.initializeTelegram()).rejects.toThrow(
      "Telegram SDK timed out",
    );
    await vi.advanceTimersByTimeAsync(10000);
    await result;
    expect(hooks.script.remove).toHaveBeenCalledOnce();
    expect(hooks.context.fetch).not.toHaveBeenCalled();
  });

  it("embeds the official fit addon before the application script", () => {
    const html = renderWebAppHtml({
      basePath: "/telegram-mcp/webapp",
      liveWsPath: "/telegram-mcp/webapp/api/live/ws",
      launchMode: "default",
    });

    expect(html).toContain("FitAddon");
    expect(html.indexOf("e.FitAddon=t()")).toBeLessThan(
      html.indexOf("const source ="),
    );
    expect(WEBAPP_APP_JS).not.toContain("._renderService");
    expect(WEBAPP_APP_JS).not.toContain("estimateTerminalSizeFromPayload");
    expect(WEBAPP_APP_JS).not.toContain("/api/view");
    expect(WEBAPP_APP_JS).not.toContain("startPolling");
  });

  it("uses fitted columns and rows in the resize message", () => {
    const hooks = createWebAppHarness();
    const socket = new FakeWebSocket("wss://example.test/live");
    socket.readyState = FakeWebSocket.OPEN;
    hooks.state.liveSocket = socket;
    hooks.state.liveSocketConnected = true;
    hooks.state.xterm = { cols: 80, rows: 24 };
    hooks.state.xtermFitAddon = {
      fit() {
        hooks.state.xterm.cols = 57;
        hooks.state.xterm.rows = 19;
      },
    };

    hooks.fitTerminal();

    expect(socket.sent).toEqual([
      JSON.stringify({ type: "resize", cols: 57, rows: 19 }),
    ]);
  });

  it("renders full snapshots directly at the fitted viewport size", () => {
    const hooks = createWebAppHarness();
    const terminal = {
      cols: 80,
      rows: 24,
      buffer: { active: { viewportY: 0, baseY: 0 } },
      reset: vi.fn(),
      write: vi.fn(),
      scrollToBottom: vi.fn(),
      scrollToLine: vi.fn(),
    };
    hooks.state.xterm = terminal;
    hooks.state.xtermFitAddon = {
      fit() {
        terminal.cols = 61;
        terminal.rows = 18;
      },
    };

    hooks.renderTerminalPayload({
      ansi: "first line\nsecond line",
      cols: 120,
      rows: 80,
    });

    expect(terminal.reset).toHaveBeenCalledOnce();
    expect(terminal.write).toHaveBeenCalledWith("first line\nsecond line");
    expect({ cols: terminal.cols, rows: terminal.rows }).toEqual({
      cols: 61,
      rows: 18,
    });
  });

  it("reconnects after a live socket closes", async () => {
    vi.useFakeTimers();
    const hooks = createWebAppHarness();
    hooks.state.token = "webapp-token";

    const initialConnection = hooks.connectLiveSocket();
    const firstSocket = FakeWebSocket.instances[0];
    expect(firstSocket.listenerCount("message")).toBe(1);
    firstSocket.open();
    await initialConnection;

    firstSocket.close();
    expect(hooks.state.liveSocketConnected).toBe(false);
    expect(hooks.state.liveReconnectTimer).not.toBeNull();

    vi.advanceTimersByTime(1000);
    await Promise.resolve();
    const secondSocket = FakeWebSocket.instances[1];
    expect(secondSocket).toBeDefined();
    secondSocket.open();
    await Promise.resolve();
    await Promise.resolve();

    expect(hooks.state.liveSocket).toBe(secondSocket);
    expect(hooks.state.liveSocketConnected).toBe(true);
    expect(hooks.state.liveReconnectTimer).toBeNull();
  });
});
