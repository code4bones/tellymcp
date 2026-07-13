import { createHash, createHmac } from "node:crypto";

import { describe, expect, it } from "vitest";

import GatewaySocketService from "../src/services/features/telegram-mcp/gateway-socket.service";
import {
  type TelegramWebAppInitDataUnsafe,
  type TelegramWebAppUser,
  validateTelegramWebAppInitData,
  WebAppLaunchRegistry,
} from "../src/services/features/telegram-mcp/src/app/webapp/auth";

const BOT_TOKEN = "123456:test-bot-token";
const MAX_AGE_SECONDS = 300;

function signInitData(input: {
  authDate: number;
  userJson: string;
  queryId?: string;
  startParam?: string;
}): { raw: string; hash: string } {
  const params = new URLSearchParams({
    auth_date: String(input.authDate),
    user: input.userJson,
    ...(input.queryId !== undefined ? { query_id: input.queryId } : {}),
    ...(input.startParam !== undefined
      ? { start_param: input.startParam }
      : {}),
  });
  const checkString = [...params.entries()]
    .sort((left, right) => left[0].localeCompare(right[0]))
    .map(([key, value]) => `${key}=${value}`)
    .join("\n");
  const secretKey = createHmac("sha256", "WebAppData")
    .update(BOT_TOKEN)
    .digest();
  const hash = createHmac("sha256", secretKey)
    .update(checkString)
    .digest("hex");
  params.set("hash", hash);

  return { raw: params.toString(), hash };
}

function makeValidInput(overrides?: {
  authDate?: number;
  user?: TelegramWebAppUser;
  queryId?: string;
  startParam?: string;
}): {
  raw: string;
  unsafe: TelegramWebAppInitDataUnsafe;
  user: TelegramWebAppUser;
  authDate: number;
} {
  const authDate = overrides?.authDate ?? Math.floor(Date.now() / 1000);
  const user = overrides?.user ?? {
    id: 111,
    first_name: "Signed",
    username: "signed_user",
  };
  const queryId = overrides?.queryId ?? "query-1";
  const startParam = overrides?.startParam ?? "launch-1";
  const signed = signInitData({
    authDate,
    userJson: JSON.stringify(user),
    queryId,
    startParam,
  });

  return {
    raw: signed.raw,
    unsafe: {
      auth_date: authDate,
      hash: signed.hash,
      query_id: queryId,
      start_param: startParam,
      user,
    },
    user,
    authDate,
  };
}

describe("Telegram WebApp initData validation", () => {
  it("derives all security-relevant fields from signed raw init data", () => {
    const input = makeValidInput();

    expect(
      validateTelegramWebAppInitData(
        input.raw,
        null,
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toMatchObject({
      user: input.user,
      authDate: input.authDate,
      queryId: "query-1",
      startParam: "launch-1",
    });
  });

  it("rejects an unsafe user that differs from the signed user", () => {
    const input = makeValidInput();

    expect(() =>
      validateTelegramWebAppInitData(
        input.raw,
        {
          ...input.unsafe,
          user: { ...input.user, id: 999 },
        },
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("unsafe user does not match signed initData");
  });

  it("rejects an unsafe auth_date that differs from the signed value", () => {
    const input = makeValidInput();

    expect(() =>
      validateTelegramWebAppInitData(
        input.raw,
        {
          ...input.unsafe,
          auth_date: input.authDate - 1,
        },
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("unsafe auth_date does not match signed initData");
  });

  it("rejects mismatched unsafe query_id and start_param values", () => {
    const input = makeValidInput();

    expect(() =>
      validateTelegramWebAppInitData(
        input.raw,
        { ...input.unsafe, query_id: "other-query" },
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("unsafe query_id does not match signed initData");

    expect(() =>
      validateTelegramWebAppInitData(
        input.raw,
        { ...input.unsafe, start_param: "other-launch" },
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("unsafe start_param does not match signed initData");
  });

  it("rejects expired signed init data", () => {
    const input = makeValidInput({
      authDate: Math.floor(Date.now() / 1000) - MAX_AGE_SECONDS - 1,
    });

    expect(() =>
      validateTelegramWebAppInitData(
        input.raw,
        input.unsafe,
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("initData is expired");
  });

  it("rejects malformed signed user JSON even when its hash is valid", () => {
    const signed = signInitData({
      authDate: Math.floor(Date.now() / 1000),
      userJson: "{not-json",
    });

    expect(() =>
      validateTelegramWebAppInitData(
        signed.raw,
        null,
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("signed user is malformed");
  });

  it("does not accept the removed unsigned user-fields protocol", () => {
    const authDate = Math.floor(Date.now() / 1000);
    const user = { id: 111, first_name: "Signed" };
    const checkString = [
      `auth_date=${authDate}`,
      "first_name=Signed",
      "id=111",
    ].join("\n");
    const legacySecret = createHash("sha256").update(BOT_TOKEN).digest();
    const legacyHash = createHmac("sha256", legacySecret)
      .update(checkString)
      .digest("hex");

    expect(() =>
      validateTelegramWebAppInitData(
        "hash=invalid",
        { auth_date: authDate, hash: legacyHash, user },
        BOT_TOKEN,
        MAX_AGE_SECONDS,
      ),
    ).toThrow("hash validation failed");
  });

  it("rejects a raw/unsafe user mismatch in relay bootstrap validation", async () => {
    const input = makeValidInput();
    const launches = new WebAppLaunchRegistry();
    launches.set(input.user.id, "session-1", 60);
    const processLiveRequest = GatewaySocketService.methods
      ?.processLiveRequest as unknown as (
      this: Record<string, unknown>,
      request: Record<string, unknown>,
    ) => Promise<Record<string, unknown>>;
    const harness = {
      getRuntimeOrThrow: () => ({
        config: {
          telegram: { botToken: BOT_TOKEN },
          webapp: { initDataTtlSeconds: MAX_AGE_SECONDS },
        },
        webAppLaunchRegistry: launches,
        telegramTransport: { deleteMessage: async () => undefined },
      }),
    };

    const response = await processLiveRequest.call(harness, {
      type: "live_request",
      request_id: "request-1",
      request_type: "bootstrap_validate",
      local_session_id: "",
      payload: {
        initDataRaw: input.raw,
        initDataUnsafe: {
          ...input.unsafe,
          user: { ...input.user, id: 999 },
        },
      },
    });

    expect(response).toMatchObject({
      type: "live_response",
      request_id: "request-1",
      ok: false,
    });
    expect(JSON.stringify(response)).toContain(
      "unsafe user does not match signed initData",
    );
    expect(launches.getByUserId(input.user.id)).not.toBeNull();
  });
});
