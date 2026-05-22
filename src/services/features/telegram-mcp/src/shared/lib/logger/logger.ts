import pino from "pino";

import type { AppConfig } from "../../../app/config/env";
import { createPinoTargets } from "../../../../../../../lib/pinoTargets";

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
  const transport = pino.transport({
    targets: createPinoTargets({
      level: config.logging.level,
      fileEnabled: config.logging.fileEnabled,
      ...(config.logging.stderrLevel
        ? { stderrLevel: config.logging.stderrLevel }
        : {}),
      filePath: config.logging.filePath,
      ...(config.logging.fileLevel
        ? { fileLevel: config.logging.fileLevel }
        : {}),
    }),
  });

  const baseLogger = pino(
    {
      name: "tellymcp",
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
