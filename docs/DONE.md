# DONE

Completed work with dated evidence. This archive starts with the managed-agent
work on `2026-08-21`; older project history remains in `CHANGELOG.md` and Git.

## 2026-08-21 — Managed Agent Providers

- added provider-neutral agent discovery, installation entry points, Telegram
  selection, and client-owned launch (`14729ac`)
- replaced the Codex SDK prototype with a client-owned Codex app-server on a
  private Unix socket and connected the console TUI through `codex --remote`
  (`e341456`)
- continued the same Codex thread from Telegram through structured
  `turn/start`, with final responses delivered through the existing notify
  route (`4eab564`)
- verified the completed continuation path with build, lint, and the full test
  suite: 40 test files and 196 tests passed

## 2026-08-21 — Documentation

- reconciled the code-review and handoff backlog with the gateway-first runtime
  (`207a9de`)
