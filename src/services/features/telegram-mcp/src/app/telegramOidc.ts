import { createHash, randomBytes } from "node:crypto";

import { createRemoteJWKSet, jwtVerify } from "jose";

const AUTHORIZE_URL = "https://oauth.telegram.org/auth";
const TOKEN_URL = "https://oauth.telegram.org/token";
const JWKS_URL = "https://oauth.telegram.org/.well-known/jwks.json";

// Module-level singleton: jose caches keys internally and only refetches on
// an unrecognized `kid`, so this must not be reconstructed per request.
const jwks = createRemoteJWKSet(new URL(JWKS_URL));

export type TelegramOidcConfig = {
  clientId: string;
  clientSecret: string;
  callbackUrl: string;
};

export type TelegramOidcIdentity = {
  telegramId: string;
  username?: string;
  firstName?: string;
};

export function generateTelegramOidcPkce(): {
  verifier: string;
  challenge: string;
} {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

export function buildTelegramAuthorizeUrl(
  config: TelegramOidcConfig,
  params: { state: string; codeChallenge: string },
): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", config.clientId);
  url.searchParams.set("redirect_uri", config.callbackUrl);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("scope", "openid profile");
  url.searchParams.set("state", params.state);
  url.searchParams.set("code_challenge", params.codeChallenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

export async function exchangeTelegramOidcCode(
  config: TelegramOidcConfig,
  params: { code: string; codeVerifier: string },
): Promise<string> {
  const body = new URLSearchParams({
    grant_type: "authorization_code",
    code: params.code,
    redirect_uri: config.callbackUrl,
    client_id: config.clientId,
    client_secret: config.clientSecret,
    code_verifier: params.codeVerifier,
  });
  const response = await fetch(TOKEN_URL, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: body.toString(),
  });
  if (!response.ok) {
    throw new Error(
      `Telegram OIDC token exchange failed with status ${response.status}`,
    );
  }
  const payload = (await response.json()) as { id_token?: string };
  if (!payload.id_token) {
    throw new Error(
      "Telegram OIDC token response did not include an id_token",
    );
  }
  return payload.id_token;
}

function readStringClaim(
  payload: Record<string, unknown>,
  ...keys: string[]
): string | undefined {
  for (const key of keys) {
    const value = payload[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }
  return undefined;
}

function readIdentifierClaim(
  payload: Record<string, unknown>,
  key: string,
): string | undefined {
  const value = payload[key];
  if (typeof value === "string" && value.trim()) {
    return value.trim();
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    return String(value);
  }
  return undefined;
}

export async function verifyTelegramOidcIdToken(
  idToken: string,
  clientId: string,
): Promise<TelegramOidcIdentity> {
  const { payload } = await jwtVerify(idToken, jwks, { audience: clientId });
  const claims = payload as Record<string, unknown>;
  // `sub` is a separate OIDC subject id that does NOT match the Bot API's
  // numeric user id; the real Telegram user id is the `id` claim, which
  // requires the `profile` scope.
  const telegramId = readIdentifierClaim(claims, "id");
  if (!telegramId) {
    throw new Error("Telegram OIDC id_token is missing the 'id' claim");
  }

  const username = readStringClaim(claims, "preferred_username");
  const firstName = readStringClaim(claims, "given_name", "name");

  return {
    telegramId,
    ...(username ? { username } : {}),
    ...(firstName ? { firstName } : {}),
  };
}
