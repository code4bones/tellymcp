**Terminal Layer**
- `client.ts`
  Generic terminal facade used by higher-level code. This is the compatibility surface that hides whether the backend is `tmux` or built-in `pty`.
- `ptyRegistry.ts`
  In-process PTY backend powered by `node-pty`. Owns PTY lifecycle, buffer capture, resize, subscriptions, and foreground attach primitives.

**Design**
- New code should depend on `shared/integrations/terminal/client.ts`, not directly on `tmux/client.ts`.
- `tmux/client.ts` remains the legacy backend adapter and still implements the shared terminal contract for `tmux`.
- `ptyRegistry.ts` is PTY-only and should stay below the generic terminal facade.

**Foreground Runtime**
- Foreground passthrough startup no longer lives in `src/cli.ts`.
- See:
  `src/services/features/telegram-mcp/src/features/foreground-terminal/model/foregroundTerminalRuntime.ts`

**Direction**
- The target architecture is:
  `feature/runtime code -> terminal/client.ts -> tmux backend or pty backend`
- This keeps `tmux` removable without forcing upper layers to know about PTY internals.
