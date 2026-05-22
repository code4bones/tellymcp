import { existsSync } from "node:fs";

import * as z from "zod/v4";

import type { QueueMode } from "../../shared/types/common";

const emptyStringToUndefined = (value: unknown): unknown => {
  if (typeof value !== "string") {
    return value;
  }

  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed;
};

const optionalNonEmptyString = z.preprocess(
  emptyStringToUndefined,
  z.string().min(1).optional(),
);

const optionalUrlString = z.preprocess(
  emptyStringToUndefined,
  z.string().url().optional(),
);

const envSchema = z.object({
  TELEGRAM_BOT_TOKEN: optionalNonEmptyString,
  TELEGRAM_BOT_USERNAME: optionalNonEmptyString,
  ADMIN_TOKEN: optionalNonEmptyString,
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
    .default(300),
  DEBUG_LANGUAGE: z.preprocess(
    emptyStringToUndefined,
    z.enum(["en", "ru"]).optional(),
  ),
  REDIS_HOST: z.string().min(1),
  REDIS_PORT: z.coerce.number().int().positive(),
  REDIS_DB: z.coerce.number().int().nonnegative(),
  REDIS_USERNAME: optionalNonEmptyString,
  REDIS_PASSWORD: optionalNonEmptyString,
  MODE: z.enum(["queue", "reject"]).default("queue"),
  PAIR_CODE_TTL_SECONDS: z.coerce.number().int().positive().default(600),
  PROJECT_NAME: optionalNonEmptyString,
  TELLYMCP_SESSION_ID: optionalNonEmptyString,
  TELLYMCP_SESSION_LABEL: optionalNonEmptyString,
  MCP_HTTP_HOST: z.string().min(1).default("127.0.0.1"),
  MCP_HTTP_PORT: z.coerce.number().int().positive().default(8787),
  MCP_HTTP_PATH: z.string().min(1).default("/mcp"),
  MCP_HTTP_BEARER_TOKEN: optionalNonEmptyString,
  MCP_HTTP_ENABLE_DEBUG_ROUTES: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  MCP_HTTP_ENABLE_PRUNE_ROUTE: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  MCP_VFS_SCOPE: z.string().min(1).default("mcp"),
  DISTRIBUTED_MODE: z.enum(["client", "gateway", "both"]).default("client"),
  GATEWAY_PUBLIC_URL: optionalUrlString,
  GATEWAY_BIND_HOST: z.string().min(1).default("127.0.0.1"),
  GATEWAY_BIND_PORT: z.coerce.number().int().positive().default(8790),
  GATEWAY_WS_URL: optionalUrlString,
  GATEWAY_WS_PATH: z
    .string()
    .min(1)
    .default(`${(process.env.ROOT_PREFIX || "/api").replace(/\/+$/u, "")}/gateway/ws`),
  GATEWAY_TOKEN: optionalNonEmptyString,
  GATEWAY_USER_UUID: optionalNonEmptyString,
  GATEWAY_AUTH_TOKEN: optionalNonEmptyString,
  GATEWAY_DATABASE_URL: optionalNonEmptyString,
  GATEWAY_S3_ENDPOINT: optionalNonEmptyString,
  GATEWAY_S3_BUCKET: optionalNonEmptyString,
  GATEWAY_S3_ACCESS_KEY: optionalNonEmptyString,
  GATEWAY_S3_SECRET_KEY: optionalNonEmptyString,
  RMQ_HOST: optionalNonEmptyString,
  RMQ_PORT: z.coerce.number().int().positive().optional(),
  RMQ_USER: optionalNonEmptyString,
  RMQ_PASSWORD: optionalNonEmptyString,
  RMQ_VHOST: z.preprocess(emptyStringToUndefined, z.string().optional()),
  RMQ_EXCHANGE: z.string().min(1).default("telegram_mcp.gateway"),
  WEBAPP_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  WEBAPP_BASE_PATH: z.string().min(1).default("/webapp"),
  WEBAPP_PUBLIC_URL: optionalUrlString,
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
  WEBAPP_LAUNCH_MODE: z
    .enum(["default", "expand", "fullscreen"])
    .default("fullscreen"),
  WEBAPP_VISIBLE_SCREENS: z.coerce.number().int().positive().default(2),
  WEBAPP_POLL_INTERVAL_MS: z.coerce.number().int().positive().default(2000),
  WEBAPP_ACTION_COOLDOWN_MS: z.coerce.number().int().nonnegative().default(150),
  MCP_XCHANGE_DIR: z.string().min(1).default(".mcp-xchange"),
  TERMINAL_TRANSPORT: z.enum(["tmux", "pty"]).default("tmux"),
  TERMINAL_SHELL: z.string().min(1).default(process.env.SHELL || "bash"),
  TERMINAL_COLS: z.coerce.number().int().positive().default(120),
  TERMINAL_ROWS: z.coerce.number().int().positive().default(40),
  TERMINAL_SCROLLBACK_LINES: z.coerce.number().int().positive().default(4000),
  TMUX_NUDGE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value !== "false"),
  TMUX_SOCKET_PATH: optionalNonEmptyString,
  TMUX_NUDGE_DEBOUNCE_SECONDS: z.coerce.number().int().positive().default(10),
  TMUX_NUDGE_COOLDOWN_SECONDS: z.coerce.number().int().positive().default(30),
  TMUX_NUDGE_MESSAGE: z
    .string()
    .min(1)
    .default("проверь xchange records: telegram_message"),
  TMUX_PARTNER_NUDGE_MESSAGE: z
    .string()
    .min(1)
    .default(
      "проверь xchange records: telegram_message для человека, partner_note для агента",
    ),
  TMUX_CAPTURE_MODE: z.enum(["visible", "lines"]).default("visible"),
  TMUX_CAPTURE_LINES: z.coerce.number().int().positive().default(300),
  TMUX_PROMPT_SCAN_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  TMUX_PROMPT_SCAN_INTERVAL_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(15),
  TMUX_PROMPT_SCAN_COOLDOWN_SECONDS: z.coerce
    .number()
    .int()
    .positive()
    .default(120),
  TMUX_PROMPT_SCAN_STRATEGY: z
    .enum(["strict", "balanced"])
    .default("strict"),
  TMUX_PROMPT_SCAN_MIN_SCORE: z.coerce.number().int().positive().default(5),
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
  BROWSER_ADDRESS: optionalUrlString,
  BROWSER_TIMEOUT_MS: z.coerce.number().int().positive().default(20000),
  BROWSER_MAX_EVENTS: z.coerce.number().int().positive().default(200),
  BROWSER_WAIT_UNTIL: z
    .enum(["load", "domcontentloaded", "networkidle", "commit"])
    .default("load"),
  BROWSER_EXECUTABLE_PATH: optionalNonEmptyString,
  BROWSER_CHANNEL: z.preprocess(
    emptyStringToUndefined,
    z.enum(["chrome", "chromium", "msedge"]).optional(),
  ),
  BROWSER_SLOW_MO_MS: z.coerce.number().int().nonnegative().default(0),
  PROXY_USE: z.preprocess(
    emptyStringToUndefined,
    z.enum(["http", "socks5"]).optional(),
  ),
  HTTP_PROXY: optionalNonEmptyString,
  SOCKS5_PROXY: optionalNonEmptyString,
  LOG_LEVEL: z
    .enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"])
    .default("info"),
  LOG_STDERR_LEVEL: z
    .preprocess(
      emptyStringToUndefined,
      z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
    ),
  LOG_FILE_ENABLED: z
    .string()
    .optional()
    .transform((value) => value === "true"),
  LOG_FILE_LEVEL: z.preprocess(
    emptyStringToUndefined,
    z.enum(["fatal", "error", "warn", "info", "debug", "trace", "silent"]).optional(),
  ),
  LOG_FILE_PATH: z.string().min(1).default(".tellymcp/log.jsonl"),
});

export type AppConfig = {
  telegram: {
    botToken?: string;
    botUsername?: string;
    adminToken?: string;
    debugLanguage?: "en" | "ru";
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
    vfsScope: string;
    bearerToken?: string;
    enableDebugRoutes: boolean;
    enablePruneRoute: boolean;
  };
  distributed: {
    mode: "client" | "gateway" | "both";
    gatewayPublicUrl?: string;
    gatewayBindHost: string;
    gatewayBindPort: number;
    gatewayWsUrl?: string;
    gatewayWsPath: string;
    gatewayToken?: string;
    gatewayUserUuid?: string;
    gatewayAuthToken?: string;
    gatewayDatabaseUrl?: string;
    gatewayS3Endpoint?: string;
    gatewayS3Bucket?: string;
    gatewayS3AccessKey?: string;
    gatewayS3SecretKey?: string;
    rmq?: {
      host: string;
      port: number;
      user?: string;
      password?: string;
      vhost: string;
      exchange: string;
    };
  };
  webapp: {
    enabled: boolean;
    basePath: string;
    publicUrl?: string;
    initDataTtlSeconds: number;
    sessionTtlSeconds: number;
    launchMode: "default" | "expand" | "fullscreen";
    visibleScreens: number;
    pollIntervalMs: number;
    actionCooldownMs: number;
  };
  exchange: {
    dir: string;
  };
  tmux: {
    transport: "tmux" | "pty";
    shell: string;
    cols: number;
    rows: number;
    scrollbackLines: number;
    nudgeEnabled: boolean;
    socketPath?: string;
    nudgeDebounceSeconds: number;
    nudgeCooldownSeconds: number;
    nudgeMessage: string;
    partnerNudgeMessage: string;
    captureMode: "visible" | "lines";
    captureLines: number;
    promptScanEnabled: boolean;
    promptScanIntervalSeconds: number;
    promptScanCooldownSeconds: number;
    promptScanStrategy: "strict" | "balanced";
    promptScanMinScore: number;
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
    sessionId?: string | undefined;
    sessionLabel?: string | undefined;
  };
  logging: {
    level: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
    stderrLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
    fileEnabled: boolean;
    fileLevel?: "fatal" | "error" | "warn" | "info" | "debug" | "trace" | "silent";
    filePath: string;
  };
};

export function loadConfig(): AppConfig {
  const explicitEnvFile = process.env.ENV_FILE?.trim();
  if (explicitEnvFile) {
    process.loadEnvFile(explicitEnvFile);
  } else if (existsSync(".env")) {
    process.loadEnvFile(".env");
  }

  const parsed = envSchema.parse(process.env);

  if (
    parsed.DISTRIBUTED_MODE !== "client" &&
    !parsed.TELEGRAM_BOT_TOKEN?.trim()
  ) {
    throw new Error(
      "TELEGRAM_BOT_TOKEN is required for gateway and both distributed modes.",
    );
  }

  if (parsed.ADMIN_TOKEN?.trim() && !parsed.TELEGRAM_BOT_TOKEN?.trim()) {
    throw new Error(
      "ADMIN_TOKEN requires TELEGRAM_BOT_TOKEN because admin mode runs through the gateway bot.",
    );
  }

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
      ...(parsed.TELEGRAM_BOT_TOKEN
        ? { botToken: parsed.TELEGRAM_BOT_TOKEN }
        : {}),
      ...(parsed.TELEGRAM_BOT_USERNAME
        ? { botUsername: parsed.TELEGRAM_BOT_USERNAME }
        : {}),
      ...(parsed.ADMIN_TOKEN ? { adminToken: parsed.ADMIN_TOKEN } : {}),
      ...(parsed.DEBUG_LANGUAGE
        ? { debugLanguage: parsed.DEBUG_LANGUAGE }
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
      vfsScope: parsed.MCP_VFS_SCOPE,
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
      ...(parsed.GATEWAY_WS_URL
        ? { gatewayWsUrl: parsed.GATEWAY_WS_URL }
        : {}),
      gatewayWsPath: parsed.GATEWAY_WS_PATH,
      ...(parsed.GATEWAY_TOKEN
        ? { gatewayToken: parsed.GATEWAY_TOKEN }
        : {}),
      ...(parsed.GATEWAY_USER_UUID
        ? { gatewayUserUuid: parsed.GATEWAY_USER_UUID }
        : {}),
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
      ...(parsed.RMQ_HOST
        ? {
            rmq: {
              host: parsed.RMQ_HOST,
              port: parsed.RMQ_PORT ?? 5672,
              ...(parsed.RMQ_USER ? { user: parsed.RMQ_USER } : {}),
              ...(parsed.RMQ_PASSWORD
                ? { password: parsed.RMQ_PASSWORD }
                : {}),
              vhost: parsed.RMQ_VHOST ?? "/",
              exchange: parsed.RMQ_EXCHANGE,
            },
          }
        : {}),
    },
    webapp: {
      enabled: parsed.WEBAPP_ENABLED,
      basePath: parsed.WEBAPP_BASE_PATH,
      ...(parsed.WEBAPP_PUBLIC_URL ? { publicUrl: parsed.WEBAPP_PUBLIC_URL } : {}),
      initDataTtlSeconds: parsed.WEBAPP_INITDATA_TTL_SECONDS,
      sessionTtlSeconds: parsed.WEBAPP_SESSION_TTL_SECONDS,
      launchMode: parsed.WEBAPP_LAUNCH_MODE,
      visibleScreens: parsed.WEBAPP_VISIBLE_SCREENS,
      pollIntervalMs: parsed.WEBAPP_POLL_INTERVAL_MS,
      actionCooldownMs: parsed.WEBAPP_ACTION_COOLDOWN_MS,
    },
    exchange: {
      dir: parsed.MCP_XCHANGE_DIR,
    },
    tmux: {
      transport: parsed.TERMINAL_TRANSPORT,
      shell: parsed.TERMINAL_SHELL,
      cols: parsed.TERMINAL_COLS,
      rows: parsed.TERMINAL_ROWS,
      scrollbackLines: parsed.TERMINAL_SCROLLBACK_LINES,
      nudgeEnabled: parsed.TMUX_NUDGE_ENABLED,
      ...(parsed.TMUX_SOCKET_PATH ? { socketPath: parsed.TMUX_SOCKET_PATH } : {}),
      nudgeDebounceSeconds: parsed.TMUX_NUDGE_DEBOUNCE_SECONDS,
      nudgeCooldownSeconds: parsed.TMUX_NUDGE_COOLDOWN_SECONDS,
      nudgeMessage: parsed.TMUX_NUDGE_MESSAGE,
      partnerNudgeMessage: parsed.TMUX_PARTNER_NUDGE_MESSAGE,
      captureMode: parsed.TMUX_CAPTURE_MODE,
      captureLines: parsed.TMUX_CAPTURE_LINES,
      promptScanEnabled: parsed.TMUX_PROMPT_SCAN_ENABLED,
      promptScanIntervalSeconds: parsed.TMUX_PROMPT_SCAN_INTERVAL_SECONDS,
      promptScanCooldownSeconds: parsed.TMUX_PROMPT_SCAN_COOLDOWN_SECONDS,
      promptScanStrategy: parsed.TMUX_PROMPT_SCAN_STRATEGY,
      promptScanMinScore: parsed.TMUX_PROMPT_SCAN_MIN_SCORE,
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
      ...(parsed.TELLYMCP_SESSION_ID
        ? { sessionId: parsed.TELLYMCP_SESSION_ID }
        : {}),
      ...(parsed.TELLYMCP_SESSION_LABEL
        ? { sessionLabel: parsed.TELLYMCP_SESSION_LABEL }
        : {}),
    },
    logging: {
      level: parsed.LOG_LEVEL,
      ...(parsed.LOG_STDERR_LEVEL ? { stderrLevel: parsed.LOG_STDERR_LEVEL } : {}),
      fileEnabled: parsed.LOG_FILE_ENABLED,
      ...(parsed.LOG_FILE_LEVEL ? { fileLevel: parsed.LOG_FILE_LEVEL } : {}),
      filePath: parsed.LOG_FILE_PATH,
    },
  };
}
