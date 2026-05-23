# Operational Invariants

1. Do not stop at inspection when a request requires a real outbound action.
2. Do not call `mark_xchange_record_read` before the required outbound tool succeeds.
3. Do not use `sleep` plus repeated `list_xchange_records` polling in the same turn after sending a partner request.
4. For inter-session work, the target console returns results to the source console, not directly to the human Telegram chat.
5. For human screenshot requests, prefer `browser_open` plus `browser_screenshot(send_to_telegram=true)` when the current console owns the browser runtime.
6. For partner screenshot requests, prefer `browser_open` plus `browser_screenshot`, then `send_partner_file` back to the source console.
7. Prefer `send_partner_file` over `send_partner_note` whenever the result is a real local file.
8. Do not invent routing or route-guessing fallbacks when the canonical path is known.
