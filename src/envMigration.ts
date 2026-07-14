import { parse as parseDotenv } from "dotenv";

import {
  getTmuxReplacement,
  LEGACY_ENV_RENAMES,
  REMOVED_ENV_KEYS,
} from "./services/features/telegram-mcp/src/app/config/environmentContract";

export type EnvironmentRole = "client" | "gateway" | "both";

type EnvironmentSection = {
  title: string;
  roles: EnvironmentRole[];
  keys: string[];
};

const allRoles: EnvironmentRole[] = ["client", "gateway", "both"];
const gatewayRoles: EnvironmentRole[] = ["gateway", "both"];
const clientRoles: EnvironmentRole[] = ["client", "both"];

const environmentSections: EnvironmentSection[] = [
  {
    title: "Runtime role and request policy",
    roles: allRoles,
    keys: ["DISTRIBUTED_MODE", "TELEGRAM_REQUEST_MODE"],
  },
  {
    title: "Workspace identity",
    roles: clientRoles,
    keys: [
      "PROJECT_NAME",
      "TELLYMCP_SESSION_ID",
      "TELLYMCP_SESSION_LABEL",
      "GATEWAY_USER_UUID",
    ],
  },
  {
    title: "Gateway connection and scope",
    roles: allRoles,
    keys: [
      "GATEWAY_PUBLIC_URL",
      "GATEWAY_WS_URL",
      "GATEWAY_WS_PATH",
      "GATEWAY_SCOPE_TOKEN",
      "GATEWAY_AUTH_TOKEN",
    ],
  },
  {
    title: "Telegram gateway",
    roles: gatewayRoles,
    keys: [
      "TELEGRAM_BOT_TOKEN",
      "TELEGRAM_BOT_USERNAME",
      "ADMIN_TOKEN",
      "DEBUG_LANGUAGE",
      "TELEGRAM_POLL_INTERVAL_MS",
      "TELEGRAM_DEFAULT_TIMEOUT_SECONDS",
      "TELEGRAM_MAX_CONTEXT_CHARS",
      "TELEGRAM_MAX_QUESTION_CHARS",
      "TELEGRAM_MAX_MESSAGE_CHARS",
      "TELEGRAM_MENU_PAYLOAD_TTL_SECONDS",
      "TELEGRAM_WEBHOOK_ENABLED",
      "TELEGRAM_WEBHOOK_PATH",
      "TELEGRAM_WEBHOOK_PUBLIC_URL",
      "TELEGRAM_WEBHOOK_SECRET",
      "TELEGRAM_WEBHOOK_TRACE",
      "TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES",
    ],
  },
  {
    title: "Redis",
    roles: gatewayRoles,
    keys: [
      "REDIS_HOST",
      "REDIS_PORT",
      "REDIS_DB",
      "REDIS_USERNAME",
      "REDIS_PASSWORD",
    ],
  },
  {
    title: "PostgreSQL gateway metadata",
    roles: gatewayRoles,
    keys: [
      "DB_HOST",
      "DB_PORT",
      "DB_USER",
      "DB_PASSWORD",
      "DB_NAME",
      "DB_SCHEMA",
    ],
  },
  {
    title: "Standalone HTTP and MCP",
    roles: allRoles,
    keys: [
      "ROOT_PREFIX",
      "PORT",
      "MCP_HTTP_HOST",
      "MCP_HTTP_PORT",
      "MCP_HTTP_PATH",
      "MCP_HTTP_BEARER_TOKEN",
      "MCP_HTTP_ENABLE_DEBUG_ROUTES",
      "MCP_HTTP_ENABLE_PRUNE_ROUTE",
      "MCP_XCHANGE_DIR",
    ],
  },
  {
    title: "Chat connector OAuth",
    roles: gatewayRoles,
    keys: [
      "TELLYMCP_PUBLIC_URL",
      "TELLYMCP_OAUTH_ISSUER",
      "TELLYMCP_OAUTH_AUDIENCE",
      "TELLYMCP_MAGIC_TOKEN",
      "TELLYMCP_MAGIC_TOKEN_HASH",
      "TELLYMCP_OAUTH_CLIENT_ID",
      "TELLYMCP_OAUTH_CLIENT_SECRET",
      "TELLYMCP_ALLOWED_REDIRECT_URIS",
      "TELLYMCP_OAUTH_PRIVATE_KEY_PEM",
      "TELLYMCP_AUTH_CODE_TTL_SECONDS",
      "TELLYMCP_OAUTH_SCOPES",
      "TELLYMCP_OAUTH_KEY_ID",
    ],
  },
  {
    title: "RabbitMQ fanout",
    roles: gatewayRoles,
    keys: [
      "RMQ_HOST",
      "RMQ_PORT",
      "RMQ_USER",
      "RMQ_PASSWORD",
      "RMQ_VHOST",
      "RMQ_EXCHANGE",
    ],
  },
  {
    title: "Telegram Mini App",
    roles: gatewayRoles,
    keys: [
      "WEBAPP_ENABLED",
      "WEBAPP_BASE_PATH",
      "WEBAPP_PUBLIC_URL",
      "WEBAPP_INITDATA_TTL_SECONDS",
      "WEBAPP_SESSION_TTL_SECONDS",
      "WEBAPP_LAUNCH_MODE",
      "WEBAPP_VISIBLE_SCREENS",
      "WEBAPP_ACTION_COOLDOWN_MS",
    ],
  },
  {
    title: "Built-in PTY terminal",
    roles: clientRoles,
    keys: [
      "TERMINAL_SHELL",
      "TERMINAL_COLS",
      "TERMINAL_ROWS",
      "TERMINAL_SCROLLBACK_LINES",
      "TERMINAL_NUDGE_ENABLED",
      "TERMINAL_NUDGE_DEBOUNCE_SECONDS",
      "TERMINAL_NUDGE_COOLDOWN_SECONDS",
      "TERMINAL_NUDGE_MESSAGE",
      "TERMINAL_PARTNER_NUDGE_MESSAGE",
      "TERMINAL_PARTNER_REPLY_NUDGE_MESSAGE",
      "TERMINAL_CAPTURE_MODE",
      "TERMINAL_CAPTURE_LINES",
      "TERMINAL_PROMPT_SCAN_ENABLED",
      "TERMINAL_PROMPT_SCAN_INTERVAL_SECONDS",
      "TERMINAL_PROMPT_SCAN_COOLDOWN_SECONDS",
      "TERMINAL_PROMPT_SCAN_STRATEGY",
      "TERMINAL_PROMPT_SCAN_MIN_SCORE",
    ],
  },
  {
    title: "Gateway-side prompt detection",
    roles: ["gateway"],
    keys: [
      "TERMINAL_PROMPT_SCAN_ENABLED",
      "TERMINAL_PROMPT_SCAN_INTERVAL_SECONDS",
      "TERMINAL_PROMPT_SCAN_COOLDOWN_SECONDS",
      "TERMINAL_PROMPT_SCAN_STRATEGY",
      "TERMINAL_PROMPT_SCAN_MIN_SCORE",
    ],
  },
  {
    title: "Browser automation",
    roles: clientRoles,
    keys: [
      "BROWSER_ENABLED",
      "BROWSER_HEADLESS",
      "BROWSER_DEVTOOLS",
      "BROWSER_ADDRESS",
      "BROWSER_TIMEOUT_MS",
      "BROWSER_MAX_EVENTS",
      "BROWSER_WAIT_UNTIL",
      "BROWSER_EXECUTABLE_PATH",
      "BROWSER_CHANNEL",
      "BROWSER_SLOW_MO_MS",
      "BROWSER_ATTACH_ENABLED",
      "BROWSER_ATTACH_WS_HOST",
      "BROWSER_ATTACH_WS_PORT",
      "BROWSER_ATTACH_WS_PATH",
    ],
  },
  {
    title: "Outbound proxy",
    roles: allRoles,
    keys: ["PROXY_USE", "HTTP_PROXY", "SOCKS5_PROXY", "NO_PROXY"],
  },
  {
    title: "Moleculer identity and diagnostics",
    roles: allRoles,
    keys: [
      "NAMESPACE",
      "NODE_ID",
      "TRANSPORT",
      "MOLECULER_TRACE",
      "MOLECULER_METRICS",
      "METRICS_PORT",
      "METRICS_PATH",
    ],
  },
  {
    title: "Logging",
    roles: allRoles,
    keys: [
      "LOG_LEVEL",
      "LOG_STDERR_LEVEL",
      "LOG_FILE_ENABLED",
      "LOG_FILE_LEVEL",
      "LOG_FILE_PATH",
      "LOGFEED_ENABLED",
      "LOGFEED_LEVEL",
      "LOGFEED_BUFFER_SIZE",
    ],
  },
];

function inferRole(environment: Record<string, string>): EnvironmentRole {
  const configuredMode = environment.DISTRIBUTED_MODE?.trim();
  if (
    configuredMode === "client" ||
    configuredMode === "gateway" ||
    configuredMode === "both"
  ) {
    return configuredMode;
  }
  if (configuredMode) {
    throw new Error(
      `DISTRIBUTED_MODE must be client, gateway, or both; received ${configuredMode}.`,
    );
  }

  return environment.TELEGRAM_BOT_TOKEN ||
    environment.DB_HOST ||
    environment.ROOT_PREFIX ||
    environment.PORT
    ? "gateway"
    : "client";
}

function formatEnvironmentValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,?&=-]*$/u.test(value)) {
    return value;
  }
  return JSON.stringify(value);
}

export type EnvironmentMigrationResult = {
  role: EnvironmentRole;
  content: string;
  keptKeys: string[];
  renamedKeys: Array<{ from: string; to: string }>;
  droppedKeys: string[];
};

export function migrateEnvironmentContent(
  source: string,
): EnvironmentMigrationResult {
  const parsed = parseDotenv(source);
  const normalized: Record<string, string> = { ...parsed };
  const renamedKeys: Array<{ from: string; to: string }> = [];
  const handledLegacyKeys = new Set<string>();

  for (const [from, to] of Object.entries(LEGACY_ENV_RENAMES)) {
    if (!(from in parsed)) {
      continue;
    }
    if (!(to in parsed)) {
      normalized[to] = parsed[from] ?? "";
    }
    delete normalized[from];
    handledLegacyKeys.add(from);
    renamedKeys.push({ from, to });
  }

  for (const [name, value] of Object.entries(parsed)) {
    if (!name.startsWith("TMUX_")) {
      continue;
    }
    const replacement = getTmuxReplacement(name);
    if (replacement && !(replacement in parsed)) {
      normalized[replacement] = value;
      renamedKeys.push({ from: name, to: replacement });
    }
    delete normalized[name];
    handledLegacyKeys.add(name);
  }

  for (const name of REMOVED_ENV_KEYS) {
    delete normalized[name];
  }

  const role = inferRole(normalized);
  normalized.DISTRIBUTED_MODE = role;

  const emitted = new Set<string>();
  const keptKeys: string[] = [];
  const output: string[] = [
    "# Generated by tellymcp migrate-env.",
    `# Role: ${role}`,
    "",
  ];

  for (const section of environmentSections) {
    if (!section.roles.includes(role)) {
      continue;
    }
    const sectionKeys = section.keys.filter(
      (key) => key in normalized && !emitted.has(key),
    );
    if (sectionKeys.length === 0) {
      continue;
    }
    output.push(`# ${section.title}`);
    for (const key of sectionKeys) {
      output.push(`${key}=${formatEnvironmentValue(normalized[key] ?? "")}`);
      emitted.add(key);
      keptKeys.push(key);
    }
    output.push("");
  }

  const droppedKeys = Object.keys(parsed)
    .filter((key) => !emitted.has(key) && !handledLegacyKeys.has(key))
    .sort();

  return {
    role,
    content: `${output.join("\n").trimEnd()}\n`,
    keptKeys,
    renamedKeys,
    droppedKeys,
  };
}
