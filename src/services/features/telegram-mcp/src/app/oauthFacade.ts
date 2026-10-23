import {
  createHash,
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  randomBytes,
  randomUUID,
  sign,
  timingSafeEqual,
  verify,
  type KeyObject,
} from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";

import type { AppConfig } from "./config/env";
import {
  buildTelegramAuthorizeUrl,
  exchangeTelegramOidcCode,
  generateTelegramOidcPkce,
  verifyTelegramOidcIdToken,
  type TelegramOidcIdentity,
} from "./telegramOidc";

const OAUTH_FORM_LIMIT_BYTES = 64 * 1024;
const FAILED_MAGIC_TOKEN_WINDOW_MS = 60_000;
const MAX_FAILED_MAGIC_TOKEN_ATTEMPTS = 5;
const TELEGRAM_LOGIN_STATE_TTL_MS = 5 * 60_000;
const CIMD_CACHE_TTL_MS = 10 * 60_000;
const CHATGPT_CIMD_CLIENT_ID = "https://chatgpt.com/oauth/client.json";
const CODEX_CIMD_CLIENT_ID = "https://chatgpt.com/oauth/codex/client.json";
const CHATGPT_CIMD_REDIRECT_URI =
  "https://chatgpt.com/connector_platform_oauth_redirect";
const CODEX_CIMD_REDIRECT_URIS = [
  "http://127.0.0.1/callback",
  "http://localhost/callback",
];

type OAuthConfig = NonNullable<AppConfig["oauth"]>;

type OAuthLogger = {
  debug: (message: string, context?: Record<string, unknown>) => void;
  info: (message: string, context?: Record<string, unknown>) => void;
  warn: (message: string, context?: Record<string, unknown>) => void;
};

type AuthorizationRequest = {
  clientId: string;
  clientAuthentication: "public" | "confidential" | "cimd";
  redirectUri: string;
  scope: string;
  state: string;
  codeChallenge: string;
  resource: string;
};

type AuthorizationCode = AuthorizationRequest & {
  expiresAtMs: number;
  subject: string;
  telegramIdentity?: TelegramOidcIdentity;
};

// Deliberately narrower than AuthorizationCode: a refresh token has no
// redirect_uri/state/code_challenge to re-check, only what's needed to
// authenticate the client and re-issue an access token for the same grant.
type RefreshTokenRecord = {
  clientId: string;
  clientAuthentication: AuthorizationRequest["clientAuthentication"];
  scope: string;
  resource: string;
  subject: string;
  telegramIdentity?: TelegramOidcIdentity;
  expiresAtMs: number;
};

type PendingTelegramLogin = {
  authorizationRequest: AuthorizationRequest;
  codeVerifier: string;
  expiresAtMs: number;
};

export type TelegramLoginApprovalOutcome =
  | "approved"
  | "rejected"
  | "timeout"
  | "no_admin";

export type TelegramLoginApprovalGate = {
  requestApproval: (
    identity: TelegramOidcIdentity,
  ) => Promise<TelegramLoginApprovalOutcome>;
};

export type OAuthAccessTokenClaims = {
  iss: string;
  aud: string;
  sub: string;
  client_id: string;
  scope: string;
  iat: number;
  exp: number;
  jti: string;
  telegram_id?: string;
  preferred_username?: string;
};

type FailedAttemptState = {
  count: number;
  windowStartedAtMs: number;
};

type CimdClient = {
  redirectUris: Set<string>;
  expiresAtMs: number;
};

type CimdClientInfo = {
  label: "ChatGPT" | "Codex";
  fallbackRedirectUris: readonly string[];
};

type ParsedAuthorizationRequest =
  | { ok: true; value: AuthorizationRequest }
  | { ok: false; error: string };

function cimdClientInfo(clientId: string): CimdClientInfo | null {
  if (clientId === CHATGPT_CIMD_CLIENT_ID) {
    return {
      label: "ChatGPT",
      fallbackRedirectUris: [CHATGPT_CIMD_REDIRECT_URI],
    };
  }
  if (clientId === CODEX_CIMD_CLIENT_ID) {
    return { label: "Codex", fallbackRedirectUris: CODEX_CIMD_REDIRECT_URIS };
  }
  return null;
}

function isCimdClientId(clientId: string): boolean {
  return cimdClientInfo(clientId) !== null;
}

function isAllowedCimdRedirectUri(
  clientId: string,
  redirectUri: string,
  redirectUris: Set<string>,
): boolean {
  if (redirectUris.has(redirectUri)) {
    return true;
  }
  if (clientId !== CODEX_CIMD_CLIENT_ID) {
    return false;
  }
  let candidate: URL;
  try {
    candidate = new URL(redirectUri);
  } catch {
    return false;
  }
  if (
    candidate.protocol !== "http:" ||
    !candidate.port ||
    (candidate.hostname !== "127.0.0.1" && candidate.hostname !== "localhost") ||
    candidate.username ||
    candidate.password ||
    candidate.hash
  ) {
    return false;
  }
  return Array.from(redirectUris).some((registeredUri) => {
    try {
      const registered = new URL(registeredUri);
      return (
        registered.protocol === "http:" &&
        !registered.port &&
        registered.hostname === candidate.hostname &&
        registered.pathname === candidate.pathname &&
        registered.search === candidate.search &&
        !registered.username &&
        !registered.password &&
        !registered.hash
      );
    } catch {
      return false;
    }
  });
}

function readStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : [];
}

export type OAuthFacade = {
  ephemeralSigningKey: boolean;
  handleRequest: (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ) => Promise<boolean>;
  verifyAccessToken: (token: string) => OAuthAccessTokenClaims | null;
  writeMcpChallenge: (res: ServerResponse) => void;
};

function base64UrlJson(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function hash(value: string): Buffer {
  return createHash("sha256").update(value).digest();
}

function safeEqual(left: string, right: string): boolean {
  return timingSafeEqual(hash(left), hash(right));
}

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
}

function writeJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "application/json; charset=utf-8");
  res.end(JSON.stringify(payload));
}

function writeOAuthJson(
  res: ServerResponse,
  statusCode: number,
  payload: unknown,
): void {
  res.setHeader("cache-control", "no-store");
  res.setHeader("pragma", "no-cache");
  writeJson(res, statusCode, payload);
}

function writeText(
  res: ServerResponse,
  statusCode: number,
  message: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/plain; charset=utf-8");
  res.end(message);
}

function writeHtml(
  res: ServerResponse,
  statusCode: number,
  html: string,
): void {
  res.statusCode = statusCode;
  res.setHeader("content-type", "text/html; charset=utf-8");
  res.setHeader("cache-control", "no-store");
  res.setHeader(
    "content-security-policy",
    "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  );
  res.setHeader("x-content-type-options", "nosniff");
  res.end(html);
}

function readHeader(
  req: IncomingMessage,
  headerName: string,
): string | undefined {
  const value = req.headers[headerName];
  return Array.isArray(value) ? value[0] : value;
}

function paramsFromRecord(value: Record<string, unknown>): URLSearchParams {
  const params = new URLSearchParams();
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry === "string") {
      params.set(key, entry);
    } else if (typeof entry === "number" || typeof entry === "boolean") {
      params.set(key, String(entry));
    } else if (Array.isArray(entry) && typeof entry[0] === "string") {
      params.set(key, entry[0]);
    }
  }
  return params;
}

function assertFormSize(params: URLSearchParams): URLSearchParams {
  if (Buffer.byteLength(params.toString()) > OAUTH_FORM_LIMIT_BYTES) {
    throw new Error("form_too_large");
  }
  return params;
}

async function readFormBody(req: IncomingMessage): Promise<URLSearchParams> {
  const requestWithParsedBody = req as IncomingMessage & {
    $params?: Record<string, unknown>;
    body?: unknown;
  };
  if (requestWithParsedBody.$params) {
    return assertFormSize(paramsFromRecord(requestWithParsedBody.$params));
  }
  if (
    requestWithParsedBody.body &&
    typeof requestWithParsedBody.body === "object"
  ) {
    return assertFormSize(
      paramsFromRecord(requestWithParsedBody.body as Record<string, unknown>),
    );
  }
  if (typeof requestWithParsedBody.body === "string") {
    if (
      Buffer.byteLength(requestWithParsedBody.body) > OAUTH_FORM_LIMIT_BYTES
    ) {
      throw new Error("form_too_large");
    }
    return assertFormSize(new URLSearchParams(requestWithParsedBody.body));
  }

  const declaredLength = Number(readHeader(req, "content-length"));
  if (
    Number.isFinite(declaredLength) &&
    declaredLength > OAUTH_FORM_LIMIT_BYTES
  ) {
    throw new Error("form_too_large");
  }

  const chunks: Buffer[] = [];
  let totalBytes = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    totalBytes += buffer.byteLength;
    if (totalBytes > OAUTH_FORM_LIMIT_BYTES) {
      throw new Error("form_too_large");
    }
    chunks.push(buffer);
  }
  return assertFormSize(
    new URLSearchParams(Buffer.concat(chunks).toString("utf8")),
  );
}

function renderAuthorizationForm(
  action: string,
  request: AuthorizationRequest,
  errorMessage?: string,
  telegramLoginUrl?: string,
): string {
  const hidden = [
    ["response_type", "code"],
    ["client_id", request.clientId],
    ["redirect_uri", request.redirectUri],
    ["scope", request.scope],
    ["state", request.state],
    ["code_challenge", request.codeChallenge],
    ["code_challenge_method", "S256"],
    ["resource", request.resource],
  ]
    .map(
      ([name, value]) =>
        `<input type="hidden" name="${name}" value="${escapeHtml(value ?? "")}">`,
    )
    .join("\n");

  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Authorize TellyMCP</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(92vw, 28rem); box-sizing: border-box; padding: 2rem; border: 1px solid #374151; border-radius: 1rem; background: #1f2937; }
    h1 { margin-top: 0; font-size: 1.5rem; }
    p { color: #d1d5db; line-height: 1.5; }
    .error { color: #fca5a5; }
    label { display: block; margin: 1.25rem 0 .5rem; }
    input[type=password] { width: 100%; box-sizing: border-box; padding: .75rem; border: 1px solid #4b5563; border-radius: .5rem; font: inherit; }
    button { width: 100%; margin-top: 1rem; padding: .8rem; border: 0; border-radius: .5rem; background: #2563eb; color: white; font: inherit; font-weight: 600; cursor: pointer; }
    a.telegram-login { display: block; box-sizing: border-box; margin-top: 1.25rem; padding: .8rem; border-radius: .5rem; background: #229ed9; color: white; font-weight: 600; text-align: center; text-decoration: none; }
    .divider { display: flex; align-items: center; gap: .75rem; margin: 1.5rem 0; color: #6b7280; font-size: .85rem; }
    .divider::before, .divider::after { content: ""; flex: 1; height: 1px; background: #374151; }
  </style>
</head>
<body>
  <main>
    <h1>Authorize TellyMCP</h1>
    <p>Enter the private connector token to allow this chat client to use TellyMCP.</p>
    ${errorMessage ? `<p class="error">${escapeHtml(errorMessage)}</p>` : ""}
    <form method="post" action="${escapeHtml(action)}" autocomplete="off">
      ${hidden}
      <label for="magic_token">Private connector token</label>
      <input id="magic_token" name="magic_token" type="password" required autofocus>
      <button type="submit">Authorize</button>
    </form>
    ${
      telegramLoginUrl
        ? `<div class="divider">or</div><a class="telegram-login" href="${escapeHtml(telegramLoginUrl)}">Log in with Telegram</a>`
        : ""
    }
  </main>
</body>
</html>`;
}

function renderTelegramLoginErrorPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1">
  <title>Telegram login failed</title>
  <style>
    :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
    body { display: grid; min-height: 100vh; margin: 0; place-items: center; background: #111827; color: #f9fafb; }
    main { width: min(92vw, 28rem); box-sizing: border-box; padding: 2rem; border: 1px solid #374151; border-radius: 1rem; background: #1f2937; }
    h1 { margin-top: 0; font-size: 1.4rem; }
    p { color: #d1d5db; line-height: 1.5; }
  </style>
</head>
<body>
  <main>
    <h1>Telegram login failed</h1>
    <p>${escapeHtml(message)}</p>
  </main>
</body>
</html>`;
}

function authorizationRequestToSearchParams(
  request: AuthorizationRequest,
): URLSearchParams {
  const params = new URLSearchParams();
  params.set("response_type", "code");
  params.set("client_id", request.clientId);
  params.set("redirect_uri", request.redirectUri);
  params.set("scope", request.scope);
  params.set("state", request.state);
  params.set("code_challenge", request.codeChallenge);
  params.set("code_challenge_method", "S256");
  params.set("resource", request.resource);
  return params;
}

function normalizeUrl(value: string): string {
  return value.replace(/\/+$/u, "");
}

function resolvePrivateKey(config: OAuthConfig): {
  key: KeyObject;
  ephemeral: boolean;
} {
  if (config.privateKeyPem) {
    return {
      key: createPrivateKey(config.privateKeyPem),
      ephemeral: false,
    };
  }

  return {
    key: generateKeyPairSync("rsa", { modulusLength: 2048 }).privateKey,
    ephemeral: true,
  };
}

function parseJwtJson(value: string): unknown {
  return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}

export function createOAuthFacade(
  config: OAuthConfig,
  mcpPath: string,
  logger?: OAuthLogger,
  telegramLoginApproval?: TelegramLoginApprovalGate,
): OAuthFacade {
  const publicUrl = normalizeUrl(config.publicUrl);
  const issuer = normalizeUrl(config.issuer);
  const audience = normalizeUrl(config.audience);
  const normalizedMcpPath = mcpPath.startsWith("/") ? mcpPath : `/${mcpPath}`;
  const mcpResource = `${publicUrl}${normalizedMcpPath}`;
  const allowedResources = new Set([publicUrl, audience, mcpResource]);
  const scope = config.scopes.join(" ");
  const requiredScopes = new Set(config.scopes);
  const { key: privateKey, ephemeral } = resolvePrivateKey(config);
  const publicKey = createPublicKey(privateKey);
  const exportedJwk = publicKey.export({ format: "jwk" });
  const jwk = {
    ...exportedJwk,
    kid: config.keyId,
    use: "sig",
    alg: "RS256",
  };
  const authorizationCodes = new Map<string, AuthorizationCode>();
  const refreshTokens = new Map<string, RefreshTokenRecord>();
  const failedAttempts = new Map<string, FailedAttemptState>();
  const pendingTelegramLogins = new Map<string, PendingTelegramLogin>();
  const cimdClients = new Map<string, CimdClient>();
  const issuerPath = new URL(issuer).pathname.replace(/\/+$/u, "");
  const mcpResourcePath = new URL(mcpResource).pathname;
  const authorizationServerInsertionPath = `/.well-known/oauth-authorization-server${issuerPath === "/" ? "" : issuerPath}`;
  const openIdInsertionPath = `/.well-known/openid-configuration${issuerPath === "/" ? "" : issuerPath}`;
  const protectedResourceInsertionPath = `/.well-known/oauth-protected-resource${mcpResourcePath}`;
  const authorizeEndpoint = `${issuer}/oauth/authorize`;
  const tokenEndpoint = `${issuer}/oauth/token`;
  const jwksUri = `${issuer}/.well-known/jwks.json`;
  const protectedResourceMetadataUrl = `${publicUrl}/.well-known/oauth-protected-resource${normalizedMcpPath}`;

  const authorizationServerMetadata = {
    issuer,
    authorization_endpoint: authorizeEndpoint,
    token_endpoint: tokenEndpoint,
    jwks_uri: jwksUri,
    response_types_supported: ["code"],
    grant_types_supported: ["authorization_code", "refresh_token"],
    code_challenge_methods_supported: ["S256"],
    // Keep `none` available for a public client that proves its identity with
    // ChatGPT's Client ID Metadata Document (CIMD). The legacy operator-owned
    // confidential client remains available alongside it.
    token_endpoint_auth_methods_supported: [
      "none",
      ...(config.clientSecret
        ? ["client_secret_post", "client_secret_basic"]
        : []),
    ],
    client_id_metadata_document_supported: true,
    authorization_response_iss_parameter_supported: true,
    scopes_supported: config.scopes,
  };

  const purgeExpiredCodes = (nowMs: number): void => {
    for (const [code, record] of authorizationCodes) {
      if (record.expiresAtMs <= nowMs) {
        authorizationCodes.delete(code);
      }
    }
  };

  const purgeExpiredRefreshTokens = (nowMs: number): void => {
    for (const [token, record] of refreshTokens) {
      if (record.expiresAtMs <= nowMs) {
        refreshTokens.delete(token);
      }
    }
  };

  const issueRefreshToken = (
    record: Pick<
      RefreshTokenRecord,
      "clientId" | "clientAuthentication" | "scope" | "resource" | "subject" | "telegramIdentity"
    >,
  ): string => {
    const token = randomBytes(32).toString("base64url");
    refreshTokens.set(token, {
      ...record,
      expiresAtMs: Date.now() + config.refreshTokenTtlSeconds * 1000,
    });
    return token;
  };

  const purgeExpiredTelegramLogins = (nowMs: number): void => {
    for (const [state, record] of pendingTelegramLogins) {
      if (record.expiresAtMs <= nowMs) {
        pendingTelegramLogins.delete(state);
      }
    }
  };

  const resolveCimdClient = async (
    clientId: string,
  ): Promise<CimdClient | null> => {
    const knownClient = cimdClientInfo(clientId);
    if (!knownClient) {
      return null;
    }

    const cached = cimdClients.get(clientId);
    if (cached && cached.expiresAtMs > Date.now()) {
      return cached;
    }

    try {
      const response = await fetch(clientId, {
        headers: { accept: "application/json" },
        redirect: "error",
        signal: AbortSignal.timeout(5_000),
      });
      if (!response.ok) {
        throw new Error(`CIMD metadata request failed: ${response.status}`);
      }
      const metadata: unknown = await response.json();
      if (!metadata || typeof metadata !== "object") {
        throw new Error("CIMD metadata was not an object");
      }
      const methods = new Set([
        ...readStringArray(
          Reflect.get(metadata, "token_endpoint_auth_methods_supported"),
        ),
        ...(typeof Reflect.get(metadata, "token_endpoint_auth_method") ===
        "string"
          ? [
              Reflect.get(
                metadata,
                "token_endpoint_auth_method",
              ) as string,
            ]
          : []),
      ]);
      const redirectUris = new Set(
        readStringArray(Reflect.get(metadata, "redirect_uris")).filter(
          (redirectUri) => {
            try {
              const parsed = new URL(redirectUri);
              const httpsRedirect = parsed.protocol === "https:" && !parsed.hash;
              const codexLoopbackRedirect =
                clientId === CODEX_CIMD_CLIENT_ID &&
                parsed.protocol === "http:" &&
                !parsed.port &&
                !parsed.hash &&
                (parsed.hostname === "127.0.0.1" ||
                  parsed.hostname === "localhost");
              return httpsRedirect || codexLoopbackRedirect;
            } catch {
              return false;
            }
          },
        ),
      );
      if (!methods.has("none") || redirectUris.size === 0) {
        throw new Error("CIMD metadata did not support public PKCE");
      }
      const client = {
        redirectUris,
        expiresAtMs: Date.now() + CIMD_CACHE_TTL_MS,
      };
      cimdClients.set(clientId, client);
      return client;
    } catch {
      // The two URLs above are pinned OpenAI public client identities. A
      // narrow fallback keeps a transient OpenAI-edge JSON failure from
      // breaking `codex mcp login`, without turning this into a generic URL
      // fetch / SSRF bypass.
      const client = {
        redirectUris: new Set(knownClient.fallbackRedirectUris),
        expiresAtMs: Date.now() + 60_000,
      };
      cimdClients.set(clientId, client);
      return client;
    }
  };

  const parseAuthorizationRequest = async (
    params: URLSearchParams,
  ): Promise<ParsedAuthorizationRequest> => {
    if (params.get("response_type") !== "code") {
      return { ok: false, error: "response_type must be code" };
    }
    if (params.get("code_challenge_method") !== "S256") {
      return { ok: false, error: "code_challenge_method must be S256" };
    }

    const clientId = params.get("client_id")?.trim() ?? "";
    const redirectUri = params.get("redirect_uri")?.trim() ?? "";
    const requestedScope = params.get("scope")?.trim() ?? scope;
    const state = params.get("state") ?? "";
    const codeChallenge = params.get("code_challenge")?.trim() ?? "";
    const resource = normalizeUrl(params.get("resource")?.trim() || audience);
    if (!clientId || !redirectUri || !codeChallenge) {
      return { ok: false, error: "Missing required OAuth parameters" };
    }
    if (!/^[A-Za-z0-9_-]{43,128}$/u.test(codeChallenge)) {
      return { ok: false, error: "Invalid PKCE code challenge" };
    }
    try {
      const parsedRedirect = new URL(redirectUri);
      if (parsedRedirect.hash) {
        return { ok: false, error: "Redirect URI must not contain a fragment" };
      }
    } catch {
      return { ok: false, error: "Invalid redirect URI" };
    }
    if (!allowedResources.has(resource)) {
      return { ok: false, error: "Invalid OAuth resource" };
    }

    const requestedScopes = requestedScope.split(/\s+/u).filter(Boolean);
    if (requestedScopes.some((requested) => !requiredScopes.has(requested))) {
      return { ok: false, error: "Unsupported OAuth scope" };
    }

    let clientAuthentication: AuthorizationRequest["clientAuthentication"];
    if (isCimdClientId(clientId)) {
      const client = await resolveCimdClient(clientId);
      if (
        !client ||
        !isAllowedCimdRedirectUri(clientId, redirectUri, client.redirectUris)
      ) {
        return { ok: false, error: "Unknown OAuth client" };
      }
      clientAuthentication = "cimd";
    } else {
      if (config.clientId && clientId !== config.clientId) {
        return { ok: false, error: "Unknown OAuth client" };
      }
      if (
        config.allowedRedirectUris.length > 0 &&
        !config.allowedRedirectUris.includes(redirectUri)
      ) {
        return { ok: false, error: "Redirect URI is not allowed" };
      }
      clientAuthentication = config.clientSecret ? "confidential" : "public";
    }

    return {
      ok: true,
      value: {
        clientId,
        clientAuthentication,
        redirectUri,
        scope: requestedScope,
        state,
        codeChallenge,
        resource,
      },
    };
  };

  const isMagicTokenValid = (candidate: string): boolean => {
    if (config.magicToken) {
      return safeEqual(candidate, config.magicToken);
    }
    if (!config.magicTokenHash) {
      return false;
    }
    const expected = Buffer.from(
      config.magicTokenHash.slice("sha256:".length),
      "hex",
    );
    return timingSafeEqual(hash(candidate), expected);
  };

  const failedAttemptKey = (req: IncomingMessage): string =>
    req.socket?.remoteAddress ?? "unknown";

  const isRateLimited = (key: string, nowMs: number): boolean => {
    const state = failedAttempts.get(key);
    if (!state) {
      return false;
    }
    if (nowMs - state.windowStartedAtMs >= FAILED_MAGIC_TOKEN_WINDOW_MS) {
      failedAttempts.delete(key);
      return false;
    }
    return state.count >= MAX_FAILED_MAGIC_TOKEN_ATTEMPTS;
  };

  const recordFailedAttempt = (key: string, nowMs: number): void => {
    const state = failedAttempts.get(key);
    if (
      !state ||
      nowMs - state.windowStartedAtMs >= FAILED_MAGIC_TOKEN_WINDOW_MS
    ) {
      failedAttempts.set(key, { count: 1, windowStartedAtMs: nowMs });
      return;
    }
    state.count += 1;
  };

  const purgeExpiredFailedAttempts = (nowMs: number): void => {
    for (const [key, state] of failedAttempts) {
      if (nowMs - state.windowStartedAtMs >= FAILED_MAGIC_TOKEN_WINDOW_MS) {
        failedAttempts.delete(key);
      }
    }
  };

  const authenticateTokenClient = (
    req: IncomingMessage,
    params: URLSearchParams,
    record: Pick<AuthorizationCode, "clientId" | "clientAuthentication">,
  ): string | null => {
    const formClientId = params.get("client_id")?.trim() ?? "";
    if (formClientId !== record.clientId) {
      return null;
    }
    if (record.clientAuthentication !== "confidential") {
      // CIMD uses a public OAuth client. Its identity and redirect URI were
      // verified from ChatGPT's hosted metadata before issuing this code; PKCE
      // binds the exchange to the same client without a stored client secret.
      return formClientId;
    }
    const clientSecret = config.clientSecret;
    if (!clientSecret) {
      return null;
    }

    const authorization = readHeader(req, "authorization");
    if (authorization?.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(
          authorization.slice("Basic ".length),
          "base64",
        ).toString("utf8");
        const separator = decoded.indexOf(":");
        if (separator < 0) {
          return null;
        }
        const basicClientId = decoded.slice(0, separator);
        const basicSecret = decoded.slice(separator + 1);
        if (
          basicClientId === record.clientId &&
          safeEqual(basicSecret, clientSecret)
        ) {
          return basicClientId;
        }
      } catch {
        return null;
      }
      return null;
    }

    const formSecret = params.get("client_secret") ?? "";
    if (
      formClientId === record.clientId &&
      safeEqual(formSecret, clientSecret)
    ) {
      return formClientId;
    }
    return null;
  };

  const issueAccessToken = (
    record: Pick<AuthorizationCode, "resource" | "subject" | "clientId" | "telegramIdentity">,
  ): string => {
    const header = base64UrlJson({
      alg: "RS256",
      typ: "JWT",
      kid: config.keyId,
    });
    const issuedAt = Math.floor(Date.now() / 1000);
    const claims: OAuthAccessTokenClaims = {
      iss: issuer,
      aud: record.resource,
      sub: record.subject,
      client_id: record.clientId,
      scope,
      iat: issuedAt,
      exp: issuedAt + config.accessTokenTtlSeconds,
      jti: randomUUID(),
      ...(record.telegramIdentity
        ? {
            telegram_id: record.telegramIdentity.telegramId,
            ...(record.telegramIdentity.username
              ? { preferred_username: record.telegramIdentity.username }
              : {}),
          }
        : {}),
    };
    const payload = base64UrlJson(claims);
    const signingInput = `${header}.${payload}`;
    const signature = sign(
      "RSA-SHA256",
      Buffer.from(signingInput),
      privateKey,
    ).toString("base64url");
    return `${signingInput}.${signature}`;
  };

  const verifyAccessToken = (token: string): OAuthAccessTokenClaims | null => {
    const reject = (reason: string): null => {
      logger?.warn("OAuth access token rejected", { reason });
      return null;
    };

    try {
      const parts = token.split(".");
      if (parts.length !== 3) {
        return reject("malformed_jwt");
      }
      const [encodedHeader, encodedPayload, encodedSignature] = parts;
      if (!encodedHeader || !encodedPayload || !encodedSignature) {
        return reject("malformed_jwt");
      }
      const header = parseJwtJson(encodedHeader);
      const claims = parseJwtJson(encodedPayload);
      if (
        !header ||
        typeof header !== "object" ||
        Reflect.get(header, "alg") !== "RS256" ||
        Reflect.get(header, "kid") !== config.keyId ||
        !claims ||
        typeof claims !== "object"
      ) {
        return reject("invalid_jwt_header_or_payload");
      }
      if (
        !verify(
          "RSA-SHA256",
          Buffer.from(`${encodedHeader}.${encodedPayload}`),
          publicKey,
          Buffer.from(encodedSignature, "base64url"),
        )
      ) {
        return reject("invalid_signature");
      }

      const candidate = claims as Partial<OAuthAccessTokenClaims>;
      if (
        candidate.iss !== issuer ||
        typeof candidate.aud !== "string" ||
        !allowedResources.has(candidate.aud) ||
        typeof candidate.sub !== "string" ||
        typeof candidate.client_id !== "string" ||
        typeof candidate.scope !== "string" ||
        typeof candidate.iat !== "number" ||
        typeof candidate.exp !== "number" ||
        typeof candidate.jti !== "string" ||
        candidate.iat > Math.floor(Date.now() / 1000) + 60 ||
        candidate.exp <= Math.floor(Date.now() / 1000)
      ) {
        return reject("invalid_claims");
      }
      if (
        config.clientId &&
        candidate.client_id !== config.clientId &&
        !isCimdClientId(candidate.client_id)
      ) {
        return reject("client_id_mismatch");
      }
      const tokenScopes = new Set(
        candidate.scope.split(/\s+/u).filter(Boolean),
      );
      if ([...requiredScopes].some((required) => !tokenScopes.has(required))) {
        return reject("missing_required_scope");
      }
      logger?.info("OAuth access token accepted", {
        clientId: candidate.client_id,
        audience: candidate.aud,
        scopes: candidate.scope,
      });
      return candidate as OAuthAccessTokenClaims;
    } catch (error) {
      return reject(
        error instanceof Error
          ? `verification_error:${error.name}`
          : "verification_error",
      );
    }
  };

  const handleRequest = async (
    req: IncomingMessage,
    res: ServerResponse,
    pathname: string,
  ): Promise<boolean> => {
    const method = req.method ?? "GET";

    if (
      pathname === "/.well-known/oauth-protected-resource" ||
      pathname === "/.well-known/oauth-protected-resource/mcp" ||
      pathname === protectedResourceInsertionPath
    ) {
      if (method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return true;
      }
      const resource =
        pathname === "/.well-known/oauth-protected-resource"
          ? audience
          : mcpResource;
      logger?.info("OAuth protected-resource metadata served", {
        path: pathname,
        resource,
      });
      writeJson(res, 200, {
        resource,
        authorization_servers: [issuer],
        scopes_supported: config.scopes,
      });
      return true;
    }

    if (
      pathname === "/.well-known/oauth-authorization-server" ||
      pathname === authorizationServerInsertionPath ||
      pathname === openIdInsertionPath
    ) {
      if (method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return true;
      }
      logger?.info("OAuth authorization-server metadata served", {
        path: pathname,
        issuer,
        clientAuthentication: config.clientSecret ? "confidential" : "public",
      });
      writeJson(res, 200, authorizationServerMetadata);
      return true;
    }

    if (pathname === "/.well-known/jwks.json") {
      if (method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return true;
      }
      logger?.info("OAuth JWKS served", { keyId: config.keyId });
      writeJson(res, 200, { keys: [jwk] });
      return true;
    }

    if (pathname === "/oauth/authorize") {
      if (method !== "GET" && method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      let params: URLSearchParams;
      try {
        params =
          method === "GET"
            ? new URL(req.url ?? authorizeEndpoint, authorizeEndpoint)
                .searchParams
            : await readFormBody(req);
      } catch {
        writeText(res, 413, "OAuth form is too large");
        return true;
      }
      const parsed = await parseAuthorizationRequest(params);
      if (!parsed.ok) {
        logger?.warn("OAuth authorization request rejected", {
          method,
          reason: parsed.error,
        });
        writeText(res, 400, parsed.error);
        return true;
      }
      const telegramLoginUrl = config.telegramLogin
        ? `${issuer}/oauth/tg/login?${authorizationRequestToSearchParams(parsed.value).toString()}`
        : undefined;

      if (method === "GET") {
        logger?.info("OAuth authorization form opened", {
          clientId: parsed.value.clientId,
          redirectUri: parsed.value.redirectUri,
          resource: parsed.value.resource,
          requestedScope: parsed.value.scope,
        });
        writeHtml(
          res,
          200,
          renderAuthorizationForm(
            authorizeEndpoint,
            parsed.value,
            undefined,
            telegramLoginUrl,
          ),
        );
        return true;
      }

      const nowMs = Date.now();
      purgeExpiredFailedAttempts(nowMs);
      const attemptKey = failedAttemptKey(req);
      if (isRateLimited(attemptKey, nowMs)) {
        logger?.warn("OAuth magic-token attempt rate-limited", {
          clientId: parsed.value.clientId,
          remoteAddress: attemptKey,
        });
        res.setHeader("retry-after", "60");
        writeHtml(
          res,
          429,
          renderAuthorizationForm(
            authorizeEndpoint,
            parsed.value,
            "Authorization failed. Try again later.",
            telegramLoginUrl,
          ),
        );
        return true;
      }

      const magicToken = params.get("magic_token") ?? "";
      if (!isMagicTokenValid(magicToken)) {
        recordFailedAttempt(attemptKey, nowMs);
        logger?.warn("OAuth magic token rejected", {
          clientId: parsed.value.clientId,
          remoteAddress: attemptKey,
        });
        writeHtml(
          res,
          401,
          renderAuthorizationForm(
            authorizeEndpoint,
            parsed.value,
            "Invalid connector token.",
            telegramLoginUrl,
          ),
        );
        return true;
      }
      failedAttempts.delete(attemptKey);
      purgeExpiredCodes(nowMs);
      const code = randomBytes(32).toString("base64url");
      authorizationCodes.set(code, {
        ...parsed.value,
        expiresAtMs: nowMs + config.authCodeTtlSeconds * 1000,
        subject: "tellymcp-magic-token",
      });
      logger?.info("OAuth authorization code issued", {
        clientId: parsed.value.clientId,
        redirectUri: parsed.value.redirectUri,
        resource: parsed.value.resource,
        grantedScopes: scope,
        expiresInSeconds: config.authCodeTtlSeconds,
      });
      const redirect = new URL(parsed.value.redirectUri);
      redirect.searchParams.set("code", code);
      redirect.searchParams.set("iss", issuer);
      if (parsed.value.state) {
        redirect.searchParams.set("state", parsed.value.state);
      }
      res.statusCode = 302;
      res.setHeader("location", redirect.toString());
      res.setHeader("cache-control", "no-store");
      res.end();
      return true;
    }

    if (pathname === "/oauth/tg/login") {
      if (!config.telegramLogin) {
        writeText(res, 404, "Not found");
        return true;
      }
      if (method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      const params = new URL(req.url ?? authorizeEndpoint, authorizeEndpoint)
        .searchParams;
      const parsed = await parseAuthorizationRequest(params);
      if (!parsed.ok) {
        logger?.warn("Telegram login request rejected", {
          reason: parsed.error,
        });
        writeText(res, 400, parsed.error);
        return true;
      }

      const nowMs = Date.now();
      purgeExpiredTelegramLogins(nowMs);
      const { verifier, challenge } = generateTelegramOidcPkce();
      const telegramState = randomBytes(24).toString("base64url");
      pendingTelegramLogins.set(telegramState, {
        authorizationRequest: parsed.value,
        codeVerifier: verifier,
        expiresAtMs: nowMs + TELEGRAM_LOGIN_STATE_TTL_MS,
      });

      const authorizeUrl = buildTelegramAuthorizeUrl(config.telegramLogin, {
        state: telegramState,
        codeChallenge: challenge,
      });
      logger?.info("Telegram login started", {
        clientId: parsed.value.clientId,
        redirectUri: parsed.value.redirectUri,
      });
      res.statusCode = 302;
      res.setHeader("location", authorizeUrl);
      res.setHeader("cache-control", "no-store");
      res.end();
      return true;
    }

    if (pathname === "/oauth/tg/callback") {
      if (!config.telegramLogin || !telegramLoginApproval) {
        writeText(res, 404, "Not found");
        return true;
      }
      if (method !== "GET") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      const params = new URL(req.url ?? authorizeEndpoint, authorizeEndpoint)
        .searchParams;
      const telegramState = params.get("state") ?? "";
      const pending = pendingTelegramLogins.get(telegramState);
      pendingTelegramLogins.delete(telegramState);
      const nowMs = Date.now();
      purgeExpiredTelegramLogins(nowMs);
      if (!pending || pending.expiresAtMs <= nowMs) {
        writeHtml(
          res,
          400,
          renderTelegramLoginErrorPage(
            "This Telegram login link has expired. Please try again.",
          ),
        );
        return true;
      }

      const code = params.get("code");
      if (!code) {
        writeHtml(
          res,
          400,
          renderTelegramLoginErrorPage(
            "Telegram did not return an authorization code.",
          ),
        );
        return true;
      }

      let identity: TelegramOidcIdentity;
      try {
        const idToken = await exchangeTelegramOidcCode(config.telegramLogin, {
          code,
          codeVerifier: pending.codeVerifier,
        });
        identity = await verifyTelegramOidcIdToken(
          idToken,
          config.telegramLogin.clientId,
        );
      } catch (error) {
        logger?.warn("Telegram OIDC login verification failed", {
          reason: error instanceof Error ? error.message : String(error),
        });
        writeHtml(
          res,
          400,
          renderTelegramLoginErrorPage(
            "Telegram login verification failed. Please try again.",
          ),
        );
        return true;
      }

      logger?.info("Telegram identity verified, requesting admin approval", {
        telegramId: identity.telegramId,
        username: identity.username,
      });

      const outcome = await telegramLoginApproval.requestApproval(identity);
      if (outcome !== "approved") {
        logger?.warn("Telegram login was not approved", {
          telegramId: identity.telegramId,
          outcome,
        });
        writeHtml(
          res,
          403,
          renderTelegramLoginErrorPage(
            outcome === "no_admin"
              ? "No gateway admin is currently authorized to approve this login. Authorize an admin on the bot first (/auth)."
              : outcome === "timeout"
                ? "The login request timed out waiting for admin approval."
                : "The admin rejected this login request.",
          ),
        );
        return true;
      }

      purgeExpiredCodes(nowMs);
      const issuedCode = randomBytes(32).toString("base64url");
      authorizationCodes.set(issuedCode, {
        ...pending.authorizationRequest,
        expiresAtMs: nowMs + config.authCodeTtlSeconds * 1000,
        subject: `telegram:${identity.telegramId}`,
        telegramIdentity: identity,
      });
      logger?.info("OAuth authorization code issued via Telegram login", {
        clientId: pending.authorizationRequest.clientId,
        redirectUri: pending.authorizationRequest.redirectUri,
        telegramId: identity.telegramId,
      });

      const redirect = new URL(pending.authorizationRequest.redirectUri);
      redirect.searchParams.set("code", issuedCode);
      redirect.searchParams.set("iss", issuer);
      if (pending.authorizationRequest.state) {
        redirect.searchParams.set("state", pending.authorizationRequest.state);
      }
      res.statusCode = 302;
      res.setHeader("location", redirect.toString());
      res.setHeader("cache-control", "no-store");
      res.end();
      return true;
    }

    if (pathname === "/oauth/token") {
      if (method !== "POST") {
        writeText(res, 405, "Method not allowed");
        return true;
      }

      let params: URLSearchParams;
      try {
        params = await readFormBody(req);
      } catch {
        writeOAuthJson(res, 413, { error: "invalid_request" });
        return true;
      }
      const grantType = params.get("grant_type");
      if (grantType !== "authorization_code" && grantType !== "refresh_token") {
        logger?.warn("OAuth token request rejected", {
          reason: "unsupported_grant_type",
        });
        writeOAuthJson(res, 400, { error: "unsupported_grant_type" });
        return true;
      }

      if (grantType === "refresh_token") {
        const presentedToken = params.get("refresh_token") ?? "";
        const refreshRecord = refreshTokens.get(presentedToken);
        const refreshNowMs = Date.now();
        purgeExpiredRefreshTokens(refreshNowMs);
        if (!refreshRecord || refreshRecord.expiresAtMs <= refreshNowMs) {
          refreshTokens.delete(presentedToken);
          logger?.warn("OAuth token request rejected", {
            reason: "unknown_or_expired_refresh_token",
            clientId: params.get("client_id")?.trim() || null,
          });
          writeOAuthJson(res, 400, { error: "invalid_grant" });
          return true;
        }

        const authenticatedRefreshClientId = authenticateTokenClient(
          req,
          params,
          refreshRecord,
        );
        if (
          !authenticatedRefreshClientId ||
          authenticatedRefreshClientId !== refreshRecord.clientId
        ) {
          logger?.warn("OAuth token request rejected", {
            reason: "invalid_client",
            clientId: params.get("client_id")?.trim() || null,
            grantType: "refresh_token",
          });
          if (refreshRecord.clientAuthentication === "confidential") {
            res.setHeader("www-authenticate", 'Basic realm="oauth/token"');
          }
          writeOAuthJson(res, 401, { error: "invalid_client" });
          return true;
        }

        // Rotate on every use: the presented token is consumed here and a
        // fresh one takes its place, so a stolen-and-replayed refresh token
        // stops working the moment the legitimate client refreshes again.
        refreshTokens.delete(presentedToken);
        const rotatedRefreshToken = issueRefreshToken(refreshRecord);
        logger?.info("OAuth access token refreshed", {
          clientId: refreshRecord.clientId,
          audience: refreshRecord.resource,
          grantedScopes: scope,
        });
        writeOAuthJson(res, 200, {
          access_token: issueAccessToken(refreshRecord),
          token_type: "Bearer",
          refresh_token: rotatedRefreshToken,
          scope,
        });
        return true;
      }

      const code = params.get("code") ?? "";
      const record = authorizationCodes.get(code);
      const nowMs = Date.now();
      purgeExpiredCodes(nowMs);
      if (!record || record.expiresAtMs <= nowMs) {
        authorizationCodes.delete(code);
        logger?.warn("OAuth token request rejected", {
          reason: "unknown_or_expired_code",
          clientId: params.get("client_id")?.trim() || null,
        });
        writeOAuthJson(res, 400, { error: "invalid_grant" });
        return true;
      }

      const authenticatedClientId = authenticateTokenClient(req, params, record);
      if (!authenticatedClientId) {
        logger?.warn("OAuth token request rejected", {
          reason: "invalid_client",
          clientId: params.get("client_id")?.trim() || null,
          authenticationMethod: readHeader(req, "authorization")?.startsWith(
            "Basic ",
          )
            ? "client_secret_basic"
            : "client_secret_post",
        });
        if (record.clientAuthentication === "confidential") {
          res.setHeader("www-authenticate", 'Basic realm="oauth/token"');
        }
        writeOAuthJson(res, 401, { error: "invalid_client" });
        return true;
      }

      const redirectUri = params.get("redirect_uri") ?? "";
      const resource = normalizeUrl(params.get("resource") || record.resource);
      const codeVerifier = params.get("code_verifier") ?? "";
      const verifierChallenge = createHash("sha256")
        .update(codeVerifier)
        .digest("base64url");
      if (
        authenticatedClientId !== record.clientId ||
        redirectUri !== record.redirectUri ||
        resource !== record.resource ||
        !/^[A-Za-z0-9._~-]{43,128}$/u.test(codeVerifier) ||
        !safeEqual(verifierChallenge, record.codeChallenge)
      ) {
        logger?.warn("OAuth token request rejected", {
          reason: "authorization_code_binding_or_pkce_mismatch",
          clientId: authenticatedClientId,
          redirectUriMatches: redirectUri === record.redirectUri,
          resourceMatches: resource === record.resource,
        });
        writeOAuthJson(res, 400, { error: "invalid_grant" });
        return true;
      }

      authorizationCodes.delete(code);
      logger?.info("OAuth access token issued", {
        clientId: record.clientId,
        audience: record.resource,
        grantedScopes: scope,
      });
      writeOAuthJson(res, 200, {
        access_token: issueAccessToken(record),
        token_type: "Bearer",
        refresh_token: issueRefreshToken(record),
        scope,
      });
      return true;
    }

    return false;
  };

  return {
    ephemeralSigningKey: ephemeral,
    handleRequest,
    verifyAccessToken,
    writeMcpChallenge(res) {
      res.setHeader(
        "www-authenticate",
        `Bearer resource_metadata="${protectedResourceMetadataUrl}", scope="${scope}"`,
      );
    },
  };
}
