import type { PartnerNoteKind } from "../../entities/collaboration/model/types";

function looksLikeBrowserScreenshotRequest(text: string): boolean {
  const haystack = text.toLowerCase();
  return (
    /\b(browser_open|browser_screenshot|playwright)\b/u.test(haystack) ||
    /\b(скриншот|screenshot|скрин)\b/u.test(haystack) ||
    /\bhttps?:\/\/[^\s]+/u.test(haystack)
  );
}

export function buildIncomingPartnerActionDesc(
  kind: PartnerNoteKind,
  requiresReply: boolean,
  prefersFileDelivery = false,
  prefersBrowserScreenshot = false,
): string {
  if (requiresReply || kind === "question" || kind === "request") {
    if (prefersBrowserScreenshot) {
      return "Start with get_xchange_record for the newest partner_note. For a webpage screenshot request, use browser_open and browser_screenshot in this console to create the screenshot artifact, then send that real file back with send_partner_file. Do not stop at analysis, do not just summarize the request, and do not replace the browser workflow with a shell fallback unless the browser tools actually fail. The task is not complete until send_partner_file succeeds. Only after that may you call mark_xchange_record_read.";
    }
    if (prefersFileDelivery) {
      return "Start with get_xchange_record for the newest partner_note, then carry out the requested work in this session and send the result back as a real file with send_partner_file. Do not stop at analysis, do not just summarize the request, and do not paste file contents into send_partner_note. The task is not complete until send_partner_file succeeds. Only after that may you call mark_xchange_record_read.";
    }
    return "Start with get_xchange_record for the newest partner_note, then carry out the requested work in this session and send the result back with send_partner_note. Do not stop at analysis and do not just restate the request. The task is not complete until send_partner_note succeeds. Only after that may you call mark_xchange_record_read.";
  }

  if (kind === "reply") {
    return "Read the reply and inspect any returned artifacts. If this reply completes a task that originally came from a human telegram_message in this session, you must forward the final result to the human now. Use notify_telegram for text-only results. If the reply returned a real local artifact or file, use send_file_to_telegram to deliver that file to the human Telegram chat. Do not leave the result only in local xchange records. Only after the human-facing delivery succeeds, or after you have incorporated the reply into a non-human internal task, may you call mark_xchange_record_read.";
  }

  if (kind === "handoff") {
    return "Inspect the attached artifacts and body_text, then continue the task in this session. Reply only if the sender requested confirmation or more work.";
  }

  return "Read the shared update and attached artifacts, then continue the task in this session.";
}

export function buildIncomingPartnerTools(
  kind: PartnerNoteKind,
  requiresReply: boolean,
  prefersFileDelivery = false,
  prefersBrowserScreenshot = false,
): string[] {
  const tools = ["get_xchange_record"];

  if (prefersBrowserScreenshot) {
    tools.push("browser_open", "browser_screenshot");
  }

  if (prefersFileDelivery) {
    tools.push("send_partner_file");
  }

  if (requiresReply || kind === "question" || kind === "request") {
    tools.push("send_partner_note");
  }

  if (kind === "handoff" && !tools.includes("send_partner_file")) {
    tools.push("send_partner_file");
  }

  if (kind === "reply") {
    tools.push("notify_telegram", "send_file_to_telegram");
  }

  tools.push("mark_xchange_record_read");

  return tools;
}

export function buildOutgoingPartnerActionDesc(
  kind: PartnerNoteKind,
  requiresReply: boolean,
): string {
  if (requiresReply || kind === "question" || kind === "request") {
    return "Outgoing collaboration note was sent to the target session. Do not block on sleep, polling, or repeated list_xchange_records calls in the same turn. The target console will be nudged separately and can reply later through the normal xchange path.";
  }

  return "Outgoing collaboration note was sent to the target session.";
}

export function buildOutgoingPartnerTools(
  kind: PartnerNoteKind,
  requiresReply: boolean,
): string[] {
  void kind;
  void requiresReply;
  return ["get_xchange_record"];
}

export function buildLocalHandoffActionDesc(): string {
  return "Read body_text, inspect the attached local artifacts, and continue the task in this same session.";
}

export function buildLocalHandoffTools(): string[] {
  return ["get_xchange_record", "mark_xchange_record_read"];
}

export function buildIncomingTelegramMessageActionDesc(
  kind: PartnerNoteKind,
  prefersBrowserScreenshot = false,
): string {
  if (kind === "question" || kind === "request") {
    if (prefersBrowserScreenshot) {
      return "Start with get_xchange_record for the newest telegram_message. For a webpage screenshot request, use browser_open and browser_screenshot in this console, and set send_to_telegram=true on browser_screenshot so the PNG goes directly back to the human Telegram chat. Do not stop at analysis, do not just restate the request, do not save the screenshot locally and then search for route metadata, and do not call get_session_context just to deliver the screenshot. The task is not complete until browser_screenshot succeeds with send_to_telegram=true. Only after that may you call mark_xchange_record_read.";
    }
    return "Start with get_xchange_record for the newest telegram_message, then carry out the requested work in this session and reply to the human through notify_telegram. Do not stop at analysis and do not just restate the request. The task is not complete until notify_telegram succeeds. Only after that may you call mark_xchange_record_read.";
  }

  return "Read the Telegram message and attachments, continue the task in this session, and use notify_telegram only if a human-facing reply is needed.";
}

export function buildIncomingTelegramMessageTools(
  kind: PartnerNoteKind,
  prefersBrowserScreenshot = false,
): string[] {
  const tools = ["get_xchange_record"];

  if (prefersBrowserScreenshot && (kind === "question" || kind === "request")) {
    tools.push("browser_open", "browser_screenshot");
  } else if (kind === "question" || kind === "request") {
    tools.push("notify_telegram");
  }

  tools.push("mark_xchange_record_read");

  return tools;
}

export function detectIncomingTelegramBrowserScreenshotRequest(input: {
  kind: PartnerNoteKind;
  text: string;
  summary?: string;
}): boolean {
  if (input.kind !== "question" && input.kind !== "request") {
    return false;
  }

  return looksLikeBrowserScreenshotRequest(
    [input.summary ?? "", input.text].join("\n"),
  );
}
