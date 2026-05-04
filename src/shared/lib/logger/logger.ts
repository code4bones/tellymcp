import { mkdirSync } from "node:fs";
import { dirname } from "node:path";

import pino from "pino";

import type { AppConfig } from "../../../app/config/env.js";

type LogMeta = Record<string, unknown>;

export interface Logger {
  trace(message: string, meta?: LogMeta): void;
  debug(message: string, meta?: LogMeta): void;
  info(message: string, meta?: LogMeta): void;
  warn(message: string, meta?: LogMeta): void;
  error(message: string, meta?: LogMeta): void;
  fatal(message: string, meta?: LogMeta): void;
}

function write(
  logger: pino.Logger,
  level: "trace" | "debug" | "info" | "warn" | "error" | "fatal",
  message: string,
  meta?: LogMeta,
): void {
  if (meta) {
    logger[level](meta, message);
    return;
  }

  logger[level](message);
}

export function createLogger(config: AppConfig): Logger {
  mkdirSync(dirname(config.logging.filePath), { recursive: true });

  const transport = pino.transport({
    targets: [
      {
        target: "pino/file",
        level: config.logging.level,
        options: {
          destination: config.logging.filePath,
          mkdir: true,
        },
      },
      {
        target: "pino-pretty",
        level: config.logging.level,
        options: {
          destination: 2,
          colorize: true,
          translateTime: "SYS:standard",
          ignore: "pid,hostname",
          singleLine: false,
        },
      },
    ],
  });

  const baseLogger = pino(
    {
      name: "telegram-human-mcp",
      level: config.logging.level,
      timestamp: pino.stdTimeFunctions.isoTime,
    },
    transport,
  );

  return {
    trace(message, meta) {
      write(baseLogger, "trace", message, meta);
    },
    debug(message, meta) {
      write(baseLogger, "debug", message, meta);
    },
    info(message, meta) {
      write(baseLogger, "info", message, meta);
    },
    warn(message, meta) {
      write(baseLogger, "warn", message, meta);
    },
    error(message, meta) {
      write(baseLogger, "error", message, meta);
    },
    fatal(message, meta) {
      write(baseLogger, "fatal", message, meta);
    },
  };
}
