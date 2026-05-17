import { Redis } from "ioredis";

import type { AppConfig } from "../../config/env";

export type RedisClient = Redis;

export async function createRedisClient(
  config: AppConfig,
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

  await client.connect();
  await client.ping();

  return client;
}
