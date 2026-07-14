import {
  createServer,
  type IncomingMessage,
  type ServerResponse,
} from "node:http";
import { randomBytes } from "node:crypto";
import { spawn } from "node:child_process";
import { parse as parseDotenv } from "dotenv";
import Redis from "ioredis";
import { Client as PgClient } from "pg";
import WebSocket from "ws";
import { connect as connectAmqp } from "amqplib";

export type ConfigureRole = "client" | "gateway";

type ConfigureField = {
  key: string;
  label: string;
  section: string;
  value: string;
  kind: "text" | "password" | "number" | "url" | "textarea" | "select";
  options?: string[] | undefined;
  required: boolean;
  derived?: boolean | undefined;
  placeholder?: string | undefined;
  help?: string | undefined;
};

type ValidationResult = {
  valid: boolean;
  errors: Record<string, string>;
};

type ConnectionCheckKind =
  | "telegram"
  | "redis"
  | "postgres"
  | "gateway"
  | "rabbitmq";

type ConnectionCheckResult = {
  ok: boolean;
  message: string;
};

const fieldLabels: Record<string, string> = {
  PUBLIC_BASE_URL: "Публичный базовый URL",
  OAUTH_ENABLED: "Включить OAuth-коннектор",
  PROJECT_NAME: "Название проекта",
  TELLYMCP_SESSION_ID: "Локальный ID сессии",
  TELLYMCP_SESSION_LABEL: "Название консоли",
  TELEGRAM_BOT_TOKEN: "Токен Telegram-бота",
  TELEGRAM_BOT_USERNAME: "Username Telegram-бота",
  ADMIN_TOKEN: "Администраторский токен",
  DEBUG_LANGUAGE: "Язык интерфейса Telegram",
  TELEGRAM_REQUEST_MODE: "Режим обработки запросов",
  TELEGRAM_WEBHOOK_ENABLED: "Использовать Telegram webhook",
  TELEGRAM_WEBHOOK_PATH: "Локальный путь webhook",
  TELEGRAM_WEBHOOK_PUBLIC_URL: "Публичный URL webhook",
  TELEGRAM_WEBHOOK_SECRET: "Секрет webhook",
  TELEGRAM_WEBHOOK_TRACE: "Подробный trace webhook",
  TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES: "Сбросить старые Telegram updates",
  REDIS_HOST: "Хост Redis",
  REDIS_PORT: "Порт Redis",
  REDIS_DB: "Номер базы Redis",
  REDIS_USERNAME: "Пользователь Redis",
  REDIS_PASSWORD: "Пароль Redis",
  GATEWAY_PUBLIC_URL: "Публичный HTTP URL шлюза",
  GATEWAY_WS_URL: "Публичный WebSocket URL шлюза",
  GATEWAY_WS_PATH: "WebSocket-путь шлюза",
  GATEWAY_AUTH_TOKEN: "Общий transport-токен шлюза",
  GATEWAY_SCOPE_TOKEN: "Scope-токен регистрации",
  GATEWAY_USER_UUID: "UUID владельца в шлюзе",
  DB_HOST: "Хост PostgreSQL",
  DB_PORT: "Порт PostgreSQL",
  DB_USER: "Пользователь PostgreSQL",
  DB_PASSWORD: "Пароль PostgreSQL",
  DB_NAME: "База PostgreSQL",
  DB_SCHEMA: "Схема PostgreSQL",
  MCP_HTTP_HOST: "Адрес привязки MCP HTTP",
  MCP_HTTP_PORT: "Порт MCP HTTP",
  MCP_HTTP_PATH: "HTTP-путь MCP",
  MCP_HTTP_BEARER_TOKEN: "Bearer-токен MCP",
  MCP_HTTP_ENABLE_DEBUG_ROUTES: "Включить debug-маршруты MCP",
  MCP_HTTP_ENABLE_PRUNE_ROUTE: "Включить системную очистку через HTTP",
  MCP_XCHANGE_DIR: "Каталог обмена файлами",
  ROOT_PREFIX: "Корневой URL-префикс шлюза",
  PORT: "HTTP-порт шлюза",
  TELLYMCP_PUBLIC_URL: "Публичный URL OAuth-коннектора",
  TELLYMCP_OAUTH_ISSUER: "OAuth issuer",
  TELLYMCP_OAUTH_AUDIENCE: "OAuth audience",
  TELLYMCP_MAGIC_TOKEN: "Magic token коннектора",
  TELLYMCP_MAGIC_TOKEN_HASH: "SHA-256 hash magic token",
  TELLYMCP_OAUTH_CLIENT_ID: "OAuth client ID",
  TELLYMCP_OAUTH_CLIENT_SECRET: "OAuth client secret",
  TELLYMCP_ALLOWED_REDIRECT_URIS: "Разрешённые redirect URI",
  TELLYMCP_OAUTH_PRIVATE_KEY_PEM: "Приватный ключ OAuth",
  TELLYMCP_AUTH_CODE_TTL_SECONDS: "Срок жизни OAuth-кода, секунд",
  TELLYMCP_OAUTH_SCOPES: "OAuth scopes",
  TELLYMCP_OAUTH_KEY_ID: "ID ключа OAuth",
  RMQ_HOST: "Хост RabbitMQ",
  RMQ_PORT: "Порт RabbitMQ",
  RMQ_USER: "Пользователь RabbitMQ",
  RMQ_PASSWORD: "Пароль RabbitMQ",
  RMQ_VHOST: "Virtual host RabbitMQ",
  RMQ_EXCHANGE: "Exchange RabbitMQ",
  WEBAPP_ENABLED: "Включить Telegram Mini App",
  WEBAPP_BASE_PATH: "Локальный путь Mini App",
  WEBAPP_PUBLIC_URL: "Публичный URL Mini App",
  WEBAPP_INITDATA_TTL_SECONDS: "Срок жизни initData, секунд",
  WEBAPP_SESSION_TTL_SECONDS: "Срок жизни Mini App сессии, секунд",
  WEBAPP_LAUNCH_MODE: "Режим открытия Mini App",
  WEBAPP_VISIBLE_SCREENS: "Количество видимых экранов",
  WEBAPP_ACTION_COOLDOWN_MS: "Задержка между действиями, мс",
  TERMINAL_SHELL: "Командная оболочка",
  TERMINAL_COLS: "Ширина терминала",
  TERMINAL_ROWS: "Высота терминала",
  TERMINAL_SCROLLBACK_LINES: "Размер истории терминала",
  TERMINAL_NUDGE_ENABLED: "Будить агента сообщениями",
  TERMINAL_NUDGE_DEBOUNCE_SECONDS: "Debounce уведомлений, секунд",
  TERMINAL_NUDGE_COOLDOWN_SECONDS: "Cooldown уведомлений, секунд",
  TERMINAL_NUDGE_MESSAGE: "Инструкция для Telegram-задачи",
  TERMINAL_PARTNER_NUDGE_MESSAGE: "Инструкция для partner-задачи",
  TERMINAL_PARTNER_REPLY_NUDGE_MESSAGE: "Инструкция для partner-ответа",
  TERMINAL_CAPTURE_MODE: "Режим захвата терминала",
  TERMINAL_CAPTURE_LINES: "Количество строк захвата",
  TERMINAL_PROMPT_SCAN_ENABLED: "Распознавать prompt терминала",
  TERMINAL_PROMPT_SCAN_INTERVAL_SECONDS: "Интервал проверки prompt, секунд",
  TERMINAL_PROMPT_SCAN_COOLDOWN_SECONDS: "Cooldown проверки prompt, секунд",
  TERMINAL_PROMPT_SCAN_STRATEGY: "Стратегия распознавания prompt",
  TERMINAL_PROMPT_SCAN_MIN_SCORE: "Минимальный score prompt",
  BROWSER_ENABLED: "Включить browser tools",
  BROWSER_HEADLESS: "Запускать браузер без окна",
  BROWSER_DEVTOOLS: "Открывать DevTools",
  BROWSER_ADDRESS: "Стартовый адрес браузера",
  BROWSER_TIMEOUT_MS: "Timeout browser-действий, мс",
  BROWSER_MAX_EVENTS: "Лимит browser-событий",
  BROWSER_WAIT_UNTIL: "Условие готовности страницы",
  BROWSER_EXECUTABLE_PATH: "Путь к браузеру",
  BROWSER_CHANNEL: "Канал браузера",
  BROWSER_SLOW_MO_MS: "Замедление browser-действий, мс",
  BROWSER_ATTACH_ENABLED: "Разрешить browser extension attach",
  BROWSER_ATTACH_WS_HOST: "Хост extension WebSocket",
  BROWSER_ATTACH_WS_PORT: "Порт extension WebSocket",
  BROWSER_ATTACH_WS_PATH: "Путь extension WebSocket",
  NAMESPACE: "Namespace Moleculer",
  NODE_ID: "ID узла Moleculer",
  LOG_LEVEL: "Уровень логирования",
  LOG_FILE_ENABLED: "Записывать лог в файл",
  LOG_FILE_PATH: "Путь к файлу логов",
  LOGFEED_ENABLED: "Включить поток логов",
};

const fieldHelp: Record<string, string> = {
  PUBLIC_BASE_URL:
    "Укажите домен или API base один раз. HTTP, WebSocket, Mini App и webhook URL будут рассчитаны автоматически.",
  OAUTH_ENABLED:
    "Если включить, public URL, issuer и audience будут рассчитаны из того же базового URL.",
  GATEWAY_PUBLIC_URL:
    "HTTP endpoint, через который клиент обращается к API шлюза.",
  GATEWAY_WS_URL: "WebSocket endpoint для live relay и управления консолью.",
  GATEWAY_AUTH_TOKEN:
    "Одинаковое значение должно быть указано на шлюзе и всех его клиентах.",
  GATEWAY_SCOPE_TOKEN:
    "Необязательный scope-токен регистрации, выданный шлюзом.",
  TELEGRAM_BOT_TOKEN:
    "Создайте бота через @BotFather и вставьте полученный токен.",
  MCP_HTTP_BEARER_TOKEN:
    "Необязательная защита MCP endpoint через Authorization: Bearer.",
  DB_HOST:
    "PostgreSQL необязателен, но рекомендуется для постоянных collaboration-данных шлюза.",
  TELLYMCP_SESSION_ID:
    "Стабильный routing ID. Оставьте пустым, чтобы получить его из workspace.",
  TELLYMCP_SESSION_LABEL:
    "Понятное имя, которое будет показано в списке консолей шлюза.",
};

const fieldExamples: Record<string, string> = {
  PUBLIC_BASE_URL:
    "https://telly.example.com или https://telly.example.com/api",
  PROJECT_NAME: "backend-api",
  TELLYMCP_SESSION_ID: "backend-dev",
  TELLYMCP_SESSION_LABEL: "Backend · Development",
  TELEGRAM_BOT_TOKEN: "123456789:AA...",
  TELEGRAM_BOT_USERNAME: "my_telly_bot",
  ADMIN_TOKEN: "случайная строка длиной 32+ символа",
  REDIS_HOST: "127.0.0.1 или redis.internal",
  REDIS_PORT: "6379",
  REDIS_DB: "1",
  REDIS_USERNAME: "tellymcp",
  REDIS_PASSWORD: "пароль Redis",
  GATEWAY_AUTH_TOKEN: "один общий случайный секрет для gateway и client",
  GATEWAY_SCOPE_TOKEN: "scope-токен из шлюза",
  GATEWAY_USER_UUID: "550e8400-e29b-41d4-a716-446655440000",
  DB_HOST: "postgres.internal",
  DB_PORT: "5432",
  DB_USER: "tellymcp",
  DB_PASSWORD: "пароль PostgreSQL",
  DB_NAME: "tellymcp",
  DB_SCHEMA: "mcp",
  MCP_HTTP_HOST: "127.0.0.1",
  MCP_HTTP_PORT: "8787",
  MCP_HTTP_PATH: "/mcp",
  MCP_HTTP_BEARER_TOKEN: "случайный bearer-секрет",
  ROOT_PREFIX: "/api",
  PORT: "8080",
  TELLYMCP_MAGIC_TOKEN: "случайная строка длиной 32+ символа",
  TELLYMCP_MAGIC_TOKEN_HASH: "sha256:<64 hex-символа>",
  TELLYMCP_OAUTH_CLIENT_ID: "tellymcp",
  TELLYMCP_ALLOWED_REDIRECT_URIS:
    "https://chatgpt.com/connector/oauth/callback,https://claude.ai/api/mcp/auth_callback",
  RMQ_HOST: "rabbitmq.internal",
  RMQ_PORT: "5672",
  RMQ_VHOST: "/",
  RMQ_EXCHANGE: "telegram_mcp.gateway",
  TERMINAL_SHELL: "bash",
  BROWSER_ADDRESS: "http://localhost:5173",
  BROWSER_EXECUTABLE_PATH: "/usr/bin/google-chrome",
  BROWSER_ATTACH_WS_HOST: "127.0.0.1",
  BROWSER_ATTACH_WS_PORT: "9999",
  BROWSER_ATTACH_WS_PATH: "/browser-attach/ws",
  NAMESPACE: "mcp",
  NODE_ID: "agent-backend",
  LOG_FILE_PATH: ".tellymcp/log.jsonl",
};

function buildFieldHelp(input: {
  key: string;
  kind: ConfigureField["kind"];
  value: string;
  derived: boolean;
}): { help: string; placeholder?: string | undefined } {
  const example =
    fieldExamples[input.key] ??
    (input.value && input.value.length <= 60 ? input.value : undefined);
  const baseHelp = input.derived
    ? "Значение рассчитывается автоматически из публичного базового URL."
    : (fieldHelp[input.key] ??
      (isSecretKey(input.key)
        ? "Секретное значение. Не публикуйте его и не отправляйте в чат."
        : input.kind === "number"
          ? "Укажите целое число; рекомендуемое значение уже подставлено."
          : input.kind === "select"
            ? "Выберите подходящий режим из списка."
            : input.kind === "url"
              ? "Укажите абсолютный URL вместе с протоколом."
              : "Оставьте рекомендуемое значение или измените его под своё окружение."));
  return {
    help: example ? `${baseHelp} Пример: ${example}.` : baseHelp,
    ...(example ? { placeholder: example } : {}),
  };
}

const selectOptions: Record<string, string[]> = {
  TELEGRAM_REQUEST_MODE: ["reject", "queue"],
  DEBUG_LANGUAGE: ["ru", "en"],
  WEBAPP_LAUNCH_MODE: ["fullscreen", "expand", "default"],
  TERMINAL_CAPTURE_MODE: ["visible", "lines"],
  TERMINAL_PROMPT_SCAN_STRATEGY: ["strict", "balanced"],
  BROWSER_WAIT_UNTIL: ["load", "domcontentloaded", "networkidle", "commit"],
  BROWSER_CHANNEL: ["", "chrome", "chromium", "msedge"],
  PROXY_USE: ["", "http", "socks5"],
  LOG_LEVEL: ["fatal", "error", "warn", "info", "debug", "trace", "silent"],
  LOG_STDERR_LEVEL: [
    "",
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ],
  LOG_FILE_LEVEL: [
    "",
    "fatal",
    "error",
    "warn",
    "info",
    "debug",
    "trace",
    "silent",
  ],
};

const booleanKeys = new Set([
  "OAUTH_ENABLED",
  "TELEGRAM_WEBHOOK_ENABLED",
  "TELEGRAM_WEBHOOK_TRACE",
  "TELEGRAM_WEBHOOK_DROP_PENDING_UPDATES",
  "MCP_HTTP_ENABLE_DEBUG_ROUTES",
  "MCP_HTTP_ENABLE_PRUNE_ROUTE",
  "WEBAPP_ENABLED",
  "TERMINAL_NUDGE_ENABLED",
  "TERMINAL_PROMPT_SCAN_ENABLED",
  "BROWSER_ENABLED",
  "BROWSER_HEADLESS",
  "BROWSER_DEVTOOLS",
  "BROWSER_ATTACH_ENABLED",
  "MOLECULER_TRACE",
  "MOLECULER_METRICS",
  "LOG_FILE_ENABLED",
]);

function sectionForKey(key: string): string {
  if (key === "PUBLIC_BASE_URL") return "Быстрая настройка";
  if (
    key.startsWith("TELEGRAM_") ||
    key === "ADMIN_TOKEN" ||
    key === "DEBUG_LANGUAGE"
  ) {
    return "Telegram";
  }
  if (key.startsWith("REDIS_")) return "Redis";
  if (key.startsWith("GATEWAY_")) return "Подключение к шлюзу";
  if (key.startsWith("DB_")) return "PostgreSQL";
  if (
    key.startsWith("TELLYMCP_OAUTH_") ||
    key.startsWith("TELLYMCP_MAGIC_") ||
    key === "TELLYMCP_PUBLIC_URL"
  )
    return "OAuth-коннектор";
  if (key.startsWith("WEBAPP_")) return "Telegram Mini App";
  if (key.startsWith("TERMINAL_")) return "Терминал";
  if (key.startsWith("BROWSER_")) return "Браузер";
  if (key.startsWith("RMQ_")) return "RabbitMQ";
  if (key.startsWith("MCP_") || key === "ROOT_PREFIX" || key === "PORT")
    return "HTTP и MCP";
  if (key === "PROJECT_NAME" || key.startsWith("TELLYMCP_SESSION_"))
    return "Идентификация консоли";
  if (
    key.startsWith("LOG") ||
    key === "NAMESPACE" ||
    key === "NODE_ID" ||
    key === "TRANSPORT" ||
    key.startsWith("MOLECULER_") ||
    key.startsWith("METRICS_")
  )
    return "Runtime и логирование";
  if (key === "PROXY_USE" || key.endsWith("_PROXY")) return "Прокси";
  return "Дополнительно";
}

function labelForKey(key: string): string {
  return fieldLabels[key] ?? `Дополнительный параметр ${key}`;
}

function isSecretKey(key: string): boolean {
  return /(?:TOKEN|PASSWORD|SECRET|PRIVATE_KEY)/u.test(key);
}

function fieldKind(key: string): ConfigureField["kind"] {
  if (selectOptions[key] || booleanKeys.has(key)) return "select";
  if (isSecretKey(key))
    return key.endsWith("PRIVATE_KEY_PEM") ? "textarea" : "password";
  if (key.endsWith("_MESSAGE") || key === "TELLYMCP_ALLOWED_REDIRECT_URIS")
    return "textarea";
  if (key.endsWith("_URL") || key === "BROWSER_ADDRESS") return "url";
  if (
    /(?:_PORT|_MS|_SECONDS|_LINES|_COLS|_ROWS|_SIZE|_SCORE|_DB)$/u.test(key) ||
    key === "PORT"
  )
    return "number";
  return "text";
}

function requiredKeys(role: ConfigureRole): Set<string> {
  const keys = new Set(["PUBLIC_BASE_URL"]);
  if (role === "gateway") {
    keys.add("REDIS_HOST");
    keys.add("REDIS_PORT");
    keys.add("REDIS_DB");
    keys.add("TELEGRAM_BOT_TOKEN");
    keys.add("GATEWAY_AUTH_TOKEN");
  } else {
    keys.add("GATEWAY_AUTH_TOKEN");
  }
  return keys;
}

function parseTemplateKeys(template: string): string[] {
  const keys: string[] = [];
  for (const line of template.split(/\r?\n/u)) {
    const match = line.match(/^\s*(?:#\s*)?([A-Z][A-Z0-9_]*)=/u);
    if (
      match?.[1] &&
      match[1] !== "DISTRIBUTED_MODE" &&
      !keys.includes(match[1])
    ) {
      keys.push(match[1]);
    }
  }
  return keys;
}

function buildFields(role: ConfigureRole, template: string): ConfigureField[] {
  const defaults = parseDotenv(template);
  const values: Record<string, string> = {
    ...defaults,
    DISTRIBUTED_MODE: role,
  };
  const required = requiredKeys(role);
  const derivedKeys = new Set(
    role === "gateway"
      ? [
          "GATEWAY_PUBLIC_URL",
          "GATEWAY_WS_URL",
          "GATEWAY_WS_PATH",
          "ROOT_PREFIX",
          "WEBAPP_PUBLIC_URL",
          "TELEGRAM_WEBHOOK_PUBLIC_URL",
          "TELLYMCP_PUBLIC_URL",
          "TELLYMCP_OAUTH_ISSUER",
          "TELLYMCP_OAUTH_AUDIENCE",
        ]
      : ["GATEWAY_PUBLIC_URL", "GATEWAY_WS_URL", "GATEWAY_WS_PATH"],
  );
  const fields: ConfigureField[] = parseTemplateKeys(template).map((key) => {
    const value = values[key] ?? "";
    const kind = fieldKind(key);
    const derived = derivedKeys.has(key);
    const presentation = buildFieldHelp({ key, kind, value, derived });
    return {
      key,
      label: labelForKey(key),
      section: sectionForKey(key),
      value,
      kind,
      ...(booleanKeys.has(key)
        ? {
            options: value.trim() ? ["true", "false"] : ["", "true", "false"],
          }
        : selectOptions[key]
          ? {
              options:
                value.trim() || selectOptions[key].includes("")
                  ? selectOptions[key]
                  : ["", ...selectOptions[key]],
            }
          : {}),
      required: required.has(key),
      ...(derived ? { derived: true } : {}),
      ...presentation,
    };
  });
  const publicBasePresentation = buildFieldHelp({
    key: "PUBLIC_BASE_URL",
    kind: "url",
    value: "",
    derived: false,
  });
  fields.unshift({
    key: "PUBLIC_BASE_URL",
    label: fieldLabels.PUBLIC_BASE_URL!,
    section: "Быстрая настройка",
    value: "",
    kind: "url",
    required: true,
    ...publicBasePresentation,
  });
  if (role === "gateway") {
    const oauthIndex = fields.findIndex(
      (field) => field.section === "OAuth-коннектор",
    );
    fields.splice(oauthIndex < 0 ? fields.length : oauthIndex, 0, {
      key: "OAUTH_ENABLED",
      label: fieldLabels.OAUTH_ENABLED!,
      section: "OAuth-коннектор",
      value: "false",
      kind: "select",
      options: ["false", "true"],
      required: false,
      ...buildFieldHelp({
        key: "OAUTH_ENABLED",
        kind: "select",
        value: "false",
        derived: false,
      }),
    });
  }
  return fields;
}

function normalizePath(value: string): string {
  const normalized = `/${value}`.replace(/\/{2,}/gu, "/").replace(/\/+$/u, "");
  return normalized === "/" ? "" : normalized;
}

export function deriveEnvironmentFromPublicBase(input: {
  role: ConfigureRole;
  values: Record<string, string>;
}): Record<string, string> {
  const values = { ...input.values };
  const rawBase = values.PUBLIC_BASE_URL?.trim();
  if (!rawBase) return values;

  let url: URL;
  try {
    url = new URL(rawBase);
  } catch {
    return values;
  }
  let rootPath = normalizePath(url.pathname);
  const knownSuffixes = [
    "/telegram/webhook",
    "/gateway/ws",
    "/gateway",
    "/webapp",
    "/mcp",
  ];
  for (const suffix of knownSuffixes) {
    if (rootPath.endsWith(suffix)) {
      rootPath = normalizePath(rootPath.slice(0, -suffix.length));
      break;
    }
  }
  if (!rootPath) {
    rootPath = normalizePath(values.ROOT_PREFIX?.trim() || "/api");
  }
  const httpBase = `${url.origin}${rootPath}`;
  const wsProtocol = url.protocol === "http:" ? "ws:" : "wss:";
  const wsBase = `${wsProtocol}//${url.host}${rootPath}`;
  values.PUBLIC_BASE_URL = httpBase;
  values.GATEWAY_PUBLIC_URL = `${httpBase}/gateway`;
  values.GATEWAY_WS_URL = `${wsBase}/gateway/ws`;
  values.GATEWAY_WS_PATH = `${rootPath}/gateway/ws`;

  if (input.role === "gateway") {
    values.ROOT_PREFIX = rootPath || "/";
    values.WEBAPP_PUBLIC_URL = `${httpBase}/webapp`;
    values.TELEGRAM_WEBHOOK_PUBLIC_URL = `${httpBase}/telegram/webhook`;
    if (values.OAUTH_ENABLED === "true") {
      values.TELLYMCP_PUBLIC_URL = httpBase;
      values.TELLYMCP_OAUTH_ISSUER = httpBase;
      values.TELLYMCP_OAUTH_AUDIENCE = httpBase;
    } else {
      values.TELLYMCP_PUBLIC_URL = "";
      values.TELLYMCP_OAUTH_ISSUER = "";
      values.TELLYMCP_OAUTH_AUDIENCE = "";
    }
  }
  return values;
}

function formatEnvironmentValue(value: string): string {
  if (/^[A-Za-z0-9_./:@%+,?&=-]*$/u.test(value)) return value;
  return JSON.stringify(value);
}

export function renderConfiguredEnvironment(input: {
  role: ConfigureRole;
  template: string;
  values: Record<string, string>;
}): string {
  const allowedKeys = new Set(parseTemplateKeys(input.template));
  const lines = [
    "# Generated by tellymcp configure.",
    `# Role: ${input.role === "gateway" ? "gateway" : "client"}`,
    "",
    `DISTRIBUTED_MODE=${input.role}`,
    "",
  ];
  let lastSection = "";
  for (const key of parseTemplateKeys(input.template)) {
    if (!allowedKeys.has(key)) continue;
    const value = input.values[key]?.trim() ?? "";
    if (!value) continue;
    const section = sectionForKey(key);
    if (section !== lastSection) {
      if (lastSection) lines.push("");
      lines.push(`# ${section}`);
      lastSection = section;
    }
    lines.push(`${key}=${formatEnvironmentValue(value)}`);
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

export function validateConfiguredEnvironment(input: {
  role: ConfigureRole;
  values: Record<string, string>;
}): ValidationResult {
  const errors: Record<string, string> = {};
  for (const key of requiredKeys(input.role)) {
    if (!input.values[key]?.trim())
      errors[key] = "Обязательное поле для выбранной роли.";
  }
  for (const [key, value] of Object.entries(input.values)) {
    const trimmed = value.trim();
    if (!trimmed) continue;
    if (fieldKind(key) === "number") {
      const number = Number(trimmed);
      if (!Number.isInteger(number) || number < 0)
        errors[key] = "Укажите целое неотрицательное число.";
      if (
        (key.endsWith("_PORT") || key === "PORT") &&
        (!Number.isInteger(number) || number < 1 || number > 65535)
      )
        errors[key] = "Порт должен быть целым числом от 1 до 65535.";
    }
    if (fieldKind(key) === "url") {
      try {
        const url = new URL(trimmed);
        const allowedProtocols =
          key === "GATEWAY_WS_URL"
            ? new Set(["ws:", "wss:"])
            : new Set(["http:", "https:"]);
        if (!allowedProtocols.has(url.protocol)) {
          errors[key] =
            `Допустимые протоколы: ${[...allowedProtocols].join(", ")}.`;
        }
        if (key === "PUBLIC_BASE_URL" && (url.search || url.hash)) {
          errors[key] =
            "Базовый URL не должен содержать query-параметры или fragment.";
        }
      } catch {
        errors[key] = "Укажите корректный абсолютный URL.";
      }
    }
    const options = booleanKeys.has(key)
      ? ["true", "false"]
      : selectOptions[key];
    if (options && !options.includes(trimmed)) {
      errors[key] = "Выберите одно из поддерживаемых значений.";
    }
  }
  if (input.values.TELEGRAM_WEBHOOK_ENABLED === "true") {
    if (!input.values.TELEGRAM_WEBHOOK_PUBLIC_URL?.trim())
      errors.TELEGRAM_WEBHOOK_PUBLIC_URL =
        "Поле обязательно, когда включён webhook.";
    if (!input.values.TELEGRAM_WEBHOOK_SECRET?.trim())
      errors.TELEGRAM_WEBHOOK_SECRET = "Секрет обязателен для webhook.";
  }
  if (input.values.PROXY_USE === "http" && !input.values.HTTP_PROXY?.trim())
    errors.HTTP_PROXY = "Укажите HTTP proxy для выбранного режима.";
  if (input.values.PROXY_USE === "socks5" && !input.values.SOCKS5_PROXY?.trim())
    errors.SOCKS5_PROXY = "Укажите SOCKS5 proxy для выбранного режима.";
  const oauthConfigured = [
    "TELLYMCP_PUBLIC_URL",
    "TELLYMCP_OAUTH_ISSUER",
    "TELLYMCP_OAUTH_AUDIENCE",
    "TELLYMCP_MAGIC_TOKEN",
    "TELLYMCP_MAGIC_TOKEN_HASH",
    "TELLYMCP_OAUTH_CLIENT_ID",
    "TELLYMCP_OAUTH_CLIENT_SECRET",
    "TELLYMCP_ALLOWED_REDIRECT_URIS",
    "TELLYMCP_OAUTH_PRIVATE_KEY_PEM",
  ].some((key) => input.values[key]?.trim());
  if (oauthConfigured && !input.values.TELLYMCP_PUBLIC_URL?.trim()) {
    errors.TELLYMCP_PUBLIC_URL =
      "Поле обязательно, когда настроен OAuth-коннектор.";
  }
  if (
    oauthConfigured &&
    !input.values.TELLYMCP_MAGIC_TOKEN?.trim() &&
    !input.values.TELLYMCP_MAGIC_TOKEN_HASH?.trim()
  ) {
    errors.TELLYMCP_MAGIC_TOKEN = "Укажите magic token или его SHA-256 hash.";
  }
  if (
    input.values.TELLYMCP_MAGIC_TOKEN?.trim() &&
    input.values.TELLYMCP_MAGIC_TOKEN_HASH?.trim()
  ) {
    errors.TELLYMCP_MAGIC_TOKEN_HASH =
      "Укажите либо обычный token, либо hash — не оба сразу.";
  }
  if (
    input.values.TELLYMCP_MAGIC_TOKEN_HASH?.trim() &&
    !/^sha256:[a-f0-9]{64}$/iu.test(
      input.values.TELLYMCP_MAGIC_TOKEN_HASH.trim(),
    )
  ) {
    errors.TELLYMCP_MAGIC_TOKEN_HASH =
      "Используйте формат sha256:<64 шестнадцатеричных символа>.";
  }
  if (
    input.values.TELLYMCP_OAUTH_CLIENT_SECRET?.trim() &&
    !input.values.TELLYMCP_OAUTH_CLIENT_ID?.trim()
  ) {
    errors.TELLYMCP_OAUTH_CLIENT_ID =
      "Client ID обязателен, когда указан OAuth client secret.";
  }
  return { valid: Object.keys(errors).length === 0, errors };
}

function sanitizeConnectionError(
  error: unknown,
  values: Record<string, string>,
): string {
  let message = error instanceof Error ? error.message : String(error);
  for (const [key, value] of Object.entries(values)) {
    if (!value || !isSecretKey(key)) continue;
    message = message.split(value).join("[СКРЫТО]");
  }
  return (
    message.replace(/\s+/gu, " ").trim().slice(0, 300) || "Неизвестная ошибка"
  );
}

async function checkTelegramBot(
  values: Record<string, string>,
): Promise<ConnectionCheckResult> {
  const token = values.TELEGRAM_BOT_TOKEN?.trim();
  if (!token)
    return { ok: false, message: "Сначала укажите токен Telegram-бота." };
  const response = await fetch(`https://api.telegram.org/bot${token}/getMe`, {
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await response.json()) as {
    ok?: boolean;
    description?: string;
    result?: { username?: string; first_name?: string };
  };
  if (!response.ok || !payload.ok) {
    throw new Error(
      payload.description || `Telegram вернул HTTP ${response.status}`,
    );
  }
  const identity = payload.result?.username
    ? `@${payload.result.username}`
    : payload.result?.first_name || "без username";
  return {
    ok: true,
    message: `Соединение установлено. Найден бот ${identity}.`,
  };
}

async function checkRedis(
  values: Record<string, string>,
): Promise<ConnectionCheckResult> {
  const client = new Redis({
    host: values.REDIS_HOST?.trim() || "127.0.0.1",
    port: Number(values.REDIS_PORT || 6379),
    db: Number(values.REDIS_DB || 0),
    ...(values.REDIS_USERNAME?.trim()
      ? { username: values.REDIS_USERNAME.trim() }
      : {}),
    ...(values.REDIS_PASSWORD ? { password: values.REDIS_PASSWORD } : {}),
    lazyConnect: true,
    connectTimeout: 4_000,
    maxRetriesPerRequest: 0,
    retryStrategy: () => null,
  });
  client.on("error", () => undefined);
  try {
    await client.connect();
    const reply = await client.ping();
    if (reply !== "PONG") throw new Error(`Неожиданный ответ Redis: ${reply}`);
    return { ok: true, message: "Redis доступен и ответил PONG." };
  } finally {
    client.disconnect();
  }
}

async function checkPostgres(
  values: Record<string, string>,
): Promise<ConnectionCheckResult> {
  if (!values.DB_HOST?.trim()) {
    return { ok: false, message: "Сначала укажите хост PostgreSQL." };
  }
  const client = new PgClient({
    host: values.DB_HOST.trim(),
    port: Number(values.DB_PORT || 5432),
    user: values.DB_USER?.trim() || undefined,
    password: values.DB_PASSWORD || undefined,
    database: values.DB_NAME?.trim() || undefined,
    connectionTimeoutMillis: 4_000,
  });
  try {
    await client.connect();
    await client.query("SELECT 1");
    return {
      ok: true,
      message: "PostgreSQL доступен; запрос SELECT 1 выполнен.",
    };
  } finally {
    await client.end().catch(() => undefined);
  }
}

async function checkGatewayWebSocket(
  values: Record<string, string>,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const socket = new WebSocket(values.GATEWAY_WS_URL!, {
      headers: {
        Authorization: `Bearer ${values.GATEWAY_AUTH_TOKEN}`,
      },
    });
    const timer = setTimeout(() => {
      socket.terminate();
      reject(new Error("WebSocket handshake не завершился за 5 секунд."));
    }, 5_000);
    const finish = (error?: Error) => {
      clearTimeout(timer);
      socket.removeAllListeners();
      if (error) reject(error);
      else resolve();
    };
    socket.once("open", () => {
      socket.close();
      finish();
    });
    socket.once("unexpected-response", (_request, response) => {
      socket.terminate();
      finish(
        new Error(`WebSocket endpoint вернул HTTP ${response.statusCode}.`),
      );
    });
    socket.once("error", (error) => finish(error));
  });
}

async function checkGateway(
  values: Record<string, string>,
): Promise<ConnectionCheckResult> {
  if (!values.GATEWAY_AUTH_TOKEN?.trim()) {
    return {
      ok: false,
      message: "Сначала укажите общий transport-токен шлюза.",
    };
  }
  const base = values.PUBLIC_BASE_URL?.replace(/\/+$/u, "");
  if (!base || !values.GATEWAY_WS_URL) {
    return { ok: false, message: "Сначала укажите публичный базовый URL." };
  }
  const response = await fetch(`${base}/healthz`, {
    signal: AbortSignal.timeout(5_000),
  });
  if (!response.ok)
    throw new Error(`Gateway health вернул HTTP ${response.status}.`);
  await checkGatewayWebSocket(values);
  return {
    ok: true,
    message: "Gateway health доступен, WebSocket handshake успешно выполнен.",
  };
}

async function checkRabbitMq(
  values: Record<string, string>,
): Promise<ConnectionCheckResult> {
  if (!values.RMQ_HOST?.trim()) {
    return { ok: false, message: "Сначала укажите хост RabbitMQ." };
  }
  const connection = await connectAmqp(
    {
      protocol: "amqp",
      hostname: values.RMQ_HOST.trim(),
      port: Number(values.RMQ_PORT || 5672),
      username: values.RMQ_USER?.trim() || "guest",
      password: values.RMQ_PASSWORD || "guest",
      vhost: values.RMQ_VHOST?.trim() || "/",
    },
    { timeout: 5_000 },
  );
  try {
    return { ok: true, message: "Соединение с RabbitMQ установлено." };
  } finally {
    await connection.close();
  }
}

export async function runConfigureConnectionCheck(input: {
  kind: ConnectionCheckKind;
  role: ConfigureRole;
  values: Record<string, string>;
}): Promise<ConnectionCheckResult> {
  const values = deriveEnvironmentFromPublicBase({
    role: input.role,
    values: input.values,
  });
  try {
    if (input.kind === "telegram") return await checkTelegramBot(values);
    if (input.kind === "redis") return await checkRedis(values);
    if (input.kind === "postgres") return await checkPostgres(values);
    if (input.kind === "gateway") return await checkGateway(values);
    return await checkRabbitMq(values);
  } catch (error) {
    return {
      ok: false,
      message: `Проверка не пройдена: ${sanitizeConnectionError(error, values)}`,
    };
  }
}

function writeJson(
  response: ServerResponse,
  status: number,
  body: unknown,
): void {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
  });
  response.end(JSON.stringify(body));
}

async function readJsonBody(request: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > 1_000_000) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
}

function renderHtml(input: {
  roles: Array<{
    role: ConfigureRole;
    title: string;
    filename: string;
    description: string;
    fields: ConfigureField[];
  }>;
  token: string;
  nonce: string;
}): string {
  const state = JSON.stringify(input).replace(/</gu, "\\u003c");
  return `<!doctype html>
<html lang="ru"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>Настройка TellyMCP</title><style nonce="${input.nonce}">
:root{color-scheme:dark;--bg:#071018;--panel:#0f1b25;--line:#223444;--text:#edf7ff;--muted:#8fa6b8;--cyan:#45d7ff;--violet:#a78bfa;--red:#ff6b7a;--green:#4ade80}*{box-sizing:border-box}body{margin:0;background:radial-gradient(circle at 10% 0,#12314a 0,transparent 34%),radial-gradient(circle at 90% 10%,#27184c 0,transparent 30%),var(--bg);font:15px/1.45 Inter,ui-sans-serif,system-ui;color:var(--text)}main{max-width:1120px;margin:auto;padding:48px 24px 96px}.brand{font-size:13px;letter-spacing:.18em;text-transform:uppercase;color:var(--cyan);font-weight:800}.hero h1{font-size:clamp(32px,5vw,60px);line-height:1;margin:12px 0}.hero p{color:var(--muted);max-width:760px}.role-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:18px;margin-top:34px}.role-card{display:block;text-align:left;padding:28px;border:1px solid var(--line);background:linear-gradient(145deg,#102532,#101725);color:var(--text);border-radius:20px;cursor:pointer}.role-card:hover{border-color:var(--cyan);transform:translateY(-2px)}.role-card strong{display:block;font-size:25px;margin-bottom:8px}.role-card span{color:var(--muted)}.wizard-head{display:flex;align-items:center;gap:14px;margin:28px 0 18px}.wizard-head h2{font-size:28px;margin:0}.pill{padding:7px 12px;border:1px solid #39546a;border-radius:999px;text-transform:uppercase;font-weight:800;color:var(--violet)}.grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.section{grid-column:1/-1;background:linear-gradient(145deg,#10202cdd,#0d1720ee);border:1px solid var(--line);border-radius:18px;padding:22px;box-shadow:0 18px 60px #0005}.section-title{display:flex;align-items:center;gap:12px;margin-bottom:18px}.section-title h3{margin:0;font-size:18px}.section-title .check-button{margin-left:auto;padding:8px 12px;background:#173140;color:var(--cyan);border:1px solid #2c5268}.check-result{font-size:12px;color:var(--muted)}.fields{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:16px}.field{display:flex;flex-direction:column;gap:7px}.field.wide{grid-column:1/-1}label{font-weight:700}.key{font:11px ui-monospace,SFMono-Regular,monospace;color:var(--muted);font-weight:400;margin-left:6px}.required{color:var(--cyan)}input,select,textarea{width:100%;border:1px solid #2b4152;background:#08121a;color:var(--text);border-radius:10px;padding:11px 12px;font:inherit;outline:none}input:focus,select:focus,textarea:focus{border-color:var(--cyan);box-shadow:0 0 0 3px #45d7ff22}input[readonly],textarea[readonly]{color:#9dc8d8;background:#0b1821;border-style:dashed}textarea{min-height:92px;resize:vertical}.help{font-size:12px;color:var(--muted)}.error{font-size:12px;color:var(--red);min-height:17px}.actions{position:sticky;bottom:16px;margin-top:24px;background:#0b1720ed;border:1px solid var(--line);backdrop-filter:blur(16px);border-radius:18px;padding:16px;display:flex;align-items:center;gap:12px;box-shadow:0 20px 50px #0008}button{border:0;border-radius:11px;padding:12px 18px;font:inherit;font-weight:800;cursor:pointer}.primary{background:linear-gradient(100deg,var(--cyan),var(--violet));color:#071018}.secondary{background:#172735;color:var(--text)}button:disabled{opacity:.55;cursor:wait}.status{margin-left:auto;color:var(--muted)}.ok{color:var(--green)}.bad{color:var(--red)}.notice{margin-top:18px;color:var(--muted);border-left:3px solid var(--violet);padding-left:12px}[hidden]{display:none!important}@media(max-width:760px){main{padding:28px 14px 80px}.role-grid,.fields{grid-template-columns:1fr}.field.wide{grid-column:auto}.actions{flex-wrap:wrap}.status{width:100%;margin:0}.section{padding:17px}.section-title{align-items:flex-start;flex-wrap:wrap}.section-title .check-button{margin-left:0}}
</style></head><body><main><div class="hero"><div class="brand">Локальная настройка TellyMCP</div><h1>Мастер конфигурации</h1><p>Выберите роль этой машины. Значения обрабатываются локально, а готовый dotenv будет скачан через браузер.</p></div><section id="role-step"><div class="role-grid"><button class="role-card" type="button" data-role="client"><strong>Клиент</strong><span>Консоль агента, подключённая к существующему шлюзу TellyMCP.</span></button><button class="role-card" type="button" data-role="gateway"><strong>Шлюз</strong><span>Telegram-бот, MCP endpoint, маршрутизация и сервисы совместной работы.</span></button></div></section><form id="form" hidden><div class="wizard-head"><button class="secondary" type="button" id="back">Назад</button><h2 id="wizard-title"></h2><span class="pill" id="role-pill"></span></div><div class="grid" id="sections"></div><div class="notice">Браузер скачает файл <b id="filename"></b>. После скачивания выполните <code>chmod 600 &lt;file&gt;</code>, потому что браузер не гарантирует Unix-права файла.</div><div class="actions"><button class="secondary" type="button" id="validate">Проверить все поля</button><button class="primary" type="submit">Скачать dotenv</button><div class="status" id="status">Готов к настройке</div></div></form></main><script nonce="${input.nonce}">
const state=${state};let selected=null;let fields=new Map();const root=document.querySelector('#sections');const form=document.querySelector('#form');const roleStep=document.querySelector('#role-step');const status=document.querySelector('#status');
function esc(v){return String(v).replace(/[&<>"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;'}[c]))}function optionLabel(value){return ({'':'Не задано','true':'Да','false':'Нет','reject':'Отклонять параллельные запросы','queue':'Ставить запросы в очередь','ru':'Русский','en':'English','fullscreen':'На весь экран','expand':'Развернуть','default':'По умолчанию','visible':'Видимая область','lines':'Последние строки','strict':'Строгая','balanced':'Сбалансированная'}[value]||value)}function renderField(f){const wide=f.kind==='textarea'?' wide':'';const req=f.required?'<span class="required"> *</span>':'';const readonly=f.derived?' readonly':'';const placeholder=f.placeholder?' placeholder="'+esc(f.placeholder)+'"':'';let control;if(f.kind==='select'){control='<select id="'+f.key+'">'+f.options.map(o=>'<option value="'+esc(o)+'" '+(o===f.value?'selected':'')+'>'+esc(optionLabel(o))+'</option>').join('')+'</select>'}else if(f.kind==='textarea'){control='<textarea id="'+f.key+'"'+readonly+placeholder+'>'+esc(f.value)+'</textarea>'}else{control='<input id="'+f.key+'" type="'+f.kind+'" value="'+esc(f.value)+'" '+(f.required?'required':'')+readonly+placeholder+' autocomplete="off">'}return '<div class="field'+wide+'"><label for="'+f.key+'">'+esc(f.label)+req+'<span class="key">'+f.key+'</span></label>'+control+(f.help?'<div class="help">'+esc(f.help)+'</div>':'')+'<div class="error" data-error="'+f.key+'"></div></div>'}
function normalizePath(value){const normalized=('/'+value).replace(new RegExp('/{2,}','g'),'/').replace(new RegExp('/+$'),'');return normalized==='/'?'':normalized}function setValue(key,value){const element=document.getElementById(key);if(element)element.value=value}function updateDerived(){const baseElement=document.getElementById('PUBLIC_BASE_URL');if(!baseElement?.value.trim())return;try{const url=new URL(baseElement.value.trim());let rootPath=normalizePath(url.pathname);for(const suffix of ['/telegram/webhook','/gateway/ws','/gateway','/webapp','/mcp']){if(rootPath.endsWith(suffix)){rootPath=normalizePath(rootPath.slice(0,-suffix.length));break}}if(!rootPath)rootPath=normalizePath(document.getElementById('ROOT_PREFIX')?.value||'/api');const httpBase=url.origin+rootPath;const wsBase=(url.protocol==='http:'?'ws:':'wss:')+'//'+url.host+rootPath;setValue('GATEWAY_PUBLIC_URL',httpBase+'/gateway');setValue('GATEWAY_WS_URL',wsBase+'/gateway/ws');setValue('GATEWAY_WS_PATH',rootPath+'/gateway/ws');if(selected.role==='gateway'){setValue('ROOT_PREFIX',rootPath||'/');setValue('WEBAPP_PUBLIC_URL',httpBase+'/webapp');setValue('TELEGRAM_WEBHOOK_PUBLIC_URL',httpBase+'/telegram/webhook');const oauth=document.getElementById('OAUTH_ENABLED')?.value==='true';setValue('TELLYMCP_PUBLIC_URL',oauth?httpBase:'');setValue('TELLYMCP_OAUTH_ISSUER',oauth?httpBase:'');setValue('TELLYMCP_OAUTH_AUDIENCE',oauth?httpBase:'')}}catch{}}
function checkForSection(name,role){if(name==='Telegram'&&role==='gateway')return'telegram';if(name==='Redis'&&role==='gateway')return'redis';if(name==='PostgreSQL'&&role==='gateway')return'postgres';if(name==='Подключение к шлюзу'&&role==='client')return'gateway';if(name==='RabbitMQ'&&role==='gateway')return'rabbitmq';return null}function chooseRole(role){selected=state.roles.find(item=>item.role===role);fields=new Map(selected.fields.map(field=>[field.key,field]));const grouped=new Map();for(const field of selected.fields){if(!grouped.has(field.section))grouped.set(field.section,[]);grouped.get(field.section).push(field)}const essential=new Set(role==='gateway'?['Быстрая настройка','Telegram','Подключение к шлюзу','Redis','PostgreSQL','HTTP и MCP']:['Быстрая настройка','Идентификация консоли','Подключение к шлюзу','HTTP и MCP']);root.innerHTML='';for(const [name,items] of grouped){const check=checkForSection(name,role);const el=document.createElement('section');el.className='section';el.innerHTML='<div class="section-title"><h3>'+esc(name)+(essential.has(name)?'':' · расширенные настройки')+'</h3>'+(check?'<span class="check-result" data-check-result="'+check+'"></span><button class="check-button" type="button" data-check="'+check+'">Проверить соединение</button>':'')+'</div><div class="fields">'+items.map(renderField).join('')+'</div>';root.append(el)}document.querySelector('#wizard-title').textContent='Настройка: '+selected.title;document.querySelector('#role-pill').textContent=selected.role==='gateway'?'шлюз':'клиент';document.querySelector('#filename').textContent=selected.filename;document.getElementById('PUBLIC_BASE_URL').addEventListener('input',updateDerived);document.getElementById('OAUTH_ENABLED')?.addEventListener('change',updateDerived);root.querySelectorAll('[data-check]').forEach(button=>button.addEventListener('click',()=>runCheck(button)));status.className='status';status.textContent='Заполните обязательные поля';roleStep.hidden=true;form.hidden=false;window.scrollTo({top:0,behavior:'smooth'})}
function values(){return Object.fromEntries([...fields.keys()].map(key=>[key,document.getElementById(key).value]))}function showErrors(errors){document.querySelectorAll('[data-error]').forEach(element=>element.textContent='');for(const [key,message] of Object.entries(errors||{})){const element=document.querySelector('[data-error="'+CSS.escape(key)+'"]');if(element)element.textContent=message}}
async function post(path,extra={}){const response=await fetch(path+'?token='+encodeURIComponent(state.token),{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({role:selected.role,values:values(),...extra})});return response}async function runCheck(button){const kind=button.dataset.check;const result=document.querySelector('[data-check-result="'+kind+'"]');button.disabled=true;result.className='check-result';result.textContent='Проверяем…';try{const response=await post('/api/check',{check:kind});const data=await response.json();result.className='check-result '+(data.ok?'ok':'bad');result.textContent=data.message}catch(error){result.className='check-result bad';result.textContent='Ошибка проверки: '+error.message}finally{button.disabled=false}}
document.querySelectorAll('[data-role]').forEach(button=>button.addEventListener('click',()=>chooseRole(button.dataset.role)));document.querySelector('#back').addEventListener('click',()=>{form.hidden=true;roleStep.hidden=false;selected=null;root.innerHTML=''});
document.querySelector('#validate').addEventListener('click',async()=>{status.textContent='Проверяем поля…';try{const response=await post('/api/validate');const data=await response.json();showErrors(data.errors);status.className='status '+(data.valid?'ok':'bad');status.textContent=data.valid?'Все поля заполнены корректно':'Исправьте подсвеченные поля'}catch(error){status.className='status bad';status.textContent=error.message}});
form.addEventListener('submit',async event=>{event.preventDefault();status.textContent='Формируем dotenv…';document.querySelectorAll('button').forEach(button=>button.disabled=true);try{const response=await post('/api/download');if(!response.ok){const data=await response.json();showErrors(data.errors);throw new Error(data.message||'Не удалось сформировать dotenv')}const blob=await response.blob();const href=URL.createObjectURL(blob);const link=document.createElement('a');link.href=href;link.download=selected.filename;document.body.append(link);link.click();link.remove();setTimeout(()=>URL.revokeObjectURL(href),1000);showErrors({});status.className='status ok';status.textContent='Файл '+selected.filename+' скачан. Перед запуском выставьте права 0600.'}catch(error){status.className='status bad';status.textContent=error.message;document.querySelectorAll('button').forEach(button=>button.disabled=false)}});
</script></body></html>`;
}

function openBrowser(url: string): void {
  const command =
    process.platform === "darwin"
      ? "open"
      : process.platform === "win32"
        ? "cmd"
        : "xdg-open";
  const args = process.platform === "win32" ? ["/c", "start", "", url] : [url];
  const child = spawn(command, args, { detached: true, stdio: "ignore" });
  child.unref();
  child.on("error", () => undefined);
}

export async function startConfigureServer(input: {
  templates: Record<ConfigureRole, string>;
  port?: number | undefined;
  open?: boolean | undefined;
  onListening?: ((url: string) => void) | undefined;
  onDownloaded?: ((filename: string) => void) | undefined;
}): Promise<void> {
  const token = randomBytes(24).toString("base64url");
  const roles = (["client", "gateway"] as const).map((role) => ({
    role,
    title: role === "gateway" ? "Шлюз" : "Клиент",
    filename: role === "gateway" ? ".env-gateway" : ".env-client",
    description:
      role === "gateway"
        ? "Telegram-бот и шлюз маршрутизации"
        : "Консоль агента, подключённая к шлюзу",
    fields: buildFields(role, input.templates[role]),
  }));

  await new Promise<void>((resolve, reject) => {
    const server = createServer(async (request, response) => {
      try {
        const url = new URL(request.url ?? "/", "http://127.0.0.1");
        if (url.searchParams.get("token") !== token) {
          writeJson(response, 403, { message: "Invalid configurator token." });
          return;
        }
        if (request.method === "GET" && url.pathname === "/") {
          const nonce = randomBytes(16).toString("base64");
          response.writeHead(200, {
            "content-type": "text/html; charset=utf-8",
            "cache-control": "no-store",
            "content-security-policy": `default-src 'none'; style-src 'nonce-${nonce}'; script-src 'nonce-${nonce}'; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'`,
            "x-content-type-options": "nosniff",
            "referrer-policy": "no-referrer",
          });
          response.end(
            renderHtml({
              roles,
              token,
              nonce,
            }),
          );
          return;
        }
        if (
          request.method === "POST" &&
          (url.pathname === "/api/validate" ||
            url.pathname === "/api/check" ||
            url.pathname === "/api/download")
        ) {
          const body = (await readJsonBody(request)) as {
            role?: unknown;
            check?: unknown;
            values?: unknown;
          };
          const role =
            body.role === "client" || body.role === "gateway"
              ? body.role
              : null;
          if (!role) {
            writeJson(response, 400, {
              message: "Выберите Client или Gateway.",
            });
            return;
          }
          if (
            !body.values ||
            typeof body.values !== "object" ||
            Array.isArray(body.values)
          ) {
            writeJson(response, 400, {
              message: "Некорректный набор значений.",
            });
            return;
          }
          const roleDefinition = roles.find((item) => item.role === role)!;
          const allowedKeys = new Set(
            roleDefinition.fields.map((field) => field.key),
          );
          const submittedValues = Object.fromEntries(
            Object.entries(body.values as Record<string, unknown>)
              .filter(([key]) => allowedKeys.has(key))
              .map(([key, value]) => [
                key,
                typeof value === "string" ? value : String(value ?? ""),
              ]),
          );
          const values = deriveEnvironmentFromPublicBase({
            role,
            values: submittedValues,
          });
          if (url.pathname === "/api/check") {
            const allowedChecks = new Set<ConnectionCheckKind>([
              "telegram",
              "redis",
              "postgres",
              "gateway",
              "rabbitmq",
            ]);
            const check =
              typeof body.check === "string" &&
              allowedChecks.has(body.check as ConnectionCheckKind)
                ? (body.check as ConnectionCheckKind)
                : null;
            if (!check) {
              writeJson(response, 400, {
                message: "Неизвестный тип проверки.",
              });
              return;
            }
            writeJson(
              response,
              200,
              await runConfigureConnectionCheck({ kind: check, role, values }),
            );
            return;
          }
          const validation = validateConfiguredEnvironment({
            role,
            values,
          });
          if (url.pathname === "/api/validate") {
            writeJson(response, 200, validation);
            return;
          }
          if (!validation.valid) {
            writeJson(response, 422, {
              message: "Исправьте ошибки конфигурации перед скачиванием.",
              errors: validation.errors,
            });
            return;
          }
          const content = renderConfiguredEnvironment({
            role,
            template: input.templates[role],
            values,
          });
          response.writeHead(200, {
            "content-type": "text/plain; charset=utf-8",
            "content-disposition": `attachment; filename="${roleDefinition.filename}"`,
            "cache-control": "no-store",
            "x-content-type-options": "nosniff",
          });
          response.end(content);
          input.onDownloaded?.(roleDefinition.filename);
          setTimeout(() => server.close(() => resolve()), 1_000).unref();
          return;
        }
        writeJson(response, 404, { message: "Not found." });
      } catch (error) {
        writeJson(response, 500, {
          message: error instanceof Error ? error.message : String(error),
        });
      }
    });
    server.once("error", reject);
    server.listen(input.port ?? 0, "127.0.0.1", () => {
      const address = server.address();
      if (!address || typeof address === "string") {
        reject(new Error("Could not determine configurator address."));
        return;
      }
      const url = `http://127.0.0.1:${address.port}/?token=${encodeURIComponent(token)}`;
      input.onListening?.(url);
      if (input.open !== false) openBrowser(url);
    });
  });
}
