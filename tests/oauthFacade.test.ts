import { createHash, generateKeyPairSync } from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { Readable } from "node:stream";

import { describe, expect, it, vi } from "vitest";

import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import { isMcpHttpRequestAuthorized } from "../src/services/features/telegram-mcp/src/app/http";
import { createOAuthFacade } from "../src/services/features/telegram-mcp/src/app/oauthFacade";

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
  scopes: ["tellymcp:read", "tellymcp:write"],
  keyId: "tellymcp-test",
} satisfies NonNullable<AppConfig["oauth"]>;

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
