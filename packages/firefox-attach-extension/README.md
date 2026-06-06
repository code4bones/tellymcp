# TellyMCP Firefox Attach Extension

Firefox extension that lets `telegram_mcp` attach to an already running user browser session through a local WebSocket bridge.

Current scope of this package:

- extension options for host / port
- background WebSocket client
- browser instance hello handshake
- tab listing
- active-tab reporting

This package is intentionally separate from the main `@deadragdoll/tellymcp` runtime package.
