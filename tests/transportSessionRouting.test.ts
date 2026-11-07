import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import type { RedisClient } from "../src/services/features/telegram-mcp/src/app/providers/redis/client";
import { buildLiveRelaySessionId } from "../src/services/features/telegram-mcp/src/app/webapp/relay";
import type { SessionBindingStore } from "../src/services/features/telegram-mcp/src/shared/api/storage/contract";
import { ProcessLocalSessionStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalSessionStore";
import { ProcessLocalStateStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalStateStore";
import { RedisStateStore } from "../src/services/features/telegram-mcp/src/shared/integrations/redis/stateStore";
import { TransportConsoleRegistry } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportConsoleRegistry";
import {
  TransportMenuCallbacks,
  type TransportMenuCallbacksHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMenuCallbacks";
import {
  TransportMenuFlow,
  type TransportMenuFlowHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMenuFlow";
import {
  TransportMenuState,
  type TransportMenuStateHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMenuState";
import type { TelegramMenuContext } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";

const principal = { telegramChatId: 42, telegramUserId: 7 };
const vitaId = buildLiveRelaySessionId("client-vita", "vita");
const gitlabId = buildLiveRelaySessionId("client-gitlab", "gitlab");
const logger = { info: vi.fn(), error: vi.fn(), warn: vi.fn() };

function redisBindingStore() {
  const values = new Map<string, string>();
  const sets = new Map<string, Set<string>>();
  const redis = {
    get: async (key: string) => values.get(key) ?? null,
    set: async (key: string, value: string) => {
      values.set(key, value);
      return "OK";
    },
    del: async (key: string) => Number(values.delete(key)),
    sadd: async (key: string, value: string) => {
      const set = sets.get(key) ?? new Set<string>();
      set.add(value);
      sets.set(key, set);
      return 1;
    },
    srem: async (key: string, value: string) =>
      Number(sets.get(key)?.delete(value)),
    smembers: async (key: string) => [...(sets.get(key) ?? [])],
    sismember: async (key: string, value: string) =>
      Number(sets.get(key)?.has(value)),
  } as unknown as RedisClient;
  return new RedisStateStore(redis);
}

function harness(bindingStore: SessionBindingStore) {
  const sessionStore = new ProcessLocalSessionStore();
  const consoles = [
    {
      client_uuid: "client-vita",
      local_session_id: "vita",
      session_label: "Vita",
    },
    {
      client_uuid: "client-gitlab",
      local_session_id: "gitlab",
      session_label: "GitLabPlugins",
    },
  ].map((session) => ({
    ...session,
    owner_user_uuid: "petr",
    telegram_display_name: "Петр Олесов",
    project_names: [],
    project_uuids: [],
  }));
  const registry = new TransportConsoleRegistry({
    config: { distributed: {} } as AppConfig,
    logger,
    bindingStore,
    sessionStore,
    callGatewayJson: async <T>() => ({ sessions: consoles }) as T,
  });
  const ctx = {
    answerCallbackQuery: vi.fn(async () => undefined),
  } as unknown as TelegramMenuContext;
  const callbacks = new TransportMenuCallbacks({
    logger,
    bindingStore,
    sessionStore,
    getPrincipalFromContext: () => principal,
    getMenuPayloadByKey: async (sessionId: string) => ({
      kind: "active-session",
      sessionId,
    }),
    maybeNotifyToolsMismatchForSession: async () => undefined,
    showMainMenu: async () => undefined,
  } as unknown as TransportMenuCallbacksHost);
  const sendLauncherMessage = vi.fn(async () => ({ message_id: 1 }));
  const shared = {
    logger,
    bindingStore,
    sessionStore,
    resolveLocaleForContext: async () => "en",
    getPrincipalFromContext: () => principal,
    t: (_locale: string, key: string, vars?: Record<string, unknown>) =>
      `${key} ${JSON.stringify(vars ?? {})}`,
  };
  const flow = new TransportMenuFlow({
    ...shared,
    getGatewayActorFromContext: () => undefined,
    liveActions: { canRender: () => true, sendLauncherMessage },
  } as unknown as TransportMenuFlowHost);
  const menuState = new TransportMenuState({
    ...shared,
    listActiveSessionScreenshots: async () => [],
    listActiveSessionStorageEntries: async () => [],
  } as unknown as TransportMenuStateHost);
  return {
    registry,
    consoles,
    ctx,
    callbacks,
    flow,
    menuState,
    sendLauncherMessage,
  };
}

describe.each([
  ["process-local", () => new ProcessLocalStateStore()],
  ["redis", redisBindingStore],
] as const)(
  "session selection during console synchronization (%s)",
  (_name, createStore) => {
    it.each([vitaId, gitlabId])(
      "keeps selected %s for Live and nested menus in either console order",
      async (selectedId) => {
        const store = createStore();
        const h = harness(store);
        await h.registry.ensureScopedConsolesBound({ principal });
        await h.callbacks.handleSessionSelection(h.ctx, selectedId);

        for (let cycle = 0; cycle < 2; cycle++) {
          h.consoles.reverse();
          const result = await h.registry.ensureScopedConsolesBound({
            principal,
          });
          expect(result.activeSessionId).toBe(selectedId);
          await h.flow.showLiveViewLauncher(h.ctx);
          expect(h.sendLauncherMessage).toHaveBeenLastCalledWith(
            expect.objectContaining({ sessionId: selectedId }),
          );
          const label = selectedId === vitaId ? "Vita" : "GitLabPlugins";
          expect(await h.menuState.buildBrowserMenuText(h.ctx)).toContain(
            label,
          );
          expect(await h.menuState.buildSettingsMenuText(h.ctx)).toContain(
            label,
          );
          expect(await h.menuState.buildStorageMenuText(h.ctx)).toContain(
            label,
          );
        }
      },
    );

    it("does not select a newly discovered console over the user's selection", async () => {
      const store = createStore();
      const h = harness(store);
      const second = h.consoles.pop()!;
      await h.registry.ensureScopedConsolesBound({ principal });
      await h.callbacks.handleSessionSelection(h.ctx, vitaId);
      h.consoles.push(second);
      await h.registry.ensureScopedConsolesBound({ principal });
      expect(await store.getActiveSessionIdForPrincipal(principal)).toBe(
        vitaId,
      );
      expect(
        await store.listBoundSessionIdsForPrincipal(principal),
      ).toHaveLength(2);
    });

    it("selects an available console when the selected one disappears", async () => {
      const store = createStore();
      const h = harness(store);
      await h.registry.ensureScopedConsolesBound({ principal });
      await h.callbacks.handleSessionSelection(h.ctx, vitaId);
      h.consoles.shift();
      const result = await h.registry.ensureScopedConsolesBound({ principal });
      expect(result.activeSessionId).toBe(gitlabId);
      expect(await store.listBoundSessionIdsForPrincipal(principal)).toEqual([
        gitlabId,
      ]);
    });

    it("still activates explicitly bound sessions by default", async () => {
      const store = createStore();
      for (const sessionId of [vitaId, gitlabId]) {
        await store.setBinding({
          ...principal,
          sessionId,
          linkedAt: "2026-10-25",
        });
        expect(await store.getActiveSessionIdForPrincipal(principal)).toBe(
          sessionId,
        );
      }
    });
  },
);
