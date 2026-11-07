import { exportJWK, generateKeyPair, SignJWT } from "jose";
import { getGlobalDispatcher } from "undici";
import { afterEach, expect, it, vi } from "vitest";
import type { AppConfig } from "../src/services/features/telegram-mcp/src/app/config/env";
import {
  exchangeTelegramOidcCode,
  verifyTelegramOidcIdToken,
} from "../src/services/features/telegram-mcp/src/app/telegramOidc";
import { createTelegramFetch } from "../src/services/features/telegram-mcp/src/shared/integrations/telegram/proxyFetch";
import { closeTellyProxyAgents } from "../src/services/features/telegram-mcp/src/shared/lib/http/tellyProxy";
import type { Logger } from "../src/services/features/telegram-mcp/src/shared/lib/logger/logger";

afterEach(async () => {
  vi.unstubAllGlobals();
  vi.unstubAllEnvs();
  await closeTellyProxyAgents();
});
const config = {
  clientId: "telegram-client",
  clientSecret: "private-client-secret",
  callbackUrl: "https://new.example/api/oauth/tg/callback",
};
async function identity(audience = config.clientId) {
  const { publicKey, privateKey } = await generateKeyPair("RS256");
  const key = {
    ...(await exportJWK(publicKey)),
    kid: "telegram-test",
    alg: "RS256",
    use: "sig",
  };
  const token = await new SignJWT({
    id: 4242,
    sub: "separate-oidc-subject",
    preferred_username: "tester",
    given_name: "Test",
  })
    .setProtectedHeader({ alg: "RS256", kid: key.kid })
    .setAudience(audience)
    .setIssuedAt()
    .setExpirationTime("5m")
    .sign(privateKey);
  return { key, token };
}

it("uses the configured Telegram proxy for token exchange AND signed-JWT key retrieval when direct egress is blocked", async () => {
  const { key, token } = await identity();
  vi.stubEnv("TELLYMCP_NO_PROXY", "");
  const originalProxy = process.env.HTTP_PROXY;
  const dispatcher = getGlobalDispatcher();
  const fetchMock = vi.fn(
    async (input: string | URL | Request, init?: RequestInit) => {
      if (!(init as RequestInit & { dispatcher?: unknown })?.dispatcher)
        throw new Error("Direct egress blocked");
      if (String(input).endsWith("/token"))
        return Response.json({ id_token: token });
      return Response.json({ keys: [key] });
    },
  );
  vi.stubGlobal("fetch", fetchMock);
  const transport = createTelegramFetch(
    {
      telegram: { proxy: { type: "http", url: "http://127.0.0.1:3128" } },
    } as AppConfig,
    { info: vi.fn(), debug: vi.fn() } as unknown as Logger,
  );
  const idToken = await exchangeTelegramOidcCode(
    config,
    { code: "single-use-test-code", codeVerifier: "test-verifier" },
    transport,
  );
  expect(
    await verifyTelegramOidcIdToken(idToken, config.clientId, transport),
  ).toEqual({ telegramId: "4242", username: "tester", firstName: "Test" });
  await verifyTelegramOidcIdToken(idToken, config.clientId, transport);
  expect(fetchMock).toHaveBeenCalledTimes(2); // jose retains its key cache.
  expect(fetchMock.mock.calls[0]![0]).toBe("https://oauth.telegram.org/token");
  const init = fetchMock.mock.calls[0]![1]!;
  expect(init.redirect).toBe("error");
  expect(init.signal).toBeInstanceOf(AbortSignal);
  const body = new URLSearchParams(String(init.body));
  expect(body.get("redirect_uri")).toBe(config.callbackUrl);
  expect(body.get("code_verifier")).toBe("test-verifier");
  expect(fetchMock.mock.calls[1]![0]).toBe(
    "https://oauth.telegram.org/.well-known/jwks.json",
  );
  expect(process.env.HTTP_PROXY).toBe(originalProxy);
  expect(getGlobalDispatcher()).toBe(dispatcher);
});

it("keeps token-exchange errors redacted and bounded without exposing endpoint credentials", async () => {
  const fetcher = vi.fn(
    async () => new Response("private-token-response", { status: 401 }),
  );
  await expect(
    exchangeTelegramOidcCode(
      config,
      { code: "private-code", codeVerifier: "private-verifier" },
      fetcher,
    ),
  ).rejects.toThrow("Telegram OIDC token exchange failed with status 401");
});

it("still rejects an invalid audience or JWT signature with a custom key transport", async () => {
  const { key, token } = await identity("other-client");
  const fetcher = vi.fn(async () => Response.json({ keys: [key] }));
  vi.stubGlobal(
    "fetch",
    vi.fn(() => {
      throw new Error("Direct fetch forbidden");
    }),
  );
  await expect(
    verifyTelegramOidcIdToken(token, config.clientId, fetcher),
  ).rejects.toThrow("aud");
  const other = await identity();
  await expect(
    verifyTelegramOidcIdToken(other.token, config.clientId, fetcher),
  ).rejects.toThrow("signature");
  expect(fetcher).toHaveBeenCalledTimes(1);
});

it("isolates JWKS caches by transport instead of reusing keys from another runtime", async () => {
  const first = await identity(),
    second = await identity();
  const firstFetch = vi.fn(async () => Response.json({ keys: [first.key] }));
  const secondFetch = vi.fn(async () => Response.json({ keys: [second.key] }));
  await verifyTelegramOidcIdToken(first.token, config.clientId, firstFetch);
  await verifyTelegramOidcIdToken(second.token, config.clientId, secondFetch);
  expect(firstFetch).toHaveBeenCalledTimes(1);
  expect(secondFetch).toHaveBeenCalledTimes(1);
});
