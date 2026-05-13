import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { Logger } from "../../../shared/lib/logger/logger";
import type { ResolvedSessionDefaults } from "../../../shared/lib/project-identity/projectIdentity";
import type { CollaborationBackend } from "../../collaboration/model/backend";

export class GatewayCollaborationBackend implements CollaborationBackend {
  public constructor(
    private readonly logger: Logger,
    private readonly gatewayPublicUrl?: string,
  ) {}

  public async sendPartnerNote(
    _input: SendPartnerNoteInput,
    resolved: ResolvedSessionDefaults,
  ): Promise<SendPartnerNoteOutput> {
    this.logger.warn("Gateway collaboration backend is not implemented yet", {
      sessionId: resolved.sessionId,
      gatewayPublicUrlConfigured: Boolean(this.gatewayPublicUrl),
    });

    throw new Error(
      "Gateway collaboration backend is not implemented yet. Use DISTRIBUTED_MODE=client for local linked-session exchange for now.",
    );
  }
}
