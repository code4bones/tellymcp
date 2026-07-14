# Chat Connector OAuth Handoff

Continuation snapshot for ChatGPT/Claude connector development.

Last updated: `2026-07-14`

## Outcome

The OAuth facade is implemented and the ChatGPT connector works in production.
ChatGPT reconnect and Refresh Tools both completed successfully after the
connection URL was corrected.

The decisive configuration distinction is:

```text
Chat host Connection:      https://drd.undoo.ru/api/mcp
OAuth public base:         https://drd.undoo.ru/api
OAuth issuer:              https://drd.undoo.ru/api
OAuth configured audience: https://drd.undoo.ru/api
Discovered MCP resource:   https://drd.undoo.ru/api/mcp
```

Entering `https://drd.undoo.ru/api` in ChatGPT's `Connection` field causes the
host to complete OAuth discovery but never reach MCP `initialize` or
`tools/list`. The UI does not expose a useful error for this case.

## Production ChatGPT Discovery

With the correct connection URL, ChatGPT derives values equivalent to:

```text
Auth URL:                  https://drd.undoo.ru/api/oauth/authorize
Token URL:                 https://drd.undoo.ru/api/oauth/token
Authorization server base: https://drd.undoo.ru/api
Resource:                  https://drd.undoo.ru/api/mcp
OIDC configuration URL:    https://drd.undoo.ru/.well-known/openid-configuration/api
```

The final `/api` on the OIDC and authorization-server discovery URLs is not an
error. It is path-insertion discovery for an issuer with a non-root `/api`
path. The working sibling implementation in
`../PMem/project-memory-mcp` behaves the same way.

## Implemented Surface

### OAuth facade

Primary file:

```text
src/services/features/telegram-mcp/src/app/oauthFacade.ts
```

Implemented behavior:

- OAuth 2.0 authorization-code flow with PKCE `S256`
- human magic-token authorization page
- raw magic token or `sha256:<hex>` storage
- exact redirect URI allowlist
- optional fixed client id and confidential client secret
- `client_secret_post` and `client_secret_basic`
- one-time, short-lived authorization codes
- RS256 access JWTs and public JWKS
- issuer, allowed resource, client id, signature, and full configured-scope
  verification
- protected-resource metadata for both the base resource and `/mcp`
- authorization-server and OpenID-compatible discovery aliases
- RFC 8414 path-insertion routes
- rate limiting for failed magic-token attempts
- secret-safe structured logs

Refresh tokens and `offline_access` are not implemented. OpenAI documentation
recommends them for long-lived authorization, but they were proven not to be
the cause of the tool-refresh incident: the current PMem connector and the new
TellyMCP connector both refresh tools successfully without them. Treat refresh
tokens as a future hardening/continuity feature, not a repair to the completed
incident.

### MCP HTTP integration

Primary file:

```text
src/services/features/telegram-mcp/src/app/http.ts
```

The MCP endpoint accepts either:

- the existing `MCP_HTTP_BEARER_TOKEN`; or
- a valid OAuth JWT issued by the facade.

OAuth does not make the endpoint public. Unauthenticated requests receive
`401` plus a `WWW-Authenticate` challenge pointing to the `/mcp`
protected-resource metadata.

The handler logs OAuth discovery, JWT acceptance/rejection, MCP `initialize`,
`tools/list`, response status, tool count, and a safe request/response envelope.
It never logs Authorization values, magic tokens, client secrets, PKCE
verifiers, authorization codes, or JWTs.

### Configuration and CLI

Configuration is parsed in:

```text
src/services/features/telegram-mcp/src/app/config/env.ts
```

Supported variables:

```text
TELLYMCP_PUBLIC_URL
TELLYMCP_OAUTH_ISSUER
TELLYMCP_OAUTH_AUDIENCE
TELLYMCP_MAGIC_TOKEN
TELLYMCP_MAGIC_TOKEN_HASH
TELLYMCP_OAUTH_CLIENT_ID
TELLYMCP_OAUTH_CLIENT_SECRET
TELLYMCP_ALLOWED_REDIRECT_URIS
TELLYMCP_OAUTH_PRIVATE_KEY_PEM
TELLYMCP_AUTH_CODE_TTL_SECONDS
TELLYMCP_OAUTH_SCOPES
TELLYMCP_OAUTH_KEY_ID
```

Do not put production secret values in documentation. The redirect URI
allowlist is matched exactly. Client id and secret are manually configured;
there is no dynamic client registration.

Generate a stable RSA key with:

```bash
tellymcp oauth key
```

Without `TELLYMCP_OAUTH_PRIVATE_KEY_PEM`, the process uses an ephemeral key and
previously issued access tokens stop working after restart.

### Nginx

The operator's production-oriented file is:

```text
nginx/tellymcp.gw.conf
```

The packaged documentation sample is:

```text
docs/tellymcp.gw.conf
```

Important proxy behavior:

- `/api/mcp` and `/api/mcp/` reach the Streamable HTTP handler
- Authorization is forwarded explicitly on MCP and token exchange routes
- buffering, request buffering, cache, and gzip are disabled for MCP streaming
- prefixed OAuth routes and root path-insertion discovery routes reach Node
- the production-oriented config declares dedicated connector access/error
  logs under `/var/log/nginx/tellymcp.*.log`

## Working Environment Shape

Non-secret production values are:

```env
TELLYMCP_PUBLIC_URL=https://drd.undoo.ru/api
TELLYMCP_OAUTH_ISSUER=https://drd.undoo.ru/api
TELLYMCP_OAUTH_AUDIENCE=https://drd.undoo.ru/api
```

The gateway also has operator-owned values for the magic token, client id,
client secret, redirect allowlist, and stable private key. Preserve them; do
not replace or print them during diagnostics.

## Observed Tool Surface

A direct authenticated Streamable HTTP smoke check returned 38 tools. Tool
names satisfy the current MCP/ChatGPT-safe character constraints, descriptions
are non-empty, and input/output schemas are objects. The original `0 actions`
symptom was not a tool-publication defect: ChatGPT never reached `tools/list`
while its Connection field pointed to `/api`.

## Diagnostics Sequence

For a healthy new authorization and scan, expect approximately:

```text
OAuth protected-resource metadata served
OAuth authorization-server metadata served
OAuth authorization form opened
OAuth authorization code issued
OAuth access token issued
OAuth access token accepted
Chat connector MCP handshake request received: initialize
MCP HTTP session initialized
Chat connector MCP handshake request received: tools/list
telegram_mcp MCP server instance created: toolCount=38
```

If only metadata appears:

1. inspect the ChatGPT `Connection` value first; it must end in `/api/mcp`;
2. inspect the safe request/response logs in PM2;
3. inspect `/var/log/nginx/tellymcp.access.log` for a request rejected before
   reaching Node;
4. verify the exact redirect URI, client id, and client secret configured in
   both ChatGPT and the gateway;
5. only then investigate JWT or MCP transport behavior.

## Validation Status

Earlier in the implementation session these passed:

```text
yarn build
yarn lint
yarn test   # 31 files, 150 tests
```

The final change added broad safe HTTP request/response diagnostics and the
dedicated Nginx log paths. Per explicit user instruction, build/lint/tests were
not rerun afterward. Runtime connector success was established through the
production ChatGPT reconnect and tool refresh, but the next session should not
claim the final working tree is fully test-validated until requested and run.

## Working Tree and Ownership

The working tree contains the complete connector implementation plus unrelated
pre-existing user changes. Preserve all unrelated changes. In particular:

- `docs/CHAT_CONNECTOR_OAUTH_GUIDE.md` was supplied as the reference guide
- `nginx/tellymcp.gw.conf` was supplied by the user and intentionally edited in
  place
- do not delete or overwrite either file as generated output

## Recommended Next Work

Only pursue these when explicitly requested:

1. reduce broad connector request logging from `info` after production
   observability is no longer needed;
2. add refresh-token rotation and `offline_access` for long-lived OAuth
   continuity;
3. add operator-facing OAuth smoke tooling that performs discovery, PKCE,
   token exchange, `initialize`, and `tools/list` without exposing secrets;
4. decide whether access JWTs should gain bounded expiry together with refresh
   support;
5. add per-tool read/write scope enforcement if coarse full-scope access is no
   longer sufficient;
6. rerun build/lint/test when the user requests final validation.
