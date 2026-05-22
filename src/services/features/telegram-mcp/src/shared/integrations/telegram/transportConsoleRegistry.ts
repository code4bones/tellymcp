import { buildLiveRelaySessionId } from "../../../app/webapp/relay";
import type { AppConfig } from "../../../app/config/env";
import type {
  SessionBindingStore,
  SessionStore,
} from "../../api/storage/contract";
import type { SessionContext } from "../../../entities/session/model/types";
import type { Logger } from "../../lib/logger/logger";
import type { TelegramMenuContext } from "./transportTypes";

type Principal = { telegramChatId: number; telegramUserId: number };

type GatewayKnownSessionRecord = {
  session_id: string;
  client_uuid: string;
  local_session_id: string;
  cwd?: string | null;
  session_label?: string | null;
  client_label?: string | null;
  system_username?: string | null;
  telegram_username?: string | null;
  telegram_display_name?: string | null;
  bot_username?: string | null;
  node_id?: string;
  package_version?: string;
  project_uuids: string[];
  project_names: string[];
  connected: boolean;
  registered: boolean;
};

export interface TransportConsoleRegistryHost {
  config: AppConfig;
  logger: Logger;
  sessionStore: SessionStore;
  bindingStore: SessionBindingStore;
  callGatewayJson<T>(path: string, payload?: Record<string, unknown>): Promise<T>;
}

export class TransportConsoleRegistry {
  public constructor(private readonly host: TransportConsoleRegistryHost) {}

  private readonly labelSeparator = " · ";

  private async clearStaleRelaySessions(input: {
    existingBound: Set<string>;
    liveRelaySessionIds: Set<string>;
  }): Promise<void> {
    for (const sessionId of input.existingBound) {
      if (!sessionId.startsWith("relay~")) {
        continue;
      }
      if (input.liveRelaySessionIds.has(sessionId)) {
        continue;
      }

      await this.host.bindingStore.clearBinding(sessionId);
      await this.host.sessionStore.clearSession(sessionId);
    }
  }

  public async listScopedConsoles(input?: {
    principal?: Principal;
  }): Promise<GatewayKnownSessionRecord[]> {
    const response = await this.host.callGatewayJson<{
      sessions?: GatewayKnownSessionRecord[];
    }>("/sessions/known", {
      connected_only: true,
      ...(input?.principal
        ? { telegram_user_id: input.principal.telegramUserId }
        : {}),
      ...(this.host.config.distributed.gatewayToken
        ? { gateway_token: this.host.config.distributed.gatewayToken }
        : {}),
    });

    return Array.isArray(response.sessions) ? response.sessions : [];
  }

  public async ensureScopedConsolesBound(input: {
    principal: Principal;
    ctx: TelegramMenuContext;
  }): Promise<{
    sessionIds: string[];
    activeSessionId: string | null;
  }> {
    const existingBound = new Set(
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(input.principal),
    );
    const consoles = await this.listScopedConsoles({
      principal: input.principal,
    });
    const liveRelaySessionIds = new Set(
      consoles.map((consoleSession) =>
        buildLiveRelaySessionId(
          consoleSession.client_uuid,
          consoleSession.local_session_id,
        ),
      ),
    );

    await this.clearStaleRelaySessions({
      existingBound,
      liveRelaySessionIds,
    });

    if (liveRelaySessionIds.size === 0) {
      const nextActive =
        await this.host.bindingStore.getActiveSessionIdForPrincipal(input.principal);
      return {
        sessionIds: [],
        activeSessionId: nextActive,
      };
    }

    const relaySessionIds: string[] = [];
    for (const consoleSession of consoles) {
      const relaySessionId = buildLiveRelaySessionId(
        consoleSession.client_uuid,
        consoleSession.local_session_id,
      );
      relaySessionIds.push(relaySessionId);
      await this.materializeRelaySession({
        ctx: input.ctx,
        principal: input.principal,
        relaySessionId,
        consoleSession,
      });
    }

    const existingActive =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(input.principal);
    const nextBound = new Set(
      await this.host.bindingStore.listBoundSessionIdsForPrincipal(input.principal),
    );
    const nextActive =
      existingActive && nextBound.has(existingActive)
        ? existingActive
        : relaySessionIds[0] ?? existingActive ?? null;
    if (nextActive) {
      await this.host.bindingStore.setActiveSessionIdForPrincipal(
        input.principal,
        nextActive,
      );
    }

    this.host.logger.info("Gateway scoped consoles synchronized for principal", {
      chatId: input.principal.telegramChatId,
      userId: input.principal.telegramUserId,
      consoleCount: relaySessionIds.length,
      activeSessionId: nextActive,
    });

    return {
      sessionIds: relaySessionIds,
      activeSessionId: nextActive,
    };
  }

  private async materializeRelaySession(input: {
    principal: Principal;
    ctx: TelegramMenuContext;
    relaySessionId: string;
    consoleSession: GatewayKnownSessionRecord;
  }): Promise<SessionContext> {
    const existingSession = await this.host.sessionStore.getSession(
      input.relaySessionId,
    );
    const label = this.buildConsoleLabel(input.consoleSession);
    const projectName = input.consoleSession.project_names[0] ?? undefined;
    const nextSession: SessionContext = {
      sessionId: input.relaySessionId,
      label,
      activeProjectUuid: input.consoleSession.project_uuids[0] ?? undefined,
      activeProjectName: projectName ?? undefined,
      ...(input.consoleSession.cwd?.trim()
        ? { cwd: input.consoleSession.cwd.trim() }
        : {}),
      updatedAt: new Date().toISOString(),
    };

    await this.host.sessionStore.setSession({
      ...(existingSession ?? nextSession),
      ...nextSession,
      ...(nextSession.cwd
        ? { cwd: nextSession.cwd }
        : existingSession?.cwd
          ? { cwd: existingSession.cwd }
          : {}),
      ...(existingSession?.task ? { task: existingSession.task } : {}),
      ...(existingSession?.summary ? { summary: existingSession.summary } : {}),
      ...(existingSession?.files ? { files: existingSession.files } : {}),
      ...(existingSession?.decisions
        ? { decisions: existingSession.decisions }
        : {}),
      ...(existingSession?.risks ? { risks: existingSession.risks } : {}),
      ...(existingSession?.lastSeenToolsHash
        ? { lastSeenToolsHash: existingSession.lastSeenToolsHash }
        : {}),
      ...(existingSession?.lastNotifiedToolsHash
        ? { lastNotifiedToolsHash: existingSession.lastNotifiedToolsHash }
        : {}),
    });

    await this.host.bindingStore.setBinding({
      sessionId: input.relaySessionId,
      telegramChatId: input.principal.telegramChatId,
      telegramUserId: input.principal.telegramUserId,
      ...(input.ctx.from?.username
        ? { telegramUsername: input.ctx.from.username }
        : {}),
      linkedAt: new Date().toISOString(),
    });

    return nextSession;
  }

  private buildConsoleLabel(session: GatewayKnownSessionRecord): string {
    const base =
      session.session_label?.trim() || session.local_session_id.trim() || "console";
    const owner =
      session.telegram_display_name?.trim() ||
      session.telegram_username?.trim() ||
      session.system_username?.trim() ||
      session.client_label?.trim() ||
      session.node_id?.trim() ||
      session.client_uuid.slice(0, 8);
    if (base.includes(this.labelSeparator)) {
      return base;
    }
    return owner ? `${base} · ${owner}` : base;
  }
}
