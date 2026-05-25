---
name: telly-browser-screenshot
description: Use when a telegram_mcp task says to open a webpage, use browser_open, take a screenshot with browser_screenshot, send a screenshot to Telegram with send_to_telegram=true, or return a screenshot artifact to another console with send_partner_file. Prefer this over shell Playwright fallbacks for browser screenshot work.
---

# Telly Browser Screenshot

Use this skill when the task says to open a webpage and make a screenshot.

## Rules

- Prefer `browser_open` and `browser_screenshot`.
- Do not replace the browser workflow with shell Playwright unless browser tools actually fail.
- If the screenshot must go straight back to the human Telegram chat from this console, set `send_to_telegram=true`.
- If the screenshot must go to another console, save the PNG through `browser_screenshot`, then return it with `send_partner_file`.
- Do not dig through sqlite or session context to guess delivery routes when the requested flow is already known.

## Preferred patterns

Human-facing screenshot:
1. `browser_open`
2. `browser_screenshot(send_to_telegram=true)`

Partner-facing screenshot:
1. `browser_open`
2. `browser_screenshot`
3. `send_partner_file`
