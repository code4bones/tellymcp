import { readFileSync } from "node:fs";
import path from "node:path";
import vm from "node:vm";

import { describe, expect, it, vi } from "vitest";

const backgroundPath = path.resolve(
  "packages/chrome-attach-extension/src/background.js",
);
const backgroundSource = readFileSync(backgroundPath, "utf8");

const extractFunction = <T>(
  name: string,
  nextDeclaration: string,
  context: Record<string, unknown>,
): T => {
  const start = backgroundSource.indexOf(`function ${name}`);
  const asyncStart = backgroundSource.indexOf(`async function ${name}`);
  const resolvedStart = asyncStart >= 0 ? asyncStart : start;
  const end = backgroundSource.indexOf(`\n${nextDeclaration}`, resolvedStart);
  if (resolvedStart < 0 || end < 0) {
    throw new Error(
      `Could not extract ${name} from Chrome extension background`,
    );
  }
  const declaration = backgroundSource.slice(resolvedStart, end);
  vm.runInNewContext(`${declaration}\nthis.extracted = ${name};`, context);
  return context.extracted as T;
};

type TabActionResult = {
  ok: boolean;
  result?: Record<string, unknown>;
  error?: string;
};

type ExecuteTabAction = (
  action: string,
  payload: Record<string, unknown>,
) => Promise<TabActionResult>;

const createPageHarness = (): {
  execute: ExecuteTabAction;
  element: {
    click: ReturnType<typeof vi.fn>;
    focus: ReturnType<typeof vi.fn>;
    dispatchEvent: ReturnType<typeof vi.fn>;
  };
} => {
  const element = {
    attributes: [{ name: "id", value: "target" }],
    outerHTML: '<button id="target">Submit</button>',
    textContent: "Submit",
    value: "",
    click: vi.fn(),
    focus: vi.fn(),
    dispatchEvent: vi.fn(),
    scrollIntoView: vi.fn(),
    getBoundingClientRect: () => ({
      x: 1,
      y: 2,
      width: 100,
      height: 40,
    }),
  };
  const document = {
    body: element,
    activeElement: element,
    title: "Test page",
    querySelector: vi.fn(() => element),
    createTreeWalker: vi.fn(),
  };
  const context: Record<string, unknown> = {
    document,
    location: { href: "https://example.com/test" },
    NodeFilter: { SHOW_ELEMENT: 1 },
    Event: class TestEvent {
      public constructor(
        public readonly type: string,
        public readonly init: Record<string, unknown>,
      ) {}
    },
    KeyboardEvent: class TestKeyboardEvent {
      public constructor(
        public readonly type: string,
        public readonly init: Record<string, unknown>,
      ) {}
    },
    window: {
      getComputedStyle: () => ({
        display: "block",
        visibility: "visible",
        opacity: "1",
        getPropertyValue: (property: string) =>
          property === "display" ? "block" : "",
      }),
    },
    setTimeout,
  };
  const execute = extractFunction<ExecuteTabAction>(
    "executeTabActionInPage",
    "async function runTabAction",
    context,
  );
  return { execute, element };
};

describe("Chrome attach tab actions", () => {
  it("uses an MV3-compatible static executeScript function", () => {
    expect(backgroundSource).not.toContain("new Function(");
    expect(backgroundSource).toContain("func: executeTabActionInPage");
    expect(backgroundSource).toContain("args: [action, payload || {}]");
  });

  it("returns DOM data from the injected function", async () => {
    const { execute } = createPageHarness();

    await expect(execute("dom", { selector: "#target" })).resolves.toEqual({
      ok: true,
      result: {
        found: true,
        outer_html: '<button id="target">Submit</button>',
        text_content: "Submit",
        visible: true,
        attributes: { id: "target" },
        url: "https://example.com/test",
        title: "Test page",
      },
    });
  });

  it("executes click and press actions", async () => {
    const { execute, element } = createPageHarness();

    await expect(
      execute("click", { selector: "#target" }),
    ).resolves.toMatchObject({
      ok: true,
    });
    expect(element.click).toHaveBeenCalledOnce();

    await expect(
      execute("press", { selector: "#target", key: "Enter" }),
    ).resolves.toMatchObject({ ok: true });
    expect(element.focus).toHaveBeenCalledOnce();
    expect(element.dispatchEvent).toHaveBeenCalledTimes(3);
    expect(
      element.dispatchEvent.mock.calls.map(
        ([event]) => (event as { type: string }).type,
      ),
    ).toEqual(["keydown", "keypress", "keyup"]);
  });

  it("always returns a correlated WS error when tab execution throws", async () => {
    const sendJson = vi.fn();
    const context: Record<string, unknown> = {
      Error,
      runTabAction: vi.fn(async () => {
        throw new Error("execution denied");
      }),
      sendJson,
    };
    const handleTabActionMessage = extractFunction<
      (message: Record<string, unknown>) => Promise<void>
    >("handleTabActionMessage", "async function handleMessage", context);

    await handleTabActionMessage({
      type: "tab_action",
      request_id: "request-1",
      tab_id: 7,
      action: "dom",
      payload: {},
    });

    expect(sendJson).toHaveBeenCalledWith({
      type: "tab_action_result",
      request_id: "request-1",
      ok: false,
      error: "execution denied",
    });
  });

  it("captures recording snapshots without extension-worker closures", () => {
    const context: Record<string, unknown> = {
      Date,
      document: {
        title: "Snapshot page",
        readyState: "complete",
        documentElement: { outerHTML: "<html></html>" },
      },
      location: { href: "https://example.com/snapshot" },
    };
    const capture = extractFunction<
      (reason: string) => Record<string, unknown>
    >("capturePageSnapshotInTab", "async function captureTabSnapshot", context);

    expect(capture("manual")).toMatchObject({
      kind: "page_snapshot",
      source: "background",
      reason: "manual",
      url: "https://example.com/snapshot",
      title: "Snapshot page",
      ready_state: "complete",
      html: "<html></html>",
    });
  });
});
