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
TELLYMCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS=3600
TELLYMCP_OAUTH_SCOPES=tellymcp:read tellymcp:write
TELLYMCP_OAUTH_KEY_ID=tellymcp-oauth
```

OAuth is enabled when a connector identity, credential, redirect, or signing-key
setting is present. `TELLYMCP_PUBLIC_URL` and one magic-token form are then
required. Redirect URIs are matched exactly when the allowlist is configured.

## ChatGPT Plugins OAuth 2.1

The facade supports the pinned OpenAI Client ID Metadata Document (CIMD)
public clients for ChatGPT and Codex. Its discovery metadata advertises PKCE
`S256`, `client_id_metadata_document_supported`, `none` token-endpoint
authentication, and RFC 9207 issuer identification. TellyMCP retrieves only
the known `https://chatgpt.com/oauth/client.json` and
`https://chatgpt.com/oauth/codex/client.json` metadata documents, requires
`none` to be an advertised client authentication method, and accepts only
their declared callbacks. Codex's RFC 8252 loopback callback may use an
ephemeral port. This bypasses the static redirect allowlist only for those
verified OpenAI CIMD clients.

`TELLYMCP_OAUTH_CLIENT_ID`, `TELLYMCP_OAUTH_CLIENT_SECRET`, and
`TELLYMCP_ALLOWED_REDIRECT_URIS` remain the compatibility path for pre-registered
clients such as existing Claude connections. Do not configure a ChatGPT client
secret for CIMD: ChatGPT uses PKCE and no stored client secret in this mode.

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
Connection:                https://your-gateway-domain.example/api/mcp
Authorization server base: https://your-gateway-domain.example/api
Resource:                  https://your-gateway-domain.example/api/mcp
OIDC configuration URL:    https://your-gateway-domain.example/.well-known/openid-configuration/api
```

The `/api` suffix in the root discovery URL is expected RFC 8414
path-insertion behavior for an issuer whose path is `/api`.

Do not give the host `MCP_HTTP_BEARER_TOKEN` or the magic token. The magic token
is entered only into the authorization page opened by the host. If a client ID
or client secret is configured in the host, it must match the gateway values.

TellyMCP tool names already use Claude-compatible letters, digits, and
underscores, and the tools publish output schemas.

## Codex CLI OAuth login

Codex can store a normal OAuth session for this MCP server; do not give it
`MCP_HTTP_BEARER_TOKEN` and do not set `--bearer-token-env-var` for this
connection:

```bash
codex mcp add tellyOAuth --url https://mcp.example.com/api/mcp
codex mcp login tellyOAuth
```

The CLI uses its pinned CIMD public client
`https://chatgpt.com/oauth/codex/client.json`, PKCE, and a loopback callback
on an ephemeral `127.0.0.1` or `localhost` port. TellyMCP validates only that
known OpenAI client and the matching callback shape; it never fetches arbitrary
client metadata URLs.

The browser flow is the same Telegram login and administrator approval used by
ChatGPT. The resulting OAuth token is stored by Codex, not exposed in the CLI
configuration. TellyMCP binds it to the verified Telegram identity, so the
token's subject is `telegram:<id>` rather than the OAuth client ID. The
read-only `get_authenticated_user` profile tool shows the connected Telegram
identity without returning a token.

Existing bearer-based entries continue to work during migration. After a
successful `mcp login`, remove the old bearer-backed entry with
`codex mcp remove <old-name>`.

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

Access tokens are RS256 JWTs with a bounded `exp` claim (one hour by default;
adjust with `TELLYMCP_OAUTH_ACCESS_TOKEN_TTL_SECONDS`). Authorization codes
remain short-lived, PKCE-bound, and one-time-use. Failed magic-token attempts
are rate-limited per source address.

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
