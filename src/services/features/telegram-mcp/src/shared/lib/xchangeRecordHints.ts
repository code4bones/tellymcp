import type { PartnerNoteKind } from "../../entities/collaboration/model/types";

export function buildIncomingPartnerActionDesc(
  kind: PartnerNoteKind,
  requiresReply: boolean,
): string {
  if (requiresReply || kind === "question" || kind === "request") {
    return "Read body_text and attachments, carry out the requested work in this session, then send the result back with send_partner_note. The task is not complete until send_partner_note succeeds.";
  }

  if (kind === "reply") {
    return "Read the reply, incorporate it into the current task, and only send a follow-up if more information is required.";
  }

  if (kind === "handoff") {
    return "Inspect the attached artifacts and body_text, then continue the task in this session. Reply only if the sender requested confirmation or more work.";
  }

  return "Read the shared update and attached artifacts, then continue the task in this session.";
}

export function buildIncomingPartnerTools(
  kind: PartnerNoteKind,
  requiresReply: boolean,
): string[] {
  const tools = ["get_xchange_record", "mark_xchange_record_read"];

  if (requiresReply || kind === "question" || kind === "request") {
    tools.push("send_partner_note");
  }

  if (kind === "handoff") {
    tools.push("send_partner_file");
  }

  return tools;
}

export function buildOutgoingPartnerActionDesc(
  kind: PartnerNoteKind,
  requiresReply: boolean,
): string {
  if (requiresReply || kind === "question" || kind === "request") {
    return "Waiting for the target session to process this note and send a reply.";
  }

  return "Outgoing collaboration note was sent to the target session.";
}

export function buildOutgoingPartnerTools(
  kind: PartnerNoteKind,
  requiresReply: boolean,
): string[] {
  const tools = ["get_xchange_record"];

  if (requiresReply || kind === "question" || kind === "request") {
    tools.push("list_xchange_records");
  }

  return tools;
}

export function buildLocalHandoffActionDesc(): string {
  return "Read body_text, inspect the attached local artifacts, and continue the task in this same session.";
}

export function buildLocalHandoffTools(): string[] {
  return ["get_xchange_record", "mark_xchange_record_read"];
}
