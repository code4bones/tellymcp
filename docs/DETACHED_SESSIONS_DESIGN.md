# Detached sessions in TellyMCP

Status: design with an isolated stage-1 prototype, updated 2026-11-07.
Branch: `feature/detached-sessions`, merged with `main` at `13a14e0` in
`b34bb74`. Current package baseline: `0.0.43`; the original `0.0.38` baseline
is historical. The public commands below still describe proposed behavior.

TellyMCP should keep a running local console alive when its terminal disconnects,
an SSH connection drops, or the user deliberately sends the session into the
background. Reattaching must return to the same shell and agent processes with
their current screen. The existing terminal experience and single
`@deadragdoll/tellymcp` package remain the product contract.

The same attachment client should also reach an existing console through the
gateway from another workstation authenticated as the same account. Local and
remote attach share terminal semantics and the background owner; they differ
in transport and authorization.

## Scope

The first release targets Linux and provides one background owner process per
console session, one interactive controller, explicit detach, discovery,
reattach, and explicit stop. Implementation proceeds from local attach to
gateway attach using the same owner protocol. Attached input and output continue through
the PTY without a replacement Telly interface.

Windows, panes, windows, terminal layouts, shared interactive viewers, automatic
agent restart, and restoration after host reboot are outside this release.
macOS support requires its own process and terminal integration checks.

Survival depends on the owner process remaining alive. A host shutdown, owner
crash, or administrator terminating the user's processes ends the live session.
A system configured to kill every process in a login session on logout may need
a user service or administrator configuration; daemonizing alone does not
override that policy. Test the deployed SSH/login configuration before claiming
disconnect survival on that host.

## Current implementation

[`foregroundTerminalRuntime.ts`](../src/services/features/telegram-mcp/src/features/foreground-terminal/model/foregroundTerminalRuntime.ts)
creates the embedded broker, registers the console, optionally starts an agent,
and connects the current terminal directly to its PTY. Finishing that attachment
currently stops the broker and all PTYs in the process.

[`ptyRegistry.ts`](../src/services/features/telegram-mcp/src/shared/integrations/terminal/ptyRegistry.ts)
owns `node-pty` processes and headless xterm buffers in a process-local map. It
already supports input, resize, output subscriptions, and terminal capture.
`subscribePtyTarget` can unsubscribe without killing a PTY, but the foreground
launcher currently couples attachment completion to runtime shutdown.

The current initial foreground capture is plain text. It cannot be reused as
the reconnect screen because it does not reconstruct terminal modes and styles.
The runtime shutdown in
[`runtime.ts`](../src/services/features/telegram-mcp/src/app/bootstrap/runtime.ts)
also stops PTYs; that shutdown must belong exclusively to the background owner.

## Process ownership

```mermaid
flowchart LR
    Terminal[User terminal] <-->|raw input and VT output| Attach[tellymcp attach]
    Attach <-->|private Unix socket| Owner[Local session owner]
    Owner <--> PTY[Existing PTY and headless screen]
    PTY <--> Shell[Shell and agent TUI]
    Owner <-->|existing connection| Gateway[Gateway]
    RemoteTerminal[Terminal on another workstation] <--> RemoteAttach[tellymcp remote attach]
    RemoteAttach <-->|authenticated WSS| Gateway
    Browser[Browser or Telegram WebApp] <--> Gateway
    Owner --> Services[Existing MCP browser and agent services]
```

The owner runs the existing embedded broker, console registry, PTY, browser
bridge, MCP endpoint, and managed agent backends. An attachment runs none of
those services. It therefore cannot create a second gateway identity, bind the
browser port again, or launch a second agent merely by reconnecting.

The owner is launched through the installed package entrypoint with
`process.execPath`, an internal command, an absolute env-file path, the original
workspace, and validated startup options. Its working directory and shell
environment must match the current foreground launch. Do not pass secrets in
command-line arguments or copy the entire environment into discovery metadata.

Use a detached child process, independent standard descriptors, and `unref()`.
Owner logs go to the existing file logger rather than to an attached terminal.
The public launcher waits for a successful local `ready` handshake with a
deadline. A PID or a created socket file alone does not mean startup succeeded.
If startup fails, clean up only that owner's partial resources and report the
failure; do not silently start another shell. See the
[Node child-process documentation](https://nodejs.org/download/release/v26.9.0/docs/api/child_process.html#optionsdetached)
for the underlying detached process and descriptor requirements; verify them
against the project's supported Node 24 runtime during implementation.

## Proposed command behavior

| Command or action                     | Behavior                                                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `tellymcp run`                        | Start the workspace session owner and attach. If that exact session is already running, attach to it.                               |
| `tellymcp run --detach`               | Start the owner, wait for readiness, print session identity, and return. An interactive TTY is not required.                        |
| `tellymcp run --agent codex --detach` | Start the managed agent once within the new owner. Reuse existing provider launch semantics.                                        |
| `tellymcp sessions`                   | List this OS user's local owners, with an opaque local handle, console identity, label, cwd, lifecycle state, and attachment state. |
| `tellymcp attach <handle>`            | Attach to the exact existing owner; never create or resume a different process. Without a handle, use the current workspace marker. |
| `tellymcp stop <handle>`              | Explicitly stop the owner, its agent backends, shell, PTY, and embedded services. Without a handle, use the workspace marker.       |
| `Ctrl+]` followed by `d`              | Detach locally and restore the outer terminal. The owner continues. `Ctrl+]` twice forwards a literal prefix.                       |
| `Ctrl+C` / `Ctrl+D` typed normally    | Forward to the PTY so the foreground program and shell retain their normal behavior.                                                |

The detach prefix parser must handle split reads and forward unmatched bytes in
order. Paste data is forwarded intact; a pasted prefix must not accidentally
detach the client. Check this against bracketed paste and common agent bindings.

Existing `--env`, session flags, `.mcpsession.json`, shell configuration, and
provider selection keep their meaning. Reattaching with `--agent` does not
launch an agent again. Incompatible requested provider or startup configuration
must produce a clear conflict instead of modifying a running owner.

Repeated `run` calls must be idempotent, including concurrent invocations. An
existing foreground process cannot transfer its live PTY into a new owner;
sessions launched before this feature need a fresh launch to gain detach support.

## Lifecycle and failure behavior

Lifecycle and attachment are separate state values. An owner moves through
`starting`, `running`, `stopping`, and `exited`; a running owner may be attached
or detached.

| Event                                                                  | Owner behavior                                                                                                              |
| ---------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
| Detach command, attachment socket EOF, frontend death, terminal hangup | Release the attachment; retain shell, PTY, services, and gateway identity.                                                  |
| Gateway restart or network interruption                                | Use the existing gateway reconnect path; keep the local session. Reconnect alone does not inject an agent instruction.      |
| Agent TUI exits to its shell                                           | Keep the shell and owner running. Do not relaunch the agent.                                                                |
| Shell / PTY exits                                                      | Notify the attachment of the actual exit status, shut down owned services, and remove live discovery state.                 |
| Explicit `stop`, or owner receives a termination request               | Stop once, close listeners, terminate owned child processes, and remove only this owner's runtime files.                    |
| Owner dies unexpectedly                                                | Mark the old owner unavailable on discovery; attach reports that the live process was lost. No automatic replacement shell. |

The frontend handles `SIGHUP`, external `SIGTERM`, stdin EOF, stdout failure, and
socket failure as attachment termination. It restores raw mode and terminal
settings on every recoverable exit path, without calling broker shutdown.
An uncatchable frontend kill must still leave the owner alive; terminal recovery
after such a kill may require the user to reset the outer terminal.

Only one interactive attachment owns input and resize, whether local, remote,
or a writable Live View. A second controller request reports busy; no implicit
takeover. Read-only observers do not send input or resize the PTY. Keep the
last size while no controller is present. The owner enforces this policy for
all transports, including existing Live View action paths. Telegram task
delivery retains its existing explicit routing and ordering; it does not become
an implicit controller or steal the terminal size.

## Local discovery and identity

Use a private directory owned by the OS user, with mode `0700`, under a suitable
user runtime directory. Validate ownership and permissions before reuse. Use
short hashed socket paths to stay within Unix socket path limits; socket files
are restricted to the owner. No new TCP listening port or gateway credential is
needed for local attach.

Discovery records contain a format version, local handle, random owner instance
ID, PID, process-start identity, socket path, package/protocol versions, console
IDs, cwd, env-file path, start time, and state. They contain no tokens or env-file
contents. Publish records atomically only after the owner is ready.

Use the canonical workspace and local session ID for the local startup lock;
resolve `.mcpsession.json` once and pass the resolved identity into the owner.
Retain its stable `gateway_client_uuid` and `local_session_id` on every attach.
Workspace paths are discovery context, never a substitute for canonical IDs in
gateway routing. Reject a second local owner claiming an already running
canonical gateway console identity, even through a different workspace path.

Startup requires an exclusive lock before creating the broker or PTY. Socket
handshakes verify the expected owner instance and identity. A PID existence
check is insufficient because PIDs can be reused. Stale-lock recovery must prove
the recorded owner is gone, probe its socket, and recheck state under the startup
lock before removing anything. Ambiguous ownership returns an error.

## Local transport

Use a versioned framed Unix-stream protocol, not newline-delimited terminal
output. Terminal bytes may contain arbitrary line breaks and escape sequences.
Frame decoding must tolerate split headers and multiple frames in a single read.

Proposed messages are `hello`, `ready`, `attach`, `snapshot_begin`, snapshot data,
`snapshot_end`, output data, input data, `resize`, `detach`, `stop`, `exit`, and
`error`. Control messages use validated JSON; input and output use data frames.
Each output frame carries a monotonic sequence number within one owner instance.
Input encoding must handle multibyte characters split between socket reads;
preserve the current UTF-8 PTY behavior without converting input into lines.

Reject unsupported protocol versions, invalid dimensions, oversized frames,
wrong instance IDs, and input from a noncontrolling attachment. Package updates
must not silently restart an existing owner: a compatible attach works; an
incompatible attach reports the mismatch and leaves the session running.

Read and retain PTY output even with no attachment. Bound parser buffers, output
history, pending writes, snapshot size, and per-client queues. A slow attachment
must not block the PTY or grow memory indefinitely. Disconnect a client whose
bounded queue cannot catch up; a new attach can obtain a fresh snapshot. Owner
logs and the retained headless scrollback also need explicit bounds.

## Terminal appearance and reconnect

During an ordinary attachment, output remains the original VT stream and the
user's terminal emulator renders it. Telly does not replace the agent interface.
Stdin stays in raw mode; paste, mouse reports, function keys, Unicode, and resize
continue to the existing PTY.

For reattach, use an ANSI/VT serialization of the headless terminal state.
Prototype a compatible `@xterm/addon-serialize` against the installed xterm 5.5
packages before selecting a version. The upstream
[serialization addon](https://github.com/xtermjs/xterm.js/tree/master/addons/addon-serialize)
provides terminal-state serialization but is described as experimental, so its
existence is not proof of full terminal fidelity.

Restore normal and alternate buffers, visible cells and styles, cursor state,
scroll region, and applicable terminal modes. Check bracketed paste, mouse,
application cursor/keypad, focus, cursor visibility, and wrapping behavior.
Do not replay all historical output: that can repeat terminal side effects such
as clipboard writes. A bounded screen/scrollback snapshot is distinct from a
complete output recording.

Attaching needs an ordered boundary between the snapshot and live output:

1. Claim the attachment and apply its dimensions through the owner.
2. Queue a snapshot operation in the same ordered pipeline as headless writes.
   Capture the output sequence at that boundary and wait for prior writes.
3. Retain subsequent output while serializing the boundary state. Send the
   snapshot with its owner instance, dimensions, and sequence.
4. Send only subsequent output, once and in order. Enable input after the client
   has applied the initial state. Overflow forces a fresh attach rather than
   silently dropping output.

Terminal query responses require explicit ownership as well. While attached,
the real terminal normally supplies responses; the shadow headless terminal must
not send duplicates. While detached, supported queries may need headless
responses so applications do not hang waiting for a terminal. The prototype
must define the handover and verify that neither delayed nor duplicate replies
corrupt stdin. Unsupported capabilities must not be advertised as supported.

## Remote attach through the gateway

Proposed additional commands are `tellymcp sessions --remote` and
`tellymcp attach --remote <client_uuid:local_session_id>`. They use the configured
gateway and an authenticated account. Local attach remains available without
network access. A remote attachment is a viewer/controller connection, not a
new routable agent console: it starts no shell, agent, browser bridge, or MCP
server and does not register a duplicate source console.

The existing relay already carries PTY output. In
[`gateway-socket.service.ts`](../src/services/features/telegram-mcp/gateway-socket.service.ts),
`stream_subscribe` sends a snapshot followed by `live_stream_event` data and exit
events; the data comes from `subscribeForegroundTerminal`. Browser delivery and
input are connected in
[`http.ts`](../src/services/features/telegram-mcp/src/app/http.ts). Reuse this
relay infrastructure and connection discovery instead of creating a second
remote shell implementation.

Several existing behaviors need a common attachment contract first:

- Relay text input currently uses `sendTerminalLiteralText`, which normalizes
  newlines and caps action text at 4000 characters. Native input requires a
  distinct ordered raw-input path; do not turn keypresses and pasted multiline
  content into command-line text actions.
- Existing stream subscription captures the screen before subscribing to new
  output and has no sequence boundary. Use the same ordered snapshot and live
  stream protocol as local attach, including terminal modes and bounded queues.
- Bind every stream to its authenticated connection, target console, owner
  instance and attachment generation. A stale response or reconnect must not
  redirect input to another client or a newly started owner with the same label.
- Local and remote attach acquire the same controller lease from the owner.
  Remote leases require heartbeat expiry because an upstream network failure
  need not immediately close the owner's gateway connection. Losing the lease
  disables input; reacquiring control never replays buffered keystrokes.
- Disconnecting the gateway closes or expires remote attachments, not the PTY.
  A reconnect reauthorizes the target and obtains a fresh snapshot. Only
  acknowledged output can be resumed; unacknowledged input is never retried
  automatically because it might already have executed.

The gateway must verify that the requesting account owns the target client
using server-side identity records. Matching display names, a supplied
`gateway_user_uuid`, or possession of the shared gateway transport bearer is
not sufficient proof of account ownership. The existing client WebSocket
authenticates with that shared bearer; it is not by itself a per-account CLI
login mechanism. Do not copy browser/WebApp launch tokens or the client's full
env file to another workstation to provide remote attach.

Proposed authorization is a short-lived attachment capability issued after
account authentication, scoped to the canonical target, allowed operations and
expiry. The gateway creates the stream only after validating it. Select the
CLI account-login integration before implementing remote attach; existing MCP
OAuth credentials cannot be assumed to authorize terminal control without an
explicit scope and audience contract. A remote attachment capability does not
grant stop or arbitrary gateway actions. Use the existing WSS deployment and
keep credentials out of URLs and logs.

Guest/project-member terminal access keeps its separate explicit approval path.
This feature's automatic authorization is limited to the same verified account.

## Implementation sequence

| Stage                  | Concrete result                                                                                                     | Completion check                                                                                                               |
| ---------------------- | ------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 1. Terminal prototype  | Snapshot restoration and ordered output boundary using the existing PTY and headless buffer.                        | Same shell PID, correct screen and modes after attach, no missing or duplicate output; query responses checked while detached. |
| 2. Owner lifecycle     | Background owner, private runtime directory, startup lock, discovery, readiness and stop protocol.                  | Launcher and controlling SSH terminal can exit without killing the owner; concurrent starts create one console.                |
| 3. Attachment client   | Raw I/O, dimensions, detach prefix, cleanup, backpressure and single-attachment rules.                              | Two real terminal emulators reproduce ordinary shell and agent behavior before and after disconnect.                           |
| 4. Product integration | CLI commands, marker identity, managed agents, gateway reconnect, browser and MCP continuity.                       | No duplicate gateway console or agent; Telegram and Live View keep working while detached.                                     |
| 5. Remote attachment   | Account-authenticated CLI access, target-scoped capabilities, raw relay input, shared control leases and reconnect. | Attach from another workstation reaches the same PTY; another account is denied; gateway loss does not kill the session.       |
| 6. Release             | English/Russian usage docs, doctor output, package version bump and packaged-install check.                         | All acceptance scenarios pass on the supported Linux environment. User performs deployment.                                    |

Suggested modules under
`src/services/features/telegram-mcp/src/features/detached-terminal/model/`:
`sessionOwner.ts`, `localProtocol.ts`, `localRegistry.ts`, and
`terminalAttachment.ts`, with separate local and gateway transport adapters.
Existing foreground launch responsibilities should
be split into reusable console initialization and attachment behavior, while
`ptyRegistry.ts` remains the single PTY and screen-state owner.

The first stage is a fidelity gate, before replacing the default launch path.
If serialization or terminal-query handling fails, resolve that behavior before
shipping a detach flag that cannot restore a working agent interface.

## Stage 1 prototype: T-TELLYMCP-040

The isolated implementation is in
`src/services/features/telegram-mcp/src/features/detached-terminal/model/`:
`terminalRestorationPrototype.ts`, `terminalSnapshot.ts`, and `vtOutput.ts`.
It takes an existing `node-pty` handle, owns its own experimental headless
screen, and creates no processes or services. **It is not imported by the
ordinary runtime or CLI.** Do not layer it onto an existing `ptyRegistry`
screen as a second permanent parser: stage 2 must integrate one authoritative
screen into that registry, keeping the existing capture and subscription APIs.

`@xterm/addon-serialize` is pinned to **0.13.0**, the compatible addon listed
in the upstream [xterm 5.5 release](https://github.com/xtermjs/xterm.js/releases/tag/5.5.0).
Both headless and browser xterm stay at **5.5.0**. The addon works with headless
at runtime; its typings import browser xterm and therefore introduce `lib.dom`.
`tellyProxy.ts` now explicitly types the Node dispatcher extension to
`RequestInit`; its actual dispatch behavior is unchanged.

### Confirmed restoration contract

- Owner instance UUID, controller generation, dimensions and monotonically
  increasing output sequence accompany a snapshot. Generation changes on
  reattach; the PTY PID and owner instance do not.
- Headless writes, resize and snapshot serialization use one ordered queue.
  Attach reserves its controller immediately, waits for preceding writes,
  applies dimensions to the existing headless terminal and PTY, then serializes.
  Later output starts at `snapshot.sequence + 1`, including empty display frames
  for query-only output. Output arriving during snapshot delivery is queued.
- The consumer applies the complete ANSI snapshot at its declared dimensions,
  then acknowledges it. Input and live-frame draining are disabled before ACK.
  No automatic input retry exists. Old handles cannot affect a new controller.
- Incomplete VT controls and a trailing UTF-16 high surrogate remain buffered
  until complete. They are not half-applied to a snapshot. Raw input uses a
  per-attachment UTF-8 decoder; detach discards an unfinished input character
  instead of moving it into the next controller's input.
- Replay tests compare both buffers' cells, widths, wraps, colors and basic
  SGR styles, cursor positions and subsequent output. Coverage includes normal
  and alternate screens, returning to normal, saved cursors/attributes,
  scroll regions/origin, tab stops, pending wrap, REP across the boundary,
  ASCII/UK/DEC graphics, CJK, combining marks, emoji and resize during output.
  Paste, focus, application cursor/keypad, insert, wrap, mouse tracking/encoding,
  cursor visibility/style/blink and newline mode are restored.
- The addon alone misses scroll regions, tab stops, saved state, mouse
  encoding and cursor visibility. It also leaks active SGR into the start of
  alternate-screen painting. A version-specific adapter supplements it and
  corrects that bleed. All additional private xterm access is in
  `terminalSnapshot.ts`; dependency changes require its replay tests.
- Snapshots reset the display and repaint bounded screen/scrollback state.
  They do not replay historical bells, clipboard operations or queries.
  Live output preserves ordinary VT data except the query families below.
- Detach and model disposal remove subscriptions without killing the caller's
  PTY. Exit status follows already accepted output; the existing attachment
  can drain final output after exit but cannot send more input.

### Query ownership selected by the prototype

This refines the earlier attached-terminal query proposal: **the headless
owner supplies supported responses both attached and detached**. There is no
handover to the physical terminal and no outstanding-response race at detach.
The complete query controls are removed from display output before delivery,
so the physical terminal cannot send a duplicate response. The attach client
must render this filtered stream rather than subscribing directly to PTY data.

Supported responses are DSR status/cursor (including private cursor DSR), primary
and secondary DA, DECRQM, xterm DECRQSS, character-size query `CSI 18 t`, and
individual OSC 10/11/12 color queries. Primary DA deliberately reports VT101
with no optional capabilities. DECRQSS SGR uses the actual current attributes
rather than xterm 5.5's hard-coded `0m` response. The experimental palette is
fixed white foreground/cursor and black background; it is not a probe of the
user's physical terminal theme.

The filter also consumes unsupported queries in these CSI/OSC/DCS families
(including pixel-size requests, palette queries, clipboard queries, XTGETTCAP,
XTVERSION and keyboard-protocol queries) rather than allowing attached-only
answers. Unsupported requests may receive no answer, or xterm's unsupported
response; applications must use their normal capability fallback/timeouts.
Do not advertise graphics, clipboard reading or enhanced keyboard protocols.
This is not a universal VT security filter: extensions outside the recognized
families need explicit handling before they become part of the contract.

### Bounds and remaining release checks

Defaults: 500 retained scrollback lines (configurable 0–5000), dimensions 2–500
in each axis, one MiB/4096 frames per attachment, four MiB/4096 operations in
the parser queue, 65536 UTF-16 units per unfinished control, and a four MiB
snapshot limit. A slow consumer loses its attachment and must request a fresh
snapshot; PTY parsing continues. Parser/control overflow records a terminal
prototype fault and rejects further operations. Stage 2 must give those faults
an explicit owner lifecycle policy; this in-process experiment does not claim
to recover a screen after dropping parser input.

Dynamic palette mutation, OSC 8 hyperlink metadata, extended underline variants,
images and additional terminal protocols are not restoration guarantees.
They need separate decisions/tests before advertising them. The manual harness
resets common terminal modes on detach/exit; complete terminal cleanup belongs
to stage 3. No SSH-disconnect survival, daemonization, account authorization,
gateway attachment, real Codex/Claude fidelity or two-terminal-emulator check
is implied by the automated fixtures. Those remain T-TELLYMCP-041..045.

### Run the experiment

```bash
yarn vitest run tests/terminalRestoration.test.ts tests/terminalRestorationPty.test.ts
yarn tsx tools/prototype-terminal-restoration.ts
```

The second command requires an interactive TTY and starts one clean Bash with
no user startup files. Try `echo $$`, a streaming counter or a TUI. Press
**Ctrl+]** to detach the display, **a** to reattach and **q** while detached to
stop the experiment. While attached, normal `exit N` returns code N. These keys
are harness controls, not the future public CLI interface; the harness reserves
Ctrl+] and ignores input while applying a snapshot. It stays in the same
foreground process, so closing it is not a daemon-survival test.

Evidence: automated PTY integration keeps the same shell and interactive Node
child PIDs, observes detached progress, checks split Unicode input after resize,
requires exactly one reply for each attached/detached query, drains final child
and shell output, and preserves shell exit 7. A manual PTY harness run also
reported Bash PID `1411199` before and after detach/reattach, delivered final
output `FINAL_OUTPUT` and propagated exit 7. This was terminal
tool PTY evidence, not visual verification in two physical terminal emulators.

## Acceptance scenarios

- Launch a shell, start a long-running counter, detach, then reattach: same shell
  PID, continuous progress, current screen, and working input.
- Kill only the attachment and separately drop an actual SSH connection: the
  owner, shell, and agent survive; local discovery and attach still find them.
- Run existing Codex and Claude launch flows. Detach during an active turn and
  reattach without creating another provider backend, thread, or TUI process.
- Reattach at different dimensions and while output is arriving rapidly. Verify
  the snapshot boundary, Unicode splits, colors, alternate screen and modes.
- Keep the session detached during terminal queries, high output volume, and a
  gateway restart. Check responsiveness and bounded memory.
- Verify Ctrl+C, Ctrl+D, Ctrl+Z, terminal resize, function keys, paste, mouse and
  focus events; the detach prefix must not consume unrelated input.
- Verify second-attachment rejection, concurrent starts, stale sockets and locks,
  PID reuse, wrong protocol versions, and startup failures.
- Verify explicit stop and normal shell exit clean up only their own services
  and descendants. Repeated attach/detach must not leak listeners or descriptors.
- Verify Telegram, MCP and browser attachment while no local terminal is open,
  and confirm the canonical console identity stays unchanged.
- Attach through the gateway from a second workstation under the same account:
  same shell PID, agent process, console identity, screen and input behavior.
  The viewing workstation must not register a second routable console.
- Deny another account, expired capabilities and attempts to select a target by
  spoofing owner metadata. Verify that read-only streams cannot write or resize.
- Drop and restore each remote network leg during output and input. Keep the
  target alive, expire stale control, and never duplicate submitted keystrokes.

Use focused protocol/state tests plus PTY subprocess integration tests. Real SSH
disconnect and agent TUI checks are release evidence, not substitutes for unit
tests or claims that a headless fixture proves every terminal emulator works.
