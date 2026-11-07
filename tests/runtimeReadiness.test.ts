import { expect, it, vi } from "vitest";
import { createAppRuntime } from "../src/services/features/telegram-mcp/src/app/bootstrap/runtime";
import schema from "../src/services/features/telegram-mcp/runtime.service";

vi.mock(
  "../src/services/features/telegram-mcp/src/app/bootstrap/runtime",
  () => ({ createAppRuntime: vi.fn() }),
);

it("observes early readiness failure while retaining the original rejection for later waiters", async () => {
  const error = new Error("injected bootstrap failure");
  vi.mocked(createAppRuntime).mockRejectedValueOnce(error);
  const hooks = schema as unknown as {
    created(this: object): void;
    started(this: object): Promise<void>;
  };
  const carrier: {
    runtime: unknown;
    readyPromise?: Promise<unknown>;
    logger: { info: () => void };
    broker: { call: () => Promise<void> };
  } = {
    runtime: null,
    logger: { info: () => {} },
    broker: { call: async () => {} },
  };
  hooks.created.call(carrier);
  await expect(hooks.started.call(carrier)).rejects.toBe(error);
  // Simulate broker.start failing before anyone has called waitUntilReady.
  // Vitest fails this test on the original unhandled rejection.
  await new Promise((resolve) => setTimeout(resolve, 10));
  await expect(carrier.readyPromise).rejects.toBe(error);
});
