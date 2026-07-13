import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { loadConfig } from "../src/services/features/telegram-mcp/src/app/config/env";

describe("gateway transport auth configuration", () => {
  beforeEach(() => {
    vi.stubEnv("ENV_FILE", "");
    vi.stubEnv("REDIS_HOST", "127.0.0.1");
    vi.stubEnv("REDIS_PORT", "6379");
    vi.stubEnv("REDIS_DB", "1");
    vi.stubEnv("MODE", "reject");
    vi.stubEnv("TELEGRAM_BOT_TOKEN", "telegram-token");
    vi.stubEnv("GATEWAY_PUBLIC_URL", "");
    vi.stubEnv("GATEWAY_WS_URL", "");
    vi.stubEnv("GATEWAY_AUTH_TOKEN", "");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it.each(["gateway", "both"] as const)(
    "rejects %s mode without GATEWAY_AUTH_TOKEN",
    (mode) => {
      vi.stubEnv("DISTRIBUTED_MODE", mode);

      expect(() => loadConfig()).toThrow(
        "GATEWAY_AUTH_TOKEN is required for gateway and both distributed modes.",
      );
    },
  );

  it("rejects a configured remote client without GATEWAY_AUTH_TOKEN", () => {
    vi.stubEnv("DISTRIBUTED_MODE", "client");
    vi.stubEnv("GATEWAY_PUBLIC_URL", "https://gateway.example/api/gateway");

    expect(() => loadConfig()).toThrow(
      "GATEWAY_AUTH_TOKEN is required when a client connects to a gateway.",
    );
  });

  it("accepts gateway mode with GATEWAY_AUTH_TOKEN", () => {
    vi.stubEnv("DISTRIBUTED_MODE", "gateway");
    vi.stubEnv("GATEWAY_AUTH_TOKEN", "transport-secret");

    expect(loadConfig().distributed.gatewayAuthToken).toBe("transport-secret");
  });

  it("keeps an unconnected local client valid without gateway auth", () => {
    vi.stubEnv("DISTRIBUTED_MODE", "client");

    expect(loadConfig().distributed.gatewayAuthToken).toBeUndefined();
  });
});
