# ChatGPT and Claude connector

TellyMCP can expose its Streamable HTTP MCP endpoint to ChatGPT and Claude
through an OAuth 2.0 authorization-code facade with PKCE. The facade coexists
with `MCP_HTTP_BEARER_TOKEN`; existing internal clients can continue to use the
static bearer token.

## Configure the gateway

Add the following to the gateway environment file:

```bash
TELLYMCP_PUBLIC_URL=https://mcp.example.com/api
TELLYMCP_OAUTH_ISSUER=https://mcp.example.com/api
TELLYMCP_OAUTH_AUDIENCE=https://mcp.example.com/api
TELLYMCP_MAGIC_TOKEN=replace_with_a_private_human_login_token
TELLYMCP_OAUTH_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\n...\n-----END PRIVATE KEY-----\n"
```

Generate the stable signing key with:

```bash
tellymcp oauth key
```

The command prints a dotenv-ready `TELLYMCP_OAUTH_PRIVATE_KEY_PEM` assignment.
If the private key is omitted, TellyMCP generates an ephemeral key and existing
OAuth access tokens stop working after a restart.

For a hashed magic token, configure
`TELLYMCP_MAGIC_TOKEN_HASH=sha256:<64-hex-digest>` instead of the raw token.
Never configure both forms.

Optional restrictions:

```bash
TELLYMCP_OAUTH_CLIENT_ID=tellymcp
TELLYMCP_OAUTH_CLIENT_SECRET=replace_with_client_secret
TELLYMCP_ALLOWED_REDIRECT_URIS=https://chatgpt.com/connector/oauth/...,https://claude.ai/api/mcp/auth_callback
TELLYMCP_AUTH_CODE_TTL_SECONDS=300
TELLYMCP_OAUTH_SCOPES=tellymcp:read tellymcp:write
TELLYMCP_OAUTH_KEY_ID=tellymcp-oauth
```

OAuth is enabled when a connector identity, credential, redirect, or signing-key
setting is present. `TELLYMCP_PUBLIC_URL` and one magic-token form are then
required. Redirect URIs are matched exactly when the allowlist is configured.

## Reverse proxy

Proxy all `/api/` routes to TellyMCP and disable response buffering on
`/api/mcp`. Claude also needs root path-insertion discovery routes such as:

```text
/.well-known/oauth-authorization-server/api
/.well-known/openid-configuration/api
/.well-known/oauth-protected-resource/api/mcp
```

The complete Nginx example is in `docs/tellymcp.gw.conf`.

## Connect the chat host

Use the concrete MCP endpoint in the host's `Connection` field:

```text
https://mcp.example.com/api/mcp
```

Do not enter `https://mcp.example.com/api` as the connection URL. That URL is
the OAuth issuer/audience base, not an MCP endpoint. With the correct
connection URL, discovery may legitimately show two related resources:

```text
OAuth issuer/audience: https://mcp.example.com/api
MCP resource:          https://mcp.example.com/api/mcp
```

For the production deployment used while implementing this feature, the
working ChatGPT values are:

```text
Connection:                https://drd.undoo.ru/api/mcp
Authorization server base: https://drd.undoo.ru/api
Resource:                  https://drd.undoo.ru/api/mcp
OIDC configuration URL:    https://drd.undoo.ru/.well-known/openid-configuration/api
```

The `/api` suffix in the root discovery URL is expected RFC 8414
path-insertion behavior for an issuer whose path is `/api`.

Do not give the host `MCP_HTTP_BEARER_TOKEN` or the magic token. The magic token
is entered only into the authorization page opened by the host. If a client ID
or client secret is configured in the host, it must match the gateway values.

TellyMCP tool names already use Claude-compatible letters, digits, and
underscores, and the tools publish output schemas.

## Verify before connecting

```bash
curl -fsS https://mcp.example.com/api/.well-known/oauth-protected-resource/mcp
curl -fsS https://mcp.example.com/api/.well-known/oauth-authorization-server
curl -fsS https://mcp.example.com/.well-known/oauth-authorization-server/api
curl -fsS https://mcp.example.com/api/.well-known/jwks.json
curl -i https://mcp.example.com/api/mcp
```

The last response must be `401` and include a `WWW-Authenticate` header whose
`resource_metadata` value points to the protected-resource metadata endpoint.

Access tokens are RS256 JWTs without `exp`, matching the trusted internal
connector model. Authorization codes remain short-lived, PKCE-bound, and
one-time-use. Failed magic-token attempts are rate-limited per source address.

## Diagnostics

OAuth discovery, authorization, token exchange, MCP `initialize`, and
`tools/list` milestones are logged at `info`. Rejections are logged at `warn`
without credentials, authorization codes, PKCE verifiers, or access tokens.
When OAuth is enabled, every HTTP request and completed response is also logged
with its normalized path, status, user agent, content types, MCP session id,
and whether an Authorization header was present. Header values and tokens are
never logged.

The production Nginx sample writes connector traffic to:

```text
/var/log/nginx/tellymcp.access.log
/var/log/nginx/tellymcp.error.log
```

If refresh stops after OAuth metadata and never logs an MCP `initialize`, first
verify that the host's `Connection` value ends in `/api/mcp`.
