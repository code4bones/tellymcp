export const LEGACY_ENV_RENAMES = {
  MODE: "TELEGRAM_REQUEST_MODE",
  GATEWAY_TOKEN: "GATEWAY_SCOPE_TOKEN",
  DB_SCHEME: "DB_SCHEMA",
  ENABLE_LOGFEED: "LOGFEED_ENABLED",
} as const;

export const REMOVED_ENV_KEYS = [
  "APP_NAME",
  "BROWSER_ATTACH_TOKEN",
  "GATEWAY_BIND_HOST",
  "GATEWAY_BIND_PORT",
  "GATEWAY_DATABASE_URL",
  "GATEWAY_S3_ACCESS_KEY",
  "GATEWAY_S3_BUCKET",
  "GATEWAY_S3_ENDPOINT",
  "GATEWAY_S3_SECRET_KEY",
  "MAX_BODY_SIZE",
  "MCP_VFS_SCOPE",
  "PAIR_CODE_TTL_SECONDS",
  "SESSION_SECRET",
  "TELEGRAM_INBOX_BATCH_SIZE",
  "TERMINAL_TRANSPORT",
  "TOKEN_BINDING_SECRET",
  "WEBAPP_POLL_INTERVAL_MS",
] as const;

export function getTmuxReplacement(name: string): string | null {
  if (!name.startsWith("TMUX_")) {
    return null;
  }
  if (name === "TMUX_SOCKET_PATH") {
    return null;
  }
  return `TERMINAL_${name.slice("TMUX_".length)}`;
}

export function assertNoLegacyEnvironmentVariables(
  environment: NodeJS.ProcessEnv,
): void {
  const issues: string[] = [];

  for (const [legacyName, replacement] of Object.entries(LEGACY_ENV_RENAMES)) {
    const value = environment[legacyName];
    if (value !== undefined) {
      // MODE is also set by tools such as Vite. Only the two former TellyMCP
      // queue-policy values identify it as our legacy setting.
      if (legacyName === "MODE" && value !== "queue" && value !== "reject") {
        continue;
      }
      issues.push(`${legacyName} -> ${replacement}`);
    }
  }

  for (const name of REMOVED_ENV_KEYS) {
    if (environment[name] !== undefined) {
      issues.push(`${name} (remove)`);
    }
  }

  for (const tmuxName of Object.keys(environment).filter((name) =>
    name.startsWith("TMUX_"),
  )) {
    const replacement = getTmuxReplacement(tmuxName);
    issues.push(
      replacement ? `${tmuxName} -> ${replacement}` : `${tmuxName} (remove)`,
    );
  }

  if (issues.length > 0) {
    throw new Error(
      `Environment migration is required: ${issues.sort().join(", ")}. ` +
        "Run: tellymcp migrate-env <input.env> > .migrated-env",
    );
  }
}
