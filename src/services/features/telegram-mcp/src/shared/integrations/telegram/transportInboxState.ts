import type { TelegramMenuContext } from "./transportTypes";
import { parseLiveRelaySessionId } from "../../../app/webapp/relay";

type Principal = { telegramChatId: number; telegramUserId: number };

export type InboxRouteSummary = {
  namespace: string;
  routeKey: string;
  label?: string;
  slug?: string;
  count: number;
};

export type InboxMessageSummary = {
  id: string;
  resourceKind: string;
  resourceId: string;
  status: string;
  statusReason?: string | null;
  title: string;
  summary: string;
  sender?: string;
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

  private canonicalSessionId(sessionId: string): string {
    const relay = parseLiveRelaySessionId(sessionId);
    if (relay) {
      return `${relay.clientUuid}:${relay.localSessionId}`;
    }
    if (sessionId.startsWith("relay~") || !sessionId.includes(":")) {
      throw new Error("A selected gateway console is required.");
    }
    return sessionId;
  }

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
      routes?.map((route) => `${route.namespace}:${route.routeKey}:${route.label ?? ""}:${route.slug ?? ""}:${route.count}`).join(",") ??
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
      session_id: this.canonicalSessionId(sessionId),
    });
  }

  public async resolveInboxMessage(
    messageId: string,
    decision: "approve" | "reject" | "defer",
    principal: Principal,
    sessionId: string,
  ): Promise<void> {
    const result = await this.host.callGatewayJson<{
      ok: boolean;
      status: string;
      status_reason?: string;
    }>("/inbox/resolve", {
      message_id: messageId,
      decision,
      telegram_user_id: principal.telegramUserId,
      session_id: this.canonicalSessionId(sessionId),
    });
    if (!result.ok) {
      throw new Error(
        result.status_reason || `Inbox delivery: ${result.status}`,
      );
    }
  }
}
