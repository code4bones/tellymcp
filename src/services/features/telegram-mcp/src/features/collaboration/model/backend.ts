import type {
  SendPartnerNoteInput,
  SendPartnerNoteOutput,
} from "../../../entities/collaboration/model/types";
import type { ResolvedSessionDefaults } from "../../../shared/lib/project-identity/projectIdentity";

export interface CollaborationBackend {
  sendPartnerNote(
    input: SendPartnerNoteInput,
    resolved: ResolvedSessionDefaults,
  ): Promise<SendPartnerNoteOutput>;
}
