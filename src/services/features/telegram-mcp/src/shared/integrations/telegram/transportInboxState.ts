import type { TelegramMenuContext } from "./transportTypes";

type Principal = { telegramChatId: number; telegramUserId: number };

export type InboxRouteSummary = {
  namespace: string;
  routeKey: string;
  count: number;
};

export type InboxMessageSummary = {
  id: string;
  resourceKind: string;
  resourceId: string;
  status: string;
  title: string;
  summary: string;
  createdAt: string;
};

export interface TransportInboxStateHost {
  getPrincipalFromContext(ctx: TelegramMenuContext): Principal | null;
  callGatewayJson<T>(path: string, payload: Record<string, unknown>): Promise<T>;
  bindingStore: {
    getActiveSessionIdForPrincipal(principal: Principal): Promise<string | null>;
  };
}

// Deliberately thin compared to TransportProjectState: there is no
// create/join/invite flow here, just three gateway calls and the session
// that "Входящие" would bind to if the viewer picks a route. The generic
// inbox stays domain-agnostic server-side (any namespace, not just
// "marrow"), and so does this client-side layer.
export class TransportInboxState {
  public constructor(private readonly host: TransportInboxStateHost) {}

  public async loadInboxRoutesContext(ctx: TelegramMenuContext): Promise<{
    principal: Principal | null;
    sessionId: string | null;
    routes: InboxRouteSummary[] | null;
  }> {
    const principal = this.host.getPrincipalFromContext(ctx);
    if (!principal) {
      return { principal: null, sessionId: null, routes: null };
    }

    const sessionId =
      await this.host.bindingStore.getActiveSessionIdForPrincipal(principal);
    if (!sessionId) {
      return { principal, sessionId: null, routes: null };
    }

    const routes = await this.listInboxRoutes(principal);
    return { principal, sessionId, routes };
  }

  public async buildInboxRoutesFingerprint(ctx: TelegramMenuContext): Promise<string> {
    const { sessionId, routes } = await this.loadInboxRoutesContext(ctx);
    const routesKey =
      routes?.map((route) => `${route.namespace}:${route.routeKey}:${route.count}`).join(",") ??
      "none";
    return `${sessionId ?? "none"}:${routesKey}`;
  }

  public async listInboxRoutes(principal: Principal): Promise<InboxRouteSummary[]> {
    return this.host.callGatewayJson<InboxRouteSummary[]>("/inbox/routes", {
      telegram_user_id: principal.telegramUserId,
    });
  }

  public async listInboxMessages(
    principal: Principal,
    namespace: string,
    routeKey: string,
  ): Promise<InboxMessageSummary[]> {
    return this.host.callGatewayJson<InboxMessageSummary[]>("/inbox/messages", {
      telegram_user_id: principal.telegramUserId,
      namespace,
      route_key: routeKey,
    });
  }

  public async bindCurrentSessionToRoute(
    principal: Principal,
    sessionId: string,
    namespace: string,
    routeKey: string,
  ): Promise<void> {
    await this.host.callGatewayJson("/inbox/bind", {
      namespace,
      route_key: routeKey,
      telegram_user_id: principal.telegramUserId,
      session_id: sessionId,
    });
  }

  public async resolveInboxMessage(
    messageId: string,
    decision: "approve" | "reject" | "defer",
  ): Promise<void> {
    await this.host.callGatewayJson("/inbox/resolve", {
      message_id: messageId,
      decision,
    });
  }
}
