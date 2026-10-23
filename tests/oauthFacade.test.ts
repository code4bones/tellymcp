import { createHash, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import { isMcpHttpRequestAuthorized } from "../src/services/features/telegram-mcp/src/app/http";
import { createOAuthFacade } from "../src/services/features/telegram-mcp/src/app/oauthFacade";

vi.mock(
  "../src/services/features/telegram-mcp/src/app/telegramOidc",
  async (importOriginal) => {
    const original = await importOriginal<
      typeof import("../src/services/features/telegram-mcp/src/app/telegramOidc")
    >();
    return {
      ...original,
      exchangeTelegramOidcCode: vi.fn(),
      verifyTelegramOidcIdToken: vi.fn(),
    };
  },
);

import {
  exchangeTelegramOidcCode,
  verifyTelegramOidcIdToken,
} from "../src/services/features/telegram-mcp/src/app/telegramOidc";

type TestResponse = ServerResponse & {
  body: string;
  headers: Map<string, string>;
};

const privateKeyPem = generateKeyPairSync("rsa", { modulusLength: 2048 })
  .privateKey.export({ type: "pkcs8", format: "pem" })
  .toString();

const oauthConfig = {
  publicUrl: "https://mcp.example.com/api",
  issuer: "https://mcp.example.com/api",
  audience: "https://mcp.example.com/api",
  magicToken: "private-magic-token",
  allowedRedirectUris: ["https://chat.example/callback"],
  privateKeyPem,
  authCodeTtlSeconds: 300,
  accessTokenTtlSeconds: 3600,
  scopes: ["tellymcp:read", "tellymcp:write"],
  keyId: "tellymcp-test",
} satisfies NonNullable<AppConfig["oauth"]>;

afterEach(() => {
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

function makeRequest(
  input: {
    method?: string;
    url?: string;
    body?: string;
    headers?: Record<string, string>;
  } = {},
): IncomingMessage {
  const request = Readable.from(
    input.body ? [input.body] : [],
  ) as IncomingMessage;
  request.method = input.method ?? "GET";
  request.url = input.url ?? "/";
  request.headers = input.headers ?? {};
  Object.defineProperty(request, "socket", {
    value: { remoteAddress: "127.0.0.1" },
    configurable: true,
  });
  return request;
}

function makeResponse(): TestResponse {
  const headers = new Map<string, string>();
  return {
    statusCode: 200,
    body: "",
    headers,
    setHeader(name: string, value: number | string | readonly string[]) {
      headers.set(name.toLowerCase(), String(value));
      return this;
    },
    getHeader(name: string) {
      return headers.get(name.toLowerCase());
    },
    end(this: TestResponse, body?: string | Buffer) {
      this.body = body?.toString() ?? "";
      return this;
    },
  } as unknown as TestResponse;
}

function authorizationParams(verifier: string): URLSearchParams {
  return new URLSearchParams({
    response_type: "code",
    client_id: "chat-client",
    redirect_uri: "https://chat.example/callback",
    scope: "tellymcp:read",
    state: "original-state",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
    resource: "https://mcp.example.com/api/mcp",
  });
}

async function authorize(
  facade: ReturnType<typeof createOAuthFacade>,
  verifier: string,
): Promise<string> {
  const params = authorizationParams(verifier);
  params.set("magic_token", "private-magic-token");
  const response = makeResponse();
  await facade.handleRequest(
    makeRequest({
      method: "POST",
      url: "/api/oauth/authorize",
      body: params.toString(),
    }),
    response,
    "/oauth/authorize",
  );

  expect(response.statusCode).toBe(302);
  const location = response.headers.get("location");
  expect(location).toBeDefined();
  const redirect = new URL(location ?? "https://invalid.example");
  expect(redirect.searchParams.get("state")).toBe("original-state");
  expect(redirect.searchParams.get("iss")).toBe(
    "https://mcp.example.com/api",
  );
  return redirect.searchParams.get("code") ?? "";
}

async function issueAccessToken(
  facade: ReturnType<typeof createOAuthFacade>,
  verifier: string,
): Promise<string> {
  const code = await authorize(facade, verifier);
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: "https://chat.example/callback",
    client_id: "chat-client",
    code_verifier: verifier,
    resource: "https://mcp.example.com/api/mcp",
  });
  const response = makeResponse();
  await facade.handleRequest(
    makeRequest({ method: "POST", body: tokenParams.toString() }),
    response,
    "/oauth/token",
  );
  expect(response.statusCode).toBe(200);
  return (JSON.parse(response.body) as { access_token: string }).access_token;
}

describe("TellyMCP OAuth facade", () => {
  it("serves prefixed and issuer path-insertion discovery metadata", async () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");

    const authorizationResponse = makeResponse();
    await expect(
      facade.handleRequest(
        makeRequest(),
        authorizationResponse,
        "/.well-known/oauth-authorization-server/api",
      ),
    ).resolves.toBe(true);
    expect(JSON.parse(authorizationResponse.body)).toMatchObject({
      issuer: "https://mcp.example.com/api",
      authorization_endpoint: "https://mcp.example.com/api/oauth/authorize",
      token_endpoint_auth_methods_supported: ["none"],
      client_id_metadata_document_supported: true,
      authorization_response_iss_parameter_supported: true,
    });

    const resourceResponse = makeResponse();
    await facade.handleRequest(
      makeRequest(),
      resourceResponse,
      "/.well-known/oauth-protected-resource/api/mcp",
    );
    expect(JSON.parse(resourceResponse.body)).toMatchObject({
      resource: "https://mcp.example.com/api/mcp",
      authorization_servers: ["https://mcp.example.com/api"],
    });

    const baseResourceResponse = makeResponse();
    await facade.handleRequest(
      makeRequest(),
      baseResourceResponse,
      "/.well-known/oauth-protected-resource",
    );
    expect(JSON.parse(baseResourceResponse.body)).toMatchObject({
      resource: "https://mcp.example.com/api",
    });
  });

  it("renders the authorization form without exposing the magic token", async () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const params = authorizationParams("v".repeat(64));
    const response = makeResponse();

    await facade.handleRequest(
      makeRequest({
        url: `/api/oauth/authorize?${params.toString()}`,
      }),
      response,
      "/oauth/authorize",
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Authorize TellyMCP");
    expect(response.body).not.toContain("private-magic-token");
  });

  it("rejects a bad magic token with a generic response", async () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const params = authorizationParams("v".repeat(64));
    params.set("magic_token", "wrong-token");
    const response = makeResponse();

    await facade.handleRequest(
      makeRequest({
        method: "POST",
        body: params.toString(),
      }),
      response,
      "/oauth/authorize",
    );

    expect(response.statusCode).toBe(401);
    expect(response.body).toContain("Invalid connector token");
    expect(response.body).not.toContain("wrong-token");
  });

  it("accepts the hashed magic-token configuration", async () => {
    const { magicToken: _magicToken, ...configWithoutRawMagicToken } =
      oauthConfig;
    const facade = createOAuthFacade(
      {
        ...configWithoutRawMagicToken,
        magicTokenHash: `sha256:${createHash("sha256")
          .update("private-magic-token")
          .digest("hex")}`,
      },
      "/mcp",
    );
    const params = authorizationParams("v".repeat(64));
    params.set("magic_token", "private-magic-token");
    const response = makeResponse();

    await facade.handleRequest(
      makeRequest({ method: "POST", body: params.toString() }),
      response,
      "/oauth/authorize",
    );

    expect(response.statusCode).toBe(302);
  });

  it("exchanges a one-time PKCE code for a verifiable RS256 token", async () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const verifier = "correct-verifier-".padEnd(64, "x");
    const code = await authorize(facade, verifier);
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chat.example/callback",
      client_id: "chat-client",
      code_verifier: verifier,
      resource: "https://mcp.example.com/api/mcp",
    });
    const tokenResponse = makeResponse();

    await facade.handleRequest(
      makeRequest({ method: "POST", body: tokenParams.toString() }),
      tokenResponse,
      "/oauth/token",
    );

    expect(tokenResponse.statusCode).toBe(200);
    const payload = JSON.parse(tokenResponse.body) as {
      access_token: string;
      scope: string;
    };
    expect(payload.scope).toBe("tellymcp:read tellymcp:write");
    expect(facade.verifyAccessToken(payload.access_token)).toMatchObject({
      iss: "https://mcp.example.com/api",
      aud: "https://mcp.example.com/api/mcp",
      client_id: "chat-client",
      scope: "tellymcp:read tellymcp:write",
      exp: expect.any(Number),
    });
    const tokenParts = payload.access_token.split(".");
    const signature = tokenParts[2]!;
    const signatureOffset = Math.floor(signature.length / 2);
    const tamperedSignature = `${signature.slice(0, signatureOffset)}${
      signature[signatureOffset] === "A" ? "B" : "A"
    }${signature.slice(signatureOffset + 1)}`;
    expect(
      facade.verifyAccessToken(
        `${tokenParts[0]}.${tokenParts[1]}.${tamperedSignature}`,
      ),
    ).toBeNull();

    const reusedResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({ method: "POST", body: tokenParams.toString() }),
      reusedResponse,
      "/oauth/token",
    );
    expect(reusedResponse.statusCode).toBe(400);
    expect(JSON.parse(reusedResponse.body)).toEqual({ error: "invalid_grant" });
  });

  it("requires the configured confidential-client secret", async () => {
    const facade = createOAuthFacade(
      {
        ...oauthConfig,
        clientId: "chat-client",
        clientSecret: "client-secret",
      },
      "/mcp",
    );
    const verifier = "confidential-verifier-".padEnd(64, "x");
    const code = await authorize(facade, verifier);
    const tokenParams = new URLSearchParams({
      grant_type: "authorization_code",
      code,
      redirect_uri: "https://chat.example/callback",
      client_id: "chat-client",
      code_verifier: verifier,
      resource: "https://mcp.example.com/api/mcp",
    });
    const response = makeResponse();

    await facade.handleRequest(
      makeRequest({ method: "POST", body: tokenParams.toString() }),
      response,
      "/oauth/token",
    );

    expect(response.statusCode).toBe(401);
    expect(JSON.parse(response.body)).toEqual({ error: "invalid_client" });
    expect(response.headers.get("www-authenticate")).toContain("Basic");

    const authenticatedResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({
        method: "POST",
        body: tokenParams.toString(),
        headers: {
          authorization: `Basic ${Buffer.from(
            "chat-client:client-secret",
          ).toString("base64")}`,
        },
      }),
      authenticatedResponse,
      "/oauth/token",
    );
    expect(authenticatedResponse.statusCode).toBe(200);
  });

  it("rejects an expired access token", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-21T00:00:00Z"));
    const facade = createOAuthFacade(
      { ...oauthConfig, accessTokenTtlSeconds: 1 },
      "/mcp",
    );
    const token = await issueAccessToken(
      facade,
      "expired-token-verifier-".padEnd(64, "x"),
    );

    vi.setSystemTime(new Date("2026-10-21T00:00:02Z"));
    expect(facade.verifyAccessToken(token)).toBeNull();
  });

  it("accepts ChatGPT's CIMD public client and its declared redirect URI", async () => {
    const clientId = "https://chatgpt.com/oauth/client.json";
    const redirectUri =
      "https://chatgpt.com/connector_platform_oauth_redirect";
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        redirect_uris: [redirectUri],
        token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
        token_endpoint_auth_method: "private_key_jwt",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);
    const facade = createOAuthFacade(
      {
        ...oauthConfig,
        clientId: "legacy-client",
        clientSecret: "legacy-secret",
      },
      "/mcp",
    );
    const verifier = "cimd-verifier-".padEnd(64, "x");
    const params = authorizationParams(verifier);
    params.set("client_id", clientId);
    params.set("redirect_uri", redirectUri);
    params.set("magic_token", "private-magic-token");
    const authorizeResponse = makeResponse();

    await facade.handleRequest(
      makeRequest({ method: "POST", body: params.toString() }),
      authorizeResponse,
      "/oauth/authorize",
    );

    expect(authorizeResponse.statusCode).toBe(302);
    expect(fetchMock).toHaveBeenCalledWith(
      clientId,
      expect.objectContaining({ redirect: "error" }),
    );
    const code = new URL(
      authorizeResponse.headers.get("location") ?? "https://invalid.example",
    ).searchParams.get("code");
    const tokenResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource: "https://mcp.example.com/api/mcp",
        }).toString(),
      }),
      tokenResponse,
      "/oauth/token",
    );

    expect(tokenResponse.statusCode).toBe(200);
  });

  it("rejects a ChatGPT CIMD request whose redirect URI is absent from metadata", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          redirect_uris: ["https://chatgpt.com/connector_platform_oauth_redirect"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      }),
    );
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const params = authorizationParams("cimd-rejected-".padEnd(64, "x"));
    params.set("client_id", "https://chatgpt.com/oauth/client.json");
    params.set("magic_token", "private-magic-token");
    const response = makeResponse();

    await facade.handleRequest(
      makeRequest({ method: "POST", body: params.toString() }),
      response,
      "/oauth/authorize",
    );

    expect(response.statusCode).toBe(400);
    expect(response.body).toBe("Unknown OAuth client");
  });

  it("accepts Codex's pinned CIMD client with an ephemeral loopback port", async () => {
    const clientId = "https://chatgpt.com/oauth/codex/client.json";
    const redirectUri = "http://127.0.0.1:44123/callback";
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: true,
        json: async () => ({
          redirect_uris: ["http://127.0.0.1/callback", "http://localhost/callback"],
          token_endpoint_auth_methods_supported: ["none"],
        }),
      }),
    );
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const verifier = "codex-cimd-verifier-".padEnd(64, "x");
    const params = authorizationParams(verifier);
    params.set("client_id", clientId);
    params.set("redirect_uri", redirectUri);
    params.set("magic_token", "private-magic-token");
    const authorizeResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({ method: "POST", body: params.toString() }),
      authorizeResponse,
      "/oauth/authorize",
    );
    expect(authorizeResponse.statusCode).toBe(302);

    const code = new URL(
      authorizeResponse.headers.get("location") ?? "https://invalid.example",
    ).searchParams.get("code");
    const tokenResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: code ?? "",
          redirect_uri: redirectUri,
          client_id: clientId,
          code_verifier: verifier,
          resource: "https://mcp.example.com/api/mcp",
        }).toString(),
      }),
      tokenResponse,
      "/oauth/token",
    );
    expect(tokenResponse.statusCode).toBe(200);
  });

  it("writes an MCP discovery challenge", () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const response = makeResponse();

    facade.writeMcpChallenge(response);

    expect(response.headers.get("www-authenticate")).toBe(
      'Bearer resource_metadata="https://mcp.example.com/api/.well-known/oauth-protected-resource/mcp", scope="tellymcp:read tellymcp:write"',
    );
  });

  it("accepts internal and OAuth bearer modes without making OAuth public", async () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");
    const accessToken = await issueAccessToken(
      facade,
      "dual-auth-verifier-".padEnd(64, "x"),
    );

    expect(
      isMcpHttpRequestAuthorized(
        makeRequest({ headers: { authorization: "Bearer internal-token" } }),
        "internal-token",
        facade,
      ),
    ).toBe(true);
    expect(
      isMcpHttpRequestAuthorized(
        makeRequest({
          headers: { authorization: `Bearer ${accessToken}` },
        }),
        "internal-token",
        facade,
      ),
    ).toBe(true);
    expect(isMcpHttpRequestAuthorized(makeRequest(), undefined, facade)).toBe(
      false,
    );
    expect(
      isMcpHttpRequestAuthorized(
        makeRequest({ headers: { authorization: "Bearer invalid" } }),
        undefined,
        facade,
      ),
    ).toBe(false);
    expect(isMcpHttpRequestAuthorized(makeRequest(), undefined, null)).toBe(
      true,
    );
  });

  it("logs OAuth milestones without logging credentials or tokens", async () => {
    const logger = {
      debug: vi.fn(),
      info: vi.fn(),
      warn: vi.fn(),
    };
    const facade = createOAuthFacade(oauthConfig, "/mcp", logger);
    const accessToken = await issueAccessToken(
      facade,
      "logging-verifier-".padEnd(64, "x"),
    );
    facade.verifyAccessToken(accessToken);

    const messages = [
      ...logger.info.mock.calls,
      ...logger.debug.mock.calls,
      ...logger.warn.mock.calls,
    ].map(([message]) => message);
    expect(messages).toContain("OAuth authorization code issued");
    expect(messages).toContain("OAuth access token issued");
    expect(messages).toContain("OAuth access token accepted");

    const serializedLogs = JSON.stringify([
      logger.info.mock.calls,
      logger.debug.mock.calls,
      logger.warn.mock.calls,
    ]);
    expect(serializedLogs).not.toContain("private-magic-token");
    expect(serializedLogs).not.toContain(accessToken);
    expect(serializedLogs).not.toContain("logging-verifier");
  });
});

const telegramLoginConfig = {
  clientId: "tg-client",
  clientSecret: "tg-secret",
  callbackUrl: "https://mcp.example.com/api/oauth/tg/callback",
};

describe("Telegram login sub-flow", () => {
  beforeEach(() => {
    vi.mocked(exchangeTelegramOidcCode).mockReset();
    vi.mocked(verifyTelegramOidcIdToken).mockReset();
  });

  async function startTelegramLogin(
    facade: ReturnType<typeof createOAuthFacade>,
  ): Promise<string> {
    const params = authorizationParams("tg-verifier-".padEnd(64, "x"));
    const response = makeResponse();
    await facade.handleRequest(
      makeRequest({ url: `/api/oauth/tg/login?${params.toString()}` }),
      response,
      "/oauth/tg/login",
    );
    expect(response.statusCode).toBe(302);
    const location = new URL(response.headers.get("location") ?? "");
    expect(location.origin + location.pathname).toBe(
      "https://oauth.telegram.org/auth",
    );
    expect(location.searchParams.get("client_id")).toBe("tg-client");
    return location.searchParams.get("state") ?? "";
  }

  it("hides the Telegram login routes when not configured", async () => {
    const facade = createOAuthFacade(oauthConfig, "/mcp");

    const loginResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({ url: "/api/oauth/tg/login?foo=bar" }),
      loginResponse,
      "/oauth/tg/login",
    );
    expect(loginResponse.statusCode).toBe(404);

    const callbackResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({ url: "/api/oauth/tg/callback?code=x&state=y" }),
      callbackResponse,
      "/oauth/tg/callback",
    );
    expect(callbackResponse.statusCode).toBe(404);
  });

  it("approves and completes the outer authorization code flow", async () => {
    const requestApproval = vi.fn().mockResolvedValue("approved");
    const facade = createOAuthFacade(
      { ...oauthConfig, telegramLogin: telegramLoginConfig },
      "/mcp",
      undefined,
      { requestApproval },
    );
    const telegramState = await startTelegramLogin(facade);

    vi.mocked(exchangeTelegramOidcCode).mockResolvedValue("fake-id-token");
    vi.mocked(verifyTelegramOidcIdToken).mockResolvedValue({
      telegramId: "4242",
      username: "someone",
    });

    const callbackResponse = makeResponse();
    await facade.handleRequest(
      makeRequest({
        url: `/api/oauth/tg/callback?code=telegram-code&state=${telegramState}`,
      }),
      callbackResponse,
      "/oauth/tg/callback",
    );

    expect(callbackResponse.statusCode).toBe(302);
    expect(requestApproval).toHaveBeenCalledWith(
      expect.objectContaining({ telegramId: "4242" }),
    );
    const redirect = new URL(callbackResponse.headers.get("location") ?? "");
    expect(redirect.origin + redirect.pathname).toBe(
      "https://chat.example/callback",
    );
    expect(redirect.searchParams.get("state")).toBe("original-state");
    expect(redirect.searchParams.get("code")).toBeTruthy();

    const tokenResponse = makeResponse();
    const verifier = "tg-verifier-".padEnd(64, "x");
    await facade.handleRequest(
      makeRequest({
        method: "POST",
        body: new URLSearchParams({
          grant_type: "authorization_code",
          code: redirect.searchParams.get("code") ?? "",
          redirect_uri: "https://chat.example/callback",
          client_id: "chat-client",
          code_verifier: verifier,
          resource: "https://mcp.example.com/api/mcp",
        }).toString(),
      }),
      tokenResponse,
      "/oauth/token",
    );
    expect(tokenResponse.statusCode).toBe(200);
    const token = (JSON.parse(tokenResponse.body) as { access_token: string })
      .access_token;
    expect(facade.verifyAccessToken(token)).toMatchObject({
      sub: "telegram:4242",
      telegram_id: "4242",
      preferred_username: "someone",
      client_id: "chat-client",
    });
  });

  it("rejects the flow when the admin declines", async () => {
    const requestApproval = vi.fn().mockResolvedValue("rejected");
    const facade = createOAuthFacade(
      { ...oauthConfig, telegramLogin: telegramLoginConfig },
      "/mcp",
      undefined,
      { requestApproval },
    );
    const telegramState = await startTelegramLogin(facade);
    vi.mocked(exchangeTelegramOidcCode).mockResolvedValue("fake-id-token");
    vi.mocked(verifyTelegramOidcIdToken).mockResolvedValue({
      telegramId: "4242",
    });

    const response = makeResponse();
    await facade.handleRequest(
      makeRequest({
        url: `/api/oauth/tg/callback?code=telegram-code&state=${telegramState}`,
      }),
      response,
      "/oauth/tg/callback",
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("rejected");
  });

  it("fails closed when no admin is authorized", async () => {
    const requestApproval = vi.fn().mockResolvedValue("no_admin");
    const facade = createOAuthFacade(
      { ...oauthConfig, telegramLogin: telegramLoginConfig },
      "/mcp",
      undefined,
      { requestApproval },
    );
    const telegramState = await startTelegramLogin(facade);
    vi.mocked(exchangeTelegramOidcCode).mockResolvedValue("fake-id-token");
    vi.mocked(verifyTelegramOidcIdToken).mockResolvedValue({
      telegramId: "4242",
    });

    const response = makeResponse();
    await facade.handleRequest(
      makeRequest({
        url: `/api/oauth/tg/callback?code=telegram-code&state=${telegramState}`,
      }),
      response,
      "/oauth/tg/callback",
    );

    expect(response.statusCode).toBe(403);
    expect(response.body).toContain("/auth");
  });

  it("rejects an unknown or expired Telegram login state", async () => {
    const requestApproval = vi.fn();
    const facade = createOAuthFacade(
      { ...oauthConfig, telegramLogin: telegramLoginConfig },
      "/mcp",
      undefined,
      { requestApproval },
    );

    const response = makeResponse();
    await facade.handleRequest(
      makeRequest({
        url: "/api/oauth/tg/callback?code=telegram-code&state=unknown-state",
      }),
      response,
      "/oauth/tg/callback",
    );

    expect(response.statusCode).toBe(400);
    expect(requestApproval).not.toHaveBeenCalled();
  });

  it("shows a Telegram login link on the authorization form when configured", async () => {
    const facade = createOAuthFacade(
      { ...oauthConfig, telegramLogin: telegramLoginConfig },
      "/mcp",
    );
    const params = authorizationParams("v".repeat(64));
    const response = makeResponse();

    await facade.handleRequest(
      makeRequest({ url: `/api/oauth/authorize?${params.toString()}` }),
      response,
      "/oauth/authorize",
    );

    expect(response.statusCode).toBe(200);
    expect(response.body).toContain("Log in with Telegram");
    expect(response.body).toContain("/oauth/tg/login?");
  });
});
