import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types.js";
import type { Logger } from "../../../shared/lib/logger/logger.js";
import { ProjectIdentityResolver } from "../../../shared/lib/project-identity/projectIdentity.js";
import type { CollaborationBackend } from "./backend.js";

export class CollaborationService {
  public constructor(
    private readonly backend: CollaborationBackend,
    private readonly logger: Logger,
    private readonly projectIdentityResolver: ProjectIdentityResolver,
  ) {}

  public async sendPartnerNote(
    input: SendPartnerNoteInput,
  ): Promise<SendPartnerNoteOutput> {
    const resolved = this.projectIdentityResolver.resolveSessionDefaults(input);
    const output = await this.backend.sendPartnerNote(input, resolved);

    this.logger.info("Partner note processed by collaboration service", {
      sessionId: output.session_id,
      partnerSessionId: output.partner_session_id,
      shareId: output.share_id,
      kind: output.kind,
      sessionIdDerived: resolved.sessionIdDerived,
    });

    return output;
  }
}
