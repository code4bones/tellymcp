---
name: telly-partner-note
description: Use when the current console received an incoming partner_note, xchange partner request, inter-session task, collab ask/share request, or agent-to-agent reply path. Start with get_xchange_record, do the work in this console, return the result with send_partner_note or send_partner_file, and only then call mark_xchange_record_read.
---

# Telly Partner Note

Use this skill when the current console received an incoming `partner_note`.

## Rules

- Start with `get_xchange_record`.
- Read whether the note is a `request`, `question`, `reply`, or `handoff`.
- If the note requires a reply, the task is not complete until `send_partner_note` or `send_partner_file` succeeds.
- Do not stop at reading the note, listing files, or summarizing the task.
- Do not call `mark_xchange_record_read` before the outbound reply succeeds.
- If the newest note is `kind=reply` and does not require a reply, process the result and do not create another reply loop.

## Return path

- Return the result to the source console.
- Do not send the result directly to the human Telegram chat from the target console unless the instruction explicitly says this console is the human-facing endpoint.

## Preferred patterns

Text result:
1. `get_xchange_record`
2. do the work in this console
3. `send_partner_note`
4. `mark_xchange_record_read`

Artifact result:
1. `get_xchange_record`
2. do the work in this console
3. `send_partner_file`
4. `mark_xchange_record_read`
