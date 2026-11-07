import type { TransportTargetOptions } from "pino";
import fs from "node:fs";
import { Writable } from "node:stream";

/** Private owner log transport: keep the current file and one bounded rotation. */
export default function boundedOwnerLog(options: {
  destination: string;
  maxBytes?: number;
}): Writable {
  const limit = options.maxBytes ?? 1048576;
  return new Writable({
    write(chunk: Buffer, _encoding, callback) {
      try {
        const data = Buffer.from(chunk).subarray(0, Math.min(limit, 65536));
        let size = 0;
        try {
          const stat = fs.lstatSync(options.destination);
          if (
            !stat.isFile() ||
            stat.isSymbolicLink() ||
            stat.uid !== process.getuid?.() ||
            stat.mode & 0o077
          )
            throw new Error("Unsafe owner log permissions");
          size = stat.size;
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
        }
        if (size + data.length > limit) {
          try {
            fs.renameSync(options.destination, `${options.destination}.1`);
          } catch (error) {
            if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          }
        }
        const fd = fs.openSync(
          options.destination,
          fs.constants.O_WRONLY |
            fs.constants.O_APPEND |
            fs.constants.O_CREAT |
            fs.constants.O_NOFOLLOW,
          0o600,
        );
        try {
          fs.writeSync(fd, data);
        } finally {
          fs.closeSync(fd);
        }
        callback();
      } catch (error) {
        callback(error instanceof Error ? error : new Error(String(error)));
      }
    },
  });
}

export type PinoTargetConfig = {
  level: string;
  stderrLevel?: string;
  fileEnabled: boolean;
  filePath: string;
  fileLevel?: string;
};

export function createPinoTargets(
  config: PinoTargetConfig,
): TransportTargetOptions[] {
  const targets: TransportTargetOptions[] = [
    {
      target: "pino-pretty",
      level: config.stderrLevel || config.level,
      options: {
        destination: 2,
        colorize: true,
        translateTime: "SYS:yyyy-mm-dd HH:MM:ss.l",
        ignore: "pid,hostname",
        singleLine: false,
      },
    },
  ];

  if (config.fileEnabled) {
    targets.unshift({
      target: process.env.TELLYMCP_OWNER_LOG_MAX_BYTES
        ? __filename
        : "pino/file",
      level: config.fileLevel || config.level,
      options: {
        destination: config.filePath,
        mkdir: true,
        ...(process.env.TELLYMCP_OWNER_LOG_MAX_BYTES
          ? { maxBytes: 1048576 }
          : {}),
      },
    });
  }

  return targets;
}
