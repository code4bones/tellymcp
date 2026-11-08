import { describe, expect, it, vi } from "vitest";
import { Menu } from "@grammyjs/menu";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import { buildLiveRelaySessionId } from "../src/services/features/telegram-mcp/src/app/webapp/relay";
import { ProcessLocalSessionStore } from "../src/services/features/telegram-mcp/src/shared/integrations/memory/processLocalSessionStore";
import { TransportMenuShell } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMenuShell";
import { TransportConsoleRegistry } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportConsoleRegistry";
import {
  TransportMenuFactories,
  type TransportMenuFactoriesHost,
} from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportMenuFactories";
import type { TelegramMenuContext } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/transportTypes";
import type { SessionContext } from "../src/services/features/telegram-mcp/src/entities/session/model/types";

const principal = { telegramChatId: 42, telegramUserId: 7 };
const ownerLabel = "Петр Олесов";
const vitaId = buildLiveRelaySessionId("client-vita", "vita");
const gitlabId = buildLiveRelaySessionId("client-gitlab", "gitlab");

function createHarness(sessions: SessionContext[]) {
  const payloads = new Map<string, Record<string, unknown>>();
  const sessionStore = new ProcessLocalSessionStore({
    initialSessions: sessions,
  });
  const storePayload = async (payload: Record<string, unknown>) => {
    const key = `payload-${payloads.size}`;
    payloads.set(key, payload);
    return key;
  };
  const host = {
    logger: { error: vi.fn(), info: vi.fn() },
    bindingStore: {
      listBoundSessionIdsForPrincipal: vi.fn(async () =>
        sessions.map((s) => s.sessionId),
      ),
      getActiveSessionIdForPrincipal: vi.fn(async () => vitaId),
      setActiveSessionIdForPrincipal: vi.fn(),
      setBinding: vi.fn(),
    },
    sessionStore,
    getPrincipalFromContext: () => principal,
    createMenuOptions: () => ({ onMenuOutdated: vi.fn() }),
    buildSessionsFingerprint: async () => "sessions",
    buildMainMenuFingerprint: async () => "main",
    tForContext: async (_ctx: TelegramMenuContext, key: string) => key,
    getMenuPayloadByKey: async (key: string) => payloads.get(key) ?? null,
    createSessionGroupMenuPayload: async (label: string, ownerKey?: string) =>
      storePayload({ kind: "session-group", ownerLabel: label, ownerKey }),
    createSessionMenuPayload: async (
      sessionId: string,
      label?: string,
      ownerKey?: string,
    ) =>
      storePayload({
        kind: "active-session",
        sessionId,
        ownerLabel: label,
        ownerKey,
      }),
    formatSessionMenuLabel: (input: { sessionLabel?: string }) =>
      input.sessionLabel,
  } as unknown as TransportMenuFactoriesHost;
  return {
    host,
    payloads,
    factories: new TransportMenuFactories(host),
    storePayload,
  };
}

async function render(menu: Menu<TelegramMenuContext>, match?: string) {
  const rows = await (
    menu as unknown as {
      render(
        ctx: TelegramMenuContext,
      ): Promise<Array<Array<{ text: string; callback_data: string }>>>;
    }
  ).render({ match } as unknown as TelegramMenuContext);
  return rows.flat();
}

function payloadKey(button: { callback_data: string }) {
  return button.callback_data.split("/")[3]!;
}

function sessions(ownerUserUuid?: string): SessionContext[] {
  return [
    {
      sessionId: vitaId,
      label: `Vita · ${ownerLabel}`,
      ownerUserUuid,
      updatedAt: "2026-10-25",
    },
    {
      sessionId: gitlabId,
      label: `GitLabPlugins · ${ownerLabel}`,
      ownerUserUuid,
      updatedAt: "2026-10-25",
    },
  ];
}

describe("Telegram account → sessions navigation", () => {
  it.each(["user-petr", undefined])(
    "groups two connections for one owner (%s)",
    async (ownerUuid) => {
      const { factories, payloads } = createHarness(sessions(ownerUuid));
      const menu = factories.createSessionsMenu();
      const accounts = (await render(menu)).filter((b) =>
        b.text.startsWith("👤"),
      );

      expect(accounts.map((b) => b.text)).toEqual([`👤 ${ownerLabel}`]);
      const buttons = await render(menu, payloadKey(accounts[0]!));
      expect(buttons.slice(0, 2).map((b) => b.text)).toEqual([
        "GitLabPlugins",
        "Vita",
      ]);
      expect(
        buttons.slice(0, 2).map((b) => payloads.get(payloadKey(b))?.sessionId),
      ).toEqual([gitlabId, vitaId]);
    },
  );

  it("keeps distinct accounts with the same display name separate", async () => {
    const rows = sessions("first-account");
    rows[1]!.ownerUserUuid = "second-account";
    const { factories, payloads } = createHarness(rows);
    const menu = factories.createSessionsMenu();
    const accounts = (await render(menu)).filter((b) =>
      b.text.startsWith("👤"),
    );

    expect(accounts).toHaveLength(2);
    expect(
      new Set(accounts.map((b) => payloads.get(payloadKey(b))?.ownerKey)).size,
    ).toBe(2);
    for (const account of accounts) {
      const buttons = await render(menu, payloadKey(account));
      expect(
        buttons.filter((b) => ["Vita", "GitLabPlugins"].includes(b.text)),
      ).toHaveLength(1);
    }
  });

  it("returns from the active session to the complete account session list", async () => {
    const { factories } = createHarness(sessions("user-petr"));
    const main = await render(factories.createMainMenu());
    const back = main.find((b) => b.text === "menu:main.buttons.back")!;
    const buttons = await render(
      factories.createSessionsMenu(),
      payloadKey(back),
    );
    expect(buttons.slice(0, 2).map((b) => b.text)).toEqual([
      "GitLabPlugins",
      "Vita",
    ]);
  });

  it("resolves old connection-based buttons to all sessions of the account", async () => {
    const { factories, storePayload } = createHarness(sessions("user-petr"));
    const oldKey = await storePayload({
      kind: "session-group",
      ownerLabel,
      ownerKey: "client-vita",
    });
    const buttons = await render(factories.createSessionsMenu(), oldKey);
    expect(buttons.slice(0, 2).map((b) => b.text)).toEqual([
      "GitLabPlugins",
      "Vita",
    ]);
  });

  it("preserves client grouping when no account or owner label is available", async () => {
    const rows = sessions().map((s) => ({ ...s, label: "Console" }));
    const { factories } = createHarness(rows);
    const buttons = await render(factories.createSessionsMenu());
    expect(buttons.filter((b) => b.text.startsWith("👤"))).toHaveLength(2);
  });

  it("retains the gateway owner ID when synchronizing console sessions", async () => {
    const { host } = createHarness([]);
    const registry = new TransportConsoleRegistry({
      config: { distributed: {} } as AppConfig,
      logger: host.logger,
      sessionStore: host.sessionStore,
      bindingStore: host.bindingStore,
      callGatewayJson: vi.fn(async () => ({
        sessions: [
          {
            client_uuid: "client-vita",
            local_session_id: "vita",
            owner_user_uuid: "user-petr",
            session_label: "Vita",
            telegram_display_name: ownerLabel,
            project_uuids: [],
            project_names: [],
          },
        ],
      })),
    });
    await registry.ensureScopedConsolesBound({ principal });
    expect(await host.sessionStore.getSession(vitaId)).toMatchObject({
      ownerUserUuid: "user-petr",
      label: `Vita · ${ownerLabel}`,
    });
  });
});

describe("session menu without provider controls", () => {
  it("renders only console tools and invalidates old Agent keyboard positions", async () => {
    const { factories } = createHarness(sessions("user-petr"));
    const buttons = await render(factories.createMainMenu());
    expect(buttons.map((b) => b.text)).toEqual([
      "menu:main.buttons.live",
      "menu:main.buttons.content",
      "menu:main.buttons.browser",
      "menu:main.buttons.collab",
      "menu:main.buttons.storage",
      "menu:main.buttons.settings",
      "menu:main.buttons.externalInbox",
      "menu:main.buttons.back",
    ]);
    const old = new Menu<TelegramMenuContext>("telegram-main-menu", {
      fingerprint: () => "main",
    })
      .text("menu:main.buttons.live", () => {})
      .row()
      .text("menu:main.buttons.agents", () => {});
    expect(buttons[0]!.callback_data).not.toBe(
      (await render(old))[0]!.callback_data,
    );
  });

  it("returns old Agent callbacks to the session menu without invoking provider controls", async () => {
    const handlers: Array<{
      pattern: string | RegExp;
      handler: (ctx: TelegramMenuContext) => Promise<void>;
    }> = [];
    const bot = {
      callbackQuery: (
        pattern: string | RegExp,
        handler: (ctx: TelegramMenuContext) => Promise<void>,
      ) => {
        handlers.push({ pattern, handler });
      },
      catch: vi.fn(),
      on: vi.fn(),
    };
    const showMainMenu = vi.fn(async () => {});
    new TransportMenuShell({ showMainMenu } as unknown as ConstructorParameters<
      typeof TransportMenuShell
    >[0]).register(bot as never);
    const callback = handlers.find(
      (h) =>
        h.pattern instanceof RegExp &&
        h.pattern.test("telegram-agent-menu/0/0//habcd"),
    )!;
    const ctx = {
      answerCallbackQuery: vi.fn(async () => {}),
    } as unknown as TelegramMenuContext;
    await callback.handler(ctx);
    expect(ctx.answerCallbackQuery).toHaveBeenCalledTimes(1);
    expect(showMainMenu).toHaveBeenCalledExactlyOnceWith(ctx);
  });
});
