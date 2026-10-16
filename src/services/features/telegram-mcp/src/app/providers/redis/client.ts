import { Redis } from "ioredis";

import type { AppConfig } from "../../config/env";
import type { Logger } from "../../../shared/lib/logger/logger";

export type RedisClient = Redis;

export async function createRedisClient(
  config: AppConfig,
  logger?: Logger,
): Promise<RedisClient> {
  const client = new Redis({
    host: config.redis.host,
    port: config.redis.port,
    db: config.redis.db,
    ...(config.redis.username ? { username: config.redis.username } : {}),
    ...(config.redis.password ? { password: config.redis.password } : {}),
    lazyConnect: true,
    maxRetriesPerRequest: 1,
  });

  // ioredis is an EventEmitter: an unhandled "error" event crashes the whole
  // process. This listener must exist before connect(), and must outlive this
  // function, since ioredis keeps reconnecting on its own after a transient error.
  client.on("error", (error: unknown) => {
    logger?.warn("Redis client error", {
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    });
  });

  await client.connect();
  await client.ping();

  return client;
}
