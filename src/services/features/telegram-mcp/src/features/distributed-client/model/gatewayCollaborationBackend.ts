import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { MaintenanceStore } from "../../../shared/api/storage/contract";
import type { Logger } from "../../../shared/lib/logger/logger";
import type { ResolvedSessionDefaults } from "../../../shared/lib/project-identity/projectIdentity";
import type { CollaborationBackend } from "../../collaboration/model/backend";

function normalizeGatewayBaseUrl(value: string): URL {
  const url = new URL(value);
  url.pathname = url.pathname.replace(/\/+$/u, "");

  if (!url.pathname.endsWith("/gateway")) {
    url.pathname = `${url.pathname}/gateway`.replace(/\/{2,}/gu, "/");
  }

  return url;
}

export class GatewayCollaborationBackend implements CollaborationBackend {
  public constructor(
    private readonly logger: Logger,
    private readonly maintenanceStore: MaintenanceStore,
    private readonly gatewayPublicUrl?: string,
    private readonly gatewayAuthToken?: string,
  ) {}

  public async sendPartnerNote(
    input: SendPartnerNoteInput,
    resolved: ResolvedSessionDefaults,
  ): Promise<SendPartnerNoteOutput> {
    if (!this.gatewayPublicUrl) {
      throw new Error(
        "Gateway collaboration backend requires GATEWAY_PUBLIC_URL.",
      );
    }

    const url = normalizeGatewayBaseUrl(this.gatewayPublicUrl);
    url.pathname = `${url.pathname}/partner-note`.replace(/\/{2,}/gu, "/");
    const clientUuid = await this.maintenanceStore.getGatewayClientUuid();
    if (!clientUuid) {
      throw new Error(
        "Gateway collaboration requires a registered client_uuid. Join or create a project first.",
      );
    }

    const response = await fetch(url, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(this.gatewayAuthToken
          ? { authorization: `Bearer ${this.gatewayAuthToken}` }
          : {}),
      },
      body: JSON.stringify({
        ...input,
        session_id: input.session_id ?? resolved.sessionId,
        client_uuid: clientUuid,
      }),
    });

    if (!response.ok) {
      const message = await response.text();
      this.logger.warn("Gateway collaboration request failed", {
        sessionId: resolved.sessionId,
        status: response.status,
        gatewayUrl: url.toString(),
        responseText: message,
      });
      throw new Error(
        `Gateway collaboration request failed with status ${response.status}: ${message || response.statusText}`,
      );
    }

    const output = (await response.json()) as SendPartnerNoteOutput;
    this.logger.info("Partner note delivered through gateway backend", {
      sessionId: resolved.sessionId,
      gatewayUrl: url.toString(),
      shareId: output.share_id,
      kind: output.kind,
      partnerSessionId: output.partner_session_id,
      sessionIdDerived: resolved.sessionIdDerived,
    });
    return output;
  }
}
