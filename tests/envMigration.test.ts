import { parse as parseDotenv } from "dotenv";
import { describe, expect, it } from "vitest";

import { migrateEnvironmentContent } from "../src/envMigration";

describe("environment migration", () => {
  it("normalizes a gateway env and preserves secret values", () => {
    const result = migrateEnvironmentContent(`
DISTRIBUTED_MODE=gateway
MODE=reject
GATEWAY_TOKEN=scope-value
GATEWAY_AUTH_TOKEN=transport-value
DB_SCHEME=mcp
TELEGRAM_BOT_TOKEN=bot-token
TELLYMCP_OAUTH_PRIVATE_KEY_PEM="-----BEGIN PRIVATE KEY-----\\nabc+/=\\n-----END PRIVATE KEY-----\\n"
PAIR_CODE_TTL_SECONDS=300
APP_NAME=legacy
`);

    expect(result.role).toBe("gateway");
    expect(parseDotenv(result.content)).toMatchObject({
      DISTRIBUTED_MODE: "gateway",
      TELEGRAM_REQUEST_MODE: "reject",
      GATEWAY_SCOPE_TOKEN: "scope-value",
      GATEWAY_AUTH_TOKEN: "transport-value",
      DB_SCHEMA: "mcp",
      TELEGRAM_BOT_TOKEN: "bot-token",
      TELLYMCP_OAUTH_PRIVATE_KEY_PEM:
        "-----BEGIN PRIVATE KEY-----\nabc+/=\n-----END PRIVATE KEY-----\n",
    });
    expect(result.content).not.toContain("PAIR_CODE_TTL_SECONDS");
    expect(result.content).not.toContain("APP_NAME");
    expect(result.droppedKeys).toEqual(
      expect.arrayContaining(["APP_NAME", "PAIR_CODE_TTL_SECONDS"]),
    );
  });

  it("normalizes tmux settings for a client and drops gateway-only keys", () => {
    const result = migrateEnvironmentContent(`
DISTRIBUTED_MODE=client
TMUX_CAPTURE_MODE=lines
TMUX_CAPTURE_LINES=250
TMUX_SOCKET_PATH=/tmp/tmux.sock
GATEWAY_AUTH_TOKEN=transport-value
TELEGRAM_BOT_TOKEN=unused-on-client
DB_HOST=unused-on-client
REDIS_HOST=unused-on-client
REDIS_PORT=6379
REDIS_DB=1
`);
    const parsed = parseDotenv(result.content);

    expect(result.role).toBe("client");
    expect(parsed.TERMINAL_CAPTURE_MODE).toBe("lines");
    expect(parsed.TERMINAL_CAPTURE_LINES).toBe("250");
    expect(parsed.GATEWAY_AUTH_TOKEN).toBe("transport-value");
    expect(parsed).not.toHaveProperty("TMUX_SOCKET_PATH");
    expect(parsed).not.toHaveProperty("TELEGRAM_BOT_TOKEN");
    expect(parsed).not.toHaveProperty("DB_HOST");
    expect(parsed).not.toHaveProperty("REDIS_HOST");
    expect(parsed).not.toHaveProperty("REDIS_PORT");
    expect(parsed).not.toHaveProperty("REDIS_DB");
  });

  it("prefers a canonical key when both canonical and legacy names exist", () => {
    const result = migrateEnvironmentContent(`
DISTRIBUTED_MODE=client
GATEWAY_TOKEN=legacy-scope
GATEWAY_SCOPE_TOKEN=current-scope
TMUX_PROMPT_SCAN_ENABLED=false
TERMINAL_PROMPT_SCAN_ENABLED=true
`);
    const parsed = parseDotenv(result.content);

    expect(parsed.GATEWAY_SCOPE_TOKEN).toBe("current-scope");
    expect(parsed.TERMINAL_PROMPT_SCAN_ENABLED).toBe("true");
  });

  it("infers gateway and client roles when DISTRIBUTED_MODE is missing", () => {
    expect(migrateEnvironmentContent("TELEGRAM_BOT_TOKEN=x\n").role).toBe(
      "gateway",
    );
    expect(migrateEnvironmentContent("GATEWAY_AUTH_TOKEN=x\n").role).toBe(
      "client",
    );
  });
});
