import { existsSync } from "node:fs";

import * as z from "zod/v4";

import type { QueueMode } from "../../shared/types/common.js";

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: z.string().min(1),
  TELEGRAM_BOT_USERNAME: z.string().min(1).optional(),
  TELEGRAM_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  TELEGRAM_DEFAULT_TIMEOUT_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  TELEGRAM_MAX_CONTEXT_CHARS: z.coerce.number().int().positive().default(3000),
  TELEGRAM_MAX_QUESTION_CHARS: z.coerce.number().int().positive().default(1000),
  TELEGRAM_MAX_MESSAGE_CHARS: z.coerce.number().int().positive().default(3900),
  TELEGRAM_INBOX_BATCH_SIZE: z.coerce
    .number()
    .int()
    .positive()
    .max(100)
    .default(20),
  TELEGRAM_MENU_PAYLOAD_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(86400),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  REDIS_DB: z.coerce.number().int().nonnegative(),
  REDIS_USERNAME: z.string().min(1).optional(),
  REDIS_PASSWORD: z.string().min(1).optional(),
  MODE: z.enum(["queue", "reject"]).default("queue"),
  PAIR_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  PROJECT_NAME: z.string().min(1).optional(),
  MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(8787),
  MCP_HTTP_PATH: z.string().min(1).default("/mcp"),
  MCP_HTTP_BEARER_TOKEN: z.string().min(1).optional(),
  MCP_HTTP_ENABLE_DEBUG_ROUTES: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  MCP_HTTP_ENABLE_PRUNE_ROUTE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  DISTRIBUTED_MODE: z.enum(["client", "gateway", "both"]).default("client"),
  GATEWAY_PUBLIC_URL: z.string().url().optional(),
  GATEWAY_BIND_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_BIND_PORT: z.coerce.number().int().positive().default(8790),
  GATEWAY_AUTH_TOKEN: z.string().min(1).optional(),
  GATEWAY_DATABASE_URL: z.string().min(1).optional(),
  GATEWAY_S3_ENDPOINT: z.string().min(1).optional(),
  GATEWAY_S3_BUCKET: z.string().min(1).optional(),
  GATEWAY_S3_ACCESS_KEY: z.string().min(1).optional(),
  GATEWAY_S3_SECRET_KEY: z.string().min(1).optional(),
  WEBAPP_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  WEBAPP_BASE_PATH: z.string().min(1).default("/webapp"),
  WEBAPP_PUBLIC_URL: z.string().url().optional(),
  WEBAPP_INITDATA_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(300),
  WEBAPP_SESSION_TTL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(900),
  WEBAPP_VISIBLE_SCREENS: z.coerce.number().int().positive().default(2),
  WEBAPP_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WEBAPP_ACTION_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(150),
  MCP_XCHANGE_DIR: z.string().min(1).default(".mcp-xchange"),
  TMUX_NUDGE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  TMUX_PROXY_URL: z.string().url().optional(),
  TMUX_PROXY_TOKEN: z.string().min(1).optional(),
  TMUX_SOCKET_PATH: z.string().min(1).optional(),
  TMUX_NUDGE_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(10),
  TMUX_NUDGE_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),
  TMUX_NUDGE_MESSAGE: z.string().min(1).default("проверь inbox"),
  TMUX_PARTNER_NUDGE_MESSAGE: z
    .string()
    .min(1)
    .default("не inbox: прочитай SHARE_INDEX.md и partner note"),
  TMUX_CAPTURE_MODE: z.enum(["visible", "lines"]).default("visible"),
  TMUX_CAPTURE_LINES: z.coerce.number().int().positive().default(300),
  BROWSER_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  BROWSER_HEADLESS: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  BROWSER_DEVTOOLS: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  BROWSER_ADDRESS: z.string().url().optional(),
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  BROWSER_MAX_EVENTS: z.coerce.number().int().positive().default(200),
  BROWSER_WAIT_UNTIL: z
    .enum(["load", "domcontentloaded", "networkidle", "commit"])
    .default("load"),
  BROWSER_EXECUTABLE_PATH: z.string().min(1).optional(),
  BROWSER_CHANNEL: z.enum(["chrome", "chromium", "msedge"]).optional(),
  BROWSER_SLOW_MO_MS: z.coerce.number().int().nonnegative().default(0),
  PROXY_USE: z.enum(["http", "socks5"]).optional(),
  HTTP_PROXY: z.string().min(1).optional(),
  SOCKS5_PROXY: z.string().min(1).optional(),
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_FILE_PATH: z.string().min(1).default(".telegram-human-mcp/log.jsonl"),
});

export type AppConfig = {
  telegram: {
    botToken: string;
    botUsername?: string;
    pollIntervalMs: number;
    defaultTimeoutSeconds: number;
    maxContextChars: number;
    maxQuestionChars: number;
    maxMessageChars: number;
    inboxBatchSize: number;
    menuPayloadTtlSeconds: number;
    proxy?: {
      type: "http" | "socks5";
      url: string;
    };
  };
  redis: {
    host: string;
    port: number;
    db: number;
    username?: string;
    password?: string;
  };
  mode: QueueMode;
  pairCodeTtlSeconds: number;
  mcp: {
    httpHost: string;
    httpPort: number;
    httpPath: string;
    bearerToken?: string;
    enableDebugRoutes: boolean;
    enablePruneRoute: boolean;
  };
  distributed: {
    mode: "client" | "gateway" | "both";
    gatewayPublicUrl?: string;
    gatewayBindHost: string;
    gatewayBindPort: number;
    gatewayAuthToken?: string;
    gatewayDatabaseUrl?: string;
    gatewayS3Endpoint?: string;
    gatewayS3Bucket?: string;
    gatewayS3AccessKey?: string;
    gatewayS3SecretKey?: string;
  };
  webapp: {
    enabled: boolean;
    basePath: string;
    publicUrl?: string;
    initDataTtlSeconds: number;
    sessionTtlSeconds: number;
    visibleScreens: number;
    pollIntervalMs: number;
    actionCooldownMs: number;
  };
  exchange: {
    dir: string;
  };
  tmux: {
    nudgeEnabled: boolean;
    proxyUrl?: string;
    proxyToken?: string;
    socketPath?: string;
    nudgeDebounceSeconds: number;
    nudgeCooldownSeconds: number;
    nudgeMessage: string;
    partnerNudgeMessage: string;
    captureMode: "visible" | "lines";
    captureLines: number;
  };
  browser: {
    enabled: boolean;
    headless: boolean;
    devtools: boolean;
    address?: string;
    timeoutMs: number;
    maxEvents: number;
    waitUntil: "load" | "domcontentloaded" | "networkidle" | "commit";
    executablePath?: string;
    channel?: "chrome" | "chromium" | "msedge";
    slowMoMs: number;
  };
  project: {
    name?: string | undefined;
  };
  logging: {
    level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
    filePath: string;
  };
};

export function loadConfig(): AppConfig {
  if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const parsed = envSchema.parse(process.env);

  const telegramProxy =
    parsed.PROXY_USE === "http"
      ? parsed.HTTP_PROXY
        ? {
            type: "http" as const,
            url: parsed.HTTP_PROXY,
          }
        : (() => {
            throw new Error("PROXY_USE=http requires HTTP_PROXY");
          })()
      : parsed.PROXY_USE === "socks5"
        ? parsed.SOCKS5_PROXY
          ? {
              type: "socks5" as const,
              url: parsed.SOCKS5_PROXY,
            }
          : (() => {
              throw new Error("PROXY_USE=socks5 requires SOCKS5_PROXY");
            })()
        : undefined;

  return {
    telegram: {
      botToken: parsed.TELEGRAM_BOT_TOKEN,
      ...(parsed.TELEGRAM_BOT_USERNAME
        ? { botUsername: parsed.TELEGRAM_BOT_USERNAME }
        : {}),
      pollIntervalMs: parsed.TELEGRAM_POLL_INTERVAL_MS,
      defaultTimeoutSeconds: parsed.TELEGRAM_DEFAULT_TIMEOUT_SECONDS,
      maxContextChars: parsed.TELEGRAM_MAX_CONTEXT_CHARS,
      maxQuestionChars: parsed.TELEGRAM_MAX_QUESTION_CHARS,
      maxMessageChars: parsed.TELEGRAM_MAX_MESSAGE_CHARS,
      inboxBatchSize: parsed.TELEGRAM_INBOX_BATCH_SIZE,
      menuPayloadTtlSeconds: parsed.TELEGRAM_MENU_PAYLOAD_TTL_SECONDS,
      ...(telegramProxy ? { proxy: telegramProxy } : {}),
    },
    redis: {
      host: parsed.REDIS_HOST,
      port: parsed.REDIS_PORT,
      db: parsed.REDIS_DB,
      ...(parsed.REDIS_USERNAME ? { username: parsed.REDIS_USERNAME } : {}),
      ...(parsed.REDIS_PASSWORD ? { password: parsed.REDIS_PASSWORD } : {}),
    },
    mode: parsed.MODE,
    pairCodeTtlSeconds: parsed.PAIR_CODE_TTL_SECONDS,
    mcp: {
      httpHost: parsed.MCP_HTTP_HOST,
      httpPort: parsed.MCP_HTTP_PORT,
      httpPath: parsed.MCP_HTTP_PATH,
      ...(parsed.MCP_HTTP_BEARER_TOKEN
        ? { bearerToken: parsed.MCP_HTTP_BEARER_TOKEN }
        : {}),
      enableDebugRoutes: parsed.MCP_HTTP_ENABLE_DEBUG_ROUTES,
      enablePruneRoute: parsed.MCP_HTTP_ENABLE_PRUNE_ROUTE,
    },
    distributed: {
      mode: parsed.DISTRIBUTED_MODE,
      ...(parsed.GATEWAY_PUBLIC_URL
        ? { gatewayPublicUrl: parsed.GATEWAY_PUBLIC_URL }
        : {}),
      gatewayBindHost: parsed.GATEWAY_BIND_HOST,
      gatewayBindPort: parsed.GATEWAY_BIND_PORT,
      ...(parsed.GATEWAY_AUTH_TOKEN
        ? { gatewayAuthToken: parsed.GATEWAY_AUTH_TOKEN }
        : {}),
      ...(parsed.GATEWAY_DATABASE_URL
        ? { gatewayDatabaseUrl: parsed.GATEWAY_DATABASE_URL }
        : {}),
      ...(parsed.GATEWAY_S3_ENDPOINT
        ? { gatewayS3Endpoint: parsed.GATEWAY_S3_ENDPOINT }
        : {}),
      ...(parsed.GATEWAY_S3_BUCKET
        ? { gatewayS3Bucket: parsed.GATEWAY_S3_BUCKET }
        : {}),
      ...(parsed.GATEWAY_S3_ACCESS_KEY
        ? { gatewayS3AccessKey: parsed.GATEWAY_S3_ACCESS_KEY }
        : {}),
      ...(parsed.GATEWAY_S3_SECRET_KEY
        ? { gatewayS3SecretKey: parsed.GATEWAY_S3_SECRET_KEY }
        : {}),
    },
    webapp: {
      enabled: parsed.WEBAPP_ENABLED,
      basePath: parsed.WEBAPP_BASE_PATH,
      ...(parsed.WEBAPP_PUBLIC_URL ? { publicUrl: parsed.WEBAPP_PUBLIC_URL } : {}),
      initDataTtlSeconds: parsed.WEBAPP_INITDATA_TTL_SECONDS,
      sessionTtlSeconds: parsed.WEBAPP_SESSION_TTL_SECONDS,
      visibleScreens: parsed.WEBAPP_VISIBLE_SCREENS,
      pollIntervalMs: parsed.WEBAPP_POLL_INTERVAL_MS,
      actionCooldownMs: parsed.WEBAPP_ACTION_COOLDOWN_MS,
    },
    exchange: {
      dir: parsed.MCP_XCHANGE_DIR,
    },
    tmux: {
      nudgeEnabled: parsed.TMUX_NUDGE_ENABLED,
      ...(parsed.TMUX_PROXY_URL ? { proxyUrl: parsed.TMUX_PROXY_URL } : {}),
      ...(parsed.TMUX_PROXY_TOKEN ? { proxyToken: parsed.TMUX_PROXY_TOKEN } : {}),
      ...(parsed.TMUX_SOCKET_PATH ? { socketPath: parsed.TMUX_SOCKET_PATH } : {}),
      nudgeDebounceSeconds: parsed.TMUX_NUDGE_DEBOUNCE_SECONDS,
      nudgeCooldownSeconds: parsed.TMUX_NUDGE_COOLDOWN_SECONDS,
      nudgeMessage: parsed.TMUX_NUDGE_MESSAGE,
      partnerNudgeMessage: parsed.TMUX_PARTNER_NUDGE_MESSAGE,
      captureMode: parsed.TMUX_CAPTURE_MODE,
      captureLines: parsed.TMUX_CAPTURE_LINES,
    },
    browser: {
      enabled: parsed.BROWSER_ENABLED,
      headless: parsed.BROWSER_HEADLESS,
      devtools: parsed.BROWSER_DEVTOOLS,
      ...(parsed.BROWSER_ADDRESS ? { address: parsed.BROWSER_ADDRESS } : {}),
      timeoutMs: parsed.BROWSER_TIMEOUT_MS,
      maxEvents: parsed.BROWSER_MAX_EVENTS,
      waitUntil: parsed.BROWSER_WAIT_UNTIL,
      ...(parsed.BROWSER_EXECUTABLE_PATH
        ? { executablePath: parsed.BROWSER_EXECUTABLE_PATH }
        : {}),
      ...(parsed.BROWSER_CHANNEL ? { channel: parsed.BROWSER_CHANNEL } : {}),
      slowMoMs: parsed.BROWSER_SLOW_MO_MS,
    },
    project: {
      ...(parsed.PROJECT_NAME ? { name: parsed.PROJECT_NAME } : {}),
    },
    logging: {
      level: parsed.LOG_LEVEL,
      filePath: parsed.LOG_FILE_PATH,
    },
  };
}
