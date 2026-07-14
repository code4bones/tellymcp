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
    vi.stubEnv("TELLYMCP_PUBLIC_URL", "");
    vi.stubEnv("TELLYMCP_OAUTH_ISSUER", "");
    vi.stubEnv("TELLYMCP_OAUTH_AUDIENCE", "");
    vi.stubEnv("TELLYMCP_MAGIC_TOKEN", "");
    vi.stubEnv("TELLYMCP_MAGIC_TOKEN_HASH", "");
    vi.stubEnv("TELLYMCP_OAUTH_CLIENT_ID", "");
    vi.stubEnv("TELLYMCP_OAUTH_CLIENT_SECRET", "");
    vi.stubEnv("TELLYMCP_ALLOWED_REDIRECT_URIS", "");
    vi.stubEnv("TELLYMCP_OAUTH_PRIVATE_KEY_PEM", "");
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

  it("loads OAuth connector configuration", () => {
    vi.stubEnv("DISTRIBUTED_MODE", "client");
    vi.stubEnv("TELLYMCP_PUBLIC_URL", "https://mcp.example.com/api/");
    vi.stubEnv("TELLYMCP_MAGIC_TOKEN", "private-magic-token");
    vi.stubEnv(
      "TELLYMCP_ALLOWED_REDIRECT_URIS",
      "https://chatgpt.com/callback, https://claude.ai/callback",
    );

    expect(loadConfig().oauth).toEqual(
      expect.objectContaining({
        publicUrl: "https://mcp.example.com/api",
        issuer: "https://mcp.example.com/api",
        audience: "https://mcp.example.com/api",
        magicToken: "private-magic-token",
        allowedRedirectUris: [
          "https://chatgpt.com/callback",
          "https://claude.ai/callback",
        ],
        scopes: ["tellymcp:read", "tellymcp:write"],
      }),
    );
  });

  it("rejects incomplete OAuth connector configuration", () => {
    vi.stubEnv("DISTRIBUTED_MODE", "client");
    vi.stubEnv("TELLYMCP_PUBLIC_URL", "https://mcp.example.com/api");

    expect(() => loadConfig()).toThrow(
      "TELLYMCP_MAGIC_TOKEN or TELLYMCP_MAGIC_TOKEN_HASH is required",
    );
  });

  it("rejects malformed magic-token hashes", () => {
    vi.stubEnv("DISTRIBUTED_MODE", "client");
    vi.stubEnv("TELLYMCP_PUBLIC_URL", "https://mcp.example.com/api");
    vi.stubEnv("TELLYMCP_MAGIC_TOKEN_HASH", "sha256:not-a-digest");

    expect(() => loadConfig()).toThrow(
      "TELLYMCP_MAGIC_TOKEN_HASH must use the format sha256:",
    );
  });
});
