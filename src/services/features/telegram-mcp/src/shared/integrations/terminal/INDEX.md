**Terminal Layer**
- `client.ts`
  Generic terminal facade used by higher-level code. It hides PTY runtime details from upper layers.
- `ptyRegistry.ts`
  In-process PTY backend powered by `node-pty`. Owns PTY lifecycle, buffer capture, resize, subscriptions, and foreground attach primitives.

**Design**
- New code should depend on `shared/integrations/terminal/client.ts`.
- `ptyRegistry.ts` is PTY-only and should stay below the generic terminal facade.

**Foreground Runtime**
- Foreground passthrough startup no longer lives in `src/cli.ts`.
- See:
  `src/services/features/telegram-mcp/src/features/foreground-terminal/model/foregroundTerminalRuntime.ts`

**Direction**
- The target architecture is:
  `feature/runtime code -> terminal/client.ts -> ptyRegistry.ts`
- This keeps upper layers isolated from PTY internals.
