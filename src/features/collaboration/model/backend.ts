import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types.js";
import type { ResolvedSessionDefaults } from "../../../shared/lib/project-identity/projectIdentity.js";

export interface CollaborationBackend {
  sendPartnerNote(
    input: SendPartnerNoteInput,
    resolved: ResolvedSessionDefaults,
  ): Promise<SendPartnerNoteOutput>;
}
