---
name: telly-collab-artifact
description: Use when a telegram_mcp collab or partner_note task must return a real file or artifact such as a screenshot, html file, txt file, report, or generated output. Prefer send_partner_file over send_partner_note when the result exists as a local file, and return the artifact to the source console before any human Telegram reply.
---

# Telly Collab Artifact

Use this skill when the result must include a real file.

## Rules

- Prefer `send_partner_file` whenever the result already exists as a local file.
- Do not paste file contents into `send_partner_note` if a real file path is available.
- For inter-session work, return the artifact to the source console, then let the source console handle the human-facing reply.
- Only fall back to `send_partner_note` without `send_partner_file` when the result is purely textual.

## Preferred pattern

1. Produce the local file in the current console.
2. Verify the path exists in the current workspace.
3. Call `send_partner_file`.
4. Only after success, call `mark_xchange_record_read` if the incoming note required a reply.
