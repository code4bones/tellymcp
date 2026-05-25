---
name: telly-human-telegram
description: Use when the current console received a human telegram_message, needs to reply through notify_telegram, or needs to open a page and send a browser screenshot back to the human with browser_screenshot(send_to_telegram=true). This skill covers direct human-facing telegram_mcp requests, not partner-to-partner return paths.
---

# Telly Human Telegram

Use this skill when the current console received a human Telegram request through `telegram_message`.

## Rules

- Start with `get_xchange_record` for the newest relevant `telegram_message`.
- If the request needs a text reply, finish with `notify_telegram`.
- If the request needs a browser screenshot sent to the human, use `browser_open` and then `browser_screenshot` with `send_to_telegram=true`.
- Do not save a screenshot locally and then search sqlite, route metadata, or session context just to deliver it.
- Do not stop at analysis or a summary.
- Call `mark_xchange_record_read` only after the required outbound tool succeeds.

## Preferred patterns

Text reply:
1. `get_xchange_record`
2. do the work
3. `notify_telegram`
4. `mark_xchange_record_read`

Browser screenshot reply:
1. `get_xchange_record`
2. `browser_open`
3. `browser_screenshot(send_to_telegram=true)`
4. `mark_xchange_record_read`
