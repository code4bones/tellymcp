# TODO

Current focus areas after the gateway-first refactor:

## Runtime

- verify browser relay stability under repeated gateway-routed actions
- continue tmux-to-terminal naming cleanup in user-facing strings
- keep project binding and live console binding paths explicit and observable

## Docs

- keep `TOOLS.md` aligned with the actual MCP surface
- keep screenshots folder labeled as current vs legacy
- keep internal docs aligned with the gateway-first model

## UX

- evaluate whether `Info` and project screens need more concise summaries
- review current Telegram menu wording after the removal of `Local` and inbox flows
- review remaining user-facing `tmux` wording

## Packaging

- smoke-test npm global install on a clean machine
- smoke-test `tellymcp codex-plugin install` on a clean Codex host
- verify webhook mode setup docs against a real nginx deployment

## Data Model

- continue removing legacy assumptions around `gateway_sessions.project_uuid`
- keep `gateway_live_consoles` as the canonical live source
- keep project relations in dedicated binding tables
