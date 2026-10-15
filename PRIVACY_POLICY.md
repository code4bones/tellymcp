# Privacy Policy — TellyMCP Browser Attach Extensions

_Last updated: 2026-10-15_

This policy covers the **TellyMCP Chrome Attach** and **TellyMCP Attach** (Firefox)
browser extensions, published by the TellyMCP project.

## What these extensions do

These extensions let a user connect their own local **TellyMCP** development
tool to a specific browser tab they explicitly select ("attach"), so that
local tool can read page content, console messages, network activity, and
cookies, and perform actions (click, fill, navigate, screenshot, inject
debug scripts) on that one tab — strictly for local software development,
testing, and browser-automation workflows.

## What data is accessed, and where it goes

- Data is only read from the single tab the user has explicitly **attached**
  or explicitly **started recording** — never passively from other open tabs.
- All data (DOM content, console output, network requests/responses,
  cookies, screenshots) is sent exclusively to a **local** TellyMCP server
  that the same user runs on their own machine, over a WebSocket connection
  to an endpoint the user configures themselves (default `127.0.0.1`).
- No data is ever sent to any server operated by the extension's developer,
  nor to any third party. The developer does not collect, receive, or store
  any of this data.
- No data is sold, shared with advertisers, or used for purposes unrelated
  to the single local development session the user is actively running.

## Remote / dynamically supplied code

The extensions' "inject script" feature executes a script that the user's
own local TellyMCP tool supplies at the moment the user explicitly triggers
that action, on the tab the user has attached. This code originates from the
user's own local process, not from any third-party or developer-controlled
server, and is never executed automatically or in the background.

## Permissions

Each browser permission the extensions request is used only for the
specific local-development behavior described above (listing/attaching
tabs, capturing console/network/cookies on an attached tab, keeping the
background connection to the user's local server alive, and running
page-interaction commands on the attached tab). Host access (`<all_urls>`)
is required only because the user may want to attach to any site they are
currently developing against; it is not used to act on tabs the user has
not explicitly attached.

## Data retention

The extensions themselves retain only small, local browser-storage state
needed for their own operation (the configured server address, which tab is
currently attached, connection status) and short in-memory buffers of
recent console/network events for the currently attached tab, cleared when
that tab is detached, closed, or the browser restarts. The extensions do not
maintain any server-side storage of their own.

## Contact

Questions about this policy can be raised via the project's repository:
https://github.com/code4bones/tellymcp
